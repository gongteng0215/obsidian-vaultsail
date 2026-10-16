import type { App } from 'obsidian';
import { bytes, hash, parseJson, validId } from '../core/safety.ts';
import { HISTORY_BYTE_LIMIT, HISTORY_TASK_LIMIT, validateHistory, type HistoryStore, type SyncHistoryTask } from '../sync/history.ts';

const key = Symbol.for('vaultsail.history-storage');
const shared = globalThis as typeof globalThis & { [key]?: WeakMap<object, Promise<void>> };
const locks = shared[key] ??= new WeakMap<object, Promise<void>>();
async function locked<T>(app: object, run: () => Promise<T>): Promise<T> {
  const operation = (locks.get(app) ?? Promise.resolve()).then(run), settled = operation.then(() => {}, () => {});
  locks.set(app, settled);
  try { return await operation; } finally { if (locks.get(app) === settled) locks.delete(app); }
}
const ownedName = /^(\d{1,16})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json(?:\.(next|previous))?$/;

/** Device/connection-local UI records, deliberately separate from recovery. */
export class ObsidianHistoryStore implements HistoryStore {
  readonly root: string; warning = false;
  private app: App; private deviceId: string; private context: string;
  constructor(app: App, deviceId: string, context: string) {
    if (!validId(deviceId) || !/^[a-f0-9]{64}$/.test(context)) throw new Error('Invalid history scope');
    this.root = `.vaultsail-state/${deviceId}/history/${context}`;
    this.app = app; this.deviceId = deviceId; this.context = context;
  }
  private async groups(): Promise<{ base: string; startedAt: number; id: string; paths: string[] }[]> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(this.root)) return [];
    const groups = new Map<string, { base: string; startedAt: number; id: string; paths: string[] }>();
    for (const path of (await adapter.list(this.root)).files) {
      const name = path.slice(this.root.length + 1), match = ownedName.exec(name);
      if (!match || path !== this.root + '/' + name || !Number.isSafeInteger(Number(match[1]))) continue;
      const base = `${this.root}/${match[1]}-${match[2]}.json`, group = groups.get(base) ?? { base, startedAt: Number(match[1]), id: match[2], paths: [] };
      group.paths.push(path); groups.set(base, group);
    }
    return [...groups.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }
  async save(input: SyncHistoryTask): Promise<void> {
    const task = validateHistory(input, this.context, this.deviceId, this.app.vault.configDir);
    const data = bytes(JSON.stringify(task)); if (data.byteLength > HISTORY_BYTE_LIMIT) throw new Error('History size limit');
    await locked(this.app, async () => {
      const adapter = this.app.vault.adapter, parts = this.root.split('/');
      for (let i = 1; i <= parts.length; i++) { const path = parts.slice(0, i).join('/'); if (!await adapter.exists(path)) await adapter.mkdir(path); }
      const target = `${this.root}/${task.startedAt}-${task.id}.json`;
      // A reload can leave an earlier snapshot queued. Never regress a record.
      for (const path of [target, target + '.next', target + '.previous']) {
        try { const stat = await adapter.stat(path); if (!stat || stat.type !== 'file' || stat.size > HISTORY_BYTE_LIMIT) continue;
          const old = validateHistory(parseJson(await adapter.readBinary(path)), this.context, this.deviceId, this.app.vault.configDir);
          if (old.id === task.id && old.startedAt === task.startedAt && old.sequence > task.sequence) return;
        } catch { /* Keep writing the new validated record; notes are unaffected. */ }
      }
      await adapter.writeBinary(target + '.next', data);
      if (hash(await adapter.readBinary(target + '.next')) !== hash(data)) throw new Error('History staging mismatch');
      if (await adapter.exists(target + '.previous')) await adapter.remove(target + '.previous');
      if (await adapter.exists(target)) await adapter.rename(target, target + '.previous');
      await adapter.rename(target + '.next', target);
      if (await adapter.exists(target + '.previous')) await adapter.remove(target + '.previous');
      for (const group of (await this.groups()).slice(HISTORY_TASK_LIMIT)) for (const path of group.paths) await adapter.remove(path);
    });
  }
  async list(): Promise<SyncHistoryTask[]> {
    return locked(this.app, async () => {
      const result: SyncHistoryTask[] = [], adapter = this.app.vault.adapter;
      for (const group of (await this.groups()).slice(0, HISTORY_TASK_LIMIT)) {
        let best: SyncHistoryTask | undefined;
        for (const path of group.paths) {
          try { const stat = await adapter.stat(path); if (!stat || stat.type !== 'file' || stat.size > HISTORY_BYTE_LIMIT) { this.warning = true; continue; }
            const task = validateHistory(parseJson(await adapter.readBinary(path)), this.context, this.deviceId, this.app.vault.configDir);
            if (task.id !== group.id || task.startedAt !== group.startedAt) { this.warning = true; continue; }
            if (!best || task.sequence > best.sequence) best = task;
          } catch { this.warning = true; }
        }
        if (best) result.push(best);
      }
      return result;
    });
  }
}
