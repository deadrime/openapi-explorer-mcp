/**
 * Collapses whitespace and line breaks into single spaces.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cuts a text to a length at a word boundary and marks the cut with an ellipsis.
 */
export function trimWords(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(' ');
  // A single long word has no boundary to cut at; cut it where the limit falls.
  const cut = space > limit * 0.6 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.—-]+$/, '')}…`;
}
