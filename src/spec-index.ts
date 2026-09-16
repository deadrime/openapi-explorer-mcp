import { classifyDanger, type Danger, type DangerRules } from './risk.js';
import { buildSchemaGraph, componentRefs, type SchemaGraph } from './schema-graph.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
// Specs are arbitrary JSON; schema nodes are walked structurally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemaNode = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenApiSpec = Record<string, any>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const NAMESPACE_SEGMENT = /^(admin|internal|api|v\d+)$/i;

/**
 * An operation parameter.
 */
export interface Parameter {
  /** Parameter name. */
  name: string;
  /** Location: path, query, header or cookie. */
  in: string;
  /** Whether the parameter is required. */
  required?: boolean;
  /** Human description from the spec. */
  description?: string;
  /** Parameter schema. */
  schema?: SchemaNode;
}

/**
 * A security scheme from components.securitySchemes.
 */
export interface SecurityScheme {
  /** apiKey, http, oauth2 or openIdConnect. */
  type: string;
  /** For apiKey: header, query or cookie. */
  in?: string;
  /** For apiKey: the header, query or cookie name. */
  name?: string;
  /** For http: bearer or basic. */
  scheme?: string;
}

/**
 * A documented error response.
 */
export interface ErrorResponse {
  /** Status code or range, e.g. 404 or 4XX. */
  status: string;
  /** Description from the spec. */
  description: string;
  /** Component schema of the error body, when it has one. */
  schemaName?: string;
}

/**
 * An endpoint that references a component schema.
 */
export interface SchemaUse {
  /** "METHOD /path". */
  key: string;
  /** Whether the operation references the schema itself rather than through another component. */
  direct: boolean;
}

/**
 * An indexed operation.
 */
export interface Operation {
  /** "METHOD /path". */
  key: string;
  /** HTTP method. */
  method: HttpMethod;
  /** Path template. */
  path: string;
  /** operationId, not necessarily unique. */
  operationId?: string;
  /** Summary, possibly empty. */
  summary: string;
  /** Description, possibly empty. */
  description: string;
  /** Whether the spec marks the operation deprecated. */
  deprecated: boolean;
  /** Tags. */
  tags: string[];
  /** Group for browsing. */
  group: string;
  /** Whether the path is under /admin. */
  admin: boolean;
  /** Danger level. */
  danger: Danger;
  /** Why the operation is destructive. */
  dangerReason?: string;
  /** Security alternatives: each lists schemes that must all be satisfied; an empty one means anonymous. */
  security: string[][];
  /** Every scheme mentioned in the alternatives. */
  authSchemes: string[];
  /** Parameters by location. */
  params: Record<'path' | 'query' | 'header' | 'cookie', Parameter[]>;
  /** JSON request body schema. */
  request?: SchemaNode;
  /** Whether the request body is required. */
  requestRequired: boolean;
  /** Status of the documented success response. */
  responseStatus: string | null;
  /** Success response schema. */
  response: SchemaNode | null;
  /** Documented 4xx and 5xx responses. */
  errors: ErrorResponse[];
}

/**
 * Searchable index of a spec.
 */
export interface SpecIndex {
  /** info.version. */
  version?: string;
  /** info.title. */
  title?: string;
  /** All operations. */
  operations: Operation[];
  /** Operations by "METHOD /path". */
  byKey: Map<string, Operation>;
  /** Operation keys by operationId. */
  byOperationId: Map<string, string[]>;
  /** Endpoints by the component schemas they reference, direct uses first. */
  schemaUsedBy: Map<string, SchemaUse[]>;
  /** components.schemas. */
  schemas: Record<string, SchemaNode>;
  /** References between component schemas. */
  graph: SchemaGraph;
  /** components.securitySchemes. */
  securitySchemes: Record<string, SecurityScheme>;
  /** servers[].url. */
  servers: string[];
  /** Counts for spec info. */
  counts: { paths: number; operations: number; schemas: number };
}

/**
 * Browsing group: the first path segment, or the first two when the first is a namespace like admin or v1.
 */
function groupOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return '(root)';
  return NAMESPACE_SEGMENT.test(parts[0]) && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Documented success response: 200, then 201, then any 2xx, then default.
 */
function successResponse(responses: SchemaNode = {}): { status: string; schema: SchemaNode } | null {
  const statuses = ['200', '201', ...Object.keys(responses).filter((s) => /^2\d\d$/.test(s) && s !== '200' && s !== '201'), 'default'];
  for (const status of statuses) {
    const schema = responses[status]?.content?.['application/json']?.schema;
    if (schema) return { status, schema };
  }
  return null;
}

/**
 * Documented 4xx and 5xx responses with their descriptions and body schema names.
 */
function errorResponses(responses: SchemaNode = {}): ErrorResponse[] {
  return Object.entries<SchemaNode>(responses)
    .filter(([status]) => /^[45](\d\d|XX)$/i.test(status))
    .map(([status, response]) => {
      const ref = response?.content?.['application/json']?.schema?.$ref;
      return {
        status: status.toUpperCase(),
        description: typeof response?.description === 'string' ? response.description : '',
        ...(typeof ref === 'string' ? { schemaName: ref.split('/').pop() } : {}),
      };
    });
}

/**
 * Builds the searchable index of a spec.
 */
export function buildIndex(spec: OpenApiSpec, rules: DangerRules): SpecIndex {
  const operations: Operation[] = [];
  const byKey = new Map<string, Operation>();
  const byOperationId = new Map<string, string[]>();
  const schemas: Record<string, SchemaNode> = spec.components?.schemas ?? {};
  const graph = buildSchemaGraph(schemas);
  const direct = new Map<string, string[]>();
  const transitive = new Map<string, string[]>();
  const globalSecurity: SchemaNode[] | undefined = spec.security;

  for (const [path, item] of Object.entries<SchemaNode>(spec.paths ?? {})) {
    for (const lower of METHODS) {
      const op: SchemaNode | undefined = item[lower];
      if (!op) continue;

      const method = lower.toUpperCase() as HttpMethod;
      const key = `${method} ${path}`;
      const params: Operation['params'] = { path: [], query: [], header: [], cookie: [] };
      for (const param of [...(item.parameters ?? []), ...(op.parameters ?? [])] as Parameter[]) {
        (params[param.in as keyof Operation['params']] ??= []).push(param);
      }
      // Operation-level security overrides the global one; an empty requirement object means anonymous access.
      const security: string[][] = ((op.security ?? globalSecurity ?? []) as SchemaNode[]).map((requirement) => Object.keys(requirement));
      const response = successResponse(op.responses);
      const verdict = classifyDanger(rules, method, path);

      const record: Operation = {
        key,
        method,
        path,
        operationId: op.operationId,
        summary: op.summary ?? '',
        description: typeof op.description === 'string' ? op.description : '',
        deprecated: op.deprecated === true,
        tags: op.tags ?? [],
        group: groupOf(path),
        admin: path.startsWith('/admin'),
        danger: verdict.danger,
        dangerReason: verdict.reason,
        security,
        authSchemes: [...new Set(security.flat())],
        params,
        request: op.requestBody?.content?.['application/json']?.schema,
        requestRequired: op.requestBody?.required === true,
        responseStatus: response?.status ?? null,
        response: response?.schema ?? null,
        errors: errorResponses(op.responses),
      };

      operations.push(record);
      byKey.set(key, record);
      if (op.operationId) {
        const keys = byOperationId.get(op.operationId) ?? [];
        keys.push(key);
        byOperationId.set(op.operationId, keys);
      }
      // The whole operation, parameters and error bodies included, counts as a use.
      const own = componentRefs(op);
      const reached = new Set<string>();
      for (const name of own) for (const inner of graph.closure(name)) if (!own.has(inner)) reached.add(inner);
      for (const name of own) direct.set(name, [...(direct.get(name) ?? []), key]);
      for (const name of reached) transitive.set(name, [...(transitive.get(name) ?? []), key]);
    }
  }

  const schemaUsedBy = new Map<string, SchemaUse[]>();
  for (const name of new Set([...direct.keys(), ...transitive.keys()])) {
    schemaUsedBy.set(name, [...(direct.get(name) ?? []).map((key) => ({ key, direct: true })), ...(transitive.get(name) ?? []).map((key) => ({ key, direct: false }))]);
  }

  return {
    version: spec.info?.version,
    title: spec.info?.title,
    operations,
    byKey,
    byOperationId,
    schemaUsedBy,
    schemas,
    graph,
    securitySchemes: spec.components?.securitySchemes ?? {},
    servers: ((spec.servers ?? []) as SchemaNode[]).map((s) => s.url).filter((url): url is string => typeof url === 'string'),
    counts: {
      paths: Object.keys(spec.paths ?? {}).length,
      operations: operations.length,
      schemas: Object.keys(spec.components?.schemas ?? {}).length,
    },
  };
}
