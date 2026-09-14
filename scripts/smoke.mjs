/**
 * Smoke test over stdio against a local fixture spec: configuration errors, tool sets, search and schema
 * rendering, auth selection and danger guards that fire before any network call, and secrets never echoed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER = new URL('../dist/index.js', import.meta.url).pathname;
const SPEC = new URL('./fixtures/pets.json', import.meta.url).pathname;
const SECRET = 'smoke-secret-value-7f3a';
const CACHE = mkdtempSync(path.join(tmpdir(), 'openapi-explorer-smoke-'));
const BASE_ENV = { OPENAPI_SPEC_URL: SPEC, OPENAPI_CACHE_DIR: CACHE };

/**
 * Starts the server, sends messages and collects responses until every request id is answered.
 */
const run = (env, messages = [], timeoutMs = 60_000) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Set(messages.filter((m) => m.id != null).map((m) => m.id));
    const responses = new Map();
    let buffer = '';
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
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
        pending.delete(message.id);
        if (pending.size === 0) child.kill();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, responses, stderr, stdout });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    if (pending.size === 0) child.stdin.end();
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

try {
  const noSpec = await run({ OPENAPI_CACHE_DIR: CACHE });
  check('exits without OPENAPI_SPEC_URL', noSpec.code === 1 && noSpec.stderr.includes('OPENAPI_SPEC_URL'), noSpec.stderr);

  const noBase = await run({ ...BASE_ENV, OPENAPI_AUTH_X_API_KEY: SECRET });
  check('credentials require OPENAPI_BASE_URL', noBase.code === 1 && noBase.stderr.includes('OPENAPI_BASE_URL'), noBase.stderr);

  const noEnvFile = await run({ ...BASE_ENV, OPENAPI_ENV_FILE: path.join(CACHE, 'missing.env') });
  check('a missing OPENAPI_ENV_FILE is an error', noEnvFile.code === 1 && noEnvFile.stderr.includes('OPENAPI_ENV_FILE'), noEnvFile.stderr);

  const readOnly = await run(BASE_ENV, [init, initialized, list(2)]);
  const expectedReadOnly = ['api_call_log', 'api_endpoint', 'api_get', 'api_schema', 'api_search', 'api_spec_info', 'api_types'];
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
  check('no api_auth or recipe without their configuration', !toolNames(main, 2).includes('api_auth') && !toolNames(main, 2).includes('recipe'));

  const info = json(main, 3);
  const apiKey = info?.securitySchemes?.find((s) => s.name === 'x-api-key');
  const bearer = info?.securitySchemes?.find((s) => s.name === 'bearer');
  check('spec info: version and scheme credential status', info?.version === '1.2.3' && apiKey?.credential === 'env' && bearer?.credential === 'not configured', text(main, 3));

  check('search finds GET /pets', (json(main, 4)?.endpoints ?? []).some((e) => e.key === 'GET /pets'), text(main, 4));
  check('endpoint lists security alternatives in spec order', JSON.stringify(json(main, 5)?.auth) === JSON.stringify(['x-api-key', 'bearer']), text(main, 5));
  check('schema outline expands nested fields', text(main, 6).includes('owner') && text(main, 6).includes('email'), text(main, 6));
  check('destructive call needs confirm_danger', isError(main, 7) && text(main, 7).includes('confirm_danger'), text(main, 7));
  check('write without credentials names the variable', isError(main, 8) && text(main, 8).includes('OPENAPI_AUTH_BEARER'), text(main, 8));
  check('unknown scheme in `as` is refused', isError(main, 9) && text(main, 9).includes('unknown security scheme'), text(main, 9));
  check('api_types generates the Pet type', !isError(main, 10) && (json(main, 10)?.types ?? '').includes('export type Pet'), text(main, 10));
  check('credential value never appears in output', !main.stdout.includes(SECRET) && !main.stderr.includes(SECRET));
} finally {
  rmSync(CACHE, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
