/**
 * Tidying of generated TypeScript: two-space indentation, one-line doc comments, optional removal of docs.
 */

/**
 * Collapses single-line JSDoc blocks and halves the four-space indentation of the generator.
 */
export function formatDeclaration(declaration: string, docs: boolean): string {
  const collapsed = declaration.replace(/\/\*\*\n[ \t]*\* ([^\n]*)\n[ \t]*\*\//g, (_, text: string) => `/** ${text.replace(/\*\//g, '* /')} */`);
  // Continuation lines of a multi-line comment sit one space deeper; that extra space is kept.
  const reindented = collapsed.replace(/^ +/gm, (spaces) => ' '.repeat(Math.floor(spaces.length / 4) * 2 + (spaces.length % 4)));
  return docs ? reindented : stripDocs(reindented);
}

/**
 * Removes doc comments that sit on their own lines.
 */
export function stripDocs(code: string): string {
  return code.replace(/^[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*\n/gm, '');
}
