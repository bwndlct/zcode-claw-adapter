// ZCode Protocol stdio client.
//
// Framing: newline-delimited JSON. Requests/notifications use {id?, method, params};
// responses are {id, result} or {id, error:{code,message,data}}. The server may also
// issue requests TO the client ({id, method, params}); every server request MUST be
// answered (result or error) or the server times it out after 15s and fails the
// dependent operation.
//
// Sensitive-data policy: provider registries may contain credentials. They are never
// logged; log lines only ever carry a shape summary (key names / counts).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export const RUNTIME_PREFERENCES_DEFAULT = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
});

export class ZCodeClientError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'ZCodeClientError';
    this.code = code;
    this.data = data;
  }
}

let nextClientId = 0;

export class ZCodeClient extends EventEmitter {
  /**
   * @param {{bin:string, args?:string[], cwd?:string, env?:object,
   *          runtimePreferences?:object, onServerRequest?:(msg)=>object|{error:object}}} opts
   */
  constructor(opts) {
    super();
    this.id = ++nextClientId;
    this.bin = opts.bin;
    this.args = opts.args ?? ['app-server', '--stdio'];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.runtimePreferences = opts.runtimePreferences ?? RUNTIME_PREFERENCES_DEFAULT;
    this.onServerRequest = opts.onServerRequest ?? null;
    this.proc = null;
    this.rl = null;
    this._stdinBroken = false;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method, timer}
    this.exitInfo = null;
    this.exitWaiters = [];
    this._buf = '';
  }

  get pid() { return this.proc?.pid ?? null; }
  get exited() { return this.exitInfo !== null; }

  start() {
    if (this.proc) throw new Error('ZCodeClient already started');
    this.proc = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._onLine(line));
    this.rl.on('error', (err) => this.emit('client-error', err));
    this.proc.stderr?.on('data', (d) => this.emit('stderr', String(d)));
    this.proc.on('error', (err) => this._onExit({ code: null, signal: null, error: err }));
    this.proc.on('close', (code, signal) => this._onExit({ code, signal }));
    return this;
  }

  _onExit(info) {
    if (this.exitInfo) return;
    this.exitInfo = info;
    const err = new ZCodeClientError(
      `zcode app-server exited (code=${info.code} signal=${info.signal}${info.error ? ` error=${info.error.message}` : ''})`,
      { code: -32000 },
    );
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const w of this.exitWaiters) w(info);
    this.exitWaiters = [];
    this.emit('exit', info);
  }

  waitExit() {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((res) => this.exitWaiters.push(res));
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      this.emit('client-error', new Error(`unparseable stdout line: ${line.slice(0, 120)}`));
      return;
    }
    if (msg.method && (msg.id === undefined || msg.id === null)) {
      // notification
      this.emit('notification', msg);
      this.emit(`notification:${msg.method}`, msg.params ?? {});
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server -> client request
      this._onServerRequest(msg);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.emit('client-error', new Error(`response for unknown request id ${msg.id}`));
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ZCodeClientError(msg.error.message ?? 'zcode protocol error', msg.error));
      else p.resolve(msg.result);
      return;
    }
    this.emit('client-error', new Error(`unrecognized protocol message: ${JSON.stringify(msg).slice(0, 160)}`));
  }

  /** Write a line to the child; never throws (child stdin may be gone). */
  _writeLine(obj) {
    if (!this.proc || this.exited || this._stdinBroken) return false;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      this._stdinBroken = true;
      this.emit('client-error', new ZCodeClientError(`child stdin write failed: ${err.message}`, { code: -32000 }));
      return false;
    }
  }

  async _onServerRequest(msg) {
    this.emit('server-request', msg);
    let reply;
    try {
      if (msg.method === 'session/requestRuntimePreferences') {
        reply = { result: this.runtimePreferences };
      } else if (this.onServerRequest) {
        reply = await this.onServerRequest(msg);
      } else {
        reply = { error: { code: -32601, message: `zcode-app-server adapter: ${msg.method} not supported` } };
      }
    } catch (err) {
      reply = { error: { code: -32000, message: `adapter handler failed: ${err.message}` } };
    }
    const out = { id: msg.id, ...(reply ?? { error: { code: -32000, message: 'no reply' } }) };
    this._writeLine(out);
  }

  notify(method, params) {
    if (!this.proc || this.exited) throw new ZCodeClientError('zcode app-server is not running', { code: -32000 });
    this._writeLine({ method, params: params ?? {} });
  }

  request(method, params, { timeoutMs = 60000 } = {}) {
    if (!this.proc || this.exited) {
      return Promise.reject(new ZCodeClientError('zcode app-server is not running', { code: -32000 }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZCodeClientError(`request timed out after ${timeoutMs}ms: ${method}`, { code: -32022 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      if (!this._writeLine({ id, method, params: params ?? {} })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ZCodeClientError('zcode app-server stdin is gone', { code: -32000 }));
      }
    });
  }

  async stop() {
    if (!this.proc || this.exited) return;
    try { this.proc.kill('SIGTERM'); } catch { /* already dead */ }
    const info = await new Promise((res) => {
      const timer = setTimeout(() => {
        try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
        res({ code: null, signal: 'SIGKILL' });
      }, 5000);
      this.waitExit().then((v) => { clearTimeout(timer); res(v); }, () => { clearTimeout(timer); res({ code: null, signal: null }); });
    });
    return info;
  }
}

/** Redact values of credential-looking keys for safe summaries. */
export function redact(value, maxDepth = 6) {
  if (maxDepth < 0) return '<deep>';
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => redact(v, maxDepth - 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/apiKey|token|secret|password|authorization|credential/i.test(k)) out[k] = '<redacted>';
      else out[k] = redact(v, maxDepth - 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
  return value;
}

/** Compact, credential-free summary of a provider registry for logs. */
export function registryShape(registry) {
  if (!registry || typeof registry !== 'object') return { type: typeof registry };
  return {
    revision: registry.revision,
    providerCount: Array.isArray(registry.providers) ? registry.providers.length : null,
    providers: (registry.providers ?? []).slice(0, 6).map((p) => ({
      providerId: p?.providerId,
      kind: p?.kind,
      models: Array.isArray(p?.models) ? p.models.length : null,
      apiKey: p?.apiKey ? { source: p.apiKey.source } : undefined,
    })),
  };
}
