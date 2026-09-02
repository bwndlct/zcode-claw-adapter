import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'adapter', 'bin', 'zcode-claw-adapter.mjs');

const env = {
  ...process.env,
  // Keep discovery deterministic: never touch PATH/real desktop config.
  ZCODE_BIN: '/nonexistent-zcode-for-tests',
  ZCODE_DESKTOP_CONFIG: '/nonexistent-config-for-tests',
  ZCODE_APPSERVER_KEY: '',
};

test('CLI --version prints package version', async () => {
  const { stdout } = await run('node', [CLI, '--version'], { env });
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  assert.equal(stdout.trim(), pkg.version);
});

test('CLI --help shows wrapper and engine usage', async () => {
  const { stdout } = await run('node', [CLI, '--help'], { env });
  assert.match(stdout, /zcode-claw-adapter — Claw custom engine/);
  assert.match(stdout, /ZCODE_BIN/);
  assert.match(stdout, /--- engine options ---/);
  assert.match(stdout, /--max-tool-concurrency/);
});

test('CLI rejects unknown arguments with exit code 2', async () => {
  await assert.rejects(
    run('node', [CLI, '--definitely-not-a-flag'], { env }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /unknown or unsupported argument/);
      // The error must not leak credential-looking environment material.
      assert.doesNotMatch(err.stderr, /ZCODE_APPSERVER_KEY=|apiKey/i);
      return true;
    },
  );
});

test('CLI validates --max-tool-concurrency as positive integer', async () => {
  await assert.rejects(
    run('node', [CLI, '--max-tool-concurrency', 'zero'], { env }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /positive integer/);
      return true;
    },
  );
});
