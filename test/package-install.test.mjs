import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('packed npm artifact installs a working global CLI without network access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zca-package-'));
  const packDir = join(root, 'pack');
  const prefix = join(root, 'prefix');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(packDir);

  const { stdout } = await run(
    'npm',
    ['pack', '--json', '--pack-destination', packDir, REPO],
    { cwd: root },
  );
  const [{ filename }] = JSON.parse(stdout);
  await run(
    'npm',
    [
      'install', '-g', join(packDir, filename), '--prefix', prefix,
      '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    ],
    { cwd: root },
  );

  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  const bin = join(prefix, process.platform === 'win32' ? 'zcode-claw-adapter.cmd' : 'bin/zcode-claw-adapter');
  const version = await run(bin, ['--version'], {
    cwd: root,
    env: {
      ...process.env,
      ZCODE_BIN: '/nonexistent-zcode-for-tests',
      ZCODE_DESKTOP_CONFIG: '/nonexistent-config-for-tests',
      ZCODE_APPSERVER_KEY: '',
    },
  });
  assert.equal(version.stdout.trim(), pkg.version);
});
