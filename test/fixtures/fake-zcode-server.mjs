#!/usr/bin/env node
// Fake ZCode app-server for integration tests. Speaks the same NDJSON protocol
// the adapter expects from `zcode app-server --stdio`. No credentials needed.
//
// Behavior driven by env vars:
//   FAKE_MEMORY=N       remember N across turns (echoed on later turns)
//   FAKE_MODE=deny      answer nothing; used for permission-request scenarios
//   FAKE_DIE_ON_SEND=1  exit(1) when session/send arrives (child-crash test)
//   FAKE_DELAY_MS=T     wait T ms before streaming the reply
//   FAKE_UNKNOWN_EVENTS=1 emit unknown protocol extensions before a normal reply

import { createInterface } from 'node:readline';

const memory = new Map();
let sessionSeq = 0;
const log = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function notify(method, params) { log({ method, params }); }

function handleSend(params) {
  const text = typeof params.content === 'string'
    ? params.content
    : JSON.stringify(params.content);
  const m = text.match(/remember the number (\d+)/i);
  if (m) memory.set(params.sessionId, m[1]);
  const asks = text.match(/what was the number/i);

  const delay = Number(process.env.FAKE_DELAY_MS ?? 50);
  const stream = () => setTimeout(() => {
    if (process.env.FAKE_UNKNOWN_EVENTS === '1') {
      notify('future/notification', { sessionId: params.sessionId });
      notify('session/events', {
        sessionId: params.sessionId,
        events: [{ type: 'future.session-event', payload: { version: 2 } }],
      });
    }
    let reply;
    if (asks) reply = `the number was ${memory.get(params.sessionId) ?? 'unknown'}`;
    else reply = m ? 'OK' : `echo: ${text.slice(0, 200)}`;
    // Stream the reply as text deltas, like the real server.
    notify('session/events', {
      sessionId: params.sessionId,
      events: [
        { type: 'turn.started', payload: { turnNumber: 1 } },
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: reply.slice(0, 5) } },
        { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: 'thinking...' } },
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: reply.slice(5) } },
      ],
    });
    notify('v4/telemetry/event', {
      sessionId: params.sessionId,
      kind: 'turn.terminal',
      status: 'success',
      tokenCount: 42,
      durationMs: delay,
    });
    log({
      id: pendingSendId,
      result: { accepted: true, reply },
    });
    pendingSendId = null;
  }, delay);

  if (process.env.FAKE_ASK_PERMISSION === '1') {
    // Server -> client permission request; the adapter must answer it.
    log({ id: 'perm-1', method: 'interaction/requestPermission', params: { toolName: 'Bash', toolCallId: 'tc_1' } });
    pendingPermReply = (reply) => {
      lastPermissionDecision = reply;
      notify('session/events', {
        sessionId: params.sessionId,
        events: [{ type: 'permission.resolved', payload: { toolName: 'Bash', decision: reply?.result?.decision ?? 'error' } }],
      });
      stream();
    };
    return;
  }
  stream();
}

let pendingSendId = null;
let pendingPermReply = null;
let lastPermissionDecision = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (id === 'perm-1' && method === undefined) {
    // Reply from the adapter to our permission request.
    if (pendingPermReply) { const cb = pendingPermReply; pendingPermReply = null; cb(msg); }
    return;
  }
  switch (method) {
    case 'workspace/updateProviderRegistry':
      log({ id, result: { status: 'applied' } });
      return;
    case 'workspace/setDefaultModel':
      log({ id, result: {} });
      return;
    case 'session/create': {
      const sessionId = `sess_fake_${++sessionSeq}`;
      log({ id, result: { session: { sessionId, protocol: { name: 'ZCode Protocol' } } } });
      return;
    }
    case 'session/resume':
      if (/^sess_fake_/.test(params.sessionId ?? '')) {
        log({ id, result: { session: { sessionId: params.sessionId } } });
      } else {
        log({ id, error: { code: -32001, message: `session not found: ${params.sessionId}` } });
      }
      return;
    case 'session/setMode':
    case 'session/subscribe':
      log({ id, result: {} });
      return;
    case 'session/messages':
      log({
        id,
        result: {
          messages: [
            { role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
            { role: 'assistant', message: { role: 'assistant', parts: [{ type: 'text', partKind: 'text', text: 'final text' }] } },
          ],
        },
      });
      return;
    case 'session/send':
      if (process.env.FAKE_DIE_ON_SEND === '1') process.exit(1);
      pendingSendId = id;
      handleSend(params);
      return;
    case 'session/stop':
      log({ id, result: {} });
      return;
    default:
      log({ id, error: { code: -32601, message: `fake: ${method} not supported` } });
  }
});
rl.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
