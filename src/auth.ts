import { type ExplorerConfig, schemeEnvName, schemeEnvSuffix } from './config.js';
import type { Operation, SecurityScheme } from './spec-index.js';

/** Where a credential used by a call came from. */
export type CredentialSource = 'call' | 'session' | 'env';

/**
 * Credentials the model supplied, resolved against the spec.
 */
export interface SuppliedCredentials {
  /** Values keyed by security scheme name. */
  schemes: Map<string, string>;
  /** Plain headers keyed by lower-cased name; only for specs that declare no security schemes. */
  headers: Map<string, string>;
}

/** Which security alternative a call uses. */
export type AuthSelection = { mode: 'anonymous'; note?: string } | { mode: 'credentials'; schemes: string[] };

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An empty set of supplied credentials.
 */
export function emptyCredentials(): SuppliedCredentials {
  return { schemes: new Map(), headers: new Map() };
}

/**
 * Where a scheme puts its value, for humans: "header x-api-key" or "Authorization: Bearer".
 */
export function placement(scheme: SecurityScheme): string {
  if (scheme.type === 'apiKey') return `${scheme.in ?? '?'} ${scheme.name ?? '?'}`;
  if (scheme.type !== 'http') return 'Authorization: Bearer';
  const kind = (scheme.scheme ?? '').toLowerCase();
  if (kind === 'bearer') return 'Authorization: Bearer';
  if (kind === 'basic') return 'Authorization: Basic';
  return `Authorization: ${scheme.scheme ?? '?'}`;
}

/**
 * Lists the security schemes of a spec with where each one puts its value.
 */
function describeSchemes(schemes: Record<string, SecurityScheme>): string {
  const entries = Object.entries(schemes);
  return entries.length ? entries.map(([name, scheme]) => `${name} (${placement(scheme)})`).join(', ') : 'none';
}

/**
 * Finds the scheme a key names: the scheme name itself, or the header, query or cookie name of an apiKey scheme.
 */
function resolveSchemeName(key: string, schemes: Record<string, SecurityScheme>): string {
  if (schemes[key]) return key;
  const lower = key.toLowerCase();
  const matches = Object.entries(schemes)
    .filter(([name, scheme]) => name.toLowerCase() === lower || (scheme.type === 'apiKey' && scheme.name?.toLowerCase() === lower))
    .map(([name]) => name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${key}" matches several security schemes (${matches.join(', ')}); use the scheme name`);
  throw new Error(`unknown credential "${key}"; the spec defines: ${describeSchemes(schemes)}`);
}

/**
 * Maps the keys of supplied credentials onto the spec; for a spec without security schemes they are plain headers.
 */
export function resolveSupplied(input: Record<string, string>, schemes: Record<string, SecurityScheme>): SuppliedCredentials {
  const out = emptyCredentials();
  const hasSchemes = Object.keys(schemes).length > 0;
  for (const [key, value] of Object.entries(input)) {
    if (/[\r\n]/.test(value)) throw new Error(`the value of "${key}" contains a line break`);
    if (hasSchemes) {
      out.schemes.set(resolveSchemeName(key, schemes), value);
      continue;
    }
    if (!HEADER_NAME.test(key)) throw new Error(`"${key}" is not a valid header name; the spec declares no security schemes, so keys are sent as headers`);
    out.headers.set(key.toLowerCase(), value);
  }
  return out;
}

/**
 * Places a credential where its security scheme says: a header, the query string, a cookie or Authorization.
 */
function applyScheme(name: string, scheme: SecurityScheme, value: string, headers: Record<string, string>, url: URL): void {
  switch (scheme.type) {
    case 'apiKey': {
      if (!scheme.name) throw new Error(`security scheme "${name}" has no parameter name`);
      if (scheme.in === 'header') headers[scheme.name.toLowerCase()] = value;
      else if (scheme.in === 'query') url.searchParams.set(scheme.name, value);
      else if (scheme.in === 'cookie') headers.cookie = [headers.cookie, `${scheme.name}=${encodeURIComponent(value)}`].filter(Boolean).join('; ');
      else throw new Error(`security scheme "${name}" uses an unsupported location "${scheme.in}"`);
      return;
    }
    case 'http': {
      const kind = (scheme.scheme ?? '').toLowerCase();
      if (kind === 'bearer') headers.authorization = `Bearer ${value}`;
      else if (kind === 'basic') headers.authorization = `Basic ${value.includes(':') ? Buffer.from(value).toString('base64') : value}`;
      else throw new Error(`security scheme "${name}" uses an unsupported HTTP scheme "${scheme.scheme}"`);
      return;
    }
    case 'oauth2':
    case 'openIdConnect':
      headers.authorization = `Bearer ${value}`;
      return;
    default:
      throw new Error(`security scheme "${name}" has an unsupported type "${scheme.type}"`);
  }
}

/**
 * Maps credentials onto the security schemes of the spec. A value passed in a call wins over one kept for the
 * session, which wins over the environment.
 */
export class Credentials {
  private readonly session = emptyCredentials();

  constructor(private readonly config: ExplorerConfig) {}

  /**
   * Keeps supplied credentials in memory for the rest of the server session.
   */
  remember(supplied: SuppliedCredentials): void {
    for (const [name, value] of supplied.schemes) this.session.schemes.set(name, value);
    for (const [name, value] of supplied.headers) this.session.headers.set(name, value);
  }

  /**
   * Forgets session credentials by key, or all of them for "*"; returns the names that were kept before.
   */
  forget(keys: string[], schemes: Record<string, SecurityScheme>): string[] {
    const kept = [...this.session.schemes.keys(), ...this.session.headers.keys()];
    if (keys.includes('*')) {
      this.session.schemes.clear();
      this.session.headers.clear();
      return kept;
    }
    const hasSchemes = Object.keys(schemes).length > 0;
    const names = keys.map((key) => (hasSchemes ? resolveSchemeName(key, schemes) : key.toLowerCase()));
    for (const name of names) {
      this.session.schemes.delete(name);
      this.session.headers.delete(name);
    }
    return kept.filter((name) => names.includes(name));
  }

  /**
   * Where the credential of a scheme comes from, or null when nothing supplies it.
   */
  source(scheme: string, call: SuppliedCredentials = emptyCredentials()): CredentialSource | null {
    if (call.schemes.has(scheme)) return 'call';
    if (this.session.schemes.has(scheme)) return 'session';
    if (this.config.schemeCredentials.has(schemeEnvSuffix(scheme))) return 'env';
    return null;
  }

  /**
   * Credential status of a scheme outside a call: its source, or "not configured".
   */
  describe(scheme: string): string {
    return this.source(scheme) ?? 'not configured';
  }

  /**
   * Names of plain headers kept for the session.
   */
  sessionHeaders(): string[] {
    return [...this.session.headers.keys()];
  }

  /**
   * Picks the security alternative for a call: a forced scheme, the first alternative with all credentials, or anonymous.
   */
  select(op: Operation, as: string, call: SuppliedCredentials, schemes: Record<string, SecurityScheme>): AuthSelection {
    if (as === 'anonymous') return { mode: 'anonymous' };

    if (as !== 'auto') {
      if (!schemes[as]) throw new Error(`unknown security scheme "${as}"; the spec defines: ${describeSchemes(schemes)}`);
      if (!this.source(as, call)) throw new Error(`no credential for "${as}": ${this.hint(as)}`);
      return { mode: 'credentials', schemes: [as] };
    }

    for (const alternative of op.security) {
      if (alternative.every((scheme) => this.source(scheme, call))) {
        return alternative.length ? { mode: 'credentials', schemes: alternative } : { mode: 'anonymous' };
      }
    }
    if (op.security.length === 0) return { mode: 'anonymous' };

    const missing = [...new Set(op.security.flat())];
    const hints = missing.map((scheme) => this.hint(scheme)).join('; ');
    // Many GET endpoints declare auth but also answer anonymously, and a 401 explains itself; writes don't get that benefit of the doubt.
    if (op.method === 'GET') return { mode: 'anonymous', note: `no credentials for ${missing.join(' or ')}, called anonymously — ${hints}` };
    throw new Error(`${op.key} requires ${op.security.map((a) => a.join(' + ')).join(' or ')}: ${hints}`);
  }

  /**
   * Puts the selected credentials and plain headers into the request; returns what was used, without values.
   */
  apply(selection: AuthSelection, schemes: Record<string, SecurityScheme>, call: SuppliedCredentials, headers: Record<string, string>, url: URL): string {
    const used: string[] = [];
    if (selection.mode === 'credentials') {
      for (const name of selection.schemes) {
        const scheme = schemes[name];
        if (!scheme) throw new Error(`the spec has no security scheme "${name}"`);
        const source = this.source(name, call);
        const value = call.schemes.get(name) ?? this.session.schemes.get(name) ?? this.config.schemeCredentials.get(schemeEnvSuffix(name));
        if (!source || value === undefined) throw new Error(`no credential for "${name}": ${this.hint(name)}`);
        applyScheme(name, scheme, value, headers, url);
        used.push(`${name} (${source})`);
      }
    }
    for (const [name, value] of new Map([...this.session.headers, ...call.headers])) {
      headers[name] = value;
      used.push(`header ${name} (${call.headers.has(name) ? 'call' : 'session'})`);
    }
    return used.length ? used.join(' + ') : 'anonymous';
  }

  /**
   * Tells how to supply a credential for a scheme.
   */
  private hint(scheme: string): string {
    return `pass credentials: { "${scheme}": "…" }, keep one with api_credentials, or set ${schemeEnvName(scheme)}`;
  }
}
