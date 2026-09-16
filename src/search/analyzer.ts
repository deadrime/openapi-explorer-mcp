/**
 * Text analysis shared by indexing and queries: words from identifiers and prose, stop words, and stemming chosen by
 * the script of each word, so English and Russian specs work without configuration.
 */
import { stemmer as russianStem } from '@orama/stemmers/russian';
import { stemmer as englishStem } from 'stemmer';

const STOP_WORDS = new Set(
  [
    // English words that carry no meaning in an endpoint search.
    'a an the to of for by with from as is are be and or in on at my me how do does get all list any some this that it its via using use new',
    // Russian.
    'и в во на по для с со к ко о об от из за как все всех это что',
  ]
    .join(' ')
    .split(' ')
);

const CASE_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

/**
 * Words of a text: split on anything that is not a letter or digit, then on camelCase and letter-digit boundaries.
 * A compound identifier is also kept whole, so "closeReason" matches both itself and "close reason".
 */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    const parts = chunk.split(CASE_BOUNDARY);
    out.push(...parts);
    if (parts.length > 1) out.push(chunk);
  }
  return out;
}

/**
 * Index term of a word: lower-cased, without stop words, stemmed by its script; null drops the word.
 */
export function normalizeTerm(word: string): string | null {
  const lower = word.toLowerCase().replace(/ё/g, 'е');
  if (!lower || STOP_WORDS.has(lower)) return null;
  if (/^[a-z]+$/.test(lower)) return englishStem(lower);
  if (/^[а-я]+$/.test(lower)) return russianStem(lower);
  return lower;
}

/**
 * Index terms of a text.
 */
export function analyze(text: string): string[] {
  return splitWords(text)
    .map(normalizeTerm)
    .filter((term): term is string => term !== null);
}

/**
 * Query term weights for compound identifiers: the whole identifier outweighs its parts, so "closeReason" ranks the
 * endpoints carrying that field above endpoints that merely mention "close". Plain words keep weight 1.
 */
export function compoundBoosts(query: string, whole = 6, part = 0.3): Map<string, number> {
  const boosts = new Map<string, number>();
  for (const chunk of query.split(/[^\p{L}\p{N}]+/u)) {
    const parts = chunk.split(CASE_BOUNDARY);
    if (parts.length < 2) continue;
    const term = normalizeTerm(chunk);
    if (term) boosts.set(term, whole);
    for (const piece of parts) {
      const pieceTerm = normalizeTerm(piece);
      if (pieceTerm && !boosts.has(pieceTerm)) boosts.set(pieceTerm, part);
    }
  }
  return boosts;
}
