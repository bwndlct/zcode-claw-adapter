import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZCodeClient, ZCodeClientError } from '../adapter/lib/zcode-client.mjs';
import { spawn } from 'node:child_process';

/** Minimal inline NDJSON server harness for client-level tests. */
function startFake(handlers) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    const handlers = ${JSON.stringify(Object.keys(handlers))};
    const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'echo/ping') write({ id: m.id, result: { pong: true } });
      else if (m.method === 'echo/slow') setTimeout(() => write({ id: m.id, result: { pong: true } }), 2000);
      else if (m.method === 'echo/fail') write({ id: m.id, error: { code: -32001, message: 'boom' } });
      else if (m.method === 'notify/hi') write({ method: 'notify/hi', params: { hello: 'world' } });
      else if (m.method === 'ask/perm') write({ id: 'p1', method: 'interaction/requestPermission', params: { toolName: 'Bash' } });
      else write({ id: m.id, error: { code: -32601, message: 'nope: ' + m.method } });
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  return child;
}

function clientFor(child, onServerRequest) {
  return new ZCodeClient({
    bin: process.execPath,
    args: child.spawnargs.slice(1),
    onServerRequest,
  });
}

test('ZCodeClient resolves requests against the fake server', async () => {
  const fake = startFake({});
  try {
    const client = new ZCodeClient({ bin: process.execPath, args: fake.spawnargs.slice(1) });
    client.start();
    const res = await client.request('echo/ping', {}, { timeoutMs: 5000 });
    assert.equal(res.pong, true);
    await client.stop();
  } finally {
    fake.kill();
  }
});

test('ZCodeClient rejects with protocol error payloads', async () => {
  const fake = startFake({});
  try {
    const client = new ZCodeClient({ bin: process.execPath, args: fake.spawnargs.slice(1) });
    client.start();
    await assert.rejects(
      client.request('echo/fail', {}, { timeoutMs: 5000 }),
      (err) => {
        assert.ok(err instanceof ZCodeClientError);
        assert.equal(err.code, -32001);
        assert.equal(err.message, 'boom');
        return true;
      },
    );
    await client.stop();
  } finally {
    fake.kill();
  }
});

test('ZCodeClient request times out', async () => {
  const fake = startFake({});
  try {
    const client = new ZCodeClient({ bin: process.execPath, args: fake.spawnargs.slice(1) });
    client.start();
    await assert.rejects(
      client.request('echo/slow', {}, { timeoutMs: 150 }),
      (err) => err.code === -32022 && /timed out/.test(err.message),
    );
    await client.stop();
  } finally {
    fake.kill();
  }
});

test('ZCodeClient surfaces notifications and answers server requests', async () => {
  const fake = startFake({});
  const client = clientFor(fake, (msg) => ({ result: { decision: 'deny' } }));
  try {
    client.start();
    const replies = [];
    client.on('server-request', (m) => replies.push(m.method));
    client.notify('notify/hi', {}); // the fake answers with a notification
    const req = client.request('ask/perm', {}, { timeoutMs: 5000 });
    await req.catch(() => {}); // fake treats ask/perm as unknown: protocol error
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(replies.includes('interaction/requestPermission'));
  } finally {
    await client.stop().catch(() => {});
    fake.kill();
  }
});

test('ZCodeClient rejects pending requests when the child exits', async () => {
  const fake = startFake({});
  const client = clientFor(fake);
  client.start();
  const p = client.request('echo/slow', {}, { timeoutMs: 5000 });
  client.proc.kill('SIGKILL'); // kill the process the client actually talks to
  await assert.rejects(p, (err) => /exited/.test(err.message));
  await client.stop().catch(() => {});
  fake.kill();
});
