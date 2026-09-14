import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Appends one JSON line, creating the directory when needed; a failed write never fails the call.
 */
export function appendJsonl(file: string, entry: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    process.stderr.write(`openapi-explorer-mcp: could not write the journal ${file} — ${(error as Error).message}\n`);
  }
}

/**
 * Returns the last entries of a JSONL journal.
 */
export function tailJsonl(file: string, limit: number): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as unknown);
}
