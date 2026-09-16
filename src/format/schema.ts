/**
 * Text description of a component schema.
 */
import type { SchemaUse } from '../spec-index.js';
import { trimWords } from './text.js';

const USE_LIMIT = 10;

/**
 * Keys with a count of the ones left out.
 */
function keyList(keys: string[]): string {
  return `${keys.slice(0, USE_LIMIT).join(', ')}${keys.length > USE_LIMIT ? ` +${keys.length - USE_LIMIT}` : ''}`;
}

/**
 * Where a schema is used: endpoints that reference it, and endpoints that reach it through other schemas.
 */
export function usageLine(uses: SchemaUse[]): string {
  const direct = uses.filter((use) => use.direct).map((use) => use.key);
  const through = uses.filter((use) => !use.direct).map((use) => use.key);
  if (!direct.length && !through.length) return 'not used by any endpoint';
  return [direct.length ? `used by ${direct.length}: ${keyList(direct)}` : '', through.length ? `through other schemas: ${keyList(through)}` : ''].filter(Boolean).join(' · ');
}

/**
 * Renders a schema, or a part of it, as text.
 */
export function renderSchema(title: string, uses: SchemaUse[], description: string, body: string, note: string): string {
  const head = [`${title} · ${usageLine(uses)}`];
  if (description.trim()) head.push(trimWords(description.trim(), 400));
  return [head.join('\n'), body, note].filter(Boolean).join('\n\n');
}
