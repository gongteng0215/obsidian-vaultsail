import { checkSize, hash, included, jsonBytes, parseJson, record, relativePath, uuid, validId, VaultSailError } from '../core/safety.ts';
import { listAll } from '../providers/provider-utils.ts';
import type { CloudStorageProvider } from '../providers/cloud-storage-provider';

export interface RemoteVault { schemaVersion: 1; vaultId: string; displayName: string; createdAt: number; }
export interface Revision {
  schemaVersion: 1; vaultId: string; opId: string; deviceId: string; fileId: string;
  path: string; parents: string[]; kind: 'update' | 'delete'; hash?: string; size: number; createdAt: number;
  previousPath?: string;
}
export function validateRevision(value: unknown, vaultId: string): Revision {
  const op = record(value);
  if (op.schemaVersion !== 1 || op.vaultId !== vaultId || !validId(op.opId) || !validId(op.deviceId) || !validId(op.fileId)
    || typeof op.path !== 'string' || !Array.isArray(op.parents) || op.parents.some(parent => !validId(parent))
    || new Set(op.parents).size !== op.parents.length || !['update', 'delete'].includes(String(op.kind))
    || typeof op.size !== 'number' || typeof op.createdAt !== 'number' || !Number.isFinite(op.createdAt)) throw new VaultSailError('schema', '操作记录格式未知或损坏，停止写入。');
  relativePath(op.path); checkSize(op.size);
  if (op.previousPath !== undefined) {
    if (typeof op.previousPath !== 'string' || op.previousPath === op.path || op.kind !== 'update') throw new VaultSailError('schema', '重命名记录无效。');
    relativePath(op.previousPath); if (!included(op.previousPath)) throw new VaultSailError('path', '重命名源路径被排除。');
  }
  if (!included(op.path)) throw new VaultSailError('path', '远端记录试图写入排除目录。');
  if (op.kind === 'update' && (typeof op.hash !== 'string' || !/^[a-f0-9]{64}$/.test(op.hash))) throw new VaultSailError('schema', '内容记录缺少 SHA-256。');
  if (op.kind === 'delete' && (op.hash !== undefined || op.size !== 0)) throw new VaultSailError('schema', '删除记录格式不正确。');
  return op as unknown as Revision;
}
export function buildHeads(ops: Revision[]): Map<string, Revision[]> {
  const byId = new Map<string, Revision>(); const children = new Map<string, string[]>(); const indegrees = new Map<string, number>();
  for (const op of ops) {
    if (byId.has(op.opId)) throw new VaultSailError('schema', '操作 ID 重复。');
    byId.set(op.opId, op); indegrees.set(op.opId, op.parents.length);
  }
  for (const op of ops) for (const parentId of op.parents) {
    const parent = byId.get(parentId);
    if (!parent || (parent.fileId !== op.fileId && parent.path !== op.path)) throw new VaultSailError('schema', '父版本缺失或关联错误，请重新扫描。');
    children.set(parentId, [...(children.get(parentId) ?? []), op.opId]);
  }
  const queue = ops.filter(op => op.parents.length === 0).map(op => op.opId); let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; visited++;
    for (const child of children.get(id) ?? []) {
      const remaining = indegrees.get(child)! - 1; indegrees.set(child, remaining); if (!remaining) queue.push(child);
    }
  }
  if (visited !== ops.length) throw new VaultSailError('schema', '版本关系包含循环。');
  const heads = new Map<string, Revision[]>();
  for (const op of ops) if (!children.has(op.opId)) heads.set(op.path, [...(heads.get(op.path) ?? []), op]);
  const filePaths = new Map<string, string>();
  for (const revisions of heads.values()) for (const head of revisions) {
    const path = filePaths.get(head.fileId);
    if (path && path !== head.path) throw new VaultSailError('rename-conflict', '同一文件存在并发重命名分支，已保留全部版本并暂停应用。');
    filePaths.set(head.fileId, head.path);
  }
  // A rename explicitly retires its old path; absence alone never does.
  const retired = new Map<string, Revision>();
  for (const id of queue) {
    const op = byId.get(id)!;
    if (op.previousPath) retired.set(op.previousPath, { ...op, path: op.previousPath, kind: 'delete', hash: undefined, size: 0, previousPath: undefined });
  }
  for (const [path, retirement] of retired) if (!heads.has(path)) heads.set(path, [retirement]);
  return heads;
}
export class RemoteVaultStore {
  readonly provider: CloudStorageProvider;
  private cachedRevisions = new Map<string, { etag?: string; contentHash?: string; size: number; revision: Revision }>();
  private cachedVaults = new Map<string, { etag?: string; contentHash: string; size: number; vault: RemoteVault }>();
  constructor(provider: CloudStorageProvider) { this.provider = provider; }
  base(id: string): string {
    if (!validId(id)) throw new VaultSailError('binding', '远端库 ID 未验证，请选择或创建云端库。');
    return 'vaultsail/vaults/' + id;
  }
  async create(displayName: string): Promise<RemoteVault> {
    if (!displayName.trim() || displayName.length > 120) throw new VaultSailError('configuration', '请输入不超过 120 字的库名称。');
    const vault: RemoteVault = { schemaVersion: 1, vaultId: uuid(), displayName: displayName.trim(), createdAt: Date.now() };
    const base = this.base(vault.vaultId);
    await this.provider.mkdir(base + '/blobs'); await this.provider.mkdir(base + '/ops');
    const data = jsonBytes(vault); await this.provider.writeImmutable(base + '/vault.json', data);
    this.cachedVaults.set(vault.vaultId, { contentHash: hash(data), size: data.byteLength, vault: { ...vault } }); return vault;
  }
  async get(id: string): Promise<RemoteVault> {
    const path = this.base(id) + '/vault.json';
    const entry = (await listAll(this.provider, this.base(id))).find(object => object.path === path);
    if (!entry || entry.isDirectory) throw new VaultSailError('not-found', '云端库元数据不存在。');
    const cached = this.cachedVaults.get(id);
    if (cached && entry.size === cached.size && ((entry.etag !== undefined && cached.etag === entry.etag)
      || this.provider.verifiedContentHash?.(entry) === cached.contentHash)) {
      cached.etag = entry.etag; return { ...cached.vault };
    }
    const data = await this.provider.read(this.base(id) + '/vault.json');
    if (data.byteLength > 1024 * 1024) throw new VaultSailError('schema', '库元数据超过安全上限。');
    const value = record(parseJson(data));
    if (value.schemaVersion !== 1 || value.vaultId !== id || typeof value.displayName !== 'string' || value.displayName.length > 120 || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) throw new VaultSailError('schema', '远端库格式未知或标识不一致。');
    const vault = value as unknown as RemoteVault;
    this.cachedVaults.set(id, { etag: entry.etag, contentHash: hash(data), size: data.byteLength, vault: { ...vault } });
    return vault;
  }
  async listVaults(): Promise<RemoteVault[]> {
    if (!await this.provider.exists('vaultsail/vaults')) return [];
    const result: RemoteVault[] = [];
    for (const entry of await listAll(this.provider, 'vaultsail/vaults')) {
      const id = entry.path.split('/').at(-1)!;
      if (entry.isDirectory && validId(id) && await this.provider.exists(entry.path + '/vault.json')) result.push(await this.get(id));
    }
    return result;
  }
  async revisions(id: string): Promise<Revision[]> {
    await this.get(id); const base = this.base(id) + '/ops'; const result: Revision[] = [];
    for (const device of await listAll(this.provider, base)) {
      const deviceId = device.path.split('/').at(-1)!;
      if (!device.isDirectory || !validId(deviceId)) throw new VaultSailError('schema', '操作目录含未知对象，停止扫描。');
      for (const entry of await listAll(this.provider, device.path)) {
        if (entry.isDirectory || entry.size > 1024 * 1024 || result.length >= 10000) throw new VaultSailError('schema', '操作记录异常或超过扫描上限。');
        const cached = this.cachedRevisions.get(entry.path);
        const reusable = cached && cached.size === entry.size && ((entry.etag !== undefined && cached.etag === entry.etag)
          || (cached.contentHash !== undefined && this.provider.verifiedContentHash?.(entry) === cached.contentHash));
        const data = reusable ? undefined : await this.provider.read(entry.path);
        const op = reusable ? cached.revision : validateRevision(parseJson(data!), id);
        if (op.deviceId !== deviceId || entry.path !== device.path + '/' + op.opId + '.json') throw new VaultSailError('schema', '操作文件与记录标识不一致。');
        this.cachedRevisions.set(entry.path, { etag: entry.etag, contentHash: data ? hash(data) : cached?.contentHash, size: entry.size, revision: op });
        result.push(op);
      }
    }
    buildHeads(result); return result;
  }
  async blob(id: string, op: Revision, onVerify: () => void = () => {}): Promise<ArrayBuffer> {
    validateRevision(op, id);
    if (op.kind !== 'update' || !op.hash) throw new VaultSailError('schema', '删除记录没有内容对象。');
    const data = await this.provider.read(this.base(id) + '/blobs/' + op.hash);
    onVerify();
    if (data.byteLength !== op.size || hash(data) !== op.hash) throw new VaultSailError('integrity', '云端内容 Hash 不匹配，未应用文件。');
    return data;
  }
  async publish(id: string, op: Revision, data?: ArrayBuffer, onPhase: (phase: 'uploading' | 'publishing') => void = () => {}): Promise<void> {
    validateRevision(op, id);
    if (op.kind === 'update') {
      if (!data || data.byteLength !== op.size || hash(data) !== op.hash) throw new VaultSailError('integrity', '待上传内容与操作记录不一致。');
      onPhase('uploading'); await this.provider.writeImmutable(this.base(id) + '/blobs/' + op.hash, data);
    }
    const path = this.base(id) + '/ops/' + op.deviceId + '/' + op.opId + '.json'; const recordData = jsonBytes(op);
    onPhase('publishing'); await this.provider.writeImmutable(path, recordData);
    this.cachedRevisions.set(path, { contentHash: hash(recordData), size: recordData.byteLength, revision: { ...op, parents: [...op.parents] } });
  }
}
