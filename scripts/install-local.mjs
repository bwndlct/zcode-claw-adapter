#!/usr/bin/env node

import { chmod, copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repoRoot, 'adapter');
const targetRoot = join(homedir(), '.local', 'share', 'zcode-claw', 'adapter');

const files = [
  { path: 'bin/zcode-app-server.mjs', mode: 0o755 },
  { path: 'bin/zcode-engine-launcher.sh', mode: 0o755 },
  { path: 'lib/state.mjs', mode: 0o644 },
  { path: 'lib/zcode-client.mjs', mode: 0o644 },
];

async function installFile(file) {
  const source = join(sourceRoot, file.path);
  const target = join(targetRoot, file.path);
  const temporary = `${target}.tmp-${process.pid}`;

  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, temporary);
    await chmod(temporary, file.mode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function main() {
  for (const file of files) await installFile(file);
  process.stdout.write(`Installed ZCode Claw adapter to ${targetRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`Failed to install ZCode Claw adapter: ${error.message}\n`);
  process.exitCode = 1;
});
