/**
 * Ranking metrics and parsing of search output for the bench.
 */

const KEY_LINE = /^(GET|POST|PUT|PATCH|DELETE) (\S+)/;

/**
 * Endpoint keys in the order a search response lists them: JSON of 0.1.x or one line per endpoint of 0.2+.
 */
export function endpointKeys(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.endpoints)) return parsed.endpoints.map((e) => e.key);
  } catch {
    // Not JSON: the text format.
  }
  return text
    .split('\n')
    .map((line) => KEY_LINE.exec(line))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`);
}

/**
 * 1-based position of the first accepted key, or null.
 */
export function rankOf(keys, accepted) {
  const index = keys.findIndex((key) => accepted.includes(key));
  return index === -1 ? null : index + 1;
}

/**
 * top1/top5/top10 hit counts and mean reciprocal rank over a list of ranks.
 */
export function summarizeRanks(ranks) {
  const hits = (k) => ranks.filter((r) => r !== null && r <= k).length;
  const mrr = ranks.length ? ranks.reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / ranks.length : 0;
  return { n: ranks.length, top1: hits(1), top5: hits(5), top10: hits(10), mrr: Number(mrr.toFixed(3)) };
}

/**
 * Value at a quantile of a numeric list.
 */
export function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
