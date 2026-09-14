import { readFileSync } from 'node:fs';
import { ConfigError } from './config.js';

/** How risky calling an operation is. */
export type Danger = 'safe' | 'write' | 'destructive';

/**
 * Danger level of an operation with the reason for destructive ones.
 */
export interface DangerVerdict {
  /** Danger level. */
  danger: Danger;
  /** Why the operation is destructive. */
  reason?: string;
}

/**
 * Rules that classify operations.
 */
export interface DangerRules {
  /** Exact "METHOD /path" keys marked destructive, with the reason. */
  operations: Record<string, string>;
  /** Path words that mark a non-GET operation destructive. */
  pathPattern: RegExp;
}

const DEFAULT_PATH_WORDS = ['drop', 'purge', 'reset', 'destroy', 'bulk', 'broadcast'];

/**
 * Escapes a word for use inside a regular expression.
 */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Loads danger rules: built-in path words plus an optional JSON file with exact operations and extra words.
 */
export function loadDangerRules(file?: string): DangerRules {
  let operations: Record<string, string> = {};
  const words = [...DEFAULT_PATH_WORDS];

  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new ConfigError(`OPENAPI_DANGER_FILE is not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('OPENAPI_DANGER_FILE must hold an object with "operations" and/or "pathPatterns"');
    }
    const { operations: ops, pathPatterns } = parsed as { operations?: unknown; pathPatterns?: unknown };
    if (ops !== undefined) {
      if (!ops || typeof ops !== 'object' || Array.isArray(ops) || !Object.values(ops).every((v) => typeof v === 'string')) {
        throw new ConfigError('OPENAPI_DANGER_FILE: "operations" must map "METHOD /path" to a reason string');
      }
      operations = ops as Record<string, string>;
    }
    if (pathPatterns !== undefined) {
      if (!Array.isArray(pathPatterns) || !pathPatterns.every((w) => typeof w === 'string' && w.length > 0)) {
        throw new ConfigError('OPENAPI_DANGER_FILE: "pathPatterns" must be a list of non-empty strings');
      }
      words.push(...(pathPatterns as string[]));
    }
  }

  return { operations, pathPattern: new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'i') };
}

/**
 * Classifies an operation: exact rules first, then GET is safe, DELETE and path words are destructive.
 */
export function classifyDanger(rules: DangerRules, method: string, path: string): DangerVerdict {
  const exact = rules.operations[`${method} ${path}`];
  if (exact) return { danger: 'destructive', reason: exact };
  if (method === 'GET') return { danger: 'safe' };
  if (method === 'DELETE') return { danger: 'destructive', reason: 'DELETE removes data' };
  if (rules.pathPattern.test(path)) return { danger: 'destructive', reason: 'the path contains a sign of an irreversible operation' };
  return { danger: 'write' };
}
