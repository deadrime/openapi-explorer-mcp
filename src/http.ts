import type { HttpMethod } from './spec-index.js';

/**
 * Outcome of an HTTP call.
 */
export interface CallResult {
  /** HTTP status. */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  /** Call duration. */
  durationMs: number;
  /** Rate limit headers the API returned. */
  rateLimit?: Record<string, string>;
  /** Parsed JSON body, raw text, or null for an empty body. */
  body: unknown;
}

const RATE_LIMIT_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

/**
 * Fills path parameters into a path template and appends the query string.
 */
export function buildUrl(baseUrl: string, pathTemplate: string, pathParams: Record<string, string | number>, query: Record<string, string | number | boolean>): URL {
  let filled = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    filled = filled.split(`{${key}}`).join(encodeURIComponent(String(value)));
  }
  const missing = filled.match(/\{[^}]+\}/g);
  if (missing) throw new Error(`missing path parameters: ${missing.join(', ')}`);

  const url = new URL(`${baseUrl}${filled}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

/**
 * Sends a request and returns a structured result; authorization and retries are the caller's job.
 */
export async function send(method: HttpMethod, url: URL, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<CallResult> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const rateLimit: Record<string, string> = {};
  for (const header of RATE_LIMIT_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) rateLimit[header] = value;
  }

  return {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    body: parsed,
  };
}
