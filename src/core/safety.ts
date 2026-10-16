import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export class VaultSailError extends Error {
  code: string;
  retryable: boolean;
  retryAfter: number;
  constructor(code: string, message: string, retryable = false, retryAfter = 0) {
    super(message); this.name = 'VaultSailError'; this.code = code;
    this.retryable = retryable; this.retryAfter = retryAfter;
  }
}
export function safeMessage(error: unknown): string {
  return error instanceof VaultSailError ? error.message : '操作失败，详细响应已隐藏以保护凭据。';
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultSailError('response', '接口或数据格式不完整，已停止操作。');
  return value as Record<string, unknown>;
}
export function relativePath(path: string): string {
  if (!path || path.length > 1024 || path.startsWith('/') || /[\\\x00-\x1f<>:"|?*]/.test(path)) throw new VaultSailError('path', '路径不安全或不兼容，已停止操作。');
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new VaultSailError('path', '路径包含保留名称或越界部分。');
  }
  return path;
}
export function appRoot(path: string): string {
  const root = path.replace(/\/$/, '');
  if (!root.startsWith('/apps/') || root.split('/').length < 3) throw new VaultSailError('path', '请输入实际获准的 /apps/应用名 目录。');
  relativePath(root.slice(1)); return root;
}
export function included(path: string, configDir = '.obsidian'): boolean {
  return !path.split('/').some(part => part.startsWith('.') || ['node_modules', 'Thumbs.db'].includes(part))
    && path !== configDir && !path.startsWith(configDir + '/') && !path.startsWith('VaultSail-conflicts/')
    && path !== 'VaultSail-配置' && !path.startsWith('VaultSail-配置/');
}
export function collisionKey(path: string): string { return path.normalize('NFC').toLowerCase(); }
export function assertNoCollisions(paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    relativePath(path); const key = collisionKey(path);
    if (seen.has(key)) throw new VaultSailError('collision', '存在大小写或 Unicode 路径冲突，请先重命名。');
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new VaultSailError('collision', '文件与目录名称冲突。');
  }
}
export function hash(data: ArrayBuffer): string { return bytesToHex(sha256(new Uint8Array(data))); }
export function conflictCopyPath(path: string, versionKey: string): string {
  relativePath(path);
  if (!/^[a-z0-9-]{1,80}$/.test(versionKey)) throw new VaultSailError('path', '冲突副本标识无效。');
  const name = path.split('/').at(-1)!; const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : '';
  const stem = (extension ? name.slice(0, dot) : name).slice(0, 100).replace(/[. ]+$/, '') || '笔记';
  return `VaultSail-conflicts/${hash(bytes(path)).slice(0, 16)}/${stem} (冲突-${versionKey})${extension}`;
}
export function bytes(text: string): ArrayBuffer { return new TextEncoder().encode(text).buffer as ArrayBuffer; }
export function jsonBytes(value: unknown): ArrayBuffer { return bytes(JSON.stringify(value)); }
export function parseJson(data: ArrayBuffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new VaultSailError('schema', '数据不是有效的 JSON，已停止写入。'); }
}
export function uuid(): string { return crypto.randomUUID(); }
export function validId(id: unknown): id is string { return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id); }
/** Validate metadata without granting permission to allocate or transfer its body. */
export function checkSizeValue(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new VaultSailError('size', '文件大小无效。');
}
export function checkSize(size: number): void {
  checkSizeValue(size);
  if (size > MAX_FILE_SIZE) throw new VaultSailError('size', '文件超过 20 MiB 上限。');
}
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});
