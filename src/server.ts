import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type AuthContext, type AuthProvider, Credentials, loadAuthProvider } from './auth.js';
import { type ExplorerConfig, readConfig, schemeEnvName } from './config.js';
import { buildUrl, type CallResult, send } from './http.js';
import { appendJsonl, tailJsonl } from './journal.js';
import { componentRef, operationTypeName, paramSummary, renderParams, resolveEndpoint } from './operations.js';
import { listRecipes } from './recipes.js';
import { type DangerRules, loadDangerRules } from './risk.js';
import { renderOutline, resolveJson, type SchemaSpec } from './schema-view.js';
import * as schemas from './schemas.js';
import type { HttpMethod, Operation, SchemaNode } from './spec-index.js';
import { SpecStore, type SpecState } from './spec-store.js';
import { getTypeMap, renameDeclaration } from './types-gen.js';

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const READ_ONLY = { readOnlyHint: true } as const;
const DANGER_ORDER = { safe: 0, write: 1, destructive: 2 } as const;

const BASE_INSTRUCTIONS = [
  'An index of an OpenAPI spec with tools to inspect and call its endpoints.',
  '',
  'Order: api_search finds an endpoint → api_endpoint shows parameters and shapes → api_types gives TypeScript types → api_get / api_request call it.',
  '',
  '- Refer to endpoints as "METHOD /path"; operationIds are not always unique.',
  '- Summaries can be missing or wrong — check the path, method and response shape.',
  '- Authentication follows the security schemes of the spec. api_spec_info shows which schemes have credentials; `as` picks one explicitly.',
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
  identity?: string;
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
    private readonly provider: AuthProvider | undefined,
    extraInstructions: string
  ) {
    this.store = new SpecStore(config, rules);
    this.credentials = new Credentials(config, provider);
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
      const provider = await loadAuthProvider(config);
      const extra = config.instructionsFile ? readFileSync(config.instructionsFile, 'utf8').trim() : '';
      return new OpenApiExplorerServer(config, rules, provider, extra);
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
   * Serializes a tool result, cutting responses that would flood the context.
   */
  private result(value: unknown): CallToolResult {
    const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
    const limit = this.config.maxResponseChars;
    const capped = text.length <= limit ? text : `${text.slice(0, limit)}\n\n… response truncated (${text.length} characters). Narrow it down: a smaller depth, a specific endpoint, or query parameters.`;
    return { content: [{ type: 'text', text: capped }] };
  }

  /**
   * Runs a handler and turns a thrown error into a tool error instead of a protocol error.
   */
  private async run(handler: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return this.result(await handler());
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
    if (state.meta.changed) note.changed = state.meta.changed;
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
   * Calls an operation: picks credentials, checks the origin, retries once on 401 with fresh provider tokens.
   */
  private async performCall(state: SpecState, op: Operation, args: CallArgs): Promise<CallResult & { auth: string; note?: Record<string, string> }> {
    const base = this.baseUrl(state);
    const origin = new URL(base).origin;
    const context: AuthContext = { identity: args.identity };
    const schemes = state.index.securitySchemes;
    const selection = this.credentials.select(op, args.as, context, schemes);

    const attempt = async (force: boolean) => {
      const url = buildUrl(base, op.path, args.pathParams, args.query);
      const headers: Record<string, string> = { ...this.config.staticHeaders };
      const applied = await this.credentials.apply(selection, schemes, { ...context, force }, headers, url);
      if (url.origin !== origin) throw new Error(`refusing to send the request to ${url.origin}; only ${origin} is allowed`);
      return { result: await send(args.method, url, headers, args.body, this.config.timeoutMs), applied };
    };

    let { result, applied } = await attempt(false);
    if (result.status === 401 && applied.fromProvider) ({ result, applied } = await attempt(true));

    const note: Record<string, string> = {};
    if (selection.mode === 'anonymous' && selection.note) note.auth = selection.note;
    if (result.status === 404) {
      const fresh = await this.store.forceRevalidate().catch(() => null);
      note.specRecheck = fresh?.index.byKey.has(op.key)
        ? 'the path is still in the spec, so the 404 is real — check path parameters'
        : 'the path is gone from the spec — the API has probably changed';
    }

    return {
      auth: selection.mode === 'anonymous' ? 'anonymous' : selection.schemes.join(' + '),
      ...result,
      ...(Object.keys(note).length ? { note } : {}),
    };
  }

  /**
   * Registers every tool; api_request, api_auth and recipe only when configured.
   */
  private registerTools(): void {
    this.server.registerTool(
      'api_spec_info',
      {
        title: 'Spec info',
        description: 'Spec version and age, counts, groups, security schemes with credential status, and changes since the previous version.',
        inputSchema: schemas.specInfoInput,
        annotations: READ_ONLY,
      },
      ({ refresh }) =>
        this.run(async () => {
          const state = refresh ? await this.store.forceRevalidate() : await this.store.load();
          const groups: Record<string, number> = {};
          for (const op of state.index.operations) groups[op.group] = (groups[op.group] ?? 0) + 1;
          return {
            title: state.index.title,
            version: state.meta.version,
            source: this.config.specSource,
            fetchedAt: new Date(state.meta.fetchedAt).toISOString(),
            baseUrl: this.config.baseUrl ?? state.index.servers[0] ?? null,
            counts: state.index.counts,
            groups,
            securitySchemes: Object.entries(state.index.securitySchemes).map(([name, scheme]) => ({
              name,
              type: scheme.type,
              ...(scheme.in ? { in: scheme.in } : {}),
              ...(scheme.name ? { parameter: scheme.name } : {}),
              ...(scheme.scheme ? { scheme: scheme.scheme } : {}),
              credential: this.credentials.describe(name),
              env: schemeEnvName(name),
            })),
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
        description:
          'Searches method, path, operationId, summary, tags and parameter names. One line per endpoint, no schemas. ' +
          'Admin endpoints come last. Summaries can be wrong — check the path and method.',
        inputSchema: schemas.searchInput,
        annotations: READ_ONLY,
      },
      ({ query, method, group, include_admin, has_body, limit }) =>
        this.run(async () => {
          const state = await this.store.load();
          const tokens = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

          let pool = state.index.operations;
          if (method) pool = pool.filter((o) => o.method === method);
          if (group) pool = pool.filter((o) => o.group === group || o.path.startsWith(`/${group}`));
          if (!include_admin) pool = pool.filter((o) => !o.admin);
          if (has_body !== undefined) pool = pool.filter((o) => Boolean(o.request) === has_body);

          const score = (op: Operation) => {
            const p = op.path.toLowerCase();
            const id = (op.operationId ?? '').toLowerCase();
            const summary = op.summary.toLowerCase();
            return tokens.reduce((acc, t) => acc + (p.includes(t) ? 3 : 0) + (id.includes(t) ? 2 : 0) + (summary.includes(t) ? 1 : 0) + (op.searchText.includes(t) ? 1 : 0), 0);
          };

          let matched = tokens.length ? pool.filter((o) => tokens.every((t) => o.searchText.includes(t))) : pool;
          let matchMode: 'all' | 'any' = 'all';
          if (tokens.length && matched.length === 0) {
            matched = pool.filter((o) => tokens.some((t) => o.searchText.includes(t)));
            matchMode = 'any';
          }
          matched = [...matched].sort(
            (a, b) => Number(a.admin) - Number(b.admin) || score(b) - score(a) || DANGER_ORDER[a.danger] - DANGER_ORDER[b.danger] || a.path.localeCompare(b.path)
          );

          const groups: Record<string, number> = {};
          for (const op of matched) groups[op.group] = (groups[op.group] ?? 0) + 1;

          return {
            total: matched.length,
            shown: Math.min(matched.length, limit),
            ...(matchMode === 'any' ? { matched: 'any word (nothing matched all of them)' } : {}),
            groups,
            endpoints: matched.slice(0, limit).map((o) => ({
              key: o.key,
              summary: o.summary || undefined,
              auth: o.authSchemes.length ? o.authSchemes : undefined,
              danger: o.danger === 'safe' ? undefined : o.danger,
              admin: o.admin || undefined,
              params: paramSummary(o.params),
            })),
            ...this.specNote(state),
          };
        })
    );

    this.server.registerTool(
      'api_endpoint',
      {
        title: 'Describe an endpoint',
        description: 'Parameters, request and response shapes (compact, depth-limited), danger level, security alternatives and URL of one endpoint.',
        inputSchema: schemas.endpointInput,
        annotations: READ_ONLY,
      },
      ({ endpoint, depth, mode }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          const spec: SchemaSpec = { components: { schemas: state.index.schemas } };
          const render = (schema: SchemaNode | null | undefined) => {
            if (!schema) return undefined;
            if (mode === 'json') return resolveJson(spec, schema, depth);
            const outline = renderOutline(spec, schema, { depth });
            return outline.truncated ? `${outline.text}\n// partly cut — increase depth` : outline.text;
          };

          let url: string | undefined;
          try {
            url = `${this.baseUrl(state)}${op.path}`;
          } catch {
            url = undefined;
          }

          return {
            key: op.key,
            operationId: op.operationId,
            summary: op.summary || undefined,
            group: op.group,
            admin: op.admin || undefined,
            danger: op.danger,
            dangerReason: op.dangerReason,
            auth: op.security.length ? op.security.map((alternative) => (alternative.length ? alternative.join(' + ') : 'anonymous')) : ['anonymous'],
            url,
            parameters: paramSummary(op.params),
            request: render(op.request),
            response: op.response ? { status: op.responseStatus, schema: render(op.response) } : null,
            ...this.specNote(state),
          };
        })
    );

    this.server.registerTool(
      'api_schema',
      {
        title: 'Describe a schema',
        description: 'A schema from components by name, compact and depth-limited. `path` drills into a nested field; usedBy lists the endpoints that reference it.',
        inputSchema: schemas.schemaInput,
        annotations: READ_ONLY,
      },
      ({ name, path: drill, depth, mode }) =>
        this.run(async () => {
          const state = await this.store.load();
          if (!state.index.schemas[name]) {
            const near = Object.keys(state.index.schemas)
              .filter((n) => n.toLowerCase().includes(name.toLowerCase()))
              .slice(0, 10);
            throw new Error(`no schema "${name}"${near.length ? `; similar: ${near.join(', ')}` : ''}`);
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
          return {
            name,
            path: drill,
            usedBy: state.index.schemaUsedBy.get(name) ?? [],
            schema: mode === 'json' ? resolveJson(spec, base, depth) : renderOutline(spec, base, { depth }).text,
            ...this.specNote(state),
          };
        })
    );

    this.server.registerTool(
      'api_types',
      {
        title: 'TypeScript types of an endpoint',
        description: 'Ready-to-paste TypeScript types for the request, response and parameters of an endpoint, generated from the spec with @hey-api/openapi-ts.',
        inputSchema: schemas.typesInput,
        annotations: READ_ONLY,
      },
      ({ endpoint, include, name_prefix }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          const typeMap = await getTypeMap(state.specPath, path.join(this.config.cacheDir, 'types'), `${state.meta.etag ?? ''}:${state.meta.fetchedAt}`);
          const opName = operationTypeName(name_prefix, op);
          const blocks: string[] = [];
          const names: string[] = [];

          const emitComponent = (node: SchemaNode | null | undefined, kind: string): string => {
            const ref = componentRef(node);
            if (!ref) return `// ${kind}: an unnamed schema — see its shape with api_endpoint`;
            const declaration = typeMap.get(ref.name);
            if (!declaration) return `// ${kind}: type ${ref.name} is missing from the generated set`;
            const finalName = `${name_prefix}${ref.name}`;
            names.push(finalName);
            const renamed = renameDeclaration(declaration, ref.name, finalName);
            return ref.array ? `${renamed}\n\nexport type ${opName}Response = ${finalName}[];` : renamed;
          };

          if (include.includes('params')) {
            const params = renderParams(op, `${opName}Params`);
            if (params) {
              blocks.push(params);
              names.push(`${opName}Params`);
            }
          }
          if (include.includes('request') && op.request) blocks.push(emitComponent(op.request, 'request'));
          if (include.includes('response') && op.response) blocks.push(emitComponent(op.response, 'response'));

          if (blocks.length === 0) return { key: op.key, note: 'the endpoint has no request body, response schema or parameters' };
          return { key: op.key, names, source: '@hey-api/openapi-ts', types: blocks.join('\n\n'), ...this.specNote(state) };
        })
    );

    this.server.registerTool(
      'api_get',
      {
        title: 'Call a GET endpoint',
        description: 'Calls a GET endpoint and returns the response. Read-only: the method is fixed.',
        inputSchema: schemas.getInput,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ endpoint, path_params, query, as, identity }) =>
        this.run(async () => {
          const state = await this.store.load();
          const op = resolveEndpoint(state.index, endpoint);
          if (op.method !== 'GET') throw new Error(`${op.key} is not a GET endpoint${this.config.allowWrite ? '; use api_request' : ''}`);
          const response = await this.performCall(state, op, { method: 'GET', pathParams: path_params, query, as, identity });
          return { key: op.key, ...response, ...this.specNote(state) };
        })
    );

    if (this.config.allowWrite) {
      this.server.registerTool(
        'api_request',
        {
          title: 'Call an endpoint with any method',
          description: 'Calls an endpoint with any method, including writes. Destructive endpoints need confirm_danger: true. Calls are recorded in api_call_log.',
          inputSchema: schemas.requestInput,
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        ({ method, endpoint, path_params, query, body, as, identity, reason, confirm_danger }) =>
          this.run(async () => {
            const state = await this.store.load();
            const op = resolveEndpoint(state.index, endpoint);
            if (method !== op.method) throw new Error(`method ${method} does not match the endpoint ${op.key}`);
            if (op.danger === 'destructive' && !confirm_danger) {
              throw new Error(`${op.key} is destructive: ${op.dangerReason}. Repeat with confirm_danger: true if this is intended.`);
            }

            const response = await this.performCall(state, op, { method, pathParams: path_params, query, body, as, identity });
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
            return { key: op.key, journaled: true, ...response, ...this.specNote(state) };
          })
      );
    }

    const provider = this.provider;
    if (provider?.authenticate) {
      this.server.registerTool(
        'api_auth',
        {
          title: 'Mint tokens',
          description: 'Mints or refreshes tokens through the auth module. show_token returns full tokens instead of previews.',
          inputSchema: schemas.authInput,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        ({ identity, refresh, show_token }) =>
          this.run(async () => {
            const session = await provider.authenticate!({ identity, force: refresh });
            const preview = (token?: string) => (token ? `${token.slice(0, 12)}…(${token.length})` : undefined);
            return {
              identity: session.identity,
              expiresAt: session.expiresAt,
              accessToken: show_token ? session.accessToken : preview(session.accessToken),
              refreshToken: show_token ? session.refreshToken : preview(session.refreshToken),
              ...(show_token ? {} : { note: 'show_token: true returns the full tokens' }),
            };
          })
      );
    }

    this.server.registerTool(
      'api_call_log',
      {
        title: 'Call journal',
        description: 'What api_request has called: endpoint, status and ids from responses — use it to clean up what was created.',
        inputSchema: schemas.callLogInput,
        annotations: READ_ONLY,
      },
      ({ limit }) =>
        this.run(async () => {
          const entries = tailJsonl(this.config.callLog, limit);
          return entries.length ? { file: this.config.callLog, entries } : { entries: [], note: 'the journal is empty' };
        })
    );

    const recipesDir = this.config.recipesDir;
    if (recipesDir) {
      this.server.registerTool(
        'recipe',
        {
          title: 'Recipes',
          description: 'Worked scenarios for this API. Without a name, lists the recipes.',
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
