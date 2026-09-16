/**
 * Ranked search over endpoints and component schemas, built lazily once per loaded spec.
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import type { Operation, SpecIndex } from '../spec-index.js';
import { analyze, compoundBoosts, normalizeTerm, splitWords } from './analyzer.js';
import { ENDPOINT_BOOST, endpointDocument, SCHEMA_BOOST, schemaDocument, type EndpointDocument, type SchemaDocument } from './documents.js';

/**
 * A ranked endpoint.
 */
export interface EndpointHit {
  /** The endpoint. */
  op: Operation;
  /** Relevance score. */
  score: number;
  /** Request or response properties that matched the query, when the endpoint itself did not. */
  fields: string[];
}

/**
 * A ranked component schema.
 */
export interface SchemaHit {
  /** Schema name. */
  name: string;
  /** Relevance score. */
  score: number;
  /** Property names that matched the query. */
  fields: string[];
}

// Fields that describe the shape of the data rather than the endpoint itself.
const SHAPE_FIELDS = new Set(['props', 'schemaNames']);
// Hits scoring below this share of the best one are noise for an agent.
const RELATIVE_CUTOFF = 0.3;

const SEARCH_OPTIONS = {
  prefix: (term: string) => term.length >= 4,
  fuzzy: (term: string) => (term.length >= 5 ? 1 : false),
  weights: { fuzzy: 0.3, prefix: 0.5 },
  combineWith: 'OR' as const,
};

const indexes = new WeakMap<SpecIndex, SearchIndex>();

/**
 * Keeps hits that score at least a share of the best one.
 */
function cut<T extends { score: number }>(hits: T[]): T[] {
  const best = hits[0]?.score ?? 0;
  return hits.filter((hit) => hit.score >= best * RELATIVE_CUTOFF);
}

/**
 * Original property names whose terms are among the given terms.
 */
function matchedNames(names: string[], terms: string[]): string[] {
  const wanted = new Set(terms);
  return names.filter((name) => analyze(name).some((term) => wanted.has(term))).slice(0, 2);
}

/**
 * Field names to point at: the properties that matched the weightiest query term, unless the endpoint or schema
 * itself matched that term too and so needs no hint.
 */
function fieldHint(result: SearchResult, props: string[], boosts: Map<string, number>): string[] {
  const weight = (term: string) => boosts.get(term) ?? 1;
  const terms = Object.keys(result.match);
  const best = Math.max(...terms.map(weight));
  const inProps = terms.filter((term) => weight(term) === best && result.match[term].includes('props'));
  if (inProps.length === 0) return [];
  const aboutItself = inProps.every((term) => result.match[term].some((field) => !SHAPE_FIELDS.has(field) && field !== 'description'));
  return aboutItself ? [] : matchedNames(props, inProps);
}

/**
 * Search indexes of one spec.
 */
export class SearchIndex {
  private readonly endpointIndex: MiniSearch<EndpointDocument>;
  private readonly endpointProps: string[][] = [];
  private schemaIndex: MiniSearch<SchemaDocument> | null = null;
  private readonly schemaNames: string[];
  private readonly schemaProps: string[][] = [];
  // First original spelling of each index term, to show suggestions as words rather than stems.
  private readonly spelling = new Map<string, string>();

  private constructor(private readonly index: SpecIndex) {
    this.endpointIndex = new MiniSearch<EndpointDocument>({
      fields: Object.keys(ENDPOINT_BOOST),
      tokenize: (text) => this.remember(text),
      processTerm: (term) => normalizeTerm(term),
      searchOptions: { ...SEARCH_OPTIONS, boost: ENDPOINT_BOOST, tokenize: splitWords },
    });
    this.endpointIndex.addAll(
      index.operations.map((op, id) => {
        const { doc, props } = endpointDocument(index, op, id);
        this.endpointProps[id] = props;
        return doc;
      })
    );
    this.schemaNames = Object.keys(index.schemas);
  }

  /**
   * The search index of a spec index, built on first use.
   */
  static of(index: SpecIndex): SearchIndex {
    let found = indexes.get(index);
    if (!found) {
      found = new SearchIndex(index);
      indexes.set(index, found);
    }
    return found;
  }

  /**
   * Endpoints ranked by relevance, filtered, with weak hits cut off.
   */
  endpoints(query: string, keep: (op: Operation) => boolean): EndpointHit[] {
    const ops = this.index.operations;
    const boosts = compoundBoosts(query);
    const results = this.endpointIndex.search(query, { filter: (result) => keep(ops[result.id as number]), boostTerm: (term) => boosts.get(term) ?? 1 });
    return cut(
      results.map((result) => ({
        op: ops[result.id as number],
        score: result.score,
        fields: fieldHint(result, this.endpointProps[result.id as number], boosts),
      }))
    );
  }

  /**
   * Component schemas ranked by relevance, with weak hits cut off.
   */
  schemas(query: string): SchemaHit[] {
    const boosts = compoundBoosts(query);
    const results = this.schemaSearch().search(query, { boostTerm: (term) => boosts.get(term) ?? 1 });
    return cut(results.map((result) => ({ name: this.schemaNames[result.id as number], score: result.score, fields: fieldHint(result, this.schemaProps[result.id as number], boosts) })));
  }

  /**
   * Words from the spec that look like the words of a query, for an empty result.
   */
  suggest(query: string): string[] {
    const suggestions = this.endpointIndex.autoSuggest(query, { fuzzy: 0.4, prefix: true, combineWith: 'OR' });
    const words = suggestions.flatMap((s) => s.terms).map((term) => this.spelling.get(term) ?? term);
    return [...new Set(words)].slice(0, 8);
  }

  /**
   * Splits a text for indexing and records how each term was spelled.
   */
  private remember(text: string): string[] {
    const words = splitWords(text);
    for (const word of words) {
      const term = normalizeTerm(word);
      if (term && !this.spelling.has(term)) this.spelling.set(term, word.toLowerCase());
    }
    return words;
  }

  /**
   * The schema index, built on the first schema search.
   */
  private schemaSearch(): MiniSearch<SchemaDocument> {
    if (this.schemaIndex) return this.schemaIndex;
    const search = new MiniSearch<SchemaDocument>({
      fields: Object.keys(SCHEMA_BOOST),
      tokenize: splitWords,
      processTerm: (term) => normalizeTerm(term),
      searchOptions: { ...SEARCH_OPTIONS, boost: SCHEMA_BOOST },
    });
    search.addAll(
      this.schemaNames.map((name, id) => {
        const { doc, props } = schemaDocument(this.index, name, id);
        this.schemaProps[id] = props;
        return doc;
      })
    );
    this.schemaIndex = search;
    return search;
  }
}
