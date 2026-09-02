// Adapter state persistence. Records the real ZCode sessionIds so a crashed or
// stopped adapter can be relaunched with --resume <clawSessionName>.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_EVENTS = 500;

export class StateStore {
  static async open(stateDir) {
    const store = new StateStore(stateDir);
    await store._load();
    return store;
  }

  constructor(stateDir) {
    this.dir = stateDir;
    this.file = join(stateDir, 'sessions.json');
    this.data = { version: 1, sessions: {} };
    this.dirty = false;
    this.flushPromise = null;
    this.lastWriteError = null;
  }

  async _load() {
    await mkdir(this.dir, { recursive: true });
    let contents;
    try {
      contents = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }

    try {
      const parsed = JSON.parse(contents);
      if (parsed && typeof parsed === 'object' && parsed.sessions) this.data = parsed;
    } catch (err) {
      // Corrupt state must not brick the adapter; keep a copy for diagnosis.
      try { await rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      this.data = { version: 1, sessions: {}, note: `recovered from corrupt state: ${err.message}` };
    }
  }

  upsert(clawSessionName, record) {
    const prev = this.data.sessions[clawSessionName] ?? {};
    this.data.sessions[clawSessionName] = {
      ...prev,
      ...record,
      clawSessionName,
      updatedAt: new Date().toISOString(),
    };
    this._scheduleFlush();
    return this.data.sessions[clawSessionName];
  }

  get(clawSessionName) {
    return this.data.sessions[clawSessionName] ?? null;
  }

  findZcode(zcodeSessionId) {
    for (const s of Object.values(this.data.sessions)) {
      if (s.zcodeSessionId === zcodeSessionId) return s;
    }
    return null;
  }

  pushEvent(clawSessionName, event) {
    const s = this.data.sessions[clawSessionName];
    if (!s) return;
    s.events = s.events ?? [];
    s.events.push({ t: new Date().toISOString(), ...event });
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    this._scheduleFlush();
  }

  list() {
    return Object.values(this.data.sessions);
  }

  _scheduleFlush() {
    this.dirty = true;
    if (!this.flushPromise) {
      this.flushPromise = this._drainWrites().finally(() => {
        this.flushPromise = null;
        if (this.dirty) this._scheduleFlush();
      });
    }
  }

  async _drainWrites() {
    while (this.dirty) {
      this.dirty = false;
      const snapshot = JSON.stringify(this.data, null, 2);
      try {
        await this._writeSnapshot(snapshot);
        this.lastWriteError = null;
      } catch (err) {
        this.lastWriteError = err;
      }
    }
  }

  async _writeSnapshot(snapshot) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, snapshot);
    await rename(tmp, this.file);
  }

  async flush() {
    while (this.flushPromise) await this.flushPromise;
    if (this.lastWriteError) throw this.lastWriteError;
  }
}
