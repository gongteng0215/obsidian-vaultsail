import { TFile, type App, requestUrl } from 'obsidian';
import { checkSize, checkSizeValue, conflictCopyPath, hash, included, jsonBytes, parseJson, relativePath, uuid, validId, VaultSailError } from '../core/safety';
import type { CredentialStore } from '../auth/auth-manager';
import type { HttpTransport } from '../providers/http';
import { newState, validateState, type LocalFiles, type StateStore, type SyncState } from '../sync/engine';
import type { RevisionCache } from '../sync/remote-vault';
import { ensureDirectories as mkdirs, vaultIO, storageAdapter } from './local-io';
import { diagnosticLog } from '../diagnostics/log';

export class ObsidianRevisionCache implements RevisionCache {
  private app: App; private path: string;
  constructor(app: App, deviceId: string, contextId: string) {
    if (!validId(deviceId) || !/^[a-f0-9]{64}$/.test(contextId)) throw new VaultSailError('state', '缓存范围标识无效。');
    this.app = app; this.path = '.vaultsail-state/' + deviceId + '/sessions/' + contextId + '.revisions.json';
  }
  async load(): Promise<unknown> {
    const stat = await storageAdapter(this.app).stat(this.path);
    if (!stat) return undefined;
    if (stat.type !== 'file' || stat.size > 16 * 1024 * 1024) return undefined;
    return parseJson(await storageAdapter(this.app).readBinary(this.path));
  }
  async save(value: unknown): Promise<boolean> {
    const data = jsonBytes(value); if (data.byteLength > 16 * 1024 * 1024) return false;
    await mkdirs(this.app, this.path.slice(0, this.path.lastIndexOf('/')));
    const temporary = this.path + '.' + uuid() + '.next';
    await storageAdapter(this.app).writeBinary(temporary, data);
    if (await storageAdapter(this.app).exists(this.path)) await storageAdapter(this.app).remove(this.path);
    await storageAdapter(this.app).rename(temporary, this.path);
    return true;
  }
}

export const obsidianTransport: HttpTransport = async input => {
  const response = await requestUrl({ ...input, throw: false });
  let json: unknown;
  // Binary downloads are not JSON; never include raw parse failures in errors.
  try { json = response.json; } catch { json = undefined; }
  return { status: response.status, headers: response.headers, json, bytes: response.arrayBuffer };
};
export class ObsidianCredentials implements CredentialStore {
  private app: App;
  constructor(app: App) { this.app = app; }
  private access<T>(run: () => T): T {
    try { return run(); } catch (error) {
      const mapped = error instanceof VaultSailError ? error : new VaultSailError('state', '访问本机密钥存储失败，请检查 Obsidian 密钥存储是否可用。', false, 0, error);
      diagnosticLog(this.app)?.record('local', 'failure', { step: 'credentials' }, mapped); throw error;
    }
  }
  get(id: string): string | null { return this.access(() => id ? this.app.secretStorage.getSecret(id) : null); }
  set(id: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new VaultSailError('credentials-id', '本地密钥标识无效或超过 64 个字符，请更新插件后重新导入。');
    this.access(() => this.app.secretStorage.setSecret(id, value));
  }
  remove(id: string): void {
    const storage = this.app.secretStorage as App['secretStorage'] & { deleteSecret?: (key: string) => boolean };
    this.access(() => {
      if (!id || storage.getSecret(id) === null) return;
      if (typeof storage.deleteSecret === 'function') storage.deleteSecret(id);
      else storage.setSecret(id, '');
    });
  }
}
export function deviceIdentity(app: App): string {
  const existing: unknown = app.loadLocalStorage('vaultsail-device-id');
  if (existing !== null && existing !== undefined && !validId(existing)) throw new VaultSailError('state', '本地设备标识损坏，请先保留状态数据。');
  if (validId(existing)) return existing;
  const id = uuid(); app.saveLocalStorage('vaultsail-device-id', id); return id;
}
export class ObsidianLocalFiles implements LocalFiles {
  private app: App; private deviceId: string; readonly internal: string; private fileLimit: () => number;
  constructor(app: App, deviceId: string, fileLimit: () => number = () => 20 * 1024 * 1024) { this.fileLimit = fileLimit; this.app = app; this.deviceId = deviceId; this.internal = '.vaultsail-state/' + deviceId; }
  private userPath(path: string): void {
    relativePath(path); if (!included(path, this.app.vault.configDir)) throw new VaultSailError('path', '此路径被同步排除。');
  }
  async paths(): Promise<string[]> { return this.app.vault.getFiles().filter(file => included(file.path, this.app.vault.configDir)).map(file => file.path); }
  async stat(path: string): Promise<{ size: number } | null> {
    this.userPath(path); const stat = await storageAdapter(this.app).stat(path);
    if (!stat) return null;
    if (stat.type !== 'file') throw new VaultSailError('collision', '目标路径是目录。');
    checkSizeValue(stat.size); return { size: stat.size };
  }
  async read(path: string): Promise<ArrayBuffer | null> {
    this.userPath(path); const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new VaultSailError('collision', '目标路径是目录。');
    const stat = await this.stat(path);
    if (!stat) throw new VaultSailError('changed', '读取期间文件已变化。');
    checkSize(stat.size, this.fileLimit());
    const data = await vaultIO(this.app, 'read-note', path, '读取待同步文件', () => this.app.vault.readBinary(file)); checkSize(data.byteLength, this.fileLimit()); return data;
  }
  async stage(id: string, data: ArrayBuffer): Promise<void> {
    if (!validId(id)) throw new VaultSailError('state', '暂存标识无效。');
    const log = diagnosticLog(this.app); log?.record('local', 'checkpoint', { step: 'writeBinary', operationRef: log.ref(id), bytes: data.byteLength, outcome: 'start' });
    checkSize(data.byteLength, this.fileLimit()); const dir = this.internal + '/staging'; await mkdirs(this.app, dir);
    const path = dir + '/' + id + '.bin';
    if (await storageAdapter(this.app).exists(path)) {
      if (hash(await storageAdapter(this.app).readBinary(path)) !== hash(data)) throw new VaultSailError('integrity', '暂存对象内容不同。'); return;
    }
    await storageAdapter(this.app).writeBinary(path, data);
    if (hash(await storageAdapter(this.app).readBinary(path)) !== hash(data)) throw new VaultSailError('integrity', '暂存校验失败。');
  }
  async readConflictCopy(path: string, versionKey: string): Promise<ArrayBuffer | null> {
    this.userPath(path); const target = conflictCopyPath(path, versionKey); const stat = await storageAdapter(this.app).stat(target);
    if (!stat) return null;
    if (stat.type !== 'file') throw new VaultSailError('collision', '冲突副本位置已被目录占用。');
    checkSize(stat.size, this.fileLimit()); return storageAdapter(this.app).readBinary(target);
  }
  async writeConflictCopy(path: string, versionKey: string, data: ArrayBuffer): Promise<void> {
    this.userPath(path); checkSize(data.byteLength, this.fileLimit()); const target = conflictCopyPath(path, versionKey);
    const old = await this.readConflictCopy(path, versionKey);
    if (old) { if (hash(old) !== hash(data)) throw new VaultSailError('integrity', '已有冲突副本被编辑，已保留它并停止覆盖。'); return; }
    await mkdirs(this.app, target.slice(0, target.lastIndexOf('/')));
    await vaultIO(this.app, 'conflict-copy', target, '保存冲突副本', () => this.app.vault.createBinary(target, data));
    const actual = await this.readConflictCopy(path, versionKey);
    if (!actual || hash(actual) !== hash(data)) throw new VaultSailError('integrity', '冲突副本校验失败，原笔记未被替换。');
  }
  async staged(id: string): Promise<ArrayBuffer | null> {
    if (!validId(id)) throw new VaultSailError('state', '暂存标识无效。');
    const path = this.internal + '/staging/' + id + '.bin';
    const stat = await storageAdapter(this.app).stat(path);
    if (!stat) return null;
    if (stat.type !== 'file') throw new VaultSailError('state', '暂存位置不是文件。');
    checkSize(stat.size, this.fileLimit());
    return storageAdapter(this.app).readBinary(path);
  }
  async preserve(path: string, data: ArrayBuffer, id: string): Promise<string> {
    this.userPath(path); if (!validId(id)) throw new VaultSailError('state', '恢复点标识无效。');
    const log = diagnosticLog(this.app); log?.record('local', 'checkpoint', { step: 'save-recovery', operationRef: log.ref(id), ...log.file(path), bytes: data.byteLength, outcome: 'start' });
    checkSize(data.byteLength, this.fileLimit());
    const target = this.internal + '/recovery/' + id + '/' + path;
    await mkdirs(this.app, target.slice(0, target.lastIndexOf('/')));
    if (await storageAdapter(this.app).exists(target)) {
      if (hash(await storageAdapter(this.app).readBinary(target)) !== hash(data)) throw new VaultSailError('integrity', '恢复点内容不同，禁止覆盖。');
    } else await storageAdapter(this.app).writeBinary(target, data);
    if (hash(await storageAdapter(this.app).readBinary(target)) !== hash(data)) throw new VaultSailError('integrity', '恢复副本校验失败。');
    return target;
  }
  async apply(path: string, data: ArrayBuffer | null, expected: string | null, recoveryId: string): Promise<void> {
    this.userPath(path); const old = await this.read(path);
    if ((old ? hash(old) : null) !== expected) throw new VaultSailError('changed', '目标文件已被编辑，停止替换。');
    if (old) await this.preserve(path, old, recoveryId);
    if (data) await this.stage(recoveryId, data);
    const latest = await this.read(path);
    if ((latest ? hash(latest) : null) !== expected) throw new VaultSailError('changed', '备份期间目标文件被编辑，停止替换。');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (data === null) { if (file instanceof TFile) await vaultIO(this.app, 'trash', path, '将本机文件移入回收站', () => this.app.vault.trash(file, false)); }
    else if (file instanceof TFile && /\.md$/i.test(path)) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new VaultSailError('encoding', 'Markdown 不是有效 UTF-8，已保留暂存内容并停止替换。'); }
      await vaultIO(this.app, 'apply-note', path, '应用笔记内容', () => this.app.vault.process(file, current => {
        if (hash(new TextEncoder().encode(current).buffer as ArrayBuffer) !== expected) throw new VaultSailError('changed', '笔记已被编辑，停止替换。');
        return text;
      }));
    }
    else if (file instanceof TFile) await vaultIO(this.app, 'apply-attachment', path, '应用附件内容', () => this.app.vault.modifyBinary(file, data));
    else {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        if (!this.app.vault.getAbstractFileByPath(directory)) {
          try { await vaultIO(this.app, 'create-folder', directory, '创建笔记目录', () => this.app.vault.createFolder(directory)); }
          catch (error) {
            const actual = this.app.vault.getAbstractFileByPath(directory);
            if (!actual || actual instanceof TFile) throw error;
          }
        }
      }
      await vaultIO(this.app, 'create-note', path, '创建本机文件', () => this.app.vault.createBinary(path, data));
    }
    const actual = await this.read(path);
    if ((actual ? hash(actual) : null) !== (data ? hash(data) : null)) throw new VaultSailError('integrity', '应用后 Hash 不一致，恢复点已保留。');
  }
  async recoveryPoints(): Promise<string[]> {
    const root = this.internal + '/recovery'; if (!await storageAdapter(this.app).exists(root)) return [];
    const files: string[] = []; const queue = [root];
    for (let i = 0; i < queue.length; i++) { const list = await storageAdapter(this.app).list(queue[i]); files.push(...list.files); queue.push(...list.folders); if (files.length > 10000) throw new VaultSailError('size', '恢复点数量超过上限。'); }
    return files.sort();
  }
  async restore(point: string): Promise<void> {
    const prefix = this.internal + '/recovery/';
    if (!point.startsWith(prefix)) throw new VaultSailError('path', '恢复点不属于当前设备。');
    const relative = point.slice(prefix.length); const id = relative.split('/')[0];
    if (!validId(id)) throw new VaultSailError('path', '恢复点标识无效。');
    const path = relative.slice(id.length + 1); this.userPath(path);
    const stat = await storageAdapter(this.app).stat(point); if (!stat || stat.type !== 'file') throw new VaultSailError('not-found', '恢复点不存在。'); checkSize(stat.size, this.fileLimit());
    const data = await storageAdapter(this.app).readBinary(point); const old = await this.read(path);
    await this.apply(path, data, old ? hash(old) : null, uuid());
  }
}
export class ObsidianStateStore implements StateStore {
  private journalStages = new Map<string, string>();
  private app: App; private deviceId: string; private vaultId: string; private path: string;
  constructor(app: App, deviceId: string, vaultId: string, contextId: string) {
    this.app = app; this.deviceId = deviceId; this.vaultId = vaultId;
    this.path = '.vaultsail-state/' + deviceId + '/sessions/' + contextId + '.json';
  }
  async load(): Promise<SyncState> {
    const adapter = storageAdapter(this.app);
    if (!await adapter.exists(this.path)) {
      if (await adapter.exists(this.path + '.previous')) return validateState(parseJson(await adapter.readBinary(this.path + '.previous')), this.vaultId, this.deviceId);
      return newState(this.deviceId);
    }
    const stat = await adapter.stat(this.path);
    if (!stat || stat.type !== 'file' || stat.size > 20 * 1024 * 1024) throw new VaultSailError('state', '本地状态文件异常。');
    return validateState(parseJson(await adapter.readBinary(this.path)), this.vaultId, this.deviceId);
  }
  async save(state: SyncState): Promise<void> {
    validateState(state, this.vaultId, this.deviceId); const adapter = storageAdapter(this.app);
    const log = diagnosticLog(this.app), context = log?.context();
    log?.record('local', 'checkpoint', { ...context, step: 'save-state', outcome: 'start', journals: state.journals.length, bases: Object.keys(state.bases).length, knownOps: state.knownOps.length });
    await mkdirs(this.app, this.path.slice(0, this.path.lastIndexOf('/')));
    const data = jsonBytes(state); checkSize(data.byteLength); const temporary = this.path + '.next';
    await adapter.writeBinary(temporary, data);
    if (hash(await adapter.readBinary(temporary)) !== hash(data)) throw new VaultSailError('integrity', '状态暂存校验失败。');
    if (await adapter.exists(this.path)) {
      if (await adapter.exists(this.path + '.previous')) await adapter.remove(this.path + '.previous');
      await adapter.rename(this.path, this.path + '.previous');
    }
    await adapter.rename(temporary, this.path);
    log?.record('local', 'checkpoint', { ...context, step: 'save-state', outcome: 'success', journals: state.journals.length });
    for (const journal of state.journals) if (this.journalStages.get(journal.id) !== journal.stage) {
      log?.record('engine', 'checkpoint', { ...context, step: 'save-state', phase: journal.stage, action: journal.action, operationRef: log.ref(journal.id), ...log.file(journal.path) });
      this.journalStages.set(journal.id, journal.stage);
    }
    while (this.journalStages.size > 512) this.journalStages.delete(this.journalStages.keys().next().value!);
  }
}
