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
const api = createServer((req, res) => {
  const seen = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const source = SOURCES[String(value).replace(/^Bearer /, '')];
    if (source) seen[name] = source;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, path: req.url, seen }));
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
    let waitingFor = null;
    let buffer = '';
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const sendNext = () => {
      while (queue.length) {
        const message = queue.shift();
        child.stdin.write(`${JSON.stringify(message)}\n`);
        if (message.id != null) {
          waitingFor = message.id;
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
        if (message.id === waitingFor) sendNext();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, responses, stderr, stdout });
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
  ]);

  check('OPENAPI_ALLOW_WRITE registers api_request', toolNames(main, 2).includes('api_request'), toolNames(main, 2).join(', '));
  check('no recipe tool without OPENAPI_RECIPES_DIR', !toolNames(main, 2).includes('recipe'));
  check('spec info: version and scheme credential status', json(main, 3)?.version === '1.2.3' && credentialOf(main, 3, 'x-api-key') === 'env' && credentialOf(main, 3, 'bearer') === 'not configured', text(main, 3));
  check('search finds GET /pets', (json(main, 4)?.endpoints ?? []).some((e) => e.key === 'GET /pets'), text(main, 4));
  check('endpoint lists security alternatives in spec order', JSON.stringify(json(main, 5)?.auth) === JSON.stringify(['x-api-key', 'bearer']), text(main, 5));
  check('schema outline expands nested fields', text(main, 6).includes('owner') && text(main, 6).includes('email'), text(main, 6));
  check('destructive call needs confirm_danger', isError(main, 7) && text(main, 7).includes('confirm_danger'), text(main, 7));
  check('write without credentials names every way to supply one', isError(main, 8) && text(main, 8).includes('OPENAPI_AUTH_BEARER') && text(main, 8).includes('api_credentials'), text(main, 8));
  check('unknown scheme in `as` is refused', isError(main, 9) && text(main, 9).includes('unknown security scheme'), text(main, 9));
  check('api_types generates the Pet type', !isError(main, 10) && (json(main, 10)?.types ?? '').includes('export type Pet'), text(main, 10));
  check('credential value never appears in output', !leaks(main.stdout, main.stderr));

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
  const journal = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
  check('the journal names the credential source, not the value', journal.includes('bearer (call)') && journal.includes('bearer (session)') && !leaks(journal), journal);
  check('supplied values never appear in output', !leaks(live.stdout, live.stderr));

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
