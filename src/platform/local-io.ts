import type { App, DataAdapter } from 'obsidian';
import { relativePath, VaultSailError } from '../core/safety.ts';

const codes = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOSPC', 'EEXIST', 'ENAMETOOLONG', 'EIO', 'EROFS']);
/** Keep native paths, note text and arbitrary error messages out of UI/history. */
export async function localIO<T>(step: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof VaultSailError) throw error;
    const native = error as { code?: unknown; message?: unknown } | null;
    const candidate = typeof native?.code === 'string' ? native.code
      : typeof native?.message === 'string' ? /^(?:Error: )?([A-Z]+)\b/.exec(native.message)?.[1] : undefined;
    const code = candidate && codes.has(candidate) ? candidate : undefined;
    const hint = code === 'ENOSPC' ? '请检查本机剩余空间。'
      : code && ['EPERM', 'EBUSY', 'EACCES'].includes(code) ? '请检查文件占用或目录写入权限，再恢复未完成任务或重试。'
      : '请检查本机目录是否可读写，再恢复未完成任务或重试。';
    throw new VaultSailError('state', `${step}失败${code ? '（' + code + '）' : ''}。${hint}`);
  }
}

const labels = { stat: '检查本机文件', exists: '检查本机路径', mkdir: '创建本机目录', readBinary: '读取本机文件',
  writeBinary: '写入本机文件', rename: '提交本机文件', remove: '清理本机旧记录', list: '枚举本机目录' } as const;
type StorageAdapter = Pick<DataAdapter, keyof typeof labels>;
const adapters = new WeakMap<object, StorageAdapter>();
export function storageAdapter(app: App): StorageAdapter {
  const source = app.vault.adapter;
  let wrapped = adapters.get(source);
  if (!wrapped) {
    wrapped = new Proxy(source, { get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof key === 'string' && Object.hasOwn(labels, key) && typeof member === 'function') {
        return (...args: unknown[]) => localIO(labels[key as keyof typeof labels], () => member.apply(target, args));
      }
      return member;
    } });
    adapters.set(source, wrapped);
  }
  return wrapped;
}

/** Another writer may create a shared parent after stat; accept only a verified folder. */
export async function ensureDirectories(app: App, path: string): Promise<void> {
  relativePath(path); const adapter = storageAdapter(app), parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/'), stat = await adapter.stat(dir);
    if (stat && stat.type !== 'folder') throw new VaultSailError('collision', '目录位置已存在同名文件。');
    if (!stat) {
      try { await adapter.mkdir(dir); }
      catch (error) {
        // Do not swallow permission/disk failures or a same-name file.
        const actual = await adapter.stat(dir);
        if (actual?.type !== 'folder') throw error;
      }
    }
  }
}
