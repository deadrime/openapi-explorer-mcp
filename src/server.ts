import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Credentials, emptyCredentials, placement, resolveSupplied } from './auth.js';
import { type ExplorerConfig, readConfig, schemeEnvName } from './config.js';
import { buildUrl, type CallResult, send } from './http.js';
import { appendJsonl, tailJsonl } from './journal.js';
import { renderEndpoint } from './format/endpoint.js';
import { compactJson, omitEmpty } from './format/json.js';
import { renderSchema } from './format/schema.js';
import { endpointLine, listHeader, schemaLine } from './format/search.js';
import { formatDeclaration, stripDocs } from './format/types.js';
import { componentRef, exactOperation, operationTypeName, renderParams, resolveEndpoint } from './operations.js';
import { listRecipes } from './recipes.js';
import { capArrays, project } from './projection.js';
import { type DangerRules, loadDangerRules } from './risk.js';
import { renderOutline, resolveJson, type SchemaSpec } from './schema-view.js';
import * as schemas from './schemas.js';
import { type EndpointHit, SearchIndex } from './search/search-index.js';
import type { HttpMethod, Operation, SchemaNode, SecurityScheme } from './spec-index.js';
import { SpecStore, type SpecState } from './spec-store.js';
import { getTypeMap, renameIdentifiers } from './types-gen.js';

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const READ_ONLY = { readOnlyHint: true } as const;
const AUTO_CAPS = [20, 5, 1];
const CALL_HINT = 'fields, max_items or query parameters';

const BASE_INSTRUCTIONS = [
  'An index of an OpenAPI spec with tools to inspect and call its endpoints.',
  '',
  'Order: api_search finds an endpoint → api_endpoint shows parameters, shapes and errors → api_types gives TypeScript types → api_get / api_request call it.',
  '',
  '- api_search ranks results and understands phrases, identifiers and field names; English words from paths and summaries work best. scope: "schemas" finds schemas by a field.',
  '- Refer to endpoints as "METHOD /path"; operationIds are not always unique. Summaries can be missing or wrong — check the path, method and response shape.',
  '- Credentials follow the security schemes of the spec: `credentials` for one call, api_credentials for the session, OPENAPI_AUTH_<SCHEME> for good; that is also the order of precedence. Keys are scheme names; an apiKey scheme also takes its header name; a spec without schemes gets them as headers. `as` picks a scheme.',
  '- Narrow large responses with `fields` and `max_items`.',
  '- Destructive endpoints need confirm_danger: true in api_request.',
].join('\n');

/**
 * Arguments of one API call.
 */
interface CallArgs {
  method: HttpMethod;
  pathParams: Record<string, string | number>;
  query: Record<string, string | number | boolean>;
  body?: unknown;
  as: string;
  credentials?: Record<string, string>;
}

/**
 * MCP server exploring an OpenAPI spec over stdio.
 */
export class OpenApiExplorerServer {
  private readonly server: McpServer;
  private readonly store: SpecStore;
  private readonly credentials: Credentials;

  constructor(
    private readonly config: ExplorerConfig,
    rules: DangerRules,
    extraInstructions: string
  ) {
    this.store = new SpecStore(config, rules);
    this.credentials = new Credentials(config);
    const instructions = extraInstructions ? `${BASE_INSTRUCTIONS}\n\n${extraInstructions}` : BASE_INSTRUCTIONS;
    this.server = new McpServer({ name: config.serverName, version: VERSION }, { capabilities: { tools: {} }, instructions });
    this.registerTools();
  }

  /**
   * Builds the server from environment variables; exits with a readable message when they are wrong.
   */
  static async fromEnvironment(): Promise<OpenApiExplorerServer> {
    try {
      const config = readConfig();
      const rules = loadDangerRules(config.dangerFile);
      const extra = config.instructionsFile ? readFileSync(config.instructionsFile, 'utf8').trim() : '';
      return new OpenApiExplorerServer(config, rules, extra);
    } catch (error) {
      // stdout carries JSON-RPC, so startup errors go to stderr.
      process.stderr.write(`openapi-explorer-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  /**
   * Connects the server to stdio.
   */
  async start(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }

  /**
   * Serializes a tool result as text or compact JSON, cutting responses that would flood the context.
   */
  private result(value: unknown, hint: string): CallToolResult {
    const text = typeof value === 'string' ? value : compactJson(value);
    const limit = this.config.maxResponseChars;
    const capped = text.length <= limit ? text : `${text.slice(0, limit)}\n\n… response truncated (${text.length} characters). Narrow it down: ${hint}.`;
    return { content: [{ type: 'text', text: capped }] };
  }

  /**
   * Runs a handler and turns a thrown error into a tool error instead of a protocol error.
   */
  private async run(handler: () => Promise<unknown>, hint = 'a narrower query'): Promise<CallToolResult> {
    try {
      return this.result(await handler(), hint);
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }

  /**
   * Adds a `spec` note when there is something to say: offline, stale or a changed version.
   */
  private specNote(state: SpecState): Record<string, unknown> {
    const note: Record<string, unknown> = {};
    if (state.offline) {
      note.warning = `the spec source is unreachable (${state.offline.reason}); serving the cached copy from ${new Date(state.meta.fetchedAt).toISOString()}, version ${state.meta.version}`;
    }
    // A change is announced once; api_spec_info keeps the full list.
    const updated = this.store.takeNotice();
    if (updated) note.updated = updated;
    const ageHours = (Date.now() - state.meta.fetchedAt) / 3.6e6;
    if (this.config.specIsUrl && !state.offline && ageHours > 24) note.stale = `the spec was fetched ${ageHours.toFixed(0)} h ago`;
    return Object.keys(note).length ? { spec: note } : {};
  }

  /**
   * Base URL for calls: OPENAPI_BASE_URL, otherwise the first server of the spec.
   */
  private baseUrl(state: SpecState): string {
    if (this.config.baseUrl) return this.config.baseUrl;
    const first = state.index.servers[0];
    if (!first) throw new Error('no base URL: the spec lists no servers; set OPENAPI_BASE_URL');
    if (/^https?:\/\//i.test(first)) return first.replace(/\/+$/, '');
    if (this.config.specIsUrl) return new URL(first, this.config.specSource).toString().replace(/\/+$/, '');
    throw new Error(`the spec server "${first}" is relative and the spec is a local file; set OPENAPI_BASE_URL`);
  }

  /**
   * Base URL for calls, or null when there is none; for reports that must not fail.
   */
  private baseUrlOrNull(state: SpecState): string | null {
    try {
      return this.baseUrl(state);
    } catch {
      return null;
    }
  }

  /**
   * The spec note as one line of text, or an empty string.
   */
  private specText(state: SpecState): string {
    const note = this.specNote(state).spec as Record<string, unknown> | undefined;
    if (!note) return '';
    const parts: string[] = [];
    if (typeof note.warning === 'string') parts.push(note.warning);
    if (typeof note.stale === 'string') parts.push(note.stale);
    if (typeof note.updated === 'string') parts.push(note.updated);
    return parts.length ? `spec: ${parts.join('; ')}` : '';
  }

  /**
   * An empty search result that says how to search differently; not an error.
   */
  private nothingFound(text: string, search: SearchIndex, filters: string[], note: string, scope: 'endpoints' | 'schemas'): string {
    const similar = text ? search.suggest(text) : [];
    const other = scope === 'schemas' ? 'the endpoints scope for paths and summaries' : 'scope: "schemas" for a field or schema name';
    return [
      `nothing matched${text ? ` "${text}"` : ''}${filters.length ? ` with ${filters.join(', ')}` : ''}.`,
      `Try fewer words, English words from the spec, ${other}, or api_spec_info for the groups.`,
      similar.length ? `similar words in the spec: ${similar.join(', ')}` : '',
      note,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Security schemes with where each puts its value and where its credential comes from — never the value.
   */
  private schemeStatus(schemes: Record<string, SecurityScheme>): Array<Record<string, string>> {
    return Object.entries(schemes).map(([name, scheme]) => ({
      name,
      type: scheme.type,
      placement: placement(scheme),
      credential: this.credentials.describe(name),
      env: schemeEnvName(name),
    }));
  }

  /**
   * Calls an operation: resolves and picks credentials, checks the origin, explains a 401 and a 404.
   */
  private async performCall(state: SpecState, op: Operation, args: CallArgs): Promise<CallResult & { auth: string; note?: Record<string, string> }> {
    const base = this.baseUrl(state);
    const origin = new URL(base).origin;
    const schemes = state.index.securitySchemes;
    const call = args.credentials ? resolveSupplied(args.credentials, schemes) : emptyCredentials();
    const selection = this.credentials.select(op, args.as, call, schemes);

    const url = buildUrl(base, op.path, args.pathParams, args.query);
    const headers: Record<string, string> = { ...this.config.staticHeaders };
    const auth = this.credentials.apply(selection, schemes, call, headers, url);
    if (url.origin !== origin) throw new Error(`refusing to send the request to ${url.origin}; only ${origin} is allowed`);
    const result = await send(args.method, url, headers, args.body, this.config.timeoutMs);

    const note: Record<string, string> = {};
    if (selection.mode === 'anonymous' && selection.note) note.auth = selection.note;
    else if (result.status === 401 && auth !== 'anonymous') note.auth = `the API rejected ${auth}: the credential is wrong or expired — supply a fresh one`;
    if (result.status === 404) {
      const fresh = await this.store.forceRevalidate().catch(() => null);
      note.specRecheck = fresh?.index.byKey.has(op.key)
        ? 'the path is still in the spec, so the 404 is real — check path parameters'
        : 'the path is gone from the spec — the API has probably changed';
    }

    return {
      auth,
      ...result,
      ...(Object.keys(note).length ? { note } : {}),
    };
  }

  /**
   * Narrows a call result: fields first, then max_items; without max_items, arrays are capped step by step until the
   * result fits the response limit.
   */
  private shapeResult(result: Record<string, unknown> & { body: unknown }, fields: string[] | undefined, maxItems: number | undefined): Record<string, unknown> {
    let body = result.body;
    const extra: Record<string, unknown> = {};
    const structured = body !== null && typeof body === 'object';
    if (fields?.length) {
      if (structured) {
        const projection = project(body, fields);
        body = projection.value;
        if (projection.missing.length) extra.missing = projection.missing;
      } else {
        extra.missing = fields;
      }
    }
    if (maxItems !== undefined && structured) {
      const capped = capArrays(body, maxItems);
      body = capped.value;
      if (Object.keys(capped.cut).length) extra.arrays = capped.cut;
    }

    const assemble = (value: unknown, more: Record<string, unknown> = {}) => ({ ...omitEmpty({ ...result, ...extra, ...more, body: undefined }), body: value });
    let shaped = assemble(body);
    if (maxItems === undefined && structured && compactJson(shaped).length > this.config.maxResponseChars) {
      for (const cap of AUTO_CAPS) {
        const capped = capArrays(body, cap);
        if (Object.keys(capped.cut).length === 0) break;
        shaped = assemble(capped.value, { arrays: capped.cut, autoCapped: `arrays cut to ${cap} items to fit the response — narrow with fields, max_items or query parameters` });
        if (compactJson(shaped).length <= this.config.maxResponseChars) break;
      }
    }
    return shaped;
  }

  /**
   * Registers every tool; api_request and recipe only when configured.
   */
  private registerTools(): void {
    this.server.registerTool(
      'api_spec_info',
      {
        title: 'Spec info',
        description: 'Spec version and age, counts, groups, security schemes and their credentials, recent changes.',
        inputSchema: schemas.specInfoInput,
        annotations: READ_ONLY,
      },
      ({ refresh }) =>
        this.run(async () => {
          const state = refresh ? await this.store.forceRevalidate() : await this.store.load();
          // This report lists the changes itself; the one-time notice is spent here.
          this.store.takeNotice();
          const counts = new Map<string, number>();
          for (const op of state.index.operations) counts.set(op.group, (counts.get(op.group) ?? 0) + 1);
          const groups = [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([group, n]) => `${group} ${n}`)
            .join(', ');
          return {
            title: state.index.title,
            version: state.meta.version,
            source: this.config.specSource,
            fetchedAt: new Date(state.meta.fetchedAt).toISOString(),
            baseUrl: this.config.baseUrl ?? state.index.servers[0] ?? null,
            counts: state.index.counts,
            groups,
            securitySchemes: this.schemeStatus(state.index.securitySchemes),
            writes: this.config.allowWrite ? 'enabled' : 'disabled (set OPENAPI_ALLOW_WRITE to register api_request)',
            ...(state.meta.changed ? { changed: state.meta.changed } : {}),
            ...(state.offline ? { offline: { since: new Date(state.offline.since).toISOString(), reason: state.offline.reason } } : {}),
          };
        })
    );

    this.server.registerTool(
      'api_search',
      {
        title: 'Find endpoints',
        description: 'Ranked search over paths, operationIds, summaries, descriptions, parameters and body fields. One line per endpoint, or per schema with scope "schemas".',
        inputSchema: schemas.searchInput,
        annotations: READ_ONLY,
      },
      ({ query, scope, method, group, include_admin, has_body, limit }) =>
        this.run(async () => {
          const state = await this.store.load();
          const search = SearchIndex.of(state.index);
          const text = (query ?? '').trim();
          const note = this.specText(state);

          if (scope === 'schemas') {
            const names = text ? search.schemas(text).map((hit) => ({ name: hit.name, fields: hit.fields })) : Object.keys(state.index.schemas).sort().map((name) => ({ name, fields: [] as string[] }));
            if (names.length === 0) return this.nothingFound(text, search, [], note, scope);
            const lines = names.slice(0, limit).map(({ name, fields }) => {
              const schema = state.index.schemas[name] ?? {};
              return schemaLine(name, typeof schema.description === 'string' ? schema.description : '', Object.keys(schema.properties ?? {}).length, state.index.schemaUsedBy.get(name) ?? [], fields);
            });
            return [`${lines.length} of ${names.length} schemas`, ...lines, note].filter(Boolean).join('\n');
          }

          const keep = (op: Operation) =>
            (!method || op.method === method) &&
            (!group || op.group === group || op.path.startsWith(`/${group}`)) &&
            (include_admin || !op.admin) &&
            (has_body === undefined || Boolean(op.request) === has_body);

          let hits: EndpointHit[];
          if (!text) {
            hits = state.index.operations
              .filter(keep)
              .sort((a, b) => Number(a.admin) - Number(b.admin) || a.path.localeCompare(b.path))
              .map((op) => ({ op, score: 0, fields: [] }));
          } else {
            hits = search.endpoints(text, keep);
            // An exact key, path or operationId goes first whatever the ranking says.
            const exact = exactOperation(state.index, text);
            if (exact && keep(exact)) hits = [{ op: exact, score: Number.POSITIVE_INFINITY, fields: [] }, ...hits.filter((hit) => hit.op !== exact)];
          }

          const filters = Object.entries({ method, group, include_admin: include_admin ? undefined : false, has_body })
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => `${name}=${value}`);
          if (hits.length === 0) return this.nothingFound(text, search, filters, note, scope);
          const shown = hits.slice(0, limit);
          const lines = shown.map((hit) => endpointLine(hit.op, hit.fields));
          return [listHeader(shown.length, hits.length, hits.map((hit) => hit.op.group)), ...lines, note].filter(Boolean).join('\n');
        }, 'a smaller limit or more specific words')
    );

    this.server.registerTool(
      'api_endpoint',
      {
        title: 'Describe an endpoint',
        description: 'One endpoint: description, danger, auth, URL, typed parameters, request and response shapes, errors.',
        inputSchema: schemas.endpointInput,
        annotations: READ_ONLY,
      },
      ({ endpoint, depth, mode }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          const spec: SchemaSpec = { components: { schemas: state.index.schemas } };
          const render = (schema: SchemaNode) => {
            if (mode === 'json') return compactJson(resolveJson(spec, schema, depth));
            const outline = renderOutline(spec, schema, { depth });
            return outline.truncated ? `${outline.text}\n// partly cut — increase depth or open the named schema with api_schema` : outline.text;
          };
          const base = this.baseUrlOrNull(state);
          return renderEndpoint({ op, url: base ? `${base}${op.path}` : undefined, render, note: this.specText(state) });
        }, 'a smaller depth, or api_schema for one part')
    );

    this.server.registerTool(
      'api_schema',
      {
        title: 'Describe a schema',
        description: 'A component schema by exact name, with the endpoints that use it.',
        inputSchema: schemas.schemaInput,
        annotations: READ_ONLY,
      },
      ({ name, path: drill, depth, mode }) =>
        this.run(async () => {
          const state = await this.store.load();
          if (!state.index.schemas[name]) {
            const bySubstring = Object.keys(state.index.schemas).filter((n) => n.toLowerCase().includes(name.toLowerCase()));
            const near = [...new Set([...bySubstring, ...SearchIndex.of(state.index).schemas(name).map((hit) => hit.name)])].slice(0, 8);
            throw new Error(`no schema "${name}"${near.length ? `; similar: ${near.join(', ')}` : ''}. api_search with scope "schemas" finds schemas by a field name`);
          }
          const spec: SchemaSpec = { components: { schemas: state.index.schemas } };
          let base: SchemaNode = { $ref: `#/components/schemas/${name}` };
          if (drill) {
            let node = resolveJson(spec, base, 12) as SchemaNode | undefined;
            for (const segment of drill.split('.')) {
              node = node?.properties?.[segment] ?? node?.items?.properties?.[segment] ?? node?.[segment];
              if (!node) throw new Error(`path ${drill}: segment "${segment}" not found`);
            }
            base = node as SchemaNode;
          }
          const shown = drill ? base : state.index.schemas[name];
          const body = mode === 'json' ? compactJson(resolveJson(spec, base, depth)) : renderOutline(spec, base, { depth }).text;
          const description = typeof shown?.description === 'string' ? shown.description : '';
          return renderSchema(drill ? `${name}.${drill}` : name, state.index.schemaUsedBy.get(name) ?? [], description, body, this.specText(state));
        }, 'a smaller depth or a path inside the schema')
    );

    this.server.registerTool(
      'api_types',
      {
        title: 'TypeScript types of an endpoint',
        description: 'Ready-to-paste TypeScript types of an endpoint: parameters, request, response and the types they reference.',
        inputSchema: schemas.typesInput,
        annotations: READ_ONLY,
      },
      ({ endpoint, include, name_prefix, docs }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          const typeMap = await getTypeMap(state.specPath, path.join(this.config.cacheDir, 'types'), `${state.meta.etag ?? ''}:${state.meta.fetchedAt}`);
          const opName = operationTypeName(name_prefix, op);
          const blocks: string[] = [];
          const names: string[] = [];
          const emitted = new Set<string>();

          // A component comes with every component it references, so the block compiles on its own.
          const emitComponent = (node: SchemaNode | null | undefined, kind: 'request' | 'response'): string => {
            const ref = componentRef(node);
            if (!ref) return `// ${kind}: an unnamed schema — see its shape with api_endpoint`;
            if (!typeMap.has(ref.name)) return `// ${kind}: type ${ref.name} is missing from the generated set`;
            const parts: string[] = [];
            for (const name of [ref.name, ...state.index.graph.closure(ref.name)]) {
              const declaration = typeMap.get(name);
              if (!declaration || emitted.has(name)) continue;
              emitted.add(name);
              names.push(`${name_prefix}${name}`);
              parts.push(formatDeclaration(declaration, docs));
            }
            if (ref.array) {
              const alias = `${opName}${kind === 'request' ? 'Body' : 'Response'}`;
              names.push(alias);
              parts.push(`export type ${alias} = ${ref.name}[];`);
            }
            return parts.join('\n\n');
          };

          if (include.includes('params')) {
            const params = renderParams(op, `${opName}Params`);
            if (params) {
              blocks.push(docs ? params : stripDocs(params));
              names.push(`${opName}Params`);
            }
          }
          if (include.includes('request') && op.request) blocks.push(emitComponent(op.request, 'request'));
          if (include.includes('response') && op.response) blocks.push(emitComponent(op.response, 'response'));

          if (blocks.length === 0) return `${op.key} has no request body, response schema or parameters`;
          const code = renameIdentifiers(blocks.filter(Boolean).join('\n\n'), emitted, name_prefix);
          const note = this.specText(state);
          return [`// ${op.key}${names.length ? ` — ${names.join(', ')}` : ''}`, code, note ? `// ${note}` : ''].filter(Boolean).join('\n\n');
        }, 'include only request, response or params')
    );

    this.server.registerTool(
      'api_get',
      {
        title: 'Call a GET endpoint',
        description: 'Calls a GET endpoint.',
        inputSchema: schemas.getInput,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ endpoint, path_params, query, as, credentials, fields, max_items }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          if (op.method !== 'GET') throw new Error(`${op.key} is not a GET endpoint${this.config.allowWrite ? '; use api_request' : ''}`);
          const response = await this.performCall(state, op, { method: 'GET', pathParams: path_params, query, as, credentials });
          return this.shapeResult({ key: op.key, ...this.specNote(state), ...response }, fields, max_items);
        }, CALL_HINT)
    );

    if (this.config.allowWrite) {
      this.server.registerTool(
        'api_request',
        {
          title: 'Call an endpoint with any method',
          description: 'Calls an endpoint with any method; recorded in api_call_log. Destructive endpoints need confirm_danger: true.',
          inputSchema: schemas.requestInput,
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        ({ method, endpoint, path_params, query, body, as, credentials, reason, confirm_danger, fields, max_items }) =>
          this.run(async () => {
            const state = await this.store.load();
            const op = resolveEndpoint(state.index, endpoint);
            if (method !== op.method) throw new Error(`method ${method} does not match the endpoint ${op.key}`);
            if (op.danger === 'destructive' && !confirm_danger) {
              throw new Error(`${op.key} is destructive: ${op.dangerReason}. Repeat with confirm_danger: true if this is intended.`);
            }

            const response = await this.performCall(state, op, { method, pathParams: path_params, query, body, as, credentials });
            const responseBody = response.body as { id?: unknown } | null;
            appendJsonl(this.config.callLog, {
              ts: new Date().toISOString(),
              key: op.key,
              reason,
              auth: response.auth,
              confirmDanger: confirm_danger || undefined,
              status: response.status,
              durationMs: response.durationMs,
              pathParams: path_params,
              responseIds: responseBody && typeof responseBody === 'object' && responseBody.id !== undefined ? [responseBody.id] : undefined,
            });
            return this.shapeResult({ key: op.key, journaled: true, ...this.specNote(state), ...response }, fields, max_items);
          }, CALL_HINT)
      );
    }

    this.server.registerTool(
      'api_credentials',
      {
        title: 'Session credentials',
        description: 'Keeps credentials for this server session or forgets them; shows where each security scheme gets its credential, never the value.',
        inputSchema: schemas.credentialsInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ set, clear }) =>
        this.run(async () => {
          const state = await this.store.load();
          const schemes = state.index.securitySchemes;
          // Resolve first, so a bad key in `set` fails before anything is forgotten.
          const supplied = resolveSupplied(set, schemes);
          const forgotten = clear.length ? this.credentials.forget(clear, schemes) : [];
          this.credentials.remember(supplied);
          const sessionHeaders = this.credentials.sessionHeaders();
          return {
            ...(forgotten.length ? { forgotten } : {}),
            baseUrl: this.baseUrlOrNull(state),
            securitySchemes: this.schemeStatus(schemes),
            ...(sessionHeaders.length ? { sessionHeaders } : {}),
          };
        })
    );

    this.server.registerTool(
      'api_call_log',
      {
        title: 'Call journal',
        description: 'What api_request called, with ids from responses, for cleaning up.',
        inputSchema: schemas.callLogInput,
        annotations: READ_ONLY,
      },
      ({ limit }) =>
        this.run(async () => {
          const entries = tailJsonl(this.config.callLog, limit);
          return entries.length ? { file: this.config.callLog, entries } : { entries: [], note: 'the journal is empty' };
        }, 'a smaller limit')
    );

    const recipesDir = this.config.recipesDir;
    if (recipesDir) {
      this.server.registerTool(
        'recipe',
        {
          title: 'Recipes',
          description: 'Worked scenarios for this API; without a name, lists them.',
          inputSchema: schemas.recipeInput,
          annotations: READ_ONLY,
        },
        ({ name }) =>
          this.run(async () => {
            const recipes = listRecipes(recipesDir);
            if (!name) return { recipes: recipes.map(({ name: id, description }) => ({ name: id, description })) };
            const found = recipes.find((r) => r.name === name);
            if (!found) throw new Error(`no recipe "${name}"; available: ${recipes.map((r) => r.name).join(', ') || 'none'}`);
            return found.text;
          })
      );
    }
  }
}
