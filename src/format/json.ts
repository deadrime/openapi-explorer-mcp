/**
 * Compact JSON for tool results.
 */

/**
 * Drops undefined, null and empty containers from the top level of an envelope; nested values stay as they are.
 */
export function omitEmpty<T extends Record<string, unknown>>(envelope: T, keep: string[] = []): Partial<T> {
  return Object.fromEntries(
    Object.entries(envelope).filter(([key, value]) => {
      if (keep.includes(key)) return true;
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    })
  ) as Partial<T>;
}

/**
 * Serializes a value without indentation.
 */
export function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? '';
}
