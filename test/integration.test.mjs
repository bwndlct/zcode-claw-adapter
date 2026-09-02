import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'adapter', 'bin', 'zcode-claw-adapter.mjs');
const FAKE_SERVER = join(REPO, 'test', 'fixtures', 'fake-zcode-server.mjs');

/**
 * Drive the real CLI end-to-end against the fake zcode app-server.
 * Resolves with the collected stdout message stream and the exit code.
 * The adapter rejects overlapping turns, so queued lines are sent one at a
 * time: the next line goes out only after the previous turn's result (or,
 * with closeOnError, after an error event). stdin is then closed — the CLI
 * is a persistent process and otherwise never exits.
 */
function runCli({ lines, env = {}, args = [], closeOnError = false }) {
  return new Promise((resolveTest, rejectTest) => {
    const child = spawn(process.execPath, [
      CLI,
      '--zcode-bin', FAKE_SERVER,
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZCODE_APPSERVER_KEY: 'sk-test-secret-do-not-leak',
        ZCODE_DESKTOP_CONFIG: '/nonexistent',
        ZCODE_CLAW_STATE_DIR: env.ZCODE_CLAW_STATE_DIR,
        FAKE_DELAY_MS: '20',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    let stderr = '';
    const queue = [...lines];
    const sendNext = () => {
      const line = queue.shift();
      if (line === undefined) child.stdin.end();
      else child.stdin.write(JSON.stringify(line) + '\n');
    };
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { msg = { unparsed: line }; }
      messages.push(msg);
      if (msg.type === 'result' || (closeOnError && msg.type === 'error')) sendNext();
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', rejectTest);
    child.on('close', (code) => resolveTest({ messages, code, stderr }));
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => clearTimeout(watchdog));
    sendNext();
  });
}

const user = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

function findResult(msgs) {
  return msgs.filter((m) => m.type === 'result');
}

test('integration: two-turn session preserves memory and real session id', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir },
    args: ['--name', 'it-memory', '--no-desktop-refresh', '--turn-timeout-ms', '15000'],
    lines: [
      user('remember the number 4173'),
      user('what was the number again?'),
    ],
  });
  assert.equal(code, 0, `stderr expected clean exit; messages: ${JSON.stringify(messages.slice(0, 3))}`);
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  assert.ok(init, 'init event present');
  assert.match(init.session_id, /^sess_fake_\d+$/);
  assert.equal(init.engine, 'zcode-app-server');

  const results = findResult(messages);
  assert.equal(results.length, 2);
  assert.equal(results[0].result, 'OK');
  assert.match(results[1].result, /4173/);
  assert.equal(results[0].subtype, 'success');

  // The assistant text must have been streamed (deltas) and assembled.
  const assistants = messages.filter((m) => m.type === 'assistant');
  assert.ok(assistants.length >= 2);
  assert.match(assistants[1].message.content[0].text, /4173/);

  // Credential material must never appear in the stream.
  assert.ok(!JSON.stringify(messages).includes('sk-test-secret-do-not-leak'));

  // State dir records the real session id.
  const state = JSON.parse(await readFile(join(stateDir, 'sessions.json'), 'utf8'));
  assert.equal(state.sessions['it-memory'].zcodeSessionId, init.session_id);
});

test('integration: --readonly denies permission requests from the server', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, stderr } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir, FAKE_ASK_PERMISSION: '1' },
    args: ['--name', 'it-readonly', '--readonly', '--no-desktop-refresh', '--turn-timeout-ms', '15000'],
    lines: [user('try something')],
  });
  assert.match(stderr, /permission DENIED \(readonly\)/);
  const permEvent = messages.find((m) => m.subtype === 'zcode_permission');
  assert.ok(permEvent, 'permission resolution surfaced to Claw');
  const results = findResult(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].subtype, 'success');
});

test('integration: --resume reuses an existing zcode session id', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir },
    args: ['--name', 'it-resume', '--resume', 'sess_fake_9', '--no-desktop-refresh', '--turn-timeout-ms', '15000'],
    lines: [user('hello')],
  });
  assert.equal(code, 0);
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  assert.equal(init.session_id, 'sess_fake_9');
});

test('integration: --resume of unknown session fails with a clear error', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir },
    args: ['--name', 'it-resume-bad', '--resume', 'sess_missing_1', '--no-desktop-refresh'],
    lines: [],
  });
  assert.equal(code, 3);
  const err = messages.find((m) => m.type === 'error');
  assert.ok(err, 'error event emitted');
  assert.match(err.error, /resume failed/);
});

test('integration: child crash mid-turn surfaces exit info and keeps exit clean', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir, FAKE_DIE_ON_SEND: '1' },
    args: ['--name', 'it-crash', '--no-desktop-refresh', '--turn-timeout-ms', '15000'],
    closeOnError: true,
    lines: [user('this will kill the child')],
  });
  assert.equal(code, 0);
  const err = messages.find((m) => m.type === 'error');
  assert.ok(err, 'error event emitted');
  assert.match(err.error, /exited unexpectedly/);
  assert.match(err.error, /--resume/);
});

test('integration: event log stays credential-free', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  const eventLog = join(stateDir, 'events.log');
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir },
    args: ['--name', 'it-log', '--no-desktop-refresh', '--event-log', eventLog, '--turn-timeout-ms', '15000'],
    lines: [user('remember the number 7')],
  });
  assert.equal(code, 0);
  const log = await readFile(eventLog, 'utf8');
  assert.ok(!log.includes('sk-test-secret-do-not-leak'));
  assert.match(log, /sess_fake_/);
});

test('integration: workspace/model/mode flags reach the child as protocol calls', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zca-it-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { messages, code } = await runCli({
    env: { ZCODE_CLAW_STATE_DIR: stateDir },
    args: [
      '--name', 'it-flags', '--no-desktop-refresh',
      '--workspace', stateDir, '--model', 'z/GLM-Test', '--mode', 'plan',
      '--max-tool-concurrency', '3', '--turn-timeout-ms', '15000',
    ],
    lines: [user('hi')],
  });
  assert.equal(code, 0);
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  assert.equal(init.mode, 'plan');
  assert.equal(init.max_tool_concurrency, 3);
});
