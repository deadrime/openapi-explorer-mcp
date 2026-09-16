/**
 * One-line descriptions of operation parameters.
 */
import { scalarLabel, shortDescription } from '../schema-view.js';
import type { Parameter, SchemaNode } from '../spec-index.js';

/**
 * Type of a parameter schema: a scalar label, an enum or an array of them.
 */
function typeLabel(schema: SchemaNode = {}): string {
  if (schema.type === 'array') {
    const item = typeLabel(schema.items);
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
  }
  const label = scalarLabel(schema) ?? 'object';
  return schema.nullable === true ? `${label} | null` : label;
}

/**
 * Constraints worth knowing before a call: default, range, length, deprecation.
 */
function constraints(param: Parameter & { deprecated?: boolean }): string[] {
  const schema = param.schema ?? {};
  const out: string[] = [];
  if (schema.default !== undefined) out.push(`default ${typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default)}`);
  if (schema.minimum !== undefined || schema.maximum !== undefined) out.push(`${schema.minimum ?? ''}..${schema.maximum ?? ''}`);
  if (schema.minLength !== undefined || schema.maxLength !== undefined) out.push(`length ${schema.minLength ?? ''}..${schema.maxLength ?? ''}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) out.push(`items ${schema.minItems ?? ''}..${schema.maxItems ?? ''}`);
  if (param.deprecated === true || schema.deprecated === true) out.push('deprecated');
  return out;
}

/**
 * "name?: integer (default 20, ..100) — Page size".
 */
export function paramLine(param: Parameter): string {
  const extra = constraints(param);
  const description = shortDescription(param.description);
  return `${param.name}${param.required ? '' : '?'}: ${typeLabel(param.schema)}${extra.length ? ` (${extra.join(', ')})` : ''}${description ? ` — ${description}` : ''}`;
}
