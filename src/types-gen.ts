import { readFileSync } from 'node:fs';
import path from 'node:path';

const cache: { key: string | null; map: Map<string, string> | null } = { key: null, map: null };

/**
 * Splits types.gen.ts into declarations by name, keeping the JSDoc right above each one.
 */
export function parseTypes(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export (?:type|interface) (\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let start = match.index;
    const before = source.slice(0, start).trimEnd();
    if (before.endsWith('*/')) start = before.lastIndexOf('/**');
    let depth = 0;
    let i = re.lastIndex;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
      else if (ch === ';' && depth === 0) break;
    }
    map.set(match[1], source.slice(start, i + 1).trim());
  }
  return map;
}

/**
 * Returns generated declarations for a spec, regenerating only when the cache key changes.
 */
export async function getTypeMap(specPath: string, outDir: string, cacheKey: string): Promise<Map<string, string>> {
  if (cache.key === cacheKey && cache.map) return cache.map;
  // Loaded lazily: the generator is heavy and only this tool needs it.
  const { createClient } = await import('@hey-api/openapi-ts');
  await createClient({
    input: specPath,
    output: { path: outDir, postProcess: [] },
    plugins: ['@hey-api/typescript'],
    logs: { level: 'silent' },
  });
  cache.map = parseTypes(readFileSync(path.join(outDir, 'types.gen.ts'), 'utf8'));
  cache.key = cacheKey;
  return cache.map;
}

/**
 * Renames the declared name in `export type Old = ...`.
 */
export function renameDeclaration(declaration: string, from: string, to: string): string {
  return from === to ? declaration : declaration.replace(new RegExp(`(export (?:type|interface) )${from}\\b`), `$1${to}`);
}
