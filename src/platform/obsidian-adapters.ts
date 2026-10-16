import { TFile, type App, requestUrl } from 'obsidian';
import { checkSize, checkSizeValue, conflictCopyPath, hash, included, jsonBytes, parseJson, relativePath, uuid, validId, VaultSailError } from '../core/safety';
import type { CredentialStore } from '../auth/auth-manager';
import type { HttpTransport } from '../providers/http';
import { newState, validateState, type LocalFiles, type StateStore, type SyncState } from '../sync/engine';
import type { RevisionCache } from '../sync/remote-vault';

export class ObsidianRevisionCache implements RevisionCache {
  private app: App; private path: string;
  constructor(app: App, deviceId: string, contextId: string) {
    if (!validId(deviceId) || !/^[a-f0-9]{64}$/.test(contextId)) throw new VaultSailError('state', '缓存范围标识无效。');
    this.app = app; this.path = '.vaultsail-state/' + deviceId + '/sessions/' + contextId + '.revisions.json';
  }
  async load(): Promise<unknown> {
    const stat = await this.app.vault.adapter.stat(this.path);
    if (!stat) return undefined;
    if (stat.type !== 'file' || stat.size > 16 * 1024 * 1024) return undefined;
    return parseJson(await this.app.vault.adapter.readBinary(this.path));
  }
  async save(value: unknown): Promise<void> {
    const data = jsonBytes(value); if (data.byteLength > 16 * 1024 * 1024) return;
    await mkdirs(this.app, this.path.slice(0, this.path.lastIndexOf('/')));
    const temporary = this.path + '.' + uuid() + '.next';
    await this.app.vault.adapter.writeBinary(temporary, data);
    if (await this.app.vault.adapter.exists(this.path)) await this.app.vault.adapter.remove(this.path);
    await this.app.vault.adapter.rename(temporary, this.path);
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
  get(id: string): string | null { return id ? this.app.secretStorage.getSecret(id) : null; }
  set(id: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new VaultSailError('credentials-id', '本地密钥标识无效或超过 64 个字符，请更新插件后重新导入。');
    this.app.secretStorage.setSecret(id, value);
  }
  remove(id: string): void {
    const storage = this.app.secretStorage as App['secretStorage'] & { deleteSecret?: (key: string) => boolean };
    if (!id || storage.getSecret(id) === null) return;
    if (typeof storage.deleteSecret === 'function') storage.deleteSecret(id);
    else storage.setSecret(id, '');
  }
}
export function deviceIdentity(app: App): string {
  const existing: unknown = app.loadLocalStorage('vaultsail-device-id');
  if (existing !== null && existing !== undefined && !validId(existing)) throw new VaultSailError('state', '本地设备标识损坏，请先保留状态数据。');
  if (validId(existing)) return existing;
  const id = uuid(); app.saveLocalStorage('vaultsail-device-id', id); return id;
}
async function mkdirs(app: App, path: string): Promise<void> {
  relativePath(path); const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/'); const stat = await app.vault.adapter.stat(dir);
    if (stat && stat.type !== 'folder') throw new VaultSailError('collision', '目录位置已存在同名文件。');
    if (!stat) await app.vault.adapter.mkdir(dir);
  }
}
export class ObsidianLocalFiles implements LocalFiles {
  private app: App; private deviceId: string; readonly internal: string;
  constructor(app: App, deviceId: string) { this.app = app; this.deviceId = deviceId; this.internal = '.vaultsail-state/' + deviceId; }
  private userPath(path: string): void {
    relativePath(path); if (!included(path, this.app.vault.configDir)) throw new VaultSailError('path', '此路径被同步排除。');
  }
  async paths(): Promise<string[]> { return this.app.vault.getFiles().filter(file => included(file.path, this.app.vault.configDir)).map(file => file.path); }
  async stat(path: string): Promise<{ size: number } | null> {
    this.userPath(path); const stat = await this.app.vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== 'file') throw new VaultSailError('collision', '目标路径是目录。');
    checkSizeValue(stat.size); return { size: stat.size };
  }
  async read(path: string): Promise<ArrayBuffer | null> {
    this.userPath(path); const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new VaultSailError('collision', '目标路径是目录。');
    checkSize(file.stat.size); return this.app.vault.readBinary(file);
  }
  async stage(id: string, data: ArrayBuffer): Promise<void> {
    if (!validId(id)) throw new VaultSailError('state', '暂存标识无效。');
    checkSize(data.byteLength); const dir = this.internal + '/staging'; await mkdirs(this.app, dir);
    const path = dir + '/' + id + '.bin';
    if (await this.app.vault.adapter.exists(path)) {
      if (hash(await this.app.vault.adapter.readBinary(path)) !== hash(data)) throw new VaultSailError('integrity', '暂存对象内容不同。'); return;
    }
    await this.app.vault.adapter.writeBinary(path, data);
    if (hash(await this.app.vault.adapter.readBinary(path)) !== hash(data)) throw new VaultSailError('integrity', '暂存校验失败。');
  }
  async readConflictCopy(path: string, versionKey: string): Promise<ArrayBuffer | null> {
    this.userPath(path); const target = conflictCopyPath(path, versionKey); const stat = await this.app.vault.adapter.stat(target);
    if (!stat) return null;
    if (stat.type !== 'file') throw new VaultSailError('collision', '冲突副本位置已被目录占用。');
    checkSize(stat.size); return this.app.vault.adapter.readBinary(target);
  }
  async writeConflictCopy(path: string, versionKey: string, data: ArrayBuffer): Promise<void> {
    this.userPath(path); checkSize(data.byteLength); const target = conflictCopyPath(path, versionKey);
    const old = await this.readConflictCopy(path, versionKey);
    if (old) { if (hash(old) !== hash(data)) throw new VaultSailError('integrity', '已有冲突副本被编辑，已保留它并停止覆盖。'); return; }
    await mkdirs(this.app, target.slice(0, target.lastIndexOf('/')));
    await this.app.vault.createBinary(target, data);
    const actual = await this.readConflictCopy(path, versionKey);
    if (!actual || hash(actual) !== hash(data)) throw new VaultSailError('integrity', '冲突副本校验失败，原笔记未被替换。');
  }
  async staged(id: string): Promise<ArrayBuffer | null> {
    if (!validId(id)) throw new VaultSailError('state', '暂存标识无效。');
    const path = this.internal + '/staging/' + id + '.bin';
    if (!await this.app.vault.adapter.exists(path)) return null;
    return this.app.vault.adapter.readBinary(path);
  }
  async preserve(path: string, data: ArrayBuffer, id: string): Promise<string> {
    this.userPath(path); if (!validId(id)) throw new VaultSailError('state', '恢复点标识无效。');
    const target = this.internal + '/recovery/' + id + '/' + path;
    await mkdirs(this.app, target.slice(0, target.lastIndexOf('/')));
    if (await this.app.vault.adapter.exists(target)) {
      if (hash(await this.app.vault.adapter.readBinary(target)) !== hash(data)) throw new VaultSailError('integrity', '恢复点内容不同，禁止覆盖。');
    } else await this.app.vault.adapter.writeBinary(target, data);
    if (hash(await this.app.vault.adapter.readBinary(target)) !== hash(data)) throw new VaultSailError('integrity', '恢复副本校验失败。');
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
    if (data === null) { if (file instanceof TFile) await this.app.vault.trash(file, false); }
    else if (file instanceof TFile && /\.md$/i.test(path)) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new VaultSailError('encoding', 'Markdown 不是有效 UTF-8，已保留暂存内容并停止替换。'); }
      await this.app.vault.process(file, current => {
        if (hash(new TextEncoder().encode(current).buffer as ArrayBuffer) !== expected) throw new VaultSailError('changed', '笔记已被编辑，停止替换。');
        return text;
      });
    }
    else if (file instanceof TFile) await this.app.vault.modifyBinary(file, data);
    else {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        if (!this.app.vault.getAbstractFileByPath(directory)) await this.app.vault.createFolder(directory);
      }
      await this.app.vault.createBinary(path, data);
    }
    const actual = await this.read(path);
    if ((actual ? hash(actual) : null) !== (data ? hash(data) : null)) throw new VaultSailError('integrity', '应用后 Hash 不一致，恢复点已保留。');
  }
  async recoveryPoints(): Promise<string[]> {
    const root = this.internal + '/recovery'; if (!await this.app.vault.adapter.exists(root)) return [];
    const files: string[] = []; const queue = [root];
    for (let i = 0; i < queue.length; i++) { const list = await this.app.vault.adapter.list(queue[i]); files.push(...list.files); queue.push(...list.folders); if (files.length > 10000) throw new VaultSailError('size', '恢复点数量超过上限。'); }
    return files.sort();
  }
  async restore(point: string): Promise<void> {
    const prefix = this.internal + '/recovery/';
    if (!point.startsWith(prefix)) throw new VaultSailError('path', '恢复点不属于当前设备。');
    const relative = point.slice(prefix.length); const id = relative.split('/')[0];
    if (!validId(id)) throw new VaultSailError('path', '恢复点标识无效。');
    const path = relative.slice(id.length + 1); this.userPath(path);
    const stat = await this.app.vault.adapter.stat(point); if (!stat || stat.type !== 'file') throw new VaultSailError('not-found', '恢复点不存在。'); checkSize(stat.size);
    const data = await this.app.vault.adapter.readBinary(point); const old = await this.read(path);
    await this.apply(path, data, old ? hash(old) : null, uuid());
  }
}
export class ObsidianStateStore implements StateStore {
  private app: App; private deviceId: string; private vaultId: string; private path: string;
  constructor(app: App, deviceId: string, vaultId: string, contextId: string) {
    this.app = app; this.deviceId = deviceId; this.vaultId = vaultId;
    this.path = '.vaultsail-state/' + deviceId + '/sessions/' + contextId + '.json';
  }
  async load(): Promise<SyncState> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(this.path)) {
      if (await adapter.exists(this.path + '.previous')) return validateState(parseJson(await adapter.readBinary(this.path + '.previous')), this.vaultId, this.deviceId);
      return newState(this.deviceId);
    }
    const stat = await adapter.stat(this.path);
    if (!stat || stat.type !== 'file' || stat.size > 20 * 1024 * 1024) throw new VaultSailError('state', '本地状态文件异常。');
    return validateState(parseJson(await adapter.readBinary(this.path)), this.vaultId, this.deviceId);
  }
  async save(state: SyncState): Promise<void> {
    validateState(state, this.vaultId, this.deviceId); const adapter = this.app.vault.adapter;
    await mkdirs(this.app, this.path.slice(0, this.path.lastIndexOf('/')));
    const data = jsonBytes(state); checkSize(data.byteLength); const temporary = this.path + '.next';
    await adapter.writeBinary(temporary, data);
    if (hash(await adapter.readBinary(temporary)) !== hash(data)) throw new VaultSailError('integrity', '状态暂存校验失败。');
    if (await adapter.exists(this.path)) {
      if (await adapter.exists(this.path + '.previous')) await adapter.remove(this.path + '.previous');
      await adapter.rename(this.path, this.path + '.previous');
    }
    await adapter.rename(temporary, this.path);
  }
}
