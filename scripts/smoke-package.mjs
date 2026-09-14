/**
 * Packs the package, installs the tarball into a clean directory the way a user would — dependencies resolved
 * from the registry — and runs the smoke test against that install. It catches what the repository's own
 * node_modules hide, such as a peer dependency resolving to an incompatible major version.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(path.join(tmpdir(), 'openapi-explorer-package-'));

try {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  // Scripts are skipped so their output doesn't mix into the JSON; the build above already ran.
  const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: root, encoding: 'utf8' }));
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'package-smoke', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', path.join(work, filename)], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });

  const version = (pkg) => JSON.parse(readFileSync(path.join(work, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  console.log(`installed ${filename}: typescript ${version('typescript')}, @hey-api/openapi-ts ${version('@hey-api/openapi-ts')}\n`);

  const result = spawnSync(process.execPath, [path.join(root, 'scripts/smoke.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, OEM_SERVER: path.join(work, 'node_modules/openapi-explorer-mcp/dist/index.js') },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
