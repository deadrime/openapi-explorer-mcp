/**
 * Smoke test over stdio against local fixture specs: configuration errors, tool sets, search and schema
 * rendering, auth selection and danger guards, credentials from a call, the session and the environment reaching
 * a local API in the right place, and secrets never echoed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// OEM_SERVER points the smoke at another install, e.g. the packed tarball installed by smoke-package.mjs.
const SERVER = process.env.OEM_SERVER ?? new URL('../dist/index.js', import.meta.url).pathname;
const SPEC = new URL('./fixtures/pets.json', import.meta.url).pathname;
const SECRET = 'smoke-secret-value-7f3a';
const CALL_SECRET = 'smoke-call-token-91bd';
const SESSION_SECRET = 'smoke-session-token-c42e';
const ALL_SECRETS = [SECRET, CALL_SECRET, SESSION_SECRET];
const CACHE = mkdtempSync(path.join(tmpdir(), 'openapi-explorer-smoke-'));
const BASE_ENV = { OPENAPI_SPEC_URL: SPEC, OPENAPI_CACHE_DIR: CACHE };

// A local API that reports which known secret arrived in which header, never the secret itself.
const SOURCES = { [SECRET]: 'env', [CALL_SECRET]: 'call', [SESSION_SECRET]: 'session' };
// A spec served over HTTP whose version the test can switch, with an optional delay.
const served = { version: '1.0.0', delayMs: 0 };
const servedSpec = () => ({
  openapi: '3.0.3',
  info: { title: 'Served', version: served.version },
  paths: {
    '/ping': { get: { operationId: 'ping', responses: { 200: { description: 'ok' } } } },
    ...(served.version === '1.0.0' ? {} : { '/pong': { get: { operationId: 'pong', responses: { 200: { description: 'ok' } } } } }),
  },
});
const api = createServer((req, res) => {
  if (req.url === '/spec.json') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(servedSpec()));
    }, served.delayMs);
    return;
  }
  const seen = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const source = SOURCES[String(value).replace(/^Bearer /, '')];
    if (source) seen[name] = source;
  }
  // A list to narrow: 5 items, or 50 with ?big=1.
  const count = new URL(req.url, 'http://local').searchParams.has('big') ? 50 : 5;
  const items = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `pet ${i + 1}`, tags: ['a', 'b', 'c'] }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, path: req.url, seen, items }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${api.address().port}`;

/**
 * Starts the server and sends messages one request at a time, so tools that change session state run in order.
 */
const run = (env, messages = [], timeoutMs = 60_000) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const queue = [...messages];
    const responses = new Map();
    const sentAt = new Map();
    const elapsed = new Map();
    let waitingFor = null;
    let buffer = '';
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const sendNext = () => {
      while (queue.length) {
        const message = queue.shift();
        // A step of the scenario rather than a message: run an action, then pause.
        if (message.wait !== undefined || message.act) {
          message.act?.();
          setTimeout(sendNext, message.wait ?? 0);
          return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
        if (message.id != null) {
          waitingFor = message.id;
          sentAt.set(message.id, Date.now());
          return;
        }
      }
      child.kill();
    };
    // A server that exits on a configuration error closes stdin under us; that is an expected outcome, not a crash.
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        responses.set(message.id, message);
        if (sentAt.has(message.id)) elapsed.set(message.id, Date.now() - sentAt.get(message.id));
        if (message.id === waitingFor) sendNext();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, responses, stderr, stdout, elapsed });
    });
    if (messages.length) sendNext();
    else child.stdin.end();
  });

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const list = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

const failures = [];
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${!condition && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures.push(label);
};
const toolNames = (r, id) => (r.responses.get(id)?.result?.tools ?? []).map((t) => t.name).sort();
const text = (r, id) => r.responses.get(id)?.result?.content?.[0]?.text ?? '';
const isError = (r, id) => r.responses.get(id)?.result?.isError === true;
const json = (r, id) => {
  try {
    return JSON.parse(text(r, id));
  } catch {
    return null;
  }
};
const credentialOf = (r, id, scheme) => json(r, id)?.securitySchemes?.find((s) => s.name === scheme)?.credential;
const leaks = (...chunks) => ALL_SECRETS.some((secret) => chunks.some((chunk) => chunk.includes(secret)));

try {
  const noSpec = await run({ OPENAPI_CACHE_DIR: CACHE });
  check('exits without OPENAPI_SPEC_URL', noSpec.code === 1 && noSpec.stderr.includes('OPENAPI_SPEC_URL'), noSpec.stderr);

  const noBase = await run({ ...BASE_ENV, OPENAPI_AUTH_X_API_KEY: SECRET });
  check('credentials in the environment require OPENAPI_BASE_URL', noBase.code === 1 && noBase.stderr.includes('OPENAPI_BASE_URL'), noBase.stderr);

  const noEnvFile = await run({ ...BASE_ENV, OPENAPI_ENV_FILE: path.join(CACHE, 'missing.env') });
  check('a missing OPENAPI_ENV_FILE is an error', noEnvFile.code === 1 && noEnvFile.stderr.includes('OPENAPI_ENV_FILE'), noEnvFile.stderr);

  const readOnly = await run(BASE_ENV, [init, initialized, list(2)]);
  const expectedReadOnly = ['api_call_log', 'api_credentials', 'api_endpoint', 'api_get', 'api_schema', 'api_search', 'api_spec_info', 'api_types'];
  check('read-only tool set', JSON.stringify(toolNames(readOnly, 2)) === JSON.stringify(expectedReadOnly), toolNames(readOnly, 2).join(', '));

  const writeEnv = { ...BASE_ENV, OPENAPI_BASE_URL: 'https://api.example.com', OPENAPI_AUTH_X_API_KEY: SECRET, OPENAPI_ALLOW_WRITE: 'true' };
  const main = await run(writeEnv, [
    init,
    initialized,
    list(2),
    call(3, 'api_spec_info', {}),
    call(4, 'api_search', { query: 'pets' }),
    call(5, 'api_endpoint', { endpoint: 'GET /admin/stats' }),
    call(6, 'api_schema', { name: 'Pet' }),
    call(7, 'api_request', { method: 'DELETE', endpoint: 'DELETE /pets/{petId}', path_params: { petId: '1' } }),
    call(8, 'api_request', { method: 'POST', endpoint: 'POST /pets', body: { name: 'Rex' } }),
    call(9, 'api_get', { endpoint: 'GET /pets', as: 'nope' }),
    call(10, 'api_types', { endpoint: 'GET /pets' }),
    call(11, 'api_schema', { name: 'Pet' }),
    call(12, 'api_schema', { name: 'Category', mode: 'json', depth: 6 }),
    call(13, 'api_schema', { name: 'Owner' }),
    call(14, 'api_types', { endpoint: 'GET /pets', name_prefix: 'X' }),
    call(15, 'api_search', { query: 'list all pets' }),
    call(16, 'api_search', { query: 'owner emaill' }),
    call(17, 'api_search', { query: 'email', scope: 'schemas' }),
    call(18, 'api_search', { query: 'zzqx' }),
    call(19, 'api_schema', { name: 'Categry' }),
    call(20, 'api_endpoint', { endpoint: 'GET /pets' }),
    call(21, 'api_types', { endpoint: 'GET /pets', docs: false }),
  ]);

  check('OPENAPI_ALLOW_WRITE registers api_request', toolNames(main, 2).includes('api_request'), toolNames(main, 2).join(', '));
  check('no recipe tool without OPENAPI_RECIPES_DIR', !toolNames(main, 2).includes('recipe'));
  check('JSON results are compact', text(main, 3).length > 0 && !text(main, 3).includes('\n'), text(main, 3));
  check('spec info: version and scheme credential status', json(main, 3)?.version === '1.2.3' && credentialOf(main, 3, 'x-api-key') === 'env' && credentialOf(main, 3, 'bearer') === 'not configured', text(main, 3));
  check('search lists endpoints one per line', text(main, 4).split('\n').some((line) => line.startsWith('GET /pets — List pets')), text(main, 4));
  check('endpoint lists security alternatives in spec order', text(main, 5).includes('auth: x-api-key | bearer'), text(main, 5));
  check('schema outline expands nested fields', text(main, 6).includes('owner') && text(main, 6).includes('email'), text(main, 6));
  check('destructive call needs confirm_danger', isError(main, 7) && text(main, 7).includes('confirm_danger'), text(main, 7));
  check('write without credentials names every way to supply one', isError(main, 8) && text(main, 8).includes('OPENAPI_AUTH_BEARER') && text(main, 8).includes('api_credentials'), text(main, 8));
  check('unknown scheme in `as` is refused', isError(main, 9) && text(main, 9).includes('unknown security scheme'), text(main, 9));
  check('api_types generates the Pet type', !isError(main, 10) && text(main, 10).includes('export type Pet = {'), text(main, 10));
  check('credential value never appears in output', !leaks(main.stdout, main.stderr));

  const lines = (id) => text(main, id).split('\n');
  check('search ranks a natural phrase', lines(15)[1]?.startsWith('GET /pets —'), text(main, 15));
  check('search tolerates a typo and matches body fields', lines(16).some((line) => line.startsWith('GET /pets —') && /field .*email/.test(line)), text(main, 16));
  check('schema scope finds a schema by its field', lines(17).some((line) => line.startsWith('Owner') && line.includes('field email')), text(main, 17));
  check('an empty search explains how to search instead of failing', !isError(main, 18) && text(main, 18).startsWith('nothing matched "zzqx"'), text(main, 18));
  check('an unknown schema name suggests similar ones', isError(main, 19) && text(main, 19).includes('Category'), text(main, 19));
  const pets = text(main, 20);
  check('endpoint shows the operation description', pets.includes('Pets in the shelter, newest first.'), pets);
  check('endpoint shows parameter types, defaults, ranges and enums', pets.includes('limit?: integer (default 20, ..100) — Page size') && pets.includes("status?: 'available' | 'sold'"), pets);
  check('endpoint lists errors and folds bare statuses', pets.includes('400 (body Problem)') && pets.includes('also: 401'), pets);
  check('types use two-space indent and one-line doc comments', text(main, 10).includes('export type Pet = {\n  id: string;\n  /** Pet name */\n  name: string;'), text(main, 10));
  check('types without docs have no comments', !isError(main, 21) && !text(main, 21).includes('/**') && text(main, 21).includes('export type Pet'), text(main, 21));

  const petOutline = text(main, 11);
  check('outline names formats instead of printing patterns', petOutline.includes('id: string (uuid)') && petOutline.includes('bornAt?: string (date-time)') && !petOutline.includes('[0-9a-fA-F]'), petOutline);
  check('outline lists a 12-value enum in full', petOutline.includes("'k12'"), petOutline);
  check('outline cuts long descriptions at a word', petOutline.includes('vaccination history and…'), petOutline);
  check('outline marks a self-referencing schema as a cycle', petOutline.includes("parent?: Category (cycle → api_schema('Category'))"), petOutline);
  check('json mode stops at a cycle', !isError(main, 12) && text(main, 12).includes('"parent":{"$ref":"Category","note":"cycle"}'), text(main, 12));
  check('schema usage follows references between schemas', text(main, 13).startsWith('Owner · through other schemas: GET /pets'), text(main, 13));
  const petTypes = text(main, 10);
  check('types keep null of a nullable enum', petTypes.includes("status?: 'available' | 'sold' | null"), petTypes);
  check('types include the components a type references', petTypes.includes('export type Owner') && petTypes.includes('export type Category'), petTypes);
  const prefixed = text(main, 14);
  check(
    'name_prefix renames references but not comments',
    prefixed.includes('owner?: XOwner') && prefixed.includes('export type XListPetsResponse = XPet[]') && prefixed.includes('Pet name') && !prefixed.includes('XPet name'),
    prefixed
  );

  const callLog = path.join(CACHE, 'live-calls.jsonl');
  const live = await run({ ...BASE_ENV, OPENAPI_BASE_URL: API, OPENAPI_AUTH_X_API_KEY: SECRET, OPENAPI_ALLOW_WRITE: 'true', OPENAPI_CALL_LOG: callLog }, [
    init,
    initialized,
    call(2, 'api_request', { method: 'POST', endpoint: 'POST /pets', body: { name: 'Rex' }, credentials: { bearer: CALL_SECRET } }),
    call(3, 'api_credentials', { set: { bearer: SESSION_SECRET } }),
    call(4, 'api_request', { method: 'POST', endpoint: 'POST /pets', body: { name: 'Rex' } }),
    call(5, 'api_get', { endpoint: 'GET /admin/stats' }),
    call(6, 'api_get', { endpoint: 'GET /admin/stats', credentials: { 'X-API-KEY': CALL_SECRET } }),
    call(7, 'api_get', { endpoint: 'GET /admin/stats', as: 'bearer', credentials: { bearer: CALL_SECRET } }),
    call(8, 'api_get', { endpoint: 'GET /pets', credentials: { 'x-admin-token': CALL_SECRET } }),
    call(9, 'api_credentials', { clear: ['bearer'] }),
    call(10, 'api_request', { method: 'POST', endpoint: 'POST /pets', body: { name: 'Rex' } }),
    call(11, 'api_get', { endpoint: 'GET /pets', fields: ['seen', 'items[].id', 'nope'], max_items: 2 }),
    call(12, 'api_get', { endpoint: 'GET /pets', fields: ['items..id'] }),
  ]);
  const seen = (id) => json(live, id)?.body?.seen ?? {};

  check('a call credential goes where its scheme says', seen(2).authorization === 'call' && json(live, 2)?.auth === 'bearer (call)', text(live, 2));
  check('api_credentials keeps a credential for the session', credentialOf(live, 3, 'bearer') === 'session' && json(live, 3)?.baseUrl === API, text(live, 3));
  check('a session credential is used by later calls', seen(4).authorization === 'session' && json(live, 4)?.auth === 'bearer (session)', text(live, 4));
  check('auto takes the first alternative, here from the environment', seen(5)['x-api-key'] === 'env' && json(live, 5)?.auth === 'x-api-key (env)', text(live, 5));
  check('a header name finds its apiKey scheme and the call wins over the environment', seen(6)['x-api-key'] === 'call' && json(live, 6)?.auth === 'x-api-key (call)', text(live, 6));
  check('a call credential wins over the session', seen(7).authorization === 'call', text(live, 7));
  check('an unknown credential key is refused', isError(live, 8) && text(live, 8).includes('unknown credential'), text(live, 8));
  check('clear forgets a session credential', credentialOf(live, 9, 'bearer') === 'not configured' && (json(live, 9)?.forgotten ?? []).includes('bearer'), text(live, 9));
  check('after clear a write needs a credential again', isError(live, 10) && text(live, 10).includes('api_credentials'), text(live, 10));
  const narrowed = json(live, 11);
  check(
    'fields and max_items narrow a response and report what they cut',
    JSON.stringify(narrowed?.body?.items) === '[{"id":1},{"id":2}]' && narrowed?.body?.seen !== undefined && narrowed?.body?.path === undefined && narrowed?.arrays?.items === 5,
    text(live, 11)
  );
  check('a field path that matches nothing is reported', JSON.stringify(narrowed?.missing) === '["nope"]', text(live, 11));
  check('a malformed field path is refused', isError(live, 12) && text(live, 12).includes('items..id'), text(live, 12));
  const journal = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
  check('the journal names the credential source, not the value', journal.includes('bearer (call)') && journal.includes('bearer (session)') && !leaks(journal), journal);
  check('supplied values never appear in output', !leaks(live.stdout, live.stderr));

  const small = await run({ ...BASE_ENV, OPENAPI_BASE_URL: API, OPENAPI_MAX_RESPONSE_CHARS: '900' }, [init, initialized, call(2, 'api_get', { endpoint: 'GET /pets', query: { big: 1 } })]);
  const fitted = json(small, 2);
  check(
    'a response over the limit gets its arrays cut instead of being truncated',
    fitted !== null && fitted.arrays?.items === 50 && fitted.body.items.length < 50 && String(fitted.autoCapped ?? '').includes('fields'),
    text(small, 2)
  );

  const background = await run({ OPENAPI_SPEC_URL: `${API}/spec.json`, OPENAPI_SPEC_TTL_S: '1', OPENAPI_CACHE_DIR: path.join(CACHE, 'served') }, [
    init,
    initialized,
    call(2, 'api_spec_info', {}),
    { wait: 1100, act: () => Object.assign(served, { version: '2.0.0', delayMs: 1500 }) },
    call(3, 'api_search', { query: 'ping' }),
    { wait: 1800 },
    call(4, 'api_search', { query: 'ping' }),
    call(5, 'api_search', { query: 'ping' }),
    call(6, 'api_spec_info', { refresh: true }),
  ]);
  check('a stale URL spec is served at once and revalidated in the background', background.elapsed.get(3) < 800 && text(background, 3).includes('GET /ping'), `${background.elapsed.get(3)} ms: ${text(background, 3)}`);
  check('a background update is announced once', text(background, 4).includes('the spec was updated: 1.0.0 → 2.0.0, +1') && !text(background, 5).includes('updated'), `${text(background, 4)} / ${text(background, 5)}`);
  check('refresh waits for the source', json(background, 6)?.version === '2.0.0' && JSON.stringify(json(background, 6)?.changed?.added) === '["GET /pong"]', text(background, 6));

  const plainSpec = path.join(CACHE, 'plain.json');
  writeFileSync(
    plainSpec,
    JSON.stringify({ openapi: '3.0.3', info: { title: 'Plain', version: '1' }, servers: [{ url: API }], paths: { '/ping': { get: { operationId: 'ping', responses: { 200: { description: 'ok' } } } } } })
  );
  const plain = await run({ OPENAPI_SPEC_URL: plainSpec, OPENAPI_CACHE_DIR: path.join(CACHE, 'plain') }, [
    init,
    initialized,
    call(2, 'api_credentials', { set: { 'X-Api-Key': SESSION_SECRET } }),
    call(3, 'api_get', { endpoint: 'GET /ping' }),
    call(4, 'api_get', { endpoint: 'GET /ping', credentials: { 'not a header': CALL_SECRET } }),
  ]);
  check('without security schemes keys are headers, sent to the server of the spec', json(plain, 3)?.body?.seen?.['x-api-key'] === 'session' && json(plain, 3)?.auth === 'header x-api-key (session)', text(plain, 3));
  check('an invalid header name is refused', isError(plain, 4) && text(plain, 4).includes('not a valid header name'), text(plain, 4));
  check('header values never appear in output', !leaks(plain.stdout, plain.stderr));
} finally {
  api.close();
  api.closeAllConnections();
  rmSync(CACHE, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
