import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * A markdown recipe.
 */
export interface Recipe {
  /** File name without .md. */
  name: string;
  /** `description:` from the front matter. */
  description: string;
  /** Full text. */
  text: string;
}

/**
 * Lists the markdown recipes of a directory.
 */
export function listRecipes(dir: string): Recipe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), 'utf8');
      return { name: path.basename(file, '.md'), description: /^description:\s*(.+)$/m.exec(text)?.[1] ?? '', text };
    });
}
