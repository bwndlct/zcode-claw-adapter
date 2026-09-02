import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../adapter/lib/state.mjs';

async function tmpStateDir() {
  return mkdtemp(join(tmpdir(), 'zca-state-'));
}

test('StateStore upsert/get/findZcode round-trips and flushes atomically', async () => {
  const dir = await tmpStateDir();
  try {
    const store = await StateStore.open(dir);
    store.upsert('claw-1', { status: 'ready', zcodeSessionId: 'sess_a' });
    store.pushEvent('claw-1', { kind: 'ready', sessionId: 'sess_a' });
    await store.flush();
    assert.equal(store.get('claw-1').zcodeSessionId, 'sess_a');
    assert.equal(store.findZcode('sess_a').clawSessionName, 'claw-1');
    assert.equal(store.findZcode('sess_missing'), null);

    const raw = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
    assert.equal(raw.sessions['claw-1'].events.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('StateStore keeps events bounded at 500', async () => {
  const dir = await tmpStateDir();
  try {
    const store = await StateStore.open(dir);
    store.upsert('s', { zcodeSessionId: 'sess_b' });
    for (let i = 0; i < 600; i++) store.pushEvent('s', { kind: 'tick', i });
    await store.flush();
    assert.equal(store.get('s').events.length, 500);
    assert.equal(store.get('s').events.at(-1).i, 599);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('StateStore recovers from corrupt state without bricking', async () => {
  const dir = await tmpStateDir();
  try {
    await writeFile(join(dir, 'sessions.json'), '{not json', 'utf8');
    const store = await StateStore.open(dir);
    assert.equal(store.list().length, 0);
    store.upsert('fresh', { zcodeSessionId: 'sess_c' });
    await store.flush();
    const again = await StateStore.open(dir);
    assert.equal(again.get('fresh').zcodeSessionId, 'sess_c');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
