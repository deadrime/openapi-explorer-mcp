import { shortDescription } from './schema-view.js';
import type { Operation, Parameter, SchemaNode, SpecIndex } from './spec-index.js';

/**
 * Finds an operation by "METHOD /path", a path with a single operation, or a unique operationId.
 */
export function resolveEndpoint(index: SpecIndex, endpoint: string): Operation {
  const raw = endpoint.trim();
  const exact = index.byKey.get(raw) ?? index.byKey.get(raw.replace(/^(\w+)/, (m) => m.toUpperCase()));
  if (exact) return exact;

  const asPath = raw.startsWith('/') ? raw : `/${raw}`;
  const byPath = index.operations.filter((o) => o.path === asPath);
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) throw new Error(`the path ${asPath} has several methods: ${byPath.map((o) => o.key).join(', ')}. Pass METHOD /path.`);

  const byOperationId = index.byOperationId.get(raw) ?? [];
  if (byOperationId.length === 1) {
    const op = index.byKey.get(byOperationId[0]);
    if (op) return op;
  }
  if (byOperationId.length > 1) throw new Error(`operationId "${raw}" is ambiguous: ${byOperationId.join(', ')}. Pass METHOD /path.`);

  throw new Error(`endpoint not found: "${endpoint}". Search with api_search.`);
}

/**
 * The operation a query names exactly — a key, a path with one operation, or a unique operationId — or null.
 */
export function exactOperation(index: SpecIndex, query: string): Operation | null {
  if (/\s/.test(query.trim()) && !/^[A-Za-z]+ \//.test(query.trim())) return null;
  try {
    return resolveEndpoint(index, query);
  } catch {
    return null;
  }
}

/**
 * Component schema name referenced by a node, directly or as array items.
 */
export function componentRef(node: SchemaNode | null | undefined): { name: string; array: boolean } | null {
  if (typeof node?.$ref === 'string') return { name: node.$ref.split('/').pop() ?? '', array: false };
  if (node?.type === 'array' && typeof node.items?.$ref === 'string') return { name: node.items.$ref.split('/').pop() ?? '', array: true };
  return null;
}

/**
 * PascalCase from snake_case, kebab-case or camelCase.
 */
function pascal(value: string): string {
  return value.replace(/(^\w|[_\-\s]+\w)/g, (m) => m.replace(/[_\-\s]+/, '').toUpperCase());
}

/**
 * Type name base for an operation: its operationId, or the method and path when there is none.
 */
export function operationTypeName(prefix: string, op: Operation): string {
  const base = op.operationId ?? `${op.method.toLowerCase()}_${op.path.replace(/[{}]/g, '').split('/').filter(Boolean).join('_')}`;
  return `${prefix}${pascal(base.replace(/[^A-Za-z0-9_\-\s]/g, '_'))}`;
}

/**
 * TypeScript type of a parameter schema: primitives, enums and arrays.
 */
function paramType(schema: SchemaNode = {}): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ');
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') {
    const item = paramType(schema.items);
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
  }
  return 'string';
}

/**
 * Renders `export type <Name>` from the path and query parameters of an operation.
 */
export function renderParams(op: Operation, name: string): string | null {
  const fields: Parameter[] = [...op.params.path, ...op.params.query];
  if (fields.length === 0) return null;
  const lines = fields.map((p) => {
    const description = shortDescription(p.description);
    const doc = description ? `  /** ${description.replace(/\*\//g, '* /')} */\n` : '';
    return `${doc}  ${p.name}${p.required ? '' : '?'}: ${paramType(p.schema)};`;
  });
  return `export type ${name} = {\n${lines.join('\n')}\n};`;
}
