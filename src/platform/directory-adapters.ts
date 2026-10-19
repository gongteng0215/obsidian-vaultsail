import type { App } from 'obsidian';
import { hash, included, jsonBytes, parseJson, VaultSailError } from '../core/safety.ts';
import { directoryPath, newDirectoryState, validateDirectoryState, type DirectoryState, type DirectoryStateStore, type LocalDirectories } from '../sync/directories.ts';
import { ensureDirectories, storageAdapter, vaultIO } from './local-io';
import { mapConcurrent } from '../core/concurrency';

export class ObsidianDirectories implements LocalDirectories {
  private app: App;
  constructor(app: App) { this.app = app; }
  private path(path: string): string { return directoryPath(path, this.app.vault.configDir); }
  async paths(): Promise<string[]> {
    const result: string[] = [];
    for (const folder of this.app.vault.getAllFolders()) {
      if (!folder.path || folder.path === '/') continue;
      // Excluded internal directories are expected; malformed included user paths are errors.
      if (!included(folder.path, this.app.vault.configDir) || folder.path === 'VaultSail-conflicts') continue;
      result.push(this.path(folder.path));
    }
    if (result.length > 10000) throw new VaultSailError('size', '本机目录超过一万个，停止目录扫描。');
    // Mobile caches can receive delete notifications later; verify with bounded local I/O.
    const present = await mapConcurrent(result, 8, path => this.present(path));
    return result.filter((_, index) => present[index]);
  }
  async files(): Promise<string[]> { return this.app.vault.getFiles().map(file => file.path); }
  async present(path: string): Promise<boolean> {
    const stat = await storageAdapter(this.app).stat(this.path(path));
    if (stat && stat.type !== 'folder') throw new VaultSailError('collision', '目录位置已被同名文件占用。');
    return Boolean(stat);
  }
  async empty(path: string): Promise<boolean> {
    if (!await this.present(path)) return true;
    const list = await storageAdapter(this.app).list(path); return !list.files.length && !list.folders.length;
  }
  async create(path: string): Promise<void> {
    this.path(path); const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (await this.present(parent)) continue;
      try { await vaultIO(this.app, 'mkdir', parent, '创建同步目录', () => this.app.vault.createFolder(parent)); }
      catch (error) { if (!await this.present(parent)) throw error; }
    }
  }
  async removeEmpty(path: string): Promise<boolean> {
    this.path(path); if (!await this.present(path)) return true;
    if (!await this.empty(path)) return false;
    try {
      // Never call Vault.delete/trash on a TFolder: they can delete a newly added child.
      // The adapter's recursive=false is the final filesystem guard against that race.
      await storageAdapter(this.app).rmdir(path, false);
    } catch (error) { if (await this.present(path) && !await this.empty(path)) return false; throw error; }
    return !await this.present(path);
  }
}
export class ObsidianDirectoryState implements DirectoryStateStore {
  private app: App; private vaultId: string; private deviceId: string; private path: string;
  constructor(app: App, vaultId: string, deviceId: string, context: string) {
    if (!/^[a-f0-9]{64}$/.test(context)) throw new VaultSailError('state', '目录状态范围无效。');
    this.app = app; this.vaultId = vaultId; this.deviceId = deviceId;
    this.path = '.vaultsail-state/' + deviceId + '/directories/' + context + '.json';
  }
  async load(): Promise<DirectoryState> {
    const adapter = storageAdapter(this.app), path = await adapter.exists(this.path) ? this.path : await adapter.exists(this.path + '.previous') ? this.path + '.previous' : undefined;
    if (!path) return newDirectoryState(this.vaultId, this.deviceId);
    const stat = await adapter.stat(path);
    if (!stat || stat.type !== 'file' || stat.size > 20 * 1024 * 1024) throw new VaultSailError('state', '目录状态文件异常，请保留日志排查。');
    return validateDirectoryState(parseJson(await adapter.readBinary(path)), this.vaultId, this.deviceId, this.app.vault.configDir);
  }
  async save(state: DirectoryState): Promise<void> {
    const valid = validateDirectoryState(state, this.vaultId, this.deviceId, this.app.vault.configDir), data = jsonBytes(valid), adapter = storageAdapter(this.app);
    if (data.byteLength > 20 * 1024 * 1024) throw new VaultSailError('size', '目录状态超过保存上限。');
    await ensureDirectories(this.app, this.path.slice(0, this.path.lastIndexOf('/')));
    await adapter.writeBinary(this.path + '.next', data);
    if (hash(await adapter.readBinary(this.path + '.next')) !== hash(data)) throw new VaultSailError('integrity', '目录状态暂存校验失败。');
    if (await adapter.exists(this.path)) {
      if (await adapter.exists(this.path + '.previous')) await adapter.remove(this.path + '.previous');
      await adapter.rename(this.path, this.path + '.previous');
    }
    await adapter.rename(this.path + '.next', this.path);
  }
}
