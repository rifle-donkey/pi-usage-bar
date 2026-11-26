import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('AC6 package declares only the approved Pi entry point and no install scripts or runtime dependencies', async () => {
  const p = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(p.name, '@rifle-donkey/pi-usage-bar');
  assert.equal(p.private ?? false, false);
  assert.deepEqual(p.pi?.extensions, ['./extensions/usage-bar.ts']);
  assert.ok(p.keywords?.includes('pi-package'));
  assert.match(typeof p.repository === 'string' ? p.repository : p.repository?.url, /rifle-donkey\/pi-usage-bar/);
  assert.deepEqual(Object.keys(p.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(p.scripts ?? {}).filter(name => /^(?:install|preinstall$|postinstall$)/.test(name)), []);
  await assert.rejects(lstat(join(root, 'scripts', 'install.sh')), { code: 'ENOENT' });
  assert.equal(p.version, '0.2.0');
});

test('AC6 offline npm dry run packs exactly seven approved files', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'usage-bar-pack-qa-'));
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline',
      '--cache', join(scratch, 'cache'), '--userconfig', join(scratch, 'user.npmrc'),
      '--globalconfig', join(scratch, 'global.npmrc')], {
      cwd: root, env: { PATH: process.env.PATH, HOME: scratch, npm_config_update_notifier: 'false' },
      encoding: 'utf8', timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const [packed] = JSON.parse(result.stdout);
    assert.deepEqual(packed.files.map(file => file.path).sort(), [
      'CHANGELOG.md', 'LICENSE', 'README.md', 'extensions/usage-bar.ts', 'package.json', 'src/copilot.ts', 'src/usage.ts',
    ]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
