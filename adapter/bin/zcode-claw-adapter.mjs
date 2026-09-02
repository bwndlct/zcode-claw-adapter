#!/usr/bin/env node
// zcode-claw-adapter — public npm CLI entry for the ZCode Claw custom engine.
//
// This is a thin, credential-safe wrapper around the protocol core in
// zcode-app-server.mjs. It owns the public CLI contract (--help/--version),
// the ZCode binary discovery order, and the OPTIONAL convenience of reading a
// credential from the local ZCode Desktop config. Explicit configuration
// always wins:
//
//   ZCode binary:  --zcode-bin <path>  >  $ZCODE_BIN  >  `zcode` on PATH
//                  > /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
//   Credential:    $ZCODE_APPSERVER_KEY (or --api-key-env NAME)
//                  > ZCode Desktop config ($ZCODE_DESKTOP_CONFIG, optional)
//
// Credentials are only ever passed via the child process environment; they are
// never written to argv, stdout, logs, or state files.

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PROG = 'zcode-claw-adapter';
const MACOS_APP_ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `${PROG} — Claw custom engine backed by ZCode app-server

Usage: ${PROG} [options]

Spawns \`zcode app-server --stdio\` and translates Claw stream-json on
stdin/stdout. All protocol options are documented by the underlying engine:

  --help                  Show the full engine option list
  --version               Print the adapter version

Environment:
  ZCODE_BIN               ZCode CLI entry (overrides autodiscovery)
  ZCODE_APPSERVER_KEY     API key the zcode child resolves (primary auth entry)
  ZCODE_DESKTOP_CONFIG    Optional ZCode Desktop config fallback for the key
  ZCODE_CLAW_STATE_DIR    Adapter state directory

ZCode binary discovery order: --zcode-bin, then $ZCODE_BIN, then \`zcode\`
on PATH, then the macOS application bundle path.
`;

function cliFail(message, code = 2) {
  process.stderr.write(`${PROG}: ${message}\n`);
  process.exit(code);
}

const PKG_NAME = '@bwndlct/zcode-claw-adapter';

async function readVersion() {
  // Local runtime copy: adapter/bin -> adapter/package.json (written by
  // install-local). npm/repo layout: adapter/bin -> <root>/package.json.
  // The runtime copy's PARENT may hold an unrelated package.json (the host
  // Claw runtime dir), so candidates are name-checked before use.
  const candidates = [join(HERE, '..', 'package.json'), join(HERE, '..', '..', 'package.json')];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(await readFile(file, 'utf8'));
      if (pkg.name === PKG_NAME && pkg.version) return pkg.version;
    } catch { /* try the next layout */ }
  }
  return 'unknown';
}

/** Find an executable `zcode` candidate on PATH (first writable-match wins). */
async function findOnPath(name) {
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
}

/**
 * Optional convenience: read the first enabled Z.AI provider apiKey from the
 * ZCode Desktop config. Mirrors the jq selection the legacy shell launcher
 * used, without the jq dependency. Returns null when unavailable; never
 * throws and never logs the value.
 */
async function readDesktopConfigKey() {
  const file = process.env.ZCODE_DESKTOP_CONFIG
    ?? join(homedir(), '.zcode', 'v2', 'config.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const config = JSON.parse(raw);
    const providers = Object.values(config?.provider ?? {});
    const match = providers.find((p) =>
      p && typeof p === 'object'
      && p.enabled !== false
      && (p.systemDisabledReason ?? '') === ''
      && typeof p.options?.apiKey === 'string' && p.options.apiKey.length > 0
      && String(p.options.baseURL ?? '').toLowerCase().includes('z.ai'));
    return match ? match.options.apiKey : null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);

  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      // The core parses --help before any side effects and prints its own
      // detailed engine option list, then exits 0.
      process.stdout.write(HELP);
      process.stdout.write('\n--- engine options ---\n');
      await import('./zcode-app-server.mjs');
      return;
    }
    if (a === '--version' || a === '-V') {
      process.stdout.write(`${await readVersion()}\n`);
      process.exit(0);
    }
  }

  const hasZcodeBinFlag = argv.some((a, i) => a === '--zcode-bin' && i + 1 < argv.length);

  // ZCode binary discovery: explicit flag/env win; otherwise PATH, then bundle.
  if (!hasZcodeBinFlag && !process.env.ZCODE_BIN) {
    const onPath = await findOnPath('zcode');
    if (onPath) process.env.ZCODE_BIN = onPath;
    else if (process.platform === 'darwin') process.env.ZCODE_BIN = MACOS_APP_ZCODE;
  }

  // Credential convenience: only when the primary env entry is unset. The
  // value stays in the environment; nothing is echoed.
  if (!process.env.ZCODE_APPSERVER_KEY) {
    const key = await readDesktopConfigKey();
    if (key) process.env.ZCODE_APPSERVER_KEY = key;
    else process.stderr.write(
      `[${PROG}] note: no credential found via ZCODE_APPSERVER_KEY or the ZCode Desktop config; `
      + 'the zcode child must obtain auth another way (e.g. --registry-fd or --api-key-env)\n',
    );
  }

  // Hand control to the protocol core with our argv in place.
  process.argv = [process.argv[0], 'zcode-app-server', ...argv];
  await import('./zcode-app-server.mjs');
}

main().catch((err) => {
  process.stderr.write(`[${PROG}] fatal: ${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
});
