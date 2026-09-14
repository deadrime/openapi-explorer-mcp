import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Runtime configuration read from environment variables.
 */
export interface ExplorerConfig {
  /** URL of the spec, or an absolute path to a local spec file. */
  specSource: string;
  /** Whether specSource is an http(s) URL. */
  specIsUrl: boolean;
  /** Explicit base URL for calls, without a trailing slash. */
  baseUrl?: string;
  /** Directory for the spec cache and generated types. */
  cacheDir: string;
  /** How often a URL spec is revalidated, in milliseconds. */
  specTtlMs: number;
  /** Timeout of spec fetches and API calls, in milliseconds. */
  timeoutMs: number;
  /** Cap on the size of a tool response, in characters. */
  maxResponseChars: number;
  /** Whether api_request is registered. */
  allowWrite: boolean;
  /** Server name reported to MCP clients. */
  serverName: string;
  /** JSON file with danger overrides. */
  dangerFile?: string;
  /** Directory of markdown recipes; the recipe tool exists only when it is set. */
  recipesDir?: string;
  /** Markdown appended to the server instructions. */
  instructionsFile?: string;
  /** JSONL journal of api_request calls. */
  callLog: string;
  /** Headers sent with every call, from OPENAPI_HEADER_<NAME>. */
  staticHeaders: Record<string, string>;
  /** Credentials keyed by the normalized scheme name, from OPENAPI_AUTH_<SCHEME>. */
  schemeCredentials: Map<string, string>;
}

/**
 * The environment is missing a required value or holds an invalid one.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const AUTH_PREFIX = 'OPENAPI_AUTH_';
const HEADER_PREFIX = 'OPENAPI_HEADER_';

/**
 * Normalizes a security scheme name into its environment variable suffix: x-admin-token becomes X_ADMIN_TOKEN.
 */
export function schemeEnvSuffix(scheme: string): string {
  return scheme
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Name of the environment variable that holds the credential of a scheme.
 */
export function schemeEnvName(scheme: string): string {
  return `${AUTH_PREFIX}${schemeEnvSuffix(scheme)}`;
}

/**
 * Expands a leading ~ to the home directory.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

/**
 * Parses KEY=VALUE lines of an env file: comments, `export` prefixes and quoted values are supported.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Merges an env file into the environment; variables that are already set win, so a client config can override the file.
 */
function loadEnvFile(file: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(file)) throw new ConfigError(`OPENAPI_ENV_FILE points to a missing file: ${file}`);
  for (const [key, value] of Object.entries(parseEnvText(readFileSync(file, 'utf8')))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Parses an optional positive number, failing loudly instead of silently turning garbage into NaN.
 */
function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  return value;
}

/**
 * Resolves an optional path variable; a variable that is set must point to something that exists.
 */
function optionalPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const resolved = path.resolve(expandHome(raw));
  if (!existsSync(resolved)) throw new ConfigError(`${name} points to a missing path: ${resolved}`);
  return resolved;
}

/**
 * Reads and validates the configuration from environment variables.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ExplorerConfig {
  const envFile = env.OPENAPI_ENV_FILE?.trim();
  if (envFile) loadEnvFile(path.resolve(expandHome(envFile)), env);

  const rawSpec = env.OPENAPI_SPEC_URL?.trim();
  if (!rawSpec) throw new ConfigError('OPENAPI_SPEC_URL is required: the URL or file path of an OpenAPI 3 JSON spec');
  const specIsUrl = /^https?:\/\//i.test(rawSpec);
  const specSource = specIsUrl ? rawSpec : path.resolve(expandHome(rawSpec));
  if (!specIsUrl && !existsSync(specSource)) throw new ConfigError(`OPENAPI_SPEC_URL points to a missing file: ${specSource}`);

  let baseUrl: string | undefined;
  const rawBase = env.OPENAPI_BASE_URL?.trim();
  if (rawBase) {
    let parsed: URL;
    try {
      parsed = new URL(rawBase);
    } catch {
      throw new ConfigError(`OPENAPI_BASE_URL is not a valid URL: ${rawBase}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ConfigError(`OPENAPI_BASE_URL must be an http(s) URL, got ${parsed.protocol}`);
    }
    baseUrl = rawBase.replace(/\/+$/, '');
  }

  const staticHeaders: Record<string, string> = {};
  const schemeCredentials = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    // An empty value, e.g. from ${VAR:-} in a client config, means "not configured".
    if (!value) continue;
    if (key.startsWith(HEADER_PREFIX)) {
      staticHeaders[key.slice(HEADER_PREFIX.length).toLowerCase().replace(/_/g, '-')] = value;
    } else if (key.startsWith(AUTH_PREFIX)) {
      schemeCredentials.set(key.slice(AUTH_PREFIX.length), value);
    }
  }

  if (!baseUrl && (schemeCredentials.size > 0 || Object.keys(staticHeaders).length > 0)) {
    throw new ConfigError(
      'OPENAPI_BASE_URL is required when credentials or headers are configured: they only go to an origin you set explicitly, never to one taken from the spec'
    );
  }

  const rawCacheDir = env.OPENAPI_CACHE_DIR?.trim();
  const cacheDir = rawCacheDir
    ? path.resolve(expandHome(rawCacheDir))
    : path.join(homedir(), '.cache', 'openapi-explorer-mcp', createHash('sha1').update(specSource).digest('hex').slice(0, 12));
  const rawCallLog = env.OPENAPI_CALL_LOG?.trim();

  return {
    specSource,
    specIsUrl,
    baseUrl,
    cacheDir,
    specTtlMs: positiveNumber(env.OPENAPI_SPEC_TTL_S, 900, 'OPENAPI_SPEC_TTL_S') * 1000,
    timeoutMs: positiveNumber(env.OPENAPI_TIMEOUT_MS, 20_000, 'OPENAPI_TIMEOUT_MS'),
    maxResponseChars: positiveNumber(env.OPENAPI_MAX_RESPONSE_CHARS, 40_000, 'OPENAPI_MAX_RESPONSE_CHARS'),
    allowWrite: /^(1|true|yes)$/i.test(env.OPENAPI_ALLOW_WRITE ?? ''),
    serverName: env.OPENAPI_SERVER_NAME?.trim() || 'openapi',
    dangerFile: optionalPath(env, 'OPENAPI_DANGER_FILE'),
    recipesDir: optionalPath(env, 'OPENAPI_RECIPES_DIR'),
    instructionsFile: optionalPath(env, 'OPENAPI_INSTRUCTIONS_FILE'),
    callLog: rawCallLog ? path.resolve(expandHome(rawCallLog)) : path.join(cacheDir, 'calls.jsonl'),
    staticHeaders,
    schemeCredentials,
  };
}
