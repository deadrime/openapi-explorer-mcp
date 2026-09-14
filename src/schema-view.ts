/**
 * Compact rendering of OpenAPI schemas. A single schema can be hundreds of kilobytes, so the outline folds it into
 * a short pseudo-type with a depth limit and a field budget, and says how to dig deeper where it cuts.
 */
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
  seen: Set<string>;
  state: WalkState;
}

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
 * Resolves a chain of $refs, returning the schema and the name of the last reference.
 */
function resolveRef(spec: SchemaSpec, node: SchemaNode | undefined, seen: Set<string>): { schema: SchemaNode | undefined; name: string | null } {
  let name: string | null = null;
  let current = node;
  let guard = 0;
  while (current && typeof current.$ref === 'string' && guard++ < 20) {
    const ref: string = current.$ref;
    name = ref.split('/').pop() ?? null;
    if (seen.has(ref)) return { schema: { __cycle: name }, name };
    current = pointerWalk(spec, ref) ?? { __unresolved: ref };
  }
  return { schema: current, name };
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
 * A one-line label for scalar, enum and plain types; null when the type needs a block.
 */
function scalarLabel(schema: SchemaNode): string | null {
  const type = primaryType(schema);
  if (schema.enum) {
    const values = (schema.enum as unknown[]).filter((v) => v !== null).map((v) => (typeof v === 'string' ? `'${v}'` : String(v)));
    return values.length <= 8 ? values.join(' | ') : `${values.slice(0, 5).join(' | ')} | … (${values.length})`;
  }
  // A record comes as an object without properties; its value type is expanded as a block rather than lost.
  const record = schema.additionalProperties && typeof schema.additionalProperties === 'object';
  if (type === 'object' && (schema.properties || record)) return null;
  const extra = [schema.format, schema.pattern && `pattern ${schema.pattern}`].filter(Boolean).join(', ');
  return `${type ?? 'unknown'}${extra ? ` (${extra})` : ''}`;
}

/**
 * Renders a schema node recursively, counting fields and marking cuts.
 */
function walk(spec: SchemaSpec, rawNode: SchemaNode | undefined, ctx: WalkContext): string {
  const { schema, name } = resolveRef(spec, rawNode, ctx.seen);
  if (!schema || typeof schema !== 'object') return String(schema);
  if (schema.__cycle) return `${schema.__cycle} (cycle)`;
  if (schema.__unresolved) return `${schema.__unresolved} (not found)`;

  const suffix = isNullable(schema) ? ' | null' : '';

  const branches: SchemaNode[] | undefined = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const rendered = branches.map((b) => walk(spec, b, { ...ctx, depth: ctx.depth - 1 }));
    return [...new Set(rendered)].join(' | ') + suffix;
  }
  if (schema.allOf) {
    const merged = (schema.allOf as SchemaNode[])
      .map((b) => resolveRef(spec, b, ctx.seen).schema ?? {})
      .reduce<SchemaNode>(
        (acc, s) => ({ ...acc, ...s, properties: { ...acc.properties, ...s.properties }, required: [...(acc.required ?? []), ...(s.required ?? [])] }),
        {}
      );
    return walk(spec, merged, ctx);
  }

  if (primaryType(schema) === 'array') {
    const inner = walk(spec, schema.items ?? {}, ctx);
    return (inner.includes('\n') ? `Array<${inner}>` : `${inner}[]`) + suffix;
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
  for (const [key, propRaw] of Object.entries<SchemaNode>(schema.properties ?? {})) {
    if (ctx.state.count >= ctx.state.budget) {
      lines.push(`${pad}… cut (budget of ${ctx.state.budget} fields) — increase depth or narrow the path`);
      ctx.state.truncated = true;
      break;
    }
    ctx.state.count += 1;
    const rendered = walk(spec, propRaw, { ...ctx, depth: ctx.depth - 1, indent: ctx.indent + 1 });
    const prop = resolveRef(spec, propRaw, ctx.seen).schema;
    const note = prop?.description ? `  // ${String(prop.description).slice(0, 80)}` : '';
    lines.push(`${pad}${key}${required.has(key) ? '' : '?'}: ${rendered}${note}`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    lines.push(`${pad}[key: string]: ${walk(spec, schema.additionalProperties, { ...ctx, depth: ctx.depth - 1, indent: ctx.indent + 1 })}`);
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
 * Returns the schema as JSON with $refs substituted, cut at a depth.
 */
export function resolveJson(spec: SchemaSpec, node: SchemaNode | undefined, depth = 6, seen: Set<string> = new Set()): unknown {
  const { schema } = resolveRef(spec, node, seen);
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.__cycle || schema.__unresolved) {
    return { $ref: schema.__cycle ?? schema.__unresolved, note: schema.__cycle ? 'cycle' : 'not found' };
  }
  if (depth <= 0) return schema.type ? { type: schema.type } : { note: '… deeper levels cut' };

  const out: SchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [prop, sub] of Object.entries<SchemaNode>(value)) out.properties[prop] = resolveJson(spec, sub, depth - 1, new Set(seen));
    } else if (key === 'items') {
      out.items = resolveJson(spec, value as SchemaNode, depth - 1, new Set(seen));
    } else {
      out[key] = value;
    }
  }
  return out;
}
