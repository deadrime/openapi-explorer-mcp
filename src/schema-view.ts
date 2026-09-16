/**
 * Compact rendering of OpenAPI schemas. A single schema can be hundreds of kilobytes, so the outline folds it into
 * a short pseudo-type with a depth limit and a field budget, and says how to dig deeper where it cuts.
 */
import { oneLine, trimWords } from './format/text.js';
import type { SchemaNode } from './spec-index.js';

/** The part of a spec schema rendering needs. */
export type SchemaSpec = { components: { schemas: Record<string, SchemaNode> } };

/**
 * Result of rendering an outline.
 */
export interface Outline {
  /** Rendered pseudo-type. */
  text: string;
  /** Whether depth or budget cut something. */
  truncated: boolean;
  /** Number of rendered fields. */
  fields: number;
}

interface WalkState {
  count: number;
  budget: number;
  truncated: boolean;
}

interface WalkContext {
  depth: number;
  indent: number;
  /** References being expanded on the way to this node; meeting one again is a cycle. */
  seen: Set<string>;
  state: WalkState;
}

/**
 * A resolved node: the schema, the name of the last reference, and every reference followed to reach it.
 */
interface Resolved {
  schema: SchemaNode | undefined;
  name: string | null;
  refs: string[];
}

const ENUM_LIMIT = 20;
const DESCRIPTION_LIMIT = 160;
const PATTERN_LIMIT = 80;

/**
 * Follows a JSON pointer like #/components/schemas/X.
 */
function pointerWalk(spec: SchemaSpec, ref: string): SchemaNode | undefined {
  const parts = ref
    .replace(/^#\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = spec;
  for (const part of parts) {
    node = node?.[part];
    if (node === undefined) return undefined;
  }
  return node as SchemaNode;
}

/**
 * Resolves a chain of $refs; a reference already being expanded resolves to a cycle marker.
 */
function resolveRef(spec: SchemaSpec, node: SchemaNode | undefined, seen: Set<string>): Resolved {
  let name: string | null = null;
  let current = node;
  const refs: string[] = [];
  while (current && typeof current.$ref === 'string' && refs.length < 20) {
    const ref: string = current.$ref;
    name = ref.split('/').pop() ?? null;
    if (seen.has(ref) || refs.includes(ref)) return { schema: { __cycle: name }, name, refs };
    refs.push(ref);
    current = pointerWalk(spec, ref) ?? { __unresolved: ref };
  }
  return { schema: current, name, refs };
}

/**
 * The references seen so far plus the ones just followed.
 */
function extend(seen: Set<string>, refs: string[]): Set<string> {
  return refs.length ? new Set([...seen, ...refs]) : seen;
}

/**
 * Whether a schema allows null.
 */
function isNullable(schema: SchemaNode): boolean {
  return schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
}

/**
 * The primary type of a schema, ignoring null in type arrays.
 */
function primaryType(schema: SchemaNode): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
}

/**
 * Whether a schema has no nested structure: no properties, items, map values or composition.
 */
function isLeaf(schema: SchemaNode): boolean {
  const record = schema.additionalProperties && typeof schema.additionalProperties === 'object';
  return !schema.properties && !schema.items && !record && !schema.oneOf && !schema.anyOf && !schema.allOf;
}

/**
 * A short name for a well-known pattern: uuid, integer, decimal, date or date-time.
 */
function knownPattern(pattern: string): string | null {
  if (/\{8\}-.*\{4\}-.*\{12\}/.test(pattern)) return 'uuid';
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/^\((?:\?:)?(.*)\)$/, '$1');
  if (/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(body) || /\[0-9\]\{4\}-/.test(body)) return /T/.test(body) ? 'date-time' : 'date';
  const digit = String.raw`(?:\\d|\[0-9\])`;
  const integer = new RegExp(String.raw`^(?:-\??)?(?:${digit}[+*]|\[1-9\]${digit}\*\|0)$`);
  if (integer.test(body)) return 'integer';
  if (new RegExp(String.raw`^-?\??${digit}[+*].*\\\.`).test(body)) return 'decimal';
  return null;
}

/**
 * A one-line label for scalar, enum and plain types; null when the type needs a block.
 */
export function scalarLabel(schema: SchemaNode): string | null {
  const type = primaryType(schema);
  if (Array.isArray(schema.enum)) {
    const values = (schema.enum as unknown[]).filter((v) => v !== null).map((v) => (typeof v === 'string' ? `'${v}'` : String(v)));
    const shown = values.length <= ENUM_LIMIT ? values : [...values.slice(0, ENUM_LIMIT), `… +${values.length - ENUM_LIMIT}`];
    return shown.join(' | ');
  }
  // A record comes as an object without properties; its value type is expanded as a block rather than lost.
  const record = schema.additionalProperties && typeof schema.additionalProperties === 'object';
  if (type === 'object' && (schema.properties || record)) return null;
  return `${type ?? 'unknown'}${typeNote(schema)}`;
}

/**
 * The format, or a readable stand-in for the pattern: " (uuid)", " (pattern ^[a-z]+$)" or "".
 */
function typeNote(schema: SchemaNode): string {
  // Some generators repeat the type as the format, e.g. string (string); that says nothing.
  if (typeof schema.format === 'string' && schema.format && schema.format !== primaryType(schema)) return ` (${schema.format})`;
  if (typeof schema.pattern !== 'string' || !schema.pattern) return '';
  const known = knownPattern(schema.pattern);
  if (known) return ` (${known})`;
  return schema.pattern.length <= PATTERN_LIMIT ? ` (pattern ${schema.pattern})` : ` (pattern of ${schema.pattern.length} chars → mode json)`;
}

/**
 * A description shortened for an inline comment.
 */
export function shortDescription(description: unknown, limit = DESCRIPTION_LIMIT): string {
  return typeof description === 'string' && description.trim() ? trimWords(oneLine(description), limit) : '';
}

/**
 * Renders a schema node recursively, counting fields and marking cuts.
 */
function walk(spec: SchemaSpec, rawNode: SchemaNode | undefined, ctx: WalkContext): string {
  const { schema, name, refs } = resolveRef(spec, rawNode, ctx.seen);
  if (!schema || typeof schema !== 'object') return String(schema);
  if (schema.__cycle) return `${schema.__cycle} (cycle → api_schema('${schema.__cycle}'))`;
  if (schema.__unresolved) return `${schema.__unresolved} (not found)`;
  const inner: WalkContext = { ...ctx, seen: extend(ctx.seen, refs) };

  const suffix = isNullable(schema) ? ' | null' : '';

  const branches: SchemaNode[] | undefined = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const rendered = branches.map((b) => walk(spec, b, { ...inner, depth: ctx.depth - 1 }));
    return [...new Set(rendered)].join(' | ') + suffix;
  }
  if (schema.allOf) {
    const parts = (schema.allOf as SchemaNode[]).map((b) => resolveRef(spec, b, inner.seen));
    const merged = parts
      .map((part) => part.schema ?? {})
      .reduce<SchemaNode>(
        (acc, s) => ({ ...acc, ...s, properties: { ...acc.properties, ...s.properties }, required: [...(acc.required ?? []), ...(s.required ?? [])] }),
        { ...schema, allOf: undefined }
      );
    return walk(spec, merged, { ...inner, seen: extend(inner.seen, parts.flatMap((part) => part.refs)) });
  }

  if (primaryType(schema) === 'array') {
    const items = walk(spec, schema.items ?? {}, inner);
    return (items.includes('\n') ? `Array<${items}>` : `${items}[]`) + suffix;
  }

  const label = scalarLabel(schema);
  if (label !== null) return label + suffix;

  if (ctx.depth <= 0) {
    const fields = Object.keys(schema.properties ?? {}).length;
    ctx.state.truncated = true;
    const hint = name ? ` → api_schema('${name}')` : ' → increase depth';
    return `{ … ${fields ? `${fields} fields` : '[key: string]'}${hint} }${suffix}`;
  }

  const required = new Set<string>(schema.required ?? []);
  const lines: string[] = [];
  const pad = '  '.repeat(ctx.indent + 1);
  const child: WalkContext = { ...inner, depth: ctx.depth - 1, indent: ctx.indent + 1 };
  for (const [key, propRaw] of Object.entries<SchemaNode>(schema.properties ?? {})) {
    if (ctx.state.count >= ctx.state.budget) {
      lines.push(`${pad}… cut (budget of ${ctx.state.budget} fields) — increase depth or narrow the path`);
      ctx.state.truncated = true;
      break;
    }
    ctx.state.count += 1;
    const rendered = walk(spec, propRaw, child);
    const note = shortDescription(resolveRef(spec, propRaw, inner.seen).schema?.description);
    lines.push(`${pad}${key}${required.has(key) ? '' : '?'}: ${rendered}${note ? `  // ${note}` : ''}`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    lines.push(`${pad}[key: string]: ${walk(spec, schema.additionalProperties, child)}`);
  }
  return `{\n${lines.join('\n')}\n${'  '.repeat(ctx.indent)}}${suffix}`;
}

/**
 * Renders a compact pseudo-type of a schema with a depth limit and a field budget.
 */
export function renderOutline(spec: SchemaSpec, schema: SchemaNode, { depth = 3, budget = 400 }: { depth?: number; budget?: number } = {}): Outline {
  const state: WalkState = { count: 0, budget, truncated: false };
  const text = walk(spec, schema, { depth, indent: 0, seen: new Set(), state });
  return { text, truncated: state.truncated, fields: state.count };
}

/**
 * Returns the schema as JSON with $refs substituted, cut at a depth. Scalars at the cut stay whole; objects and
 * arrays become a note that says how to see them.
 */
export function resolveJson(spec: SchemaSpec, node: SchemaNode | undefined, depth = 6, seen: Set<string> = new Set()): unknown {
  const { schema, name, refs } = resolveRef(spec, node, seen);
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.__cycle || schema.__unresolved) {
    return { $ref: schema.__cycle ?? schema.__unresolved, note: schema.__cycle ? 'cycle' : 'not found' };
  }
  if (depth <= 0 && !isLeaf(schema)) {
    const fields = Object.keys(schema.properties ?? {}).length;
    const what = fields ? `${fields} fields` : 'nested schema';
    return { ...(schema.type ? { type: schema.type } : {}), note: `${what} cut${name ? ` → api_schema('${name}')` : ' → increase depth'}` };
  }

  const inner = extend(seen, refs);
  const out: SchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [prop, sub] of Object.entries<SchemaNode>(value)) out.properties[prop] = resolveJson(spec, sub, depth - 1, inner);
    } else if (key === 'items' || (key === 'additionalProperties' && value && typeof value === 'object')) {
      out[key] = resolveJson(spec, value as SchemaNode, depth - 1, inner);
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map((branch: SchemaNode) => resolveJson(spec, branch, depth, inner));
    } else {
      out[key] = value;
    }
  }
  return out;
}
