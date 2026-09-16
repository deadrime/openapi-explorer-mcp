/**
 * Bench: runs a server over stdio against a query file and reports search quality, latency and response sizes.
 *
 *   node scripts/bench/run.mjs <queries.json> [--spec <file|url>] [--server "<command>"] [--runs 5]
 *                                            [--json <report.json>] [--compare <previous report.json>]
 *
 * The query file holds `env` for the server (relative paths resolve against the file, ${VAR} expands from the
 * environment), `queries` with the endpoints each one should find, and `calls` whose response sizes are measured.
 * Compare two servers on the same spec snapshot, e.g. --server "npx -y openapi-explorer-mcp@0.1.0".
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { endpointKeys, quantile, rankOf, summarizeRanks } from './metrics.mjs';
import { countTokens } from './tokens.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    spec: { type: 'string' },
    server: { type: 'string', default: `node ${path.join(ROOT, 'dist/index.js')}` },
    runs: { type: 'string', default: '5' },
    json: { type: 'string' },
    compare: { type: 'string' },
  },
});
if (positionals.length !== 1) {
  console.error('usage: node scripts/bench/run.mjs <queries.json> [--spec] [--server] [--runs] [--json] [--compare]');
  process.exit(2);
}

const file = path.resolve(positionals[0]);
const base = path.dirname(file);
const suite = JSON.parse(readFileSync(file, 'utf8'));
const runs = Math.max(1, Number(opts.runs));

/**
 * Expands ${VAR} and resolves ./relative paths against the query file.
 */
function resolveEnvValue(value) {
  const expanded = String(value).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
  return /^\.\.?\//.test(expanded) ? path.resolve(base, expanded) : expanded;
}

const cacheDir = mkdtempSync(path.join(tmpdir(), 'openapi-explorer-bench-'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, OPENAPI_CACHE_DIR: cacheDir };
for (const [key, value] of Object.entries(suite.env ?? {})) env[key] = resolveEnvValue(value);
if (opts.spec) env.OPENAPI_SPEC_URL = /^https?:\/\//.test(opts.spec) ? opts.spec : path.resolve(opts.spec);
if (!env.OPENAPI_SPEC_URL) {
  console.error('no spec: set env.OPENAPI_SPEC_URL in the query file or pass --spec');
  process.exit(2);
}
if (!/^https?:\/\//.test(env.OPENAPI_SPEC_URL) && !existsSync(env.OPENAPI_SPEC_URL)) {
  console.error(`spec file not found: ${env.OPENAPI_SPEC_URL}`);
  process.exit(2);
}

const [command, ...args] = opts.server.split(/\s+/).filter(Boolean);
const client = new Client({ name: 'openapi-explorer-bench', version: '0' });

/**
 * Calls a tool and returns its text, duration and error flag.
 */
async function call(name, args) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
  return { text, ms: performance.now() - started, isError: result.isError === true };
}

const report = { file: path.relative(ROOT, file), server: opts.server, spec: env.OPENAPI_SPEC_URL, runs, at: new Date().toISOString() };

try {
  const started = performance.now();
  await client.connect(new StdioClientTransport({ command, args, env, stderr: 'inherit' }));
  report.initMs = Math.round(performance.now() - started);

  const { tools } = await client.listTools();
  report.toolTokens = Object.fromEntries(tools.map((t) => [t.name, countTokens(JSON.stringify(t))]));
  report.toolsListTokens = countTokens(JSON.stringify(tools));
  report.instructionsTokens = countTokens(client.getInstructions() ?? '');

  const first = await call('api_spec_info', {});
  if (first.isError) throw new Error(`api_spec_info failed: ${first.text}`);
  report.firstCallMs = Math.round(first.ms);

  report.queries = [];
  for (const query of suite.queries ?? []) {
    const times = [];
    let response;
    for (let i = 0; i < runs; i += 1) {
      response = await call('api_search', { query: query.q, ...(query.args ?? {}) });
      times.push(response.ms);
    }
    const keys = endpointKeys(response.text);
    report.queries.push({
      q: query.q,
      kind: query.kind ?? 'other',
      rank: rankOf(keys, query.expect),
      shown: keys.length,
      tokens: countTokens(response.text),
      medianMs: Number(quantile(times, 0.5).toFixed(2)),
      p95Ms: Number(quantile(times, 0.95).toFixed(2)),
      error: response.isError || undefined,
    });
  }

  report.calls = [];
  for (const item of suite.calls ?? []) {
    const response = await call(item.tool, item.args ?? {});
    report.calls.push({ label: item.label ?? `${item.tool} ${JSON.stringify(item.args ?? {})}`, tokens: countTokens(response.text), ms: Math.round(response.ms), error: response.isError || undefined });
  }
} finally {
  await client.close().catch(() => {});
  rmSync(cacheDir, { recursive: true, force: true });
}

// Aggregates.
const queries = report.queries;
const kinds = [...new Set(queries.map((q) => q.kind))];
report.summary = {
  ...summarizeRanks(queries.map((q) => q.rank)),
  tokensPerQuery: queries.length ? Math.round(queries.reduce((a, q) => a + q.tokens, 0) / queries.length) : 0,
  medianMs: Number(quantile(queries.map((q) => q.medianMs), 0.5).toFixed(2)),
  p95Ms: Number(quantile(queries.map((q) => q.p95Ms), 0.95).toFixed(2)),
};
report.byKind = Object.fromEntries(kinds.map((kind) => [kind, summarizeRanks(queries.filter((q) => q.kind === kind).map((q) => q.rank))]));

if (opts.json) writeFileSync(path.resolve(opts.json), `${JSON.stringify(report, null, 2)}\n`);

// Output.
const previous = opts.compare ? JSON.parse(readFileSync(path.resolve(opts.compare), 'utf8')) : null;
const delta = (now, before) => (before === undefined ? '' : ` (${now - before >= 0 ? '+' : ''}${Number((now - before).toFixed(3))})`);

console.log(`${report.file} · ${report.server} · runs ${runs}`);
console.log(`init ${report.initMs} ms · first call ${report.firstCallMs} ms · tools/list ${report.toolsListTokens} tokens${delta(report.toolsListTokens, previous?.toolsListTokens)} · instructions ${report.instructionsTokens} tokens`);
if (queries.length) {
  const s = report.summary;
  const p = previous?.summary ?? {};
  console.log(
    `search n=${s.n}: top1 ${s.top1}${delta(s.top1, p.top1)} · top5 ${s.top5}${delta(s.top5, p.top5)} · top10 ${s.top10}${delta(s.top10, p.top10)} · MRR ${s.mrr}${delta(s.mrr, p.mrr)} · ` +
      `${s.tokensPerQuery} tokens/query${delta(s.tokensPerQuery, p.tokensPerQuery)} · median ${s.medianMs} ms · p95 ${s.p95Ms} ms`
  );
  console.table(Object.fromEntries(Object.entries(report.byKind).map(([kind, k]) => [kind, { n: k.n, top1: k.top1, top5: k.top5, top10: k.top10, mrr: k.mrr }])));
  const before = new Map((previous?.queries ?? []).map((q) => [q.q, q]));
  console.table(
    queries.map((q) => ({
      query: q.q,
      kind: q.kind,
      rank: q.rank ?? '—',
      ...(previous ? { was: before.get(q.q)?.rank ?? '—' } : {}),
      shown: q.shown,
      tokens: q.tokens,
      ...(previous ? { wasTokens: before.get(q.q)?.tokens ?? '' } : {}),
      ms: q.medianMs,
      ...(q.error ? { error: true } : {}),
    }))
  );
}
if (report.calls.length) {
  const before = new Map((previous?.calls ?? []).map((c) => [c.label, c]));
  console.table(report.calls.map((c) => ({ call: c.label, tokens: c.tokens, ...(previous ? { was: before.get(c.label)?.tokens ?? '' } : {}), ms: c.ms, ...(c.error ? { error: true } : {}) })));
}
