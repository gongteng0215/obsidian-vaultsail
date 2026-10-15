import type { App } from 'obsidian';
import { bytes, hash, parseJson, validId, VaultSailError } from '../core/safety.ts';
export interface ConflictDraft { version: 1; fingerprint: string; text: string; blocks: Record<string, string>; manual?: boolean; }
export class ConflictDrafts {
  private app: App; private root: string; private pending = new Map<string, Promise<void>>();
  constructor(app: App, deviceId: string, context: string) {
    if (!validId(deviceId) || !/^[a-f0-9]{64}$/.test(context)) throw new VaultSailError('state', '合并草稿范围无效。');
    this.app = app; this.root = '.vaultsail-state/' + deviceId + '/drafts/' + context;
  }
  private path(path: string): string { return this.root + '/' + hash(bytes(path)) + '.json'; }
  async load(path: string): Promise<ConflictDraft | undefined> {
    let target = this.path(path); await this.pending.get(target);
    if (!await this.app.vault.adapter.exists(target) && await this.app.vault.adapter.exists(target + '.next')) target += '.next';
    const stat = await this.app.vault.adapter.stat(target); if (!stat || stat.type !== 'file' || stat.size > 1024 * 1024) return undefined;
    try { const value = parseJson(await this.app.vault.adapter.readBinary(target)) as ConflictDraft;
      if (value.version === 1 && typeof value.fingerprint === 'string' && typeof value.text === 'string' && value.text.length <= 256 * 1024
        && value.blocks && typeof value.blocks === 'object' && !Array.isArray(value.blocks) && Object.values(value.blocks).every(text => typeof text === 'string')) return value;
    } catch { /* A damaged draft must not affect the note or conflict graph. */ }
  }
  async save(path: string, draft: ConflictDraft): Promise<void> {
    const target = this.path(path), data = bytes(JSON.stringify(draft));
    if (data.byteLength > 1024 * 1024) throw new VaultSailError('size', '合并草稿过大，请精简后保存。');
    const operation = (this.pending.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const adapter = this.app.vault.adapter, parts = this.root.split('/');
      for (let i = 1; i <= parts.length; i++) { const dir = parts.slice(0, i).join('/'); if (!await adapter.exists(dir)) await adapter.mkdir(dir); }
      await adapter.writeBinary(target + '.next', data);
      if (await adapter.exists(target)) await adapter.remove(target);
      await adapter.rename(target + '.next', target);
    });
    this.pending.set(target, operation);
    try { await operation; } finally { if (this.pending.get(target) === operation) this.pending.delete(target); }
  }
}
