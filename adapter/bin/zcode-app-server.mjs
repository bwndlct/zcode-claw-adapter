#!/usr/bin/env node
// zcode-app-server — a Claw Orchestrator custom engine that runs ZCode as the
// session owner via `zcode app-server` (ZCode Protocol over stdio).
//
// Claw spawns this binary (customEngine, persistent mode) and speaks
// Claude-Code-style stream-json on OUR stdin/stdout:
//   claw -> adapter : {"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}
//   adapter -> claw : {"type":"system","subtype":"init","session_id":"<real sess_...>"}
//                     {"type":"stream_event","event":{...}}   (best-effort deltas)
//                     {"type":"assistant","message":{...}}    (completed messages)
//                     {"type":"tool_use"|"tool_result", ...}
//                     {"type":"result","result":text,"usage":{...}}  (ends the turn)
//                     {"type":"error","error":"..."}
//
// The REAL ZCode sessionId is preserved end-to-end: it is announced in the init
// event (Claw captures it for resume) and stored under the configured state dir.
//
// Credentials: this adapter never reads, logs, or persists credential material.
// Model auth is configured by pushing a provider registry whose apiKey is an
// env-NAME reference ({source:"env",name:"ZCODE_APPSERVER_KEY"}) or an opaque
// registry passed on an inherited fd (--registry-fd N) that is forwarded
// byte-for-byte to the child and never logged.

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFile as readFileCallback } from 'node:fs';
import { appendFile, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ZCodeClient, ZCodeClientError, redact, registryShape } from '../lib/zcode-client.mjs';
import { StateStore } from '../lib/state.mjs';

const PROG = 'zcode-app-server';
const readFileFromFd = promisify(readFileCallback);

function parseArgs(argv) {
  const out = {
    workspace: process.cwd(),
    stateDir: null,
    registryFd: null,
    zcodeBin: process.env.ZCODE_BIN || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    nodeBin: process.execPath,
    resume: null,
    clawName: process.env.CLAW_SESSION_NAME || `zcode-${Date.now()}`,
    providerId: process.env.ZCODE_APPSERVER_PROVIDER_ID || 'z',
    modelId: process.env.ZCODE_APPSERVER_MODEL_ID || 'GLM-5.3',
    baseURL: process.env.ZCODE_APPSERVER_BASE_URL || 'https://api.z.ai/api/anthropic',
    apiKeyEnv: process.env.ZCODE_APPSERVER_KEY_ENV || 'ZCODE_APPSERVER_KEY',
    mode: 'build',
    readonly: false,
    surface: 'desktop',
    desktopRefresh: true,
    maxToolConcurrency: null,
    turnTimeoutMs: 15 * 60 * 1000,
    zcodeArgs: [],
    eventLog: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--workspace': case '--cwd': out.workspace = resolve(argv[++i]); break;
      case '--state-dir': out.stateDir = resolve(argv[++i]); break;
      case '--registry-fd': out.registryFd = Number(argv[++i]); break;
      case '--zcode-bin': out.zcodeBin = argv[++i]; break;
      case '--node-bin': out.nodeBin = argv[++i]; break;
      case '--resume': out.resume = argv[++i]; break;
      case '--name': out.clawName = argv[++i]; break;
      case '--provider-id': out.providerId = argv[++i]; break;
      case '--model': {
        const v = argv[++i];
        const slash = v.lastIndexOf('/');
        if (slash > 0) { out.modelId = v.slice(slash + 1); out.providerId = v.slice(0, slash); }
        else out.modelId = v;
        break;
      }
      case '--base-url': out.baseURL = argv[++i]; break;
      case '--api-key-env': out.apiKeyEnv = argv[++i]; break;
      case '--mode': out.mode = argv[++i]; break;
      case '--readonly': case '--read-only': out.readonly = true; out.mode = 'plan'; break;
      case '--surface': out.surface = argv[++i]; break;
      case '--desktop-refresh': out.desktopRefresh = true; break;
      case '--no-desktop-refresh': out.desktopRefresh = false; break;
      case '--max-tool-concurrency': {
        const v = argv[++i];
        if (!/^[1-9][0-9]*$/.test(v)) {
          fail(`--max-tool-concurrency expects a positive integer (sub-agent budget N), got: ${v}`, 2);
        }
        out.maxToolConcurrency = v; // kept as the verbatim string, forwarded as-is
        break;
      }
      case '--turn-timeout-ms': out.turnTimeoutMs = Number(argv[++i]); break;
      case '--zcode-arg': out.zcodeArgs.push(argv[++i]); break;
      case '--event-log': out.eventLog = resolve(argv[++i]); break;
      case '--help': case '-h':
        process.stdout.write(USAGE); process.exit(0); break;
      default:
        fail(`unknown or unsupported argument: ${a} (Claw flags must be mapped away in customEngine.args; see README)`, 2);
    }
  }
  if (!out.stateDir) {
    out.stateDir = process.env.ZCODE_CLAW_STATE_DIR
      ? resolve(process.env.ZCODE_CLAW_STATE_DIR)
      : join(homedir(), '.local', 'state', 'zcode-claw');
  }
  return out;
}

const USAGE = `${PROG} — Claw custom engine for ZCode app-server sessions

Usage: ${PROG} [options]
  --workspace <dir>        Workspace dir for ZCode sessions (default: cwd)
  --state-dir <dir>        Adapter state dir (default: $ZCODE_CLAW_STATE_DIR or ~/.local/state/zcode-claw)
  --registry-fd <n>        fd carrying an opaque provider registry JSON (forwarded to child, never logged)
  --zcode-bin <path>       ZCode CLI entry (default: $ZCODE_BIN or /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs)
  --resume <sessionId>     Resume a ZCode session by its real sess_... id
  --name <name>            Claw session name used for state bookkeeping
  --model <p/m>            Provider/model (default: $ZCODE_APPSERVER_PROVIDER_ID/GLM-5.3)
  --base-url <url>         Provider baseURL for the default env-referenced provider
  --api-key-env <name>     Env var NAME the zcode child resolves its API key from (default: ZCODE_APPSERVER_KEY)
  --mode <mode>            ZCode permission mode: plan|build|edit|yolo (default: build)
  --readonly               Shorthand for --mode plan + deny-all permission answers
  --surface <surface>      app-server presentation surface: terminal|desktop (default: desktop)
  --desktop-refresh        Refresh the ZCode desktop session list after session creation (default)
  --no-desktop-refresh     Disable automatic ZCode desktop session-list refresh
  --max-tool-concurrency <N>
                           Positive integer forwarded VERBATIM to the zcode child as the
                           native ZCODE_MAX_TOOL_CONCURRENCY env var (and the bare
                           MAX_TOOL_CONCURRENCY compatibility alias). The adapter never
                           counts, intercepts, or limits sub-agents itself. NOTE (zcode
                           0.16.5): the native knob throttles ALL parallel tool calls
                           (ToolScheduler parallel groups), not only sub-agent spawns.
  --turn-timeout-ms <n>    Per-turn timeout (default: 900000)
  --zcode-arg <arg>        Extra arg passed to the zcode child (repeatable; e.g. --disallowed-tools)
  --event-log <file>       Append raw protocol events for diagnostics (redacted)
`;

// Logging and output must never throw: when the parent (Claw) dies, our stdout
// and stderr pipes break and any further write raises EPIPE. An unguarded
// write inside an exception handler re-throws and turns into an infinite
// loop (observed in the wild: an orphaned adapter spinning on EPIPE and
// appending ~23GB to its event log). Rules applied below:
//   - every stream write is wrapped, and a broken stream is never written again;
//   - stream 'error' (async EPIPE) is swallowed, not escalated;
//   - the event log has a hard byte cap;
//   - the uncaughtException handler is re-entrancy guarded.
const EVENT_LOG_MAX_BYTES = 64 * 1024 * 1024;
const ioBroken = { stderr: false, stdout: false };

class EventLog {
  static async open(file) {
    if (!file) return null;
    await mkdir(dirname(file), { recursive: true });
    let bytes = 0;
    try { bytes = (await stat(file)).size; } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    return new EventLog(file, bytes);
  }

  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
    this.pending = Promise.resolve();
    this.lastError = null;
  }

  write(line) {
    const size = Buffer.byteLength(line);
    if (this.bytes >= EVENT_LOG_MAX_BYTES || this.bytes + size > EVENT_LOG_MAX_BYTES) return;
    this.bytes += size;
    this.pending = this.pending.then(async () => {
      try {
        await appendFile(this.file, line);
        this.lastError = null;
      } catch (err) {
        this.lastError = err;
      }
    });
  }

  async flush() {
    await this.pending;
    if (this.lastError) throw this.lastError;
  }
}

function writeErr(line) {
  if (ioBroken.stderr) return;
  try { process.stderr.write(line); } catch { ioBroken.stderr = true; }
}

function fail(message, code = 1) {
  writeErr(`${PROG}: ${message}\n`);
  process.exit(code);
}

function log(opts, ...parts) {
  const line = `[${PROG}] ` + parts.join(' ') + '\n';
  writeErr(line);
  if (opts?.eventLogger) {
    const entry = `[${new Date().toISOString()}] ` + parts.join(' ') + '\n';
    opts.eventLogger.write(entry);
  }
}

function refreshDesktopWorkspace(opts, workspaceDir, reason) {
  if (!opts.desktopRefresh || opts.surface !== 'desktop' || process.platform !== 'darwin') return;
  const url = `zcode://workspace/open?path=${encodeURIComponent(workspaceDir)}`;
  try {
    const child = spawn('/usr/bin/open', ['-g', url], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => {
      log(opts, `desktop refresh failed (${reason}, non-fatal):`, err.message);
    });
    child.unref();
    log(opts, `desktop refresh requested (${reason})`);
  } catch (err) {
    log(opts, `desktop refresh failed (${reason}, non-fatal):`, err.message);
  }
}

/** Claw stream-json emitters. */
class ClawOut {
  constructor(sink) { this.sink = sink; this.broken = false; }
  write(obj) {
    if (this.broken) return;
    try { this.sink.write(JSON.stringify(obj) + '\n'); }
    catch { this.broken = true; } // downstream (Claw) is gone; drop further events
  }
  init(sessionId, extra = {}) {
    this.write({ type: 'system', subtype: 'init', session_id: sessionId, ...extra });
  }
  systemEvent(subtype, payload) {
    this.write({ type: 'system', subtype, ...payload });
  }
  textDelta(text) {
    this.write({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
  }
  assistant(text, toolUses = []) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const t of toolUses) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} });
    if (content.length) this.write({ type: 'assistant', message: { role: 'assistant', content } });
  }
  toolUse(id, name, input) { this.write({ type: 'tool_use', tool_use_id: id, name, input: input ?? {} }); }
  toolResult(id, content, isError = false) {
    this.write({ type: 'tool_result', tool_use_id: id, content: String(content ?? ''), ...(isError ? { is_error: true } : {}) });
  }
  error(message) { this.write({ type: 'error', error: message }); }
  result(text, { usage = null, isError = false, durationMs = null, subtype = 'success' } = {}) {
    this.write({
      type: 'result',
      subtype,
      ...(isError ? { is_error: true } : {}),
      result: text ?? '',
      ...(usage ? { usage } : {}),
      ...(durationMs != null ? { duration_ms: durationMs } : {}),
    });
  }
}

/** Deep-scan a value for assistant text content in known ZCode message shapes. */
function extractText(value, acc = { texts: [], toolUses: [] }) {
  if (!value || typeof value !== 'object') return acc;
  if (Array.isArray(value)) { for (const v of value) extractText(v, acc); return acc; }
  // A message-ish node: role assistant/user with parts/content
  const role = value.role ?? value.sender ?? null;
  const parts = value.parts ?? value.content ?? null;
  if (Array.isArray(parts)) {
    const looksAssistant = role === 'assistant' || value.partKind === 'text' || !role;
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string' && p.text && (p.type === 'text' || p.partKind === 'text' || p.type === 'text_delta')) {
        if (looksAssistant) acc.texts.push(p.text);
      } else if (p.type === 'tool_call' || p.type === 'tool_use' || p.toolCallId || p.tool_call_id) {
        acc.toolUses.push({
          id: p.toolCallId ?? p.tool_call_id ?? p.id ?? `tool_${acc.toolUses.length}`,
          name: p.toolName ?? p.tool_name ?? p.name ?? 'unknown-tool',
          input: p.input ?? p.arguments ?? {},
          state: p.state ?? p.status ?? null,
        });
      } else if (typeof p === 'object') extractText(p, acc);
    }
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'parts' || k === 'content') continue;
    if (v && typeof v === 'object') extractText(v, acc);
  }
  return acc;
}

class TurnStateMachine {
  constructor() {
    this.reset();
  }
  reset() {
    this.state = 'idle';
    this.turnId = null;
    this.startedAt = null;
    this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    this.error = null;
    this.terminal = null;
    this.textBuffer = '';
    this.reasoningChars = 0;
    this.infraEvents = {};
    this.toolEvents = 0;
    this.durableDone = null; // promise resolve for waitForTurn
  }
  begin(turnId) {
    this.reset();
    this.state = 'running';
    this.turnId = turnId ?? null;
    this.startedAt = Date.now();
    return new Promise((res) => { this.durableDone = res; });
  }
  appendText(delta) { this.textBuffer += delta; }
  countInfra(kind) { this.infraEvents[kind] = (this.infraEvents[kind] ?? 0) + 1; }
  addUsage(u) {
    if (!u) return;
    this.usage.input_tokens += u.inputTokens ?? u.input_tokens ?? 0;
    this.usage.output_tokens += u.outputTokens ?? u.output_tokens ?? 0;
    this.usage.cache_read_input_tokens += u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0;
  }
  finish(terminal) {
    if (this.state === 'idle') return;
    this.terminal = terminal;
    this.state = 'terminal';
    const done = this.durableDone;
    this.durableDone = null;
    if (done) done(this);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.eventLogger = await EventLog.open(opts.eventLog);
  const state = await StateStore.open(opts.stateDir);
  const claw = new ClawOut(process.stdout);

  // ── Registry: opaque bytes from an inherited fd, or an env-name-referenced
  // default provider. Either way the adapter never holds credential values in
  // logs and never persists them.
  let registry = null;
  if (opts.registryFd !== null) {
    try {
      registry = JSON.parse(await readFileFromFd(opts.registryFd, 'utf8'));
      log(opts, 'registry loaded from fd', opts.registryFd, JSON.stringify(registryShape(registry)));
    } catch (err) {
      fail(`--registry-fd ${opts.registryFd}: ${err.message}`, 2);
    }
  } else {
    registry = {
      revision: `adapter-${Date.now()}`,
      generatedAt: Date.now(),
      providers: [{
        providerId: opts.providerId,
        kind: 'anthropic',
        baseURL: opts.baseURL,
        apiKey: { source: 'env', name: opts.apiKeyEnv },
        models: [{ modelId: opts.modelId }],
      }],
    };
  }

  // ── Workspace: sessions must be keyed by the worktree's canonical absolute
  // path (symlinks resolved), used for both workspacePath and workspaceKey.
  let workspaceDir = opts.workspace;
  try {
    workspaceDir = await realpath(opts.workspace);
  } catch (err) {
    log(opts, `workspace realpath failed (${err.message}); using resolved path`, opts.workspace);
  }

  // ── Spawn the ZCode child. ZCode is the session owner; we are a protocol
  // adapter only. Extra child args (e.g. --disallowed-tools) are pass-through.
  // `--surface desktop` makes the app-server register itself like the ZCode
  // desktop's own runtime would; desktop clients then auto-discover the session
  // in shared storage and can attach with desktop-continuous delivery.
  const childArgs = ['app-server', '--stdio', '--surface', opts.surface, ...opts.zcodeArgs];
  // N is forwarded verbatim via ZCode's NATIVE tool-concurrency env var. The
  // adapter adds no counting, interception, or limiting of its own; if the
  // parent env already carries either variable it is passed through unchanged
  // unless an explicit --max-tool-concurrency overrides both.
  // RECORDED FACT (zcode CLI 0.16.5): the env config parser only recognizes
  // variables prefixed "ZCODE_" (bundle: xEo="ZCODE_"), so the EFFECTIVE native
  // variable is ZCODE_MAX_TOOL_CONCURRENCY; a bare MAX_TOOL_CONCURRENCY is
  // ignored by zcode (falls back to default 10). We set BOTH — the effective
  // native one, plus the bare name for environments that recognize it — each
  // carrying N verbatim. The native knob throttles ALL parallel tool calls
  // (ToolScheduler parallel groups), not only sub-agent spawns.
  const childEnv = { ...process.env };
  if (opts.maxToolConcurrency !== null) {
    childEnv.ZCODE_MAX_TOOL_CONCURRENCY = opts.maxToolConcurrency;
    childEnv.MAX_TOOL_CONCURRENCY = opts.maxToolConcurrency;
  }
  const effectiveMaxToolConcurrency = childEnv.ZCODE_MAX_TOOL_CONCURRENCY
    ?? childEnv.MAX_TOOL_CONCURRENCY ?? null;
  const client = new ZCodeClient({
    bin: opts.nodeBin,
    args: [opts.zcodeBin, ...childArgs],
    cwd: workspaceDir,
    env: childEnv,
    onServerRequest: (msg) => handleServerRequest(msg),
  });
  client.start();
  log(
    opts,
    `zcode child spawned pid=${client.pid} workspace=${workspaceDir} surface=${opts.surface}`,
    `model=${opts.providerId}/${opts.modelId} readonly=${opts.readonly}`,
    `env MAX_TOOL_CONCURRENCY=${effectiveMaxToolConcurrency ?? '(not set; zcode default)'}`,
  );

  const turn = new TurnStateMachine();
  let zcodeSessionId = null;
  let turnSeq = 0;
  let shuttingDown = false;
  let followupDesktopRefreshDone = false;

  function refreshDesktopAfterMetadata(reason) {
    if (followupDesktopRefreshDone) return;
    followupDesktopRefreshDone = true;
    refreshDesktopWorkspace(opts, workspaceDir, reason);
  }

  function record(patch, event = null) {
    state.upsert(opts.clawName, {
      zcodeSessionId, workspace: workspaceDir,
      providerId: opts.providerId, modelId: opts.modelId,
      readonly: opts.readonly, pid: client.pid,
      surface: opts.surface,
      maxToolConcurrency: opts.maxToolConcurrency !== null ? Number(opts.maxToolConcurrency) : null,
      effectiveMaxToolConcurrency: effectiveMaxToolConcurrency !== null ? Number(effectiveMaxToolConcurrency) : null,
      engine: 'zcode-app-server', ...patch,
    });
    if (event) state.pushEvent(opts.clawName, event);
  }

  function handleServerRequest(msg) {
    const m = msg.method;
    const p = msg.params ?? {};
    if (m === 'interaction/requestPermission') {
      if (opts.readonly) {
        log(opts, 'permission DENIED (readonly):', JSON.stringify(redact({ tool: p.toolName ?? p.tool ?? p.toolCallId })));
        record({ status: 'permission-denied' }, { kind: 'permission-denied', tool: p.toolName ?? p.tool ?? null });
        return { result: { decision: 'deny', reason: 'zcode-app-server adapter: read-only session' } };
      }
      log(opts, 'permission default-deny (non-interactive):', JSON.stringify(redact({ tool: p.toolName ?? p.tool ?? p.toolCallId })));
      return { result: { decision: 'deny', reason: 'zcode-app-server adapter runs non-interactive; permission denied' } };
    }
    if (m === 'interaction/requestUserInput') {
      return { error: { code: -32601, message: 'zcode-app-server adapter: no interactive user input available' } };
    }
    if (m === 'interaction/requestProviderRuntimeHeaders' || m === 'interaction/requestOfficialMcpAuthHeaders') {
      return { result: {} };
    }
    log(opts, 'unanswered server request (default reject):', m);
    return { error: { code: -32601, message: `zcode-app-server adapter: ${m} not supported` } };
  }

  // ── Notification routing ─────────────────────────────────────────────────
  client.on('notification', (msg) => routeNotification(msg.method, msg.params ?? {}));
  client.on('client-error', (err) => log(opts, 'client-error:', err.message));
  client.on('exit', async (info) => {
    if (shuttingDown) return;
    log(opts, 'child exited unexpectedly:', JSON.stringify(info));
    claw.error(`zcode app-server exited unexpectedly (code=${info.code} signal=${info.signal}); sessionId=${zcodeSessionId ?? 'none'} preserved for --resume`);
    if (turn.state === 'running') {
      turn.error = `zcode app-server exited mid-turn (code=${info.code} signal=${info.signal})`;
      turn.finish({ status: 'failed', errorCode: 'child_exit', errorMessage: turn.error });
    }
    record({ status: 'child-exited' }, { kind: 'child-exit', ...info });
    await Promise.allSettled([state.flush(), opts.eventLogger?.flush()]);
    process.exit(0);
  });

  function routeNotification(method, params) {
    opts.eventLogger?.write(`[${new Date().toISOString()}] NOTIF ${method} ${JSON.stringify(redact(params)).slice(0, 2000)}\n`);
    if (params && zcodeSessionId && params.sessionId && params.sessionId !== zcodeSessionId) {
      return; // other sessions in shared runtime; not ours
    }
    switch (method) {
      // Known infrastructure noise — aggregated per turn, not forwarded individually.
      case 'process/mcpTelemetry':
      case 'process/resourceSample':
        turn.countInfra(method);
        return;
      case 'state.updated': {
        const status = params?.patch?.status;
        if (status && status !== 'running') {
          record({ zcodeStatus: status }, { kind: 'state', status });
        }
        return;
      }
      case 'v4/telemetry/event': return handleTelemetry(params);
      case 'computer-use/operation-event': return handleOperationEvent(params);
      case 'session/event':
      case 'session/events':
        return handleSessionEvent(params);
      default:
        // Unknown protocol events are surfaced, never swallowed.
        claw.systemEvent('zcode_event', {
          zcode_method: method,
          summary: JSON.stringify(redact(params)).slice(0, 600),
        });
        record(null, { kind: 'unknown-notification', method });
        return;
    }
  }

  function handleTelemetry(p) {
    const kind = p?.kind;
    switch (kind) {
      case 'turn.started':
        return;
      case 'usage.delta':
        turn.addUsage(p);
        return;
      case 'model.request.status':
      case 'stream.chunk':
        // stream.chunk carries lengths only; content arrives via session/event.
        turn.countInfra(`telemetry:${kind}`);
        return;
      case 'turn.terminal': {
        const terminal = {
          status: p.status, resultType: p.resultType,
          errorCode: p.errorCode, errorMessage: p.errorMessage,
          tokenCount: p.tokenCount, toolCallCount: p.toolCallCount,
          durationMs: p.durationMs,
        };
        turn.finish(terminal);
        return;
      }
      default:
        claw.systemEvent('zcode_event', { zcode_method: 'v4/telemetry/event', zcode_kind: kind, summary: JSON.stringify(redact(p)).slice(0, 400) });
        return;
    }
  }

  function handleOperationEvent(p) {
    const k = p?.kind;
    if (k === 'turn-started' || k === 'turn-completed' || k === 'turn-failed') return; // mirrored by telemetry
    turn.countInfra(`op:${k ?? 'unknown'}`);
  }

  /**
   * Content channel (session/subscribe, deliveryKind desktop-continuous).
   * Observed shapes (ZCode Protocol v1, zcode 0.16.5):
   *   {type:"model.streaming", payload:{assistantMessageId, delta, done, kind:"reasoning_delta"|"text_delta"}}
   *   {type:"turn.started", payload:{turnNumber, input}}
   *   {type:"session.updated"|"session.titleUpdated", payload:{...}}
   * Unknown types are surfaced as zcode_event; known-but-quiet ones are counted.
   */
  function handleSessionEvent(params) {
    try {
      const events = Array.isArray(params?.events) ? params.events
        : Array.isArray(params) ? params
        : [params];
      for (const ev of events) {
        const type = ev?.type ?? ev?.kind ?? null;
        const payload = ev?.payload ?? {};
        if (!type) {
          claw.systemEvent('zcode_event', { zcode_method: 'session/event', summary: JSON.stringify(redact(ev)).slice(0, 400) });
          continue;
        }
        switch (type) {
          case 'model.streaming': {
            const k = payload.kind;
            if (k === 'text_delta' && typeof payload.delta === 'string') {
              turn.appendText(payload.delta);
              claw.textDelta(payload.delta);
            } else if (k === 'reasoning_delta') {
              turn.reasoningChars += payload.delta?.length ?? 0;
            } else {
              claw.systemEvent('zcode_event', { zcode_method: 'session/event', zcode_kind: `model.streaming:${k}`, summary: '' });
            }
            break;
          }
          case 'turn.started':
          case 'turn.completed':
          case 'session.updated':
            break; // known lifecycle/metadata noise (mirrored by telemetry)
          case 'session.titleUpdated':
            refreshDesktopAfterMetadata('session-title-updated');
            break;
          case 'streamRecovery.updated':
            turn.countInfra('streamRecovery');
            break;
          case 'permission.requested':
          case 'permission.resolved': {
            const summary = { type, tool: payload.toolName ?? payload.tool ?? null, decision: payload.decision ?? null };
            record({ lastPermission: summary }, { kind: 'permission', ...summary });
            claw.systemEvent('zcode_permission', { zcode_method: 'session/event', zcode_kind: type, summary: JSON.stringify(redact(summary)) });
            break;
          }
          case 'tool.updated': {
            // Tool lifecycle: payload carries toolCallId/toolName and evolving
            // state (args while running, output when finished).
            turn.toolEvents++;
            const toolId = payload.toolCallId ?? payload.id ?? `tool_${turn.toolEvents}`;
            const toolName = payload.toolName ?? payload.name ?? 'tool';
            const output = payload.output ?? payload.result ?? null;
            if (output !== null && output !== undefined) {
              claw.toolResult(toolId, output, !!(payload.isError ?? payload.error));
            } else {
              claw.toolUse(toolId, toolName, payload.input ?? payload.args ?? {});
            }
            record(null, { kind: 'tool', tool: toolName, id: toolId, hasOutput: output != null });
            break;
          }
          default: {
            // Generic tool-event mapping: anything tool-shaped is forwarded.
            const toolId = payload.toolCallId ?? payload.id ?? null;
            const toolName = payload.toolName ?? payload.name ?? null;
            if (toolId && toolName && /tool/i.test(type)) {
              turn.toolEvents++;
              if (/result|output|complet/i.test(type)) {
                claw.toolResult(toolId, payload.output ?? payload.result ?? '', !!(payload.isError ?? payload.error));
              } else {
                claw.toolUse(toolId, toolName, payload.input ?? {});
              }
            } else {
              claw.systemEvent('zcode_event', { zcode_method: 'session/event', zcode_kind: type, summary: JSON.stringify(redact(payload)).slice(0, 400) });
              record(null, { kind: 'unknown-session-event', type });
            }
          }
        }
      }
    } catch (err) {
      claw.systemEvent('zcode_event', { zcode_method: 'session/event', summary: `mapper error: ${err.message}` });
    }
  }

  // ── Final message assembly: authoritative text from session/messages ──────
  async function collectLastAssistantText() {
    try {
      const res = await client.request('session/messages', { sessionId: zcodeSessionId, limit: 50 }, { timeoutMs: 20000 });
      const messages = res?.messages ?? res ?? [];
      const arr = Array.isArray(messages) ? messages : [];
      let text = '';
      let toolUses = [];
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        const role = m?.role ?? m?.message?.role ?? m?.sender ?? null;
        if (role !== 'assistant' && role !== 'agent') continue;
        const acc = extractText(m?.message ?? m, { texts: [], toolUses: [] });
        if (acc.texts.length || acc.toolUses.length) { text = acc.texts.join(''); toolUses = acc.toolUses; break; }
      }
      return { text, toolUses, rawCount: arr.length };
    } catch (err) {
      log(opts, 'session/messages failed:', err.message);
      return { text: '', toolUses: [], rawCount: 0, error: err.message };
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  const workspace = { workspacePath: workspaceDir, workspaceKey: workspaceDir };
  const push = await client.request('workspace/updateProviderRegistry', { workspace, registry }, { timeoutMs: 60000 });
  if (push?.status !== 'applied') log(opts, 'registry push status:', JSON.stringify(redact(push)).slice(0, 300));
  await client.request('workspace/setDefaultModel', { workspace, model: { providerId: opts.providerId, modelId: opts.modelId } }, { timeoutMs: 30000 })
    .catch((err) => log(opts, 'setDefaultModel failed:', err.message));

  let sessionInfo = null;
  if (opts.resume) {
    try {
      const res = await client.request('session/resume', { sessionId: opts.resume }, { timeoutMs: 60000 });
      sessionInfo = res?.session ?? res ?? {};
      zcodeSessionId = sessionInfo.sessionId ?? opts.resume;
      log(opts, 'resumed zcode session', zcodeSessionId);
    } catch (err) {
      const hint = /not found/i.test(err.message)
        ? ' (ZCode persists a session durably only after its first completed turn; a session killed before that point is not resumable)'
        : '';
      claw.error(`resume failed for ${opts.resume}: ${err.message}${hint}`);
      record({ status: 'resume-failed', lastResumeError: err.message }, { kind: 'resume-failed', error: err.message });
      fail(`resume failed for ${opts.resume}: ${err.message}${hint}`, 3);
    }
  } else {
    const res = await client.request('session/create', { workspace }, { timeoutMs: 60000 });
    sessionInfo = res?.session ?? res ?? {};
    zcodeSessionId = sessionInfo.sessionId;
    if (!zcodeSessionId) throw new ZCodeClientError(`session/create returned no sessionId: ${JSON.stringify(redact(res)).slice(0, 300)}`);
    log(opts, 'created zcode session', zcodeSessionId);
    refreshDesktopWorkspace(opts, workspaceDir, 'session-created');
  }

  // Mode: plan for readonly, otherwise configured mode.
  const wantedMode = opts.readonly ? 'plan' : opts.mode;
  await client.request('session/setMode', { sessionId: zcodeSessionId, mode: wantedMode }, { timeoutMs: 15000 })
    .catch((err) => log(opts, `session/setMode(${wantedMode}) failed:`, err.message));

  // Subscribe for content events (deliveryKind desktop-continuous = event stream).
  await client.request('session/subscribe', { sessionId: zcodeSessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 20000 })
    .catch((err) => log(opts, 'session/subscribe failed (falling back to session/messages polling):', err.message));

  record({ status: 'ready', mode: wantedMode, resumedFrom: opts.resume ?? null }, { kind: 'ready', sessionId: zcodeSessionId });
  claw.init(zcodeSessionId, {
    engine: 'zcode-app-server',
    zcode_session_id: zcodeSessionId,
    zcode_protocol: sessionInfo?.protocol?.name ?? 'ZCode Protocol',
    mode: wantedMode,
    readonly: opts.readonly,
    surface: opts.surface,
    ...(opts.maxToolConcurrency !== null ? { max_tool_concurrency: Number(opts.maxToolConcurrency) } : {}),
  });

  // ── Claw stdin loop ─────────────────────────────────────────────────────
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => { if (line.trim()) onClawLine(line).catch((err) => { log(opts, 'turn error:', err.message); }); });
  rl.on('close', () => shutdown('stdin-closed', 0));

  async function onClawLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      claw.systemEvent('zcode_event', { summary: `unparseable claw input line: ${line.slice(0, 80)}` });
      return;
    }
    if (msg?.type !== 'user') {
      claw.systemEvent('zcode_event', { summary: `unsupported claw message type ${msg?.type}` });
      return;
    }
    const content = msg?.message?.content ?? [];
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
    const texts = [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else claw.systemEvent('zcode_event', { summary: `unsupported input block type ${b?.type ?? 'unknown'} ignored` });
    }
    const text = texts.join('\n');
    if (!text) {
      claw.result('', { isError: true, subtype: 'error_during_execution' });
      return;
    }
    if (turn.state === 'running') {
      claw.error('turn already in progress; wait for the previous result before sending again');
      return;
    }
    const myTurn = ++turnSeq;
    const done = turn.begin(null);
    record({ status: 'turn-running' }, { kind: 'turn-sent', seq: myTurn });
    try {
      await client.request('session/send', { sessionId: zcodeSessionId, content: text }, { timeoutMs: 30000 });
    } catch (err) {
      turn.error = `session/send failed: ${err.message}`;
      turn.finish({ status: 'failed', errorCode: 'send_failed', errorMessage: turn.error });
    }
    // Turn watchdog: protocol-event driven, timeout only as a backstop.
    const watchdog = setTimeout(() => {
      if (turn.state === 'running') {
        log(opts, `turn ${myTurn} timed out after ${opts.turnTimeoutMs}ms; sending session/stop`);
        client.request('session/stop', { sessionId: zcodeSessionId }, { timeoutMs: 15000 }).catch(() => {});
        turn.error = `turn timed out after ${opts.turnTimeoutMs}ms`;
        turn.finish({ status: 'failed', errorCode: 'turn_timeout', errorMessage: turn.error });
      }
    }, opts.turnTimeoutMs);
    const finished = await done;
    clearTimeout(watchdog);
    await emitTurnResult(finished, myTurn);
  }

  async function emitTurnResult(finished, seq) {
    const t = finished.terminal ?? {};
    const ok = t.status === 'success';
    refreshDesktopAfterMetadata('first-turn-finished');
    const collected = await collectLastAssistantText();
    // Prefer the streamed text (text_delta accumulation); session/messages is
    // the authoritative cross-check when the stream was unavailable.
    const text = finished.textBuffer || collected.text || (ok ? '' : (t.errorMessage ?? `turn ${t.status}`));
    if (collected.toolUses.length) {
      for (const tu of collected.toolUses) claw.toolUse(tu.id, tu.name, tu.input);
      claw.assistant(text, collected.toolUses);
    } else if (text) {
      claw.assistant(text);
    }
    const usage = Object.values(finished.usage).some((v) => v > 0)
      ? finished.usage
      : (t.tokenCount ? { output_tokens: 0, input_tokens: t.tokenCount } : null);
    if (!ok) {
      claw.error(`zcode turn failed: ${t.errorCode ?? 'unknown'} ${t.errorMessage ?? ''}`.trim());
      record({ status: 'turn-failed', lastError: t.errorMessage ?? t.errorCode ?? 'unknown' }, { kind: 'turn-terminal', seq, ...t });
      claw.result(text || t.errorMessage || 'turn failed', { isError: true, subtype: 'error_during_execution', usage, durationMs: t.durationMs ?? null });
      return;
    }
    record({ status: 'idle', lastTurnAt: new Date().toISOString(), zcodeStatus: 'idle' }, { kind: 'turn-terminal', seq, ...t, infra: finished.infraEvents });
    claw.result(text, { usage, durationMs: t.durationMs ?? null, subtype: 'success' });
  }

  async function shutdown(reason, code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(opts, 'shutdown:', reason);
    try {
      if (turn.state === 'running') {
        try { await client.request('session/stop', { sessionId: zcodeSessionId }, { timeoutMs: 10000 }); } catch { /* ignore */ }
        turn.finish({ status: 'failed', errorCode: 'adapter_shutdown', errorMessage: `adapter shutting down (${reason})` });
      }
      record({ status: 'stopped', stopReason: reason }, { kind: 'shutdown', reason });
      await client.stop();
      await Promise.allSettled([state.flush(), opts.eventLogger?.flush()]);
    } catch (err) {
      log(opts, 'shutdown cleanup error (non-fatal):', err.message);
    }
    process.exit(code ?? 0);
  }
  process.on('SIGTERM', () => { shutdown('SIGTERM', 0).catch(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown('SIGINT', 0).catch(() => process.exit(0)); });
}

// Swallow async EPIPE/EBADF on our own standard streams: a broken pipe is a
// normal consequence of the parent dying, not a crash-worthy condition.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    if (stream === process.stderr) ioBroken.stderr = true;
    else ioBroken.stdout = true;
  });
}

// Re-entrancy guarded fatal handler: if anything in here throws again (e.g.
// EPIPE while logging to a dead parent), exit immediately instead of looping.
let inFatalHandler = false;
function fatal(err, code = 1) {
  if (inFatalHandler) process.exit(code);
  inFatalHandler = true;
  writeErr(`[${PROG}] fatal: ${err?.stack ?? err?.message ?? String(err)}\n`);
  if (!ioBroken.stdout) {
    try { process.stdout.write(JSON.stringify({ type: 'error', error: String(err?.message ?? err) }) + '\n'); } catch { ioBroken.stdout = true; }
  }
  process.exit(code);
}

process.on('uncaughtException', (err) => fatal(err, 1));
process.on('unhandledRejection', (err) => fatal(err, 1));

main().catch((err) => fatal(err, 1));
