import { classifyDanger, type Danger, type DangerRules } from './risk.js';

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
  /** Status of the documented success response. */
  responseStatus: string | null;
  /** Success response schema. */
  response: SchemaNode | null;
  /** Lower-cased text for search. */
  searchText: string;
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
  /** Operation keys by the component schemas they mention. */
  schemaUsedBy: Map<string, string[]>;
  /** components.schemas. */
  schemas: Record<string, SchemaNode>;
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
 * Builds the searchable index of a spec.
 */
export function buildIndex(spec: OpenApiSpec, rules: DangerRules): SpecIndex {
  const operations: Operation[] = [];
  const byKey = new Map<string, Operation>();
  const byOperationId = new Map<string, string[]>();
  const schemaUsedBy = new Map<string, string[]>();
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
        tags: op.tags ?? [],
        group: groupOf(path),
        admin: path.startsWith('/admin'),
        danger: verdict.danger,
        dangerReason: verdict.reason,
        security,
        authSchemes: [...new Set(security.flat())],
        params,
        request: op.requestBody?.content?.['application/json']?.schema,
        responseStatus: response?.status ?? null,
        response: response?.schema ?? null,
        searchText: [method, path, op.operationId, op.summary, (op.tags ?? []).join(' '), Object.values(params).flat().map((p) => p.name).join(' ')]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      };

      operations.push(record);
      byKey.set(key, record);
      if (op.operationId) {
        const keys = byOperationId.get(op.operationId) ?? [];
        keys.push(key);
        byOperationId.set(op.operationId, keys);
      }
      for (const name of new Set([...JSON.stringify(op).matchAll(/#\/components\/schemas\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]))) {
        const keys = schemaUsedBy.get(name) ?? [];
        keys.push(key);
        schemaUsedBy.set(name, keys);
      }
    }
  }

  return {
    version: spec.info?.version,
    title: spec.info?.title,
    operations,
    byKey,
    byOperationId,
    schemaUsedBy,
    schemas: spec.components?.schemas ?? {},
    securitySchemes: spec.components?.securitySchemes ?? {},
    servers: ((spec.servers ?? []) as SchemaNode[]).map((s) => s.url).filter((url): url is string => typeof url === 'string'),
    counts: {
      paths: Object.keys(spec.paths ?? {}).length,
      operations: operations.length,
      schemas: Object.keys(spec.components?.schemas ?? {}).length,
    },
  };
}
