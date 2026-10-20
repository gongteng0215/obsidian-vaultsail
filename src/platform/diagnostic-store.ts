import type { App } from 'obsidian';
import { bytes, hash, parseJson, validId } from '../core/safety.ts';
import { validateDiagnostic, type DiagnosticRecord, type DiagnosticStore } from '../diagnostics/log.ts';

export const DIAGNOSTIC_SEGMENTS = 32, DIAGNOSTIC_SEGMENT_BYTES = 128 * 1024, DIAGNOSTIC_RETENTION_MS = 7 * 24 * 3600_000;
const name = /^(error|trace)-(\d{1,16})-(\d{1,16})-([a-f0-9-]{36})\.json(?:\.next)?$/;
const key = Symbol.for('vaultsail.diagnostic-storage');
const shared = window as typeof window & { [key]?: WeakMap<object, Promise<void>> };
const locks = shared[key] ??= new WeakMap<object, Promise<void>>();
/** Uses the raw adapter so a logging failure never logs itself. */
export class ObsidianDiagnosticStore implements DiagnosticStore {
  readonly root: string; private app: App; private now: () => number;
  constructor(app: App, deviceId: string, now = () => Date.now()) {
    if (!validId(deviceId)) throw new Error('Invalid diagnostic scope');
    this.app = app; this.root = '.vaultsail-state/' + deviceId + '/diagnostics'; this.now = now;
  }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    const operation = (locks.get(this.app) ?? Promise.resolve()).then(run), settled = operation.then(() => {}, () => {});
    locks.set(this.app, settled); try { return await operation; } finally { if (locks.get(this.app) === settled) locks.delete(this.app); }
  }
  private async files(): Promise<{ path: string; at: number; sequence: number; bucket: string }[]> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(this.root)) return [];
    return (await adapter.list(this.root)).files.flatMap(path => {
      const match = name.exec(path.slice(this.root.length + 1));
      return match && path === this.root + '/' + match[0] && validId(match[4]) && Number.isSafeInteger(Number(match[2])) && Number.isSafeInteger(Number(match[3])) ? [{ path, at: Number(match[2]), sequence: Number(match[3]), bucket: match[1] }] : [];
    }).sort((a, b) => b.at - a.at || b.sequence - a.sequence || b.path.localeCompare(a.path));
  }
  private async prune(reserve?: string): Promise<void> {
    const files = await this.files();
    const retained = new Set(['error', 'trace'].flatMap(bucket => files.filter(file => file.bucket === bucket && file.at >= this.now() - DIAGNOSTIC_RETENTION_MS)
      .slice(0, DIAGNOSTIC_SEGMENTS / 2 - (reserve === bucket ? 1 : 0)).map(file => file.path)));
    for (const file of files) if (!retained.has(file.path)) await this.app.vault.adapter.remove(file.path);
  }
  async append(records: DiagnosticRecord[]): Promise<void> {
    const checked = records.map(validateDiagnostic); if (!checked.length || checked.some(item => !item)) throw new Error('Invalid diagnostic record');
    const data = bytes(JSON.stringify(checked)); if (data.byteLength > DIAGNOSTIC_SEGMENT_BYTES) throw new Error('Diagnostic segment exceeds limit');
    await this.locked(async () => {
      const adapter = this.app.vault.adapter, parts = this.root.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/'), stat = await adapter.stat(path);
        if (stat && stat.type !== 'folder') throw new Error('Diagnostic directory collision');
        if (!stat) { try { await adapter.mkdir(path); } catch (error) { if ((await adapter.stat(path))?.type !== 'folder') throw error; } }
      }
      const first = checked[0]!, bucket = checked.some(item => item?.event === 'failure') ? 'error' : 'trace';
      // A failed cleanup can leave a committed batch while more events arrive.
      // Name by the entire batch so replay with a larger buffer cannot collide.
      const digest = hash(data), batchId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const target = this.root + '/' + bucket + '-' + first.at + '-' + first.sequence + '-' + batchId + '.json';
      // Bound complete and interrupted segments before allocating another one.
      await this.prune(bucket);
      if (await adapter.exists(target)) {
        const stat = await adapter.stat(target);
        if (stat?.type !== 'file' || stat.size !== data.byteLength || hash(await adapter.readBinary(target)) !== hash(data)) throw new Error('Diagnostic segment mismatch');
      } else {
        await adapter.writeBinary(target + '.next', data);
        if (hash(await adapter.readBinary(target + '.next')) !== hash(data)) throw new Error('Diagnostic staging mismatch');
        await adapter.rename(target + '.next', target);
      }
      await this.prune();
    });
  }
  async read(): Promise<{ records: DiagnosticRecord[]; unreadable: number }> {
    return this.locked(async () => {
      const result: DiagnosticRecord[] = []; let unreadable = 0; const adapter = this.app.vault.adapter;
      const files = (await this.files()).filter(file => file.at >= this.now() - DIAGNOSTIC_RETENTION_MS).slice(0, DIAGNOSTIC_SEGMENTS * 2);
      for (const file of files) {
        try {
          const stat = await adapter.stat(file.path);
          if (stat?.type !== 'file' || stat.size > DIAGNOSTIC_SEGMENT_BYTES) { unreadable++; continue; }
          const raw = parseJson(await adapter.readBinary(file.path));
          if (!Array.isArray(raw) || raw.length > 64) { unreadable++; continue; }
          for (const item of raw) { const checked = validateDiagnostic(item); if (checked) result.push(checked); else unreadable++; }
        } catch { unreadable++; }
      }
      return { records: result, unreadable };
    });
  }
}
