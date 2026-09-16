/**
 * Text rendering of search results: one line per endpoint or schema.
 */
import type { Operation, SchemaUse } from '../spec-index.js';
import { oneLine, trimWords } from './text.js';

const SUMMARY_LIMIT = 140;
const PARAM_LIMIT = 6;

/**
 * Auth alternatives of an endpoint: "x-api-key|bearer", "bearer|none"; empty when it declares no security.
 */
export function authLabel(op: Operation, separator = '|'): string {
  return [...new Set(op.security.map((alternative) => (alternative.length ? alternative.join('+') : 'none')))].join(separator);
}

/**
 * Parameter names by location, optional ones marked with ?, at most six names in total.
 */
function paramsLabel(op: Operation): string {
  let budget = PARAM_LIMIT;
  const parts: string[] = [];
  let hidden = 0;
  for (const [where, list] of Object.entries(op.params)) {
    if (list.length === 0) continue;
    const shown = list.slice(0, Math.max(0, budget));
    budget -= shown.length;
    hidden += list.length - shown.length;
    if (shown.length) parts.push(`${where}: ${shown.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')}`);
  }
  if (hidden) parts.push(`+${hidden}`);
  return parts.join('; ');
}

/**
 * One line describing an endpoint.
 */
export function endpointLine(op: Operation, fields: string[] = []): string {
  const flags = [authLabel(op), op.danger === 'destructive' ? 'destructive' : '', op.request ? 'body' : '', op.deprecated ? 'deprecated' : ''].filter(Boolean).join(' ');
  const params = paramsLabel(op);
  const summary = op.summary ? ` — ${trimWords(oneLine(op.summary), SUMMARY_LIMIT)}` : '';
  return `${op.key}${summary}${flags ? ` [${flags}]` : ''}${params ? ` (${params})` : ''}${fields.length ? ` · field ${fields.join(', ')}` : ''}`;
}

/**
 * Header of a result list: how many are shown and the groups they fall into.
 */
export function listHeader(shown: number, total: number, groups: string[]): string {
  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const label =
    top.length === 1 ? top[0][0] : top.length > 1 ? `${top.slice(0, 3).map(([group, n]) => `${group} ${n}`).join(', ')}${top.length > 3 ? `, +${top.length - 3} groups` : ''}` : '';
  return `${shown} of ${total}${label ? ` · ${label}` : ''}`;
}

/**
 * One line describing a component schema found by search.
 */
export function schemaLine(name: string, description: string, fieldCount: number, uses: SchemaUse[], fields: string[]): string {
  const about = description ? ` — ${trimWords(oneLine(description), 80)}` : '';
  const keys = uses.map((use) => use.key);
  const usedBy = keys.length ? ` · used by ${keys.length}: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3}` : ''}` : ' · not used by any endpoint';
  return `${name}${about} · ${fieldCount} field${fieldCount === 1 ? '' : 's'}${usedBy}${fields.length ? ` · field ${fields.join(', ')}` : ''}`;
}
