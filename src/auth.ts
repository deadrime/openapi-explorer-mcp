import { pathToFileURL } from 'node:url';
import { ConfigError, type ExplorerConfig, schemeEnvName, schemeEnvSuffix } from './config.js';
import type { Operation, SecurityScheme } from './spec-index.js';

/**
 * Per-call context passed to an auth provider.
 */
export interface AuthContext {
  /** Identity from the tool call, e.g. a user id; the provider decides what it means. */
  identity?: string;
  /** Ignore cached credentials, e.g. after a 401. */
  force?: boolean;
}

/**
 * Tokens a provider minted, shown by the api_auth tool.
 */
export interface AuthSession {
  /** Who the tokens belong to. */
  identity: string;
  /** When the access token expires, ISO 8601. */
  expiresAt?: string;
  /** Access token. */
  accessToken?: string;
  /** Refresh token. */
  refreshToken?: string;
}

/**
 * Supplies credentials that can't be static, e.g. tokens minted per user.
 */
export interface AuthProvider {
  /** Whether the provider can supply a credential for the scheme in this context, without doing I/O. */
  canProvide(scheme: string, context: AuthContext): boolean;
  /** Returns the credential value for the scheme. */
  getCredential(scheme: string, context: AuthContext): Promise<string>;
  /** Mints or refreshes tokens for an identity; registers the api_auth tool when present. */
  authenticate?(context: AuthContext): Promise<AuthSession>;
}

/**
 * What a provider factory receives.
 */
export interface AuthProviderOptions {
  /** OPENAPI_BASE_URL. */
  baseUrl: string;
  /** OPENAPI_TIMEOUT_MS. */
  timeoutMs: number;
  /** The process environment, with OPENAPI_ENV_FILE already merged in. */
  env: NodeJS.ProcessEnv;
}

/** The default export of an OPENAPI_AUTH_MODULE. */
export type AuthProviderFactory = (options: AuthProviderOptions) => AuthProvider | Promise<AuthProvider>;

/** Which security alternative a call uses. */
export type AuthSelection = { mode: 'anonymous'; note?: string } | { mode: 'credentials'; schemes: string[] };

/**
 * Imports OPENAPI_AUTH_MODULE and creates its provider.
 */
export async function loadAuthProvider(config: ExplorerConfig): Promise<AuthProvider | undefined> {
  if (!config.authModule || !config.baseUrl) return undefined;
  const mod = (await import(pathToFileURL(config.authModule).href)) as { default?: unknown };
  if (typeof mod.default !== 'function') {
    throw new ConfigError(`OPENAPI_AUTH_MODULE must default-export a factory function: ${config.authModule}`);
  }
  const provider = (await (mod.default as AuthProviderFactory)({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, env: process.env })) as Partial<AuthProvider> | undefined;
  if (!provider || typeof provider.canProvide !== 'function' || typeof provider.getCredential !== 'function') {
    throw new ConfigError('OPENAPI_AUTH_MODULE factory must return an object with canProvide and getCredential');
  }
  return provider as AuthProvider;
}

/**
 * Places a credential where its security scheme says: a header, the query string, a cookie or Authorization.
 */
function applyScheme(name: string, scheme: SecurityScheme, value: string, headers: Record<string, string>, url: URL): void {
  switch (scheme.type) {
    case 'apiKey': {
      if (!scheme.name) throw new Error(`security scheme "${name}" has no parameter name`);
      if (scheme.in === 'header') headers[scheme.name] = value;
      else if (scheme.in === 'query') url.searchParams.set(scheme.name, value);
      else if (scheme.in === 'cookie') headers.Cookie = [headers.Cookie, `${scheme.name}=${encodeURIComponent(value)}`].filter(Boolean).join('; ');
      else throw new Error(`security scheme "${name}" uses an unsupported location "${scheme.in}"`);
      return;
    }
    case 'http': {
      const kind = (scheme.scheme ?? '').toLowerCase();
      if (kind === 'bearer') headers.Authorization = `Bearer ${value}`;
      else if (kind === 'basic') headers.Authorization = `Basic ${value.includes(':') ? Buffer.from(value).toString('base64') : value}`;
      else throw new Error(`security scheme "${name}" uses an unsupported HTTP scheme "${scheme.scheme}"`);
      return;
    }
    case 'oauth2':
    case 'openIdConnect':
      headers.Authorization = `Bearer ${value}`;
      return;
    default:
      throw new Error(`security scheme "${name}" has an unsupported type "${scheme.type}"`);
  }
}

/**
 * Maps credentials from the environment and an auth provider onto the security schemes of the spec.
 */
export class Credentials {
  constructor(
    private readonly config: ExplorerConfig,
    private readonly provider?: AuthProvider
  ) {}

  /**
   * Where the credential of a scheme comes from, or null when nothing supplies it.
   */
  source(scheme: string, context: AuthContext = {}): 'env' | 'module' | null {
    if (this.config.schemeCredentials.has(schemeEnvSuffix(scheme))) return 'env';
    return this.provider?.canProvide(scheme, context) ? 'module' : null;
  }

  /**
   * Credential status of a scheme for spec info.
   */
  describe(scheme: string): string {
    const source = this.source(scheme);
    if (source) return source;
    // canProvide does no I/O by contract, so probing with a placeholder identity is safe and tells whether passing one would help.
    return this.provider?.canProvide(scheme, { identity: 'identity' }) ? 'module, when an identity is passed' : 'not configured';
  }

  /**
   * Picks the security alternative for a call: a forced scheme, the first alternative with all credentials, or anonymous.
   */
  select(op: Operation, as: string, context: AuthContext, schemes: Record<string, SecurityScheme>): AuthSelection {
    if (as === 'anonymous') return { mode: 'anonymous' };

    if (as !== 'auto') {
      if (!schemes[as]) {
        const known = Object.keys(schemes);
        throw new Error(`unknown security scheme "${as}"; the spec defines: ${known.length ? known.join(', ') : 'none'}`);
      }
      if (!this.source(as, context)) throw new Error(`no credential for "${as}": ${this.hint(as)}`);
      return { mode: 'credentials', schemes: [as] };
    }

    for (const alternative of op.security) {
      if (alternative.every((scheme) => this.source(scheme, context))) {
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
   * Puts the credentials of the selected schemes into the request; reports whether any came from the provider.
   */
  async apply(
    selection: AuthSelection,
    schemes: Record<string, SecurityScheme>,
    context: AuthContext,
    headers: Record<string, string>,
    url: URL
  ): Promise<{ fromProvider: boolean }> {
    if (selection.mode === 'anonymous') return { fromProvider: false };

    let fromProvider = false;
    for (const name of selection.schemes) {
      const scheme = schemes[name];
      if (!scheme) throw new Error(`the spec has no security scheme "${name}"`);
      let value = this.config.schemeCredentials.get(schemeEnvSuffix(name));
      if (value === undefined) {
        if (!this.provider) throw new Error(`no credential for "${name}": ${this.hint(name)}`);
        value = await this.provider.getCredential(name, context);
        fromProvider = true;
      }
      applyScheme(name, scheme, value, headers, url);
    }
    return { fromProvider };
  }

  /**
   * Tells the user how to supply a credential for a scheme.
   */
  private hint(scheme: string): string {
    return `set ${schemeEnvName(scheme)}${this.provider ? ' or pass an identity the auth module accepts' : ''}`;
  }
}
