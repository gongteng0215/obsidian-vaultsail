import { collisionKey, hash, included, jsonBytes, parseJson, record, relativePath, uuid, validId, VaultSailError } from '../core/safety.ts';
import { listAll } from '../providers/provider-utils.ts';
import { mapConcurrent } from '../core/concurrency.ts';
import type { CloudStorageProvider } from '../providers/cloud-storage-provider';
import type { FileHistoryEvent } from './history';

// A separate namespace is deliberately invisible to older file-only clients.
export interface DirectoryRevision { version: 1; vaultId: string; opId: string; deviceId: string; path: string; parents: string[]; kind: 'create' | 'delete'; createdAt: number; }
export interface DirectoryBase { present: boolean; heads: string[]; }
export interface DirectoryPending { row: DirectoryRow; revision?: DirectoryRevision; }
export interface DirectoryState { version: 1; vaultId: string; deviceId: string; bases: Record<string, DirectoryBase>; pending?: DirectoryPending; }
export interface DirectoryStateStore { load(): Promise<unknown>; save(state: DirectoryState): Promise<void>; }
export interface LocalDirectories {
  paths(): Promise<string[]>; files(): Promise<string[]>; present(path: string): Promise<boolean>;
  empty(path: string): Promise<boolean>; create(path: string): Promise<void>; removeEmpty(path: string): Promise<boolean>;
}
export type DirectoryAction = 'publish-directory' | 'create-directory' | 'delete-directory' | 'delete-remote-directory' | 'noop-directory' | 'skip-directory';
export interface DirectoryRow { path: string; action: DirectoryAction; local: boolean; heads: DirectoryRevision[]; reason: string; }
export interface DirectoryPlan { mode: 'upload' | 'download' | 'sync'; deletionEnabled: boolean; signature: string; rows: DirectoryRow[]; }
const ids = (heads: DirectoryRevision[]) => heads.map(op => op.opId).sort();
const same = (a: string[], b: string[]) => { const right = [...b].sort(); return a.length === b.length && [...a].sort().every((id, i) => id === right[i]); };
export const directoryPresent = (heads: DirectoryRevision[]) => heads.some(op => op.kind === 'create');
export function directoryPath(path: string, configDir = '.obsidian'): string {
  relativePath(path);
  if (!included(path, configDir) || path === 'VaultSail-conflicts') throw new VaultSailError('path', '目录属于插件或配置排除范围。');
  return path;
}
export function validateDirectoryRevision(value: unknown, vaultId: string): DirectoryRevision {
  const row = record(value);
  if (row.version !== 1 || row.vaultId !== vaultId || !validId(row.opId) || !validId(row.deviceId) || typeof row.path !== 'string'
    || !['create', 'delete'].includes(String(row.kind)) || !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0
    || !Array.isArray(row.parents) || row.parents.some(id => !validId(id)) || new Set(row.parents).size !== row.parents.length || row.parents.length > 10000)
    throw new VaultSailError('schema', '目录版本格式未知或损坏，已停止目录同步。');
  directoryPath(row.path);
  return { version: 1, vaultId, opId: row.opId, deviceId: row.deviceId, path: row.path, parents: [...row.parents] as string[], kind: row.kind as DirectoryRevision['kind'], createdAt: Number(row.createdAt) };
}
export function directoryHeads(ops: DirectoryRevision[]): Map<string, DirectoryRevision[]> {
  const byId = new Map<string, DirectoryRevision>(), children = new Map<string, string[]>(), degree = new Map<string, number>();
  for (const op of ops) { if (byId.has(op.opId)) throw new VaultSailError('schema', '目录操作 ID 重复。'); byId.set(op.opId, op); degree.set(op.opId, op.parents.length); }
  for (const op of ops) for (const id of op.parents) {
    const parent = byId.get(id); if (!parent || parent.path !== op.path) throw new VaultSailError('schema', '目录父版本缺失或关联错误。');
    children.set(id, [...(children.get(id) ?? []), op.opId]);
  }
  const queue = ops.filter(op => !op.parents.length).map(op => op.opId);
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) ?? []) { const left = degree.get(id)! - 1; degree.set(id, left); if (!left) queue.push(id); }
  if (queue.length !== ops.length) throw new VaultSailError('schema', '目录版本关系包含循环。');
  const heads = new Map<string, DirectoryRevision[]>();
  for (const op of ops) if (!children.has(op.opId)) heads.set(op.path, [...(heads.get(op.path) ?? []), op]);
  return heads;
}
export class RemoteDirectoryStore {
  private provider: CloudStorageProvider; private vaultId: string; private concurrency: number;
  private cached = new Map<string, { fingerprint: string; op: DirectoryRevision }>();
  constructor(provider: CloudStorageProvider, vaultId: string, concurrency = 4) {
    if (!validId(vaultId)) throw new VaultSailError('binding', '云端库标识无效。');
    this.provider = provider; this.vaultId = vaultId; this.concurrency = Math.max(1, Math.min(4, concurrency));
  }
  private root(): string { return 'vaultsail/vaults/' + this.vaultId + '/directories'; }
  async revisions(): Promise<DirectoryRevision[]> {
    // Enumerating the vault root distinguishes an absent optional namespace from a failed listing.
    const root = this.root(), parent = root.slice(0, root.lastIndexOf('/'));
    const entry = (await listAll(this.provider, parent, undefined, 10000)).find(item => item.path === root);
    if (!entry) return [];
    if (!entry.isDirectory) throw new VaultSailError('schema', '目录版本位置被文件占用。');
    const devices = await listAll(this.provider, root, undefined, 10000);
    if (devices.some(item => !item.isDirectory || !validId(item.path.slice(root.length + 1)) || item.path !== root + '/' + item.path.split('/').at(-1))) throw new VaultSailError('schema', '目录设备清单不完整。');
    let total = 0;
    const groups = await mapConcurrent(devices, this.concurrency, async device => {
      const entries = await listAll(this.provider, device.path, undefined, 10000); total += entries.length;
      if (total > 10000) throw new VaultSailError('size', '目录记录超过一万条，停止扫描。');
      return entries;
    });
    const active = new Set<string>(), entries = groups.flat(), result: DirectoryRevision[] = [];
    for (let offset = 0; offset < entries.length; offset += 100) {
      const window = entries.slice(offset, offset + 100);
      const missing = window.filter(item => !item.etag || this.cached.get(item.path)?.fingerprint !== item.size + ':' + item.etag);
      if (missing.length && this.provider.prepareReads) {
        const prepared = await this.provider.prepareReads(missing);
        if (prepared.length !== missing.length || prepared.some((item, i) => item.path !== missing[i].path || item.size !== missing[i].size || item.id !== missing[i].id || item.isDirectory
          || missing[i].etag !== undefined && item.etag !== missing[i].etag)) throw new VaultSailError('changed', '目录记录读取信息与清单不一致。');
        const byPath = new Map(prepared.map(item => [item.path, item]));
        window.forEach((item, i) => { window[i] = byPath.get(item.path) ?? item; });
      }
      result.push(...await mapConcurrent(window, this.concurrency, async item => {
      if (item.isDirectory || item.size > 1024 * 1024 || item.size < 0) throw new VaultSailError('schema', '目录记录大小或类型异常。');
      const fingerprint = item.etag ? item.size + ':' + item.etag : '';
      let op = fingerprint && this.cached.get(item.path)?.fingerprint === fingerprint ? this.cached.get(item.path)!.op : undefined;
      if (!op) { const data = await this.provider.read(item.path); if (data.byteLength !== item.size || data.byteLength > 1024 * 1024) throw new VaultSailError('integrity', '目录记录大小与清单不一致。'); op = validateDirectoryRevision(parseJson(data), this.vaultId); }
      if (item.path !== root + '/' + op.deviceId + '/' + op.opId + '.json') throw new VaultSailError('schema', '目录记录身份与路径不一致。');
      const old = this.cached.get(item.path);
      if (old && hash(jsonBytes(old.op)) !== hash(jsonBytes(op))) throw new VaultSailError('integrity', '已发布的目录记录被修改，停止同步。');
      active.add(item.path); this.cached.set(item.path, { fingerprint, op }); return structuredClone(op);
      }));
    }
    for (const key of this.cached.keys()) if (!active.has(key)) this.cached.delete(key);
    directoryHeads(result); return result;
  }
  async publish(op: DirectoryRevision): Promise<void> {
    const valid = validateDirectoryRevision(op, this.vaultId), dir = this.root() + '/' + valid.deviceId;
    await this.provider.mkdir(dir); const path = dir + '/' + valid.opId + '.json', data = jsonBytes(valid);
    // Read-before-retry makes lost commit responses idempotent with the original operation ID.
    if (await this.provider.exists(path)) {
      if (hash(await this.provider.read(path)) !== hash(data)) throw new VaultSailError('integrity', '目录操作 ID 的内容不一致。');
    } else await this.provider.writeImmutable(path, data);
    if (hash(await this.provider.read(path)) !== hash(data)) throw new VaultSailError('integrity', '目录记录回读校验失败。');
  }
}
export function newDirectoryState(vaultId: string, deviceId: string): DirectoryState { return { version: 1, vaultId, deviceId, bases: Object.create(null) as Record<string, DirectoryBase> }; }
export function validateDirectoryState(value: unknown, vaultId: string, deviceId: string, configDir = '.obsidian'): DirectoryState {
  const state = record(value);
  if (state.version !== 1 || state.vaultId !== vaultId || state.deviceId !== deviceId || !validId(deviceId)) throw new VaultSailError('state', '目录基线的身份或版本无效。');
  const bases: Record<string, DirectoryBase> = Object.create(null) as Record<string, DirectoryBase>;
  for (const [path, raw] of Object.entries(record(state.bases))) {
    directoryPath(path, configDir); const base = record(raw);
    if (typeof base.present !== 'boolean' || !Array.isArray(base.heads) || base.heads.some(id => !validId(id)) || new Set(base.heads).size !== base.heads.length) throw new VaultSailError('state', '目录基线损坏。');
    bases[path] = { present: base.present, heads: [...base.heads] as string[] };
  }
  if (Object.keys(bases).length > 10000) throw new VaultSailError('size', '目录基线超过上限。');
  const result: DirectoryState = { version: 1, vaultId, deviceId, bases };
  if (state.pending !== undefined) {
    const pending = record(state.pending), row = record(pending.row);
    if (typeof row.path !== 'string' || typeof row.local !== 'boolean' || !Array.isArray(row.heads) || typeof row.reason !== 'string'
      || !['publish-directory', 'create-directory', 'delete-directory', 'delete-remote-directory'].includes(String(row.action))) throw new VaultSailError('state', '目录恢复记录损坏。');
    directoryPath(row.path, configDir);
    const heads = row.heads.map(op => validateDirectoryRevision(op, vaultId));
    if (heads.some(op => op.path !== row.path)) throw new VaultSailError('state', '目录恢复版本关联错误。');
    const revision = pending.revision === undefined ? undefined : validateDirectoryRevision(pending.revision, vaultId);
    const publishing = ['publish-directory', 'delete-remote-directory'].includes(String(row.action));
    if (row.local !== ['publish-directory', 'delete-directory'].includes(String(row.action)) || new Set(heads.map(op => op.opId)).size !== heads.length) throw new VaultSailError('state', '目录恢复依据无效。');
    if (publishing !== Boolean(revision) || (revision && (revision.path !== row.path || revision.deviceId !== deviceId || !same(revision.parents, ids(heads)) || revision.kind !== (row.action === 'publish-directory' ? 'create' : 'delete')))) throw new VaultSailError('state', '目录恢复操作与目标不一致。');
    result.pending = { row: { path: row.path, local: row.local, heads, action: row.action as DirectoryAction, reason: row.reason.slice(0, 256) }, ...(revision ? { revision } : {}) };
  }
  return result;
}
export class DirectorySync {
  private remote: RemoteDirectoryStore; private local: LocalDirectories; private store: DirectoryStateStore;
  private vaultId: string; private deviceId: string; private configDir: string;
  private guard: () => void; private onFile: (event: FileHistoryEvent) => void;
  private onFailure: (error: unknown, path: string, action: string) => string | undefined;
  constructor(remote: RemoteDirectoryStore, local: LocalDirectories, store: DirectoryStateStore, vaultId: string, deviceId: string, configDir = '.obsidian', guard: () => void = () => {}, onFile: (event: FileHistoryEvent) => void = () => {}, onFailure: (error: unknown, path: string, action: string) => string | undefined = () => undefined) {
    this.remote = remote; this.local = local; this.store = store; this.vaultId = vaultId; this.deviceId = deviceId; this.configDir = configDir; this.guard = guard; this.onFile = onFile; this.onFailure = onFailure;
  }
  private async state(): Promise<DirectoryState> { return validateDirectoryState(await this.store.load(), this.vaultId, this.deviceId, this.configDir); }
  private signature(ops: DirectoryRevision[]): string { return hash(jsonBytes([...ops].sort((a, b) => a.opId.localeCompare(b.opId)))); }
  private verifyKnown(state: DirectoryState, ops: DirectoryRevision[]): void {
    const found = new Set(ops.map(op => op.opId));
    if (Object.values(state.bases).some(base => base.heads.some(id => !found.has(id)))) throw new VaultSailError('visibility', '已验证的目录版本暂不可见，停止处理并保留本机状态。');
  }
  async preview(mode: DirectoryPlan['mode'], deletionEnabled: boolean): Promise<DirectoryPlan> {
    this.guard(); const state = await this.state();
    if (state.pending) throw new VaultSailError('recovery', '存在未完成的目录操作，请先恢复未完成任务。');
    const ops = await this.remote.revisions(), heads = directoryHeads(ops), paths = await this.local.paths(), files = await this.local.files(); this.guard();
    this.verifyKnown(state, ops);
    if (paths.length > 10000) throw new VaultSailError('size', '目录超过一万个，停止目录同步。');
    const seen = new Map<string, string>();
    const register = (path: string) => { directoryPath(path, this.configDir); const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) { const prefix = parts.slice(0, i).join('/'), key = collisionKey(prefix), old = seen.get(key); if (old && old !== prefix) throw new VaultSailError('collision', '目录存在大小写或 Unicode 冲突。'); seen.set(key, prefix); }
    };
    for (const path of [...paths, ...heads.keys(), ...Object.keys(state.bases)]) register(path);
    for (const file of files) if (included(file, this.configDir) && file.startsWith('VaultSail-conflicts/') === false && file.includes('/')) register(file.slice(0, file.lastIndexOf('/')));
    const active = new Set([...heads].filter(([, h]) => directoryPresent(h)).map(([path]) => path));
    const fileKeys = new Set(files.map(collisionKey));
    for (const folder of [...paths, ...active]) { const parts = collisionKey(folder).split('/');
      for (let i = 1; i <= parts.length; i++) if (fileKeys.has(parts.slice(0, i).join('/'))) throw new VaultSailError('collision', '文件与同步目录路径冲突，请先重命名。');
    }
    const present = new Set(paths), rows: DirectoryRow[] = [];
    for (const path of new Set([...paths, ...heads.keys(), ...Object.keys(state.bases)])) {
      const local = present.has(path), h = heads.get(path) ?? [], remote = directoryPresent(h), base = state.bases[path];
      let action: DirectoryAction = 'noop-directory', reason = '目录状态一致。';
      if (local && !remote) {
        if (h.length && base?.present && !same(base.heads, ids(h))) {
          if (!deletionEnabled) { action = 'skip-directory'; reason = '远端目录已删除，删除传播已关闭。'; }
          else if (!await this.local.empty(path) && (files.some(file => file.startsWith(path + '/'))
            || !paths.some(child => child.startsWith(path + '/'))
            || paths.some(child => child.startsWith(path + '/') && (!state.bases[child]?.present || !heads.has(child) || directoryPresent(heads.get(child)!))))) {
            action = 'publish-directory'; reason = '本地目录仍有内容，保留目录并发布新版本。';
          }
          else { action = 'delete-directory'; reason = '应用云端目录删除，仅移除空目录。'; }
        } else { action = 'publish-directory'; reason = '发布本地目录，包含空目录。'; }
      } else if (!local && remote) {
        if (base?.present && same(base.heads, ids(h))) { action = deletionEnabled ? 'delete-remote-directory' : 'skip-directory'; reason = deletionEnabled ? '发布本地目录删除记录，历史保留。' : '本地目录已删除；删除传播关闭，保留云端版本。'; }
        else { action = 'create-directory'; reason = '创建云端目录；并发创建与删除时优先保留。'; }
      } else if (local && h.length > 1 && remote) { action = 'publish-directory'; reason = '合并目录分支，优先保留目录。'; }
      const publish = ['publish-directory', 'delete-remote-directory'].includes(action), apply = ['create-directory', 'delete-directory'].includes(action);
      if ((mode === 'download' && publish) || (mode === 'upload' && apply)) { action = 'skip-directory'; reason = '按当前传输方向保留，未执行。'; }
      rows.push({ path, action, local, heads: h, reason });
    }
    return { mode, deletionEnabled, signature: this.signature(ops), rows };
  }
  async validate(plan: DirectoryPlan): Promise<void> {
    this.guard(); if (this.signature(await this.remote.revisions()) !== plan.signature) throw new VaultSailError('changed', '目录版本在预览后变化，请重新预览。');
    const paths = new Set(await this.local.paths());
    for (const row of plan.rows) if (paths.has(row.path) !== row.local) throw new VaultSailError('changed', '本地目录在预览后变化，请重新预览。');
    const planned = new Set(plan.rows.map(row => row.path));
    if ([...paths].some(path => !planned.has(path))) throw new VaultSailError('changed', '预览后新增了目录，请重新预览。');
  }
  async recover(deletionEnabled: boolean): Promise<void> {
    const state = await this.state(); if (!state.pending) return;
    const { row, revision } = state.pending, id = revision?.opId ?? uuid();
    const notify = (status: FileHistoryEvent['state'], error?: unknown) => { try {
      const diagnosticId = error === undefined ? undefined : this.onFailure(error, row.path, row.action);
      this.onFile({ id, path: row.path, action: row.action as FileHistoryEvent['action'], size: 0, state: status, reason: error ? 'stopped' : 'recovered', ...(error instanceof VaultSailError ? { code: error.code } : {}), ...(validId(diagnosticId) ? { diagnosticId } : {}) });
    } catch { /* Advisory. */ } };
    try {
      this.guard(); notify('running'); const ops = await this.remote.revisions();
      this.verifyKnown(state, ops);
      await this.completePending(state, deletionEnabled, ops, directoryHeads(ops).get(row.path) ?? []);
      const base = state.bases[row.path];
      notify(base && base.present === ['create-directory', 'publish-directory'].includes(row.action) && same(base.heads, revision ? [revision.opId] : ids(row.heads)) ? 'succeeded' : 'skipped');
    } catch (error) { notify('unconfirmed', error); throw error; }
  }
  private async completePending(state: DirectoryState, deletionEnabled: boolean, ops: DirectoryRevision[], heads: DirectoryRevision[]): Promise<void> {
    if (!state.pending) return;
    this.guard(); const { row, revision } = state.pending;
    if (!deletionEnabled && ['delete-directory', 'delete-remote-directory'].includes(row.action)) throw new VaultSailError('recovery', '目录删除任务尚未完成；请重新启用删除传播后恢复，或保留日志排查。');
    if (revision) {
      if (!ops.some(op => op.opId === revision.opId)) {
        this.guard();
        if (await this.local.present(row.path) !== row.local) { delete state.pending; await this.store.save(state); throw new VaultSailError('changed', '目录发布前本地状态已变化，请重新同步。'); }
        await this.remote.publish(revision);
      }
      else if (hash(jsonBytes(ops.find(op => op.opId === revision.opId))) !== hash(jsonBytes(revision))) throw new VaultSailError('integrity', '目录恢复记录与云端内容不一致。');
      // A later local change is left for the next plan, never undone by recovery.
      state.bases[row.path] = { present: row.local, heads: [revision.opId] };
    } else {
      if (!same(ids(heads), ids(row.heads))) { delete state.pending; await this.store.save(state); return; }
      this.guard();
      if (row.action === 'create-directory') await this.local.create(row.path);
      else if (!await this.local.removeEmpty(row.path)) { delete state.pending; await this.store.save(state); return; }
      state.bases[row.path] = { present: row.action === 'create-directory', heads: ids(heads) };
    }
    delete state.pending; await this.store.save(state);
  }
  async execute(plan: DirectoryPlan, deletionEnabled: boolean): Promise<{ created: number; deleted: number; skipped: number }> {
    return this.run(plan, deletionEnabled, true);
  }
  private async run(plan: DirectoryPlan, deletionEnabled: boolean, revalidate: boolean): Promise<{ created: number; deleted: number; skipped: number }> {
    if (!deletionEnabled && plan.rows.some(row => ['delete-directory', 'delete-remote-directory'].includes(row.action))) throw new VaultSailError('configuration', '删除传播已关闭，请重新预览。');
    if (revalidate) await this.validate(plan); const result = { created: 0, deleted: 0, skipped: 0 };
    const rows = [...plan.rows].sort((a, b) => {
      const removeA = a.action === 'delete-directory', removeB = b.action === 'delete-directory';
      return removeA !== removeB ? removeA ? 1 : -1 : removeA ? b.path.split('/').length - a.path.split('/').length : a.path.split('/').length - b.path.split('/').length;
    });
    let state = await this.state();
    if (state.pending) throw new VaultSailError('recovery', '目录操作需要先恢复。');
    let dirty = false;
    for (const row of rows) {
      this.guard();
      if (row.action === 'skip-directory') { result.skipped++; continue; }
      if (row.action === 'noop-directory') { const next = { present: row.local, heads: ids(row.heads) }, old = state.bases[row.path]; if (!old || old.present !== next.present || !same(old.heads, next.heads)) { state.bases[row.path] = next; dirty = true; } continue; }
      const id = uuid(), action = row.action;
      const emit = (status: FileHistoryEvent['state'], error?: unknown) => { try {
        const diagnosticId = error === undefined ? undefined : this.onFailure(error, row.path, action);
        this.onFile({ id, path: row.path, size: 0, action, state: status, reason: status === 'succeeded' ? 'planned' : status === 'skipped' ? 'policy' : 'stopped', ...(error instanceof VaultSailError ? { code: error.code } : {}), ...(validId(diagnosticId) ? { diagnosticId } : {}) }); } catch { /* Presentation is advisory. */ } };
      emit('running');
      try {
        if ((await this.local.present(row.path)) !== row.local) throw new VaultSailError('changed', '目录在执行前发生变化，请重新同步。');
        state.pending = { row, ...(['publish-directory', 'delete-remote-directory'].includes(action) ? { revision: { version: 1 as const, vaultId: this.vaultId, deviceId: this.deviceId, opId: id, path: row.path, parents: ids(row.heads), kind: action === 'publish-directory' ? 'create' as const : 'delete' as const, createdAt: Date.now() } } : {}) };
        await this.store.save(state); dirty = false;
        // Creation/publication preserves concurrent content and can consume the verified batch.
        // Destructive local application gets a fresh inventory immediately before removal.
        const fresh = action === 'delete-directory' ? await this.remote.revisions() : [];
        await this.completePending(state, deletionEnabled, fresh, action === 'delete-directory' ? directoryHeads(fresh).get(row.path) ?? [] : row.heads);
        const applied = state.bases[row.path];
        const completed = applied && (state.bases[row.path].present === ['publish-directory', 'create-directory'].includes(action))
          && same(applied.heads, ['publish-directory', 'delete-remote-directory'].includes(action) ? [id] : ids(row.heads));
        if (!completed) { result.skipped++; emit('skipped'); }
        else { if (['publish-directory', 'create-directory'].includes(action)) result.created++; else result.deleted++; emit('succeeded'); }
      } catch (error) { emit('unconfirmed', error); throw error; }
    }
    if (dirty) await this.store.save(state);
    return result;
  }
  async sync(mode: DirectoryPlan['mode'], deletionEnabled: boolean): Promise<{ created: number; deleted: number; skipped: number }> {
    await this.recover(deletionEnabled); return this.run(await this.preview(mode, deletionEnabled), deletionEnabled, false);
  }
  async abandonPending(): Promise<void> {
    this.guard(); const state = await this.state(); if (!state.pending) return;
    this.verifyKnown(state, await this.remote.revisions()); this.guard();
    delete state.pending; await this.store.save(state);
  }
}
