import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExplorerConfig } from './config.js';
import type { DangerRules } from './risk.js';
import { buildIndex, type OpenApiSpec, type SpecIndex } from './spec-index.js';

/**
 * Operations added and removed between two spec versions.
 */
export interface KeyDiff {
  /** Operation keys that appeared. */
  added: string[];
  /** Operation keys that disappeared. */
  removed: string[];
}

/**
 * What is known about the loaded spec.
 */
export interface SpecMeta {
  /** Spec URL or file path. */
  source: string;
  /** ETag of the last fetched copy. */
  etag: string | null;
  /** When the current content was fetched (URL) or modified (file), epoch ms. */
  fetchedAt: number;
  /** When the source was last checked, epoch ms. */
  checkedAt: number;
  /** info.version. */
  version?: string;
  /** Size of the spec text in characters. */
  size: number;
  /** Operations changed since the previous version. */
  changed?: KeyDiff;
}

/**
 * The loaded spec with its index.
 */
export interface SpecState {
  /** Searchable index. */
  index: SpecIndex;
  /** Metadata. */
  meta: SpecMeta;
  /** Set when the source is unreachable and a cached copy is served. */
  offline: { since: number; reason: string } | null;
  /** Path of a local copy of the spec, used for type generation. */
  specPath: string;
}

/**
 * Parses spec text and checks that it is OpenAPI 3.
 */
function parseSpec(text: string, source: string): OpenApiSpec {
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(text) as OpenApiSpec;
  } catch {
    throw new Error(`the spec at ${source} is not valid JSON (only JSON specs are supported)`);
  }
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) {
    throw new Error(`the spec at ${source} is not OpenAPI 3.x (openapi: ${String(spec.openapi ?? spec.swagger ?? 'missing')})`);
  }
  return spec;
}

/**
 * Lists operations added and removed between two indexes.
 */
function diffKeys(before: SpecIndex, after: SpecIndex): KeyDiff {
  const old = new Set(before.operations.map((o) => o.key));
  const next = new Set(after.operations.map((o) => o.key));
  return { added: [...next].filter((k) => !old.has(k)), removed: [...old].filter((k) => !next.has(k)) };
}

/**
 * Loads the spec lazily: a local file is re-read when modified, a URL is cached on disk and revalidated with ETag.
 */
export class SpecStore {
  private state: SpecState | null = null;
  private readonly cachedSpecPath: string;
  private readonly metaPath: string;

  constructor(
    private readonly config: ExplorerConfig,
    private readonly rules: DangerRules
  ) {
    this.cachedSpecPath = path.join(config.cacheDir, 'spec.json');
    this.metaPath = path.join(config.cacheDir, 'meta.json');
  }

  /**
   * Returns the current spec, revalidating it when due.
   */
  async load(force = false): Promise<SpecState> {
    return this.config.specIsUrl ? this.loadUrl(force) : this.loadFile(force);
  }

  /**
   * Revalidates the spec now.
   */
  forceRevalidate(): Promise<SpecState> {
    return this.load(true);
  }

  /**
   * Loads a local spec file, re-reading it only when its modification time changes.
   */
  private loadFile(force: boolean): SpecState {
    const { mtimeMs } = statSync(this.config.specSource);
    if (!force && this.state && this.state.meta.fetchedAt === mtimeMs) return this.state;

    const text = readFileSync(this.config.specSource, 'utf8');
    const index = buildIndex(parseSpec(text, this.config.specSource), this.rules);
    const meta: SpecMeta = { source: this.config.specSource, etag: null, fetchedAt: mtimeMs, checkedAt: Date.now(), version: index.version, size: text.length };
    if (this.state?.meta.version && this.state.meta.version !== meta.version) meta.changed = diffKeys(this.state.index, index);
    this.state = { index, meta, offline: null, specPath: this.config.specSource };
    return this.state;
  }

  /**
   * Loads a URL spec: memory, then disk cache, then a conditional fetch; serves the cache when the source is down.
   */
  private async loadUrl(force: boolean): Promise<SpecState> {
    const now = Date.now();
    if (!force && this.state && !this.state.offline && now - this.state.meta.checkedAt < this.config.specTtlMs) return this.state;
    this.state ??= this.readDisk();

    try {
      const response = await fetch(this.config.specSource, {
        headers: this.state?.meta.etag ? { 'If-None-Match': this.state.meta.etag } : {},
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (response.status === 304 && this.state) {
        this.state.meta.checkedAt = now;
        this.state.offline = null;
      } else if (response.ok) {
        const text = await response.text();
        const index = buildIndex(parseSpec(text, this.config.specSource), this.rules);
        const meta: SpecMeta = {
          source: this.config.specSource,
          etag: response.headers.get('etag'),
          fetchedAt: now,
          checkedAt: now,
          version: index.version,
          size: text.length,
        };
        if (this.state?.meta.version && this.state.meta.version !== meta.version) meta.changed = diffKeys(this.state.index, index);
        this.writeDisk(text, meta);
        this.state = { index, meta, offline: null, specPath: this.cachedSpecPath };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!this.state) throw new Error(`the spec is unreachable and there is no cached copy: ${reason}. Check that ${this.config.specSource} is reachable`);
      this.state.offline = { since: this.state.offline?.since ?? now, reason };
    }

    return this.state;
  }

  /**
   * Reads the cached copy; ignores a cache that belongs to another spec source.
   */
  private readDisk(): SpecState | null {
    if (!existsSync(this.cachedSpecPath) || !existsSync(this.metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as SpecMeta & { url?: string };
      if ((meta.source ?? meta.url) !== this.config.specSource) return null;
      const text = readFileSync(this.cachedSpecPath, 'utf8');
      const index = buildIndex(parseSpec(text, this.cachedSpecPath), this.rules);
      return { index, meta: { ...meta, source: this.config.specSource, etag: meta.etag ?? null }, offline: null, specPath: this.cachedSpecPath };
    } catch {
      return null;
    }
  }

  /**
   * Writes the fetched spec and its metadata; a failed cache write never fails the call.
   */
  private writeDisk(text: string, meta: SpecMeta): void {
    try {
      mkdirSync(this.config.cacheDir, { recursive: true });
      writeFileSync(`${this.cachedSpecPath}.tmp`, text);
      renameSync(`${this.cachedSpecPath}.tmp`, this.cachedSpecPath);
      writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
    } catch (error) {
      process.stderr.write(`openapi-explorer-mcp: could not write the spec cache — ${(error as Error).message}\n`);
    }
  }
}
