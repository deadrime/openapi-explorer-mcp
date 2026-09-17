import { readFileSync } from 'node:fs';
import path from 'node:path';

const cache: { key: string | null; map: Map<string, string> | null } = { key: null, map: null };

// Bump when the generation input or options change, so a cached types.gen.ts from an older run is not reused.
const GENERATOR_REVISION = 'v3';

// String formats the generated type already shows: a binary string becomes Blob | File.
const TYPED_STRING_FORMATS = new Set(['binary']);

// Keys whose values are data rather than schemas; a `format` inside them is not a schema format.
const DATA_KEYS = new Set(['example', 'examples', 'default', 'enum', 'const']);

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
 * Adds null to the values of nullable enums. OpenAPI 3.0.3 requires null to be listed for a nullable enum to accept
 * it, and the generator follows that, while most specs only set nullable: true.
 */
export function patchNullableEnums(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) patchNullableEnums(item);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.nullable === true && Array.isArray(record.enum) && !record.enum.includes(null)) record.enum.push(null);
  for (const value of Object.values(record)) patchNullableEnums(value);
}

/**
 * Adds an `@format` tag to the description of every string schema with a format. The generated type of such a
 * field is plain `string`, and the generator writes doc comments only from the title and the description.
 */
export function patchFormatDocs(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) patchFormatDocs(item);
    return;
  }
  const record = node as Record<string, unknown>;
  const { format } = record;
  const isString = record.type === 'string' || (Array.isArray(record.type) && record.type.includes('string'));
  if (isString && typeof format === 'string' && format && format !== 'string' && !TYPED_STRING_FORMATS.has(format)) {
    const tag = `@format ${format}`;
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    if (!description.split('\n').includes(tag)) record.description = description ? `${description}\n${tag}` : tag;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!DATA_KEYS.has(key) && !key.startsWith('x-')) patchFormatDocs(value);
  }
}

/**
 * Returns generated declarations for a spec, regenerating only when the cache key changes.
 */
export async function getTypeMap(specPath: string, outDir: string, cacheKey: string): Promise<Map<string, string>> {
  const key = `${GENERATOR_REVISION}:${cacheKey}`;
  if (cache.key === key && cache.map) return cache.map;
  // Loaded lazily: the generator is heavy and only this tool needs it.
  const { createClient } = await import('@hey-api/openapi-ts');
  await createClient({
    input: specPath,
    output: { path: outDir, postProcess: [] },
    parser: {
      patch: {
        input: (spec) => {
          patchNullableEnums(spec);
          patchFormatDocs(spec);
        },
      },
    },
    plugins: ['@hey-api/typescript'],
    logs: { level: 'silent' },
  });
  cache.map = parseTypes(readFileSync(path.join(outDir, 'types.gen.ts'), 'utf8'));
  cache.key = key;
  return cache.map;
}

/**
 * Prefixes every listed type name where it is used as an identifier; string literals and property keys stay as they are.
 */
export function renameIdentifiers(declaration: string, names: Iterable<string>, prefix: string): string {
  if (!prefix) return declaration;
  // Not part of a longer identifier, not inside quotes, not a property key (followed by ?: or :).
  const patterns = [...names].map((name) => [new RegExp(`(?<![\\w$'".])${name}(?![\\w$'"]|\\??:)`, 'g'), `${prefix}${name}`] as const);
  // Odd parts of the split are comments; they keep the original words.
  return declaration
    .split(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/)
    .map((part, i) => (i % 2 ? part : patterns.reduce((code, [re, to]) => code.replace(re, to), part)))
    .join('');
}
