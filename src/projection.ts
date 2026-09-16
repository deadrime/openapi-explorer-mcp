/**
 * Narrowing of API responses: keep chosen fields, cap long arrays.
 */

/** One step of a field path: a property, or every element of an array. */
type Step = { kind: 'key'; name: string } | { kind: 'each' };

/**
 * Result of a projection.
 */
export interface Projection {
  /** The narrowed value. */
  value: unknown;
  /** Paths that matched nothing. */
  missing: string[];
}

/**
 * Result of capping arrays.
 */
export interface Capped {
  /** The value with long arrays cut. */
  value: unknown;
  /** Original lengths of the cut arrays by path; "[]" is a root array. */
  cut: Record<string, number>;
}

const MISSING = Symbol('missing');

/**
 * Whether a value is a plain JSON object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses "data[].id" into steps; a path on an array body that does not start with [] applies to every element.
 */
export function parseFieldPath(path: string, rootIsArray: boolean): Step[] {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('an empty path in fields');
  const steps: Step[] = [];
  trimmed.split('.').forEach((part, i) => {
    const match = /^([^[\]]*)((?:\[\])*)$/.exec(part);
    if (!match || (!match[1] && (i > 0 || !match[2]))) {
      throw new Error(`fields: "${path}" is not a path like data[].id, [].name or meta.total`);
    }
    if (match[1]) steps.push({ kind: 'key', name: match[1] });
    for (let n = 0; n < match[2].length / 2; n += 1) steps.push({ kind: 'each' });
  });
  if (rootIsArray && steps[0]?.kind !== 'each') steps.unshift({ kind: 'each' });
  return steps;
}

/**
 * The part of a value a path selects, keeping the structure around it.
 */
function pick(value: unknown, steps: Step[], i: number): unknown {
  if (i === steps.length) return value;
  const step = steps[i];
  if (step.kind === 'each') {
    if (!Array.isArray(value)) return MISSING;
    const items = value.map((item) => pick(item, steps, i + 1));
    return items.every((item) => item === MISSING) && items.length ? MISSING : items.map((item) => (item === MISSING ? undefined : item));
  }
  if (!isObject(value) || !(step.name in value)) return MISSING;
  const inner = pick(value[step.name], steps, i + 1);
  return inner === MISSING ? MISSING : { [step.name]: inner };
}

/**
 * Merges two projections of the same value.
 */
function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((item, i) => merge(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = merge(a[key], value);
    return out;
  }
  return b;
}

/**
 * Array elements no path matched become empty objects, so positions stay aligned with the original.
 */
function fillHoles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? {} : fillHoles(item)));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillHoles(item)]));
  return value;
}

/**
 * Keeps only the fields the paths select.
 */
export function project(value: unknown, paths: string[]): Projection {
  const missing: string[] = [];
  let out: unknown;
  for (const path of paths) {
    const picked = pick(value, parseFieldPath(path, Array.isArray(value)), 0);
    if (picked === MISSING) missing.push(path);
    else out = merge(out, picked);
  }
  return { value: out === undefined ? (Array.isArray(value) ? [] : {}) : fillHoles(out), missing };
}

/**
 * Cuts every array longer than max and records the original lengths.
 */
export function capArrays(value: unknown, max: number): Capped {
  const cut: Record<string, number> = {};
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      const key = path || '[]';
      if (node.length > max) cut[key] = Math.max(cut[key] ?? 0, node.length);
      return node.slice(0, max).map((item) => walk(item, `${path}[]`));
    }
    if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, item]) => [k, walk(item, path ? `${path}.${k}` : k)]));
    return node;
  };
  return { value: walk(value, ''), cut };
}
