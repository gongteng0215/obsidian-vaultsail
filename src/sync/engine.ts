import { assertNoCollisions, checkSize, hash, included, uuid, validId, VaultSailError } from '../core/safety.ts';
import { reconcileFile } from '../core/reconcile.ts';
import { buildHeads, RemoteVaultStore, validateRevision, type Revision } from './remote-vault.ts';
import type { SyncProgress, ProgressPhase } from './progress.ts';

export interface LocalFiles {
  paths(): Promise<string[]>;
  read(path: string): Promise<ArrayBuffer | null>;
  apply(path: string, data: ArrayBuffer | null, expected: string | null, recoveryId: string): Promise<void>;
  preserve(path: string, data: ArrayBuffer, id: string): Promise<string>;
  stage(id: string, data: ArrayBuffer): Promise<void>;
  staged(id: string): Promise<ArrayBuffer | null>;
}
export interface Baseline { hash: string | null; heads: string[]; fileId: string; }
export interface Journal {
  id: string; path: string; action: 'publish' | 'apply' | 'resolve'; stage: 'prepared' | 'published' | 'applied';
  revision: Revision; expectedLocal: string | null; dataHash?: string;
}
export interface SyncState {
  schemaVersion: 1; deviceId: string; bases: Record<string, Baseline>; journals: Journal[];
  knownOps: string[];
}
export interface StateStore { load(): Promise<SyncState>; save(state: SyncState): Promise<void>; }
export interface PlanRow {
  path: string; action: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'skip' | 'noop';
  reason: string; localHash: string | null; size: number; heads: Revision[];
  renameFrom?: string;
}
export interface SyncPlan { vaultId: string; mode: 'upload' | 'download' | 'sync'; deletionEnabled: boolean; revisionIds: string[]; rows: PlanRow[]; }
export function newState(deviceId = uuid()): SyncState { return { schemaVersion: 1, deviceId, bases: Object.create(null) as Record<string, Baseline>, journals: [], knownOps: [] }; }
export function validateState(value: unknown, vaultId: string, deviceId: string): SyncState {
  const state = value as SyncState;
  if (!state || state.schemaVersion !== 1 || state.deviceId !== deviceId || !validId(deviceId) || !state.bases || typeof state.bases !== 'object' || Array.isArray(state.bases)
    || !Array.isArray(state.journals) || !Array.isArray(state.knownOps) || state.knownOps.some(id => !validId(id))) throw new VaultSailError('state', '本地基线或恢复日志损坏，请保留数据并重新绑定。');
  assertNoCollisions(Object.keys(state.bases));
  state.bases = Object.assign(Object.create(null) as Record<string, Baseline>, state.bases);
  for (const base of Object.values(state.bases)) {
    if (!base || !validId(base.fileId) || !(base.hash === null || /^[a-f0-9]{64}$/.test(base.hash)) || !Array.isArray(base.heads) || base.heads.some(id => !validId(id))) throw new VaultSailError('state', '本地基线格式不正确。');
  }
  for (const journal of state.journals) {
    validateRevision(journal.revision, vaultId);
    if (!validId(journal.id) || journal.id !== journal.revision.opId || journal.path !== journal.revision.path || !['publish', 'apply', 'resolve'].includes(journal.action)
      || !['prepared', 'published', 'applied'].includes(journal.stage) || !(journal.expectedLocal === null || /^[a-f0-9]{64}$/.test(journal.expectedLocal))) throw new VaultSailError('state', '恢复日志格式不正确。');
  }
  return state;
}
const ids = (heads: Revision[]) => heads.map(head => head.opId).sort();
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === [...b].sort()[i]);
export class SyncEngine {
  private remote: RemoteVaultStore; private local: LocalFiles; private store: StateStore; readonly vaultId: string;
  private stopped = false; private running = false; private configDir: string;
  private report: (progress: SyncProgress) => void;
  private progress!: SyncProgress;
  constructor(remote: RemoteVaultStore, local: LocalFiles, store: StateStore, vaultId: string, configDir = '.obsidian', report: (progress: SyncProgress) => void = () => {}) {
    this.remote = remote; this.local = local; this.store = store; this.vaultId = vaultId; this.configDir = configDir;
    this.report = report;
  }
  private emit(phase: ProgressPhase, update: Partial<SyncProgress> = {}): void {
    this.progress = { ...this.progress, ...update, phase, updatedAt: Date.now() };
    // Observers must never interrupt a journaled write or affect its result.
    try { this.report({ ...this.progress }); } catch { /* UI is advisory. */ }
  }
  pause(): void { this.stopped = true; }
  private guard(): void { if (this.stopped) throw new VaultSailError('paused', '任务已暂停，未完成操作保留在恢复日志中。'); }
  private async exclusive<T>(run: () => Promise<T>, successPhase: 'completed' | 'preview-ready' = 'completed'): Promise<T> {
    if (this.running) throw new VaultSailError('busy', '当前库已有任务在运行。');
    this.running = true; this.stopped = false;
    this.progress = { phase: 'checking', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0, startedAt: Date.now(), updatedAt: Date.now() };
    this.emit('checking');
    try { const value = await run(); this.emit(successPhase, { path: undefined }); return value; }
    catch (error) { this.emit(error instanceof VaultSailError && ['paused', 'cancelled'].includes(error.code) ? 'paused' : 'failed'); throw error; }
    finally { this.running = false; }
  }
  private async state(): Promise<SyncState> {
    const state = await this.store.load(); return validateState(state, this.vaultId, state.deviceId);
  }
  private async scan(state: SyncState): Promise<{ ops: Revision[]; heads: Map<string, Revision[]>; local: Map<string, { hash: string; size: number }> }> {
    this.emit('scanning-remote', { path: undefined }); this.guard(); const ops = await this.remote.revisions(this.vaultId); this.guard();
    const found = new Set(ops.map(op => op.opId));
    if (state.knownOps.some(id => !found.has(id))) throw new VaultSailError('visibility', '之前确认的远端记录暂不可见，停止写入。');
    const heads = buildHeads(ops); const paths = (await this.local.paths()).filter(path => included(path, this.configDir));
    assertNoCollisions(paths); const local = new Map<string, { hash: string; size: number }>();
    let scanned = 0; this.emit('scanning-local', { totalFiles: paths.length });
    for (const path of paths) {
      this.emit('scanning-local', { path });
      this.guard(); const data = await this.local.read(path);
      if (data === null) throw new VaultSailError('changed', '扫描期间本地文件发生变化，请重新预览。');
      checkSize(data.byteLength); local.set(path, { hash: hash(data), size: data.byteLength });
      this.emit('scanning-local', { doneFiles: ++scanned });
    }
    assertNoCollisions([...new Set([...paths, ...heads.keys()])]);
    for (const path of heads.keys()) if (!included(path, this.configDir)) throw new VaultSailError('path', '远端路径属于排除目录。');
    return { ops, heads, local };
  }
  async preview(mode: SyncPlan['mode'], deletionEnabled = false): Promise<SyncPlan> {
    return this.exclusive(async () => {
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '有未完成操作，请先恢复任务。');
      const snapshot = await this.scan(state); const rows: PlanRow[] = [];
      const renames = new Map<string, string>();
      if (mode === 'sync') {
        for (const [path, local] of snapshot.local) if (!snapshot.heads.has(path) && !state.bases[path]) {
          const candidates = Object.entries(state.bases).filter(([oldPath, base]) => !snapshot.local.has(oldPath) && base.hash === local.hash
            && snapshot.heads.get(oldPath)?.length === 1 && snapshot.heads.get(oldPath)?.[0].kind === 'update'
            && snapshot.heads.get(oldPath)?.[0].hash === local.hash && sameIds(base.heads, ids(snapshot.heads.get(oldPath)!)));
          const duplicates = [...snapshot.local].filter(([p, value]) => !snapshot.heads.has(p) && !state.bases[p] && value.hash === local.hash);
          if (candidates.length === 1 && duplicates.length === 1) renames.set(path, candidates[0][0]);
        }
      }
      for (const path of [...new Set([...snapshot.local.keys(), ...snapshot.heads.keys(), ...Object.keys(state.bases)])].sort()) {
        const renameFrom = renames.get(path);
        const local = snapshot.local.get(path); const heads = snapshot.heads.get(renameFrom ?? path) ?? []; const base = state.bases[path]; const head = heads[0];
        let action: PlanRow['action'] = 'noop'; let reason = '双方内容一致';
        if (renameFrom) { action = 'upload'; reason = '识别到唯一的同内容重命名，保留文件身份'; }
        else if ([...renames.values()].includes(path)) { action = 'skip'; reason = '源路径由重命名操作处理'; }
        else if (base && head && base.fileId !== head.fileId) { action = 'conflict'; reason = '同一路径的文件身份已变化，需手动确认'; }
        else if (heads.length > 1) { action = 'conflict'; reason = '云端有并发版本，需保留并处理所有分支'; }
        else if (local && head?.kind === 'update' && local.hash === head.hash) {
          if (local.size !== head.size) throw new VaultSailError('integrity', '远端版本大小与相同内容 Hash 矛盾。'); action = 'noop';
        }
        else if (mode === 'upload') {
          if (!local) { action = 'skip'; reason = '手动上传不传播删除'; }
          else if (head) { action = 'conflict'; reason = '同名内容不同，需确认后保留恢复副本'; }
          else { action = 'upload'; reason = '上传本地新文件'; }
        } else if (mode === 'download') {
          if (head?.kind !== 'update') { action = 'skip'; reason = '手动下载不传播删除'; }
          else if (local) { action = 'conflict'; reason = '同名内容不同，需确认后保留恢复副本'; }
          else { action = 'download'; reason = '下载远端新文件'; }
        } else {
          if (base && !base.heads.every(id => snapshot.ops.some(op => op.opId === id))) throw new VaultSailError('state', '基线引用的远端版本缺失。');
          if (base && !head) throw new VaultSailError('visibility', '基线文件的远端版本缺失。');
          const decision = reconcileFile({ path, base: base?.hash ? { hash: base.hash, size: 0 } : null,
            local: local ? { hash: local.hash, size: 0 } : null, remote: head?.kind === 'update' ? { hash: head.hash!, size: 0 } : null });
          action = decision.operation; reason = ({ upload: '本地修改，远端未变', download: '远端修改，本地未变', conflict: '双方均已修改', 'delete-local': '远端明确记录了删除', 'delete-remote': '本地删除，远端未变', noop: '双方内容一致' })[decision.operation];
          if ((action === 'delete-local' || action === 'delete-remote') && (!deletionEnabled || !base)) { action = 'skip'; reason = '删除传播关闭或缺少可信基线'; }
        }
        rows.push({ path, action, reason, localHash: local?.hash ?? null, size: local?.size ?? head?.size ?? 0, heads, ...(renameFrom ? { renameFrom } : {}) });
      }
      this.emit('preview-ready', { doneFiles: rows.length, totalFiles: rows.length, path: undefined });
      return { vaultId: this.vaultId, mode, deletionEnabled, revisionIds: snapshot.ops.map(op => op.opId).sort(), rows };
    }, 'preview-ready');
  }
  async execute(plan: SyncPlan, onProgress: (done: number, total: number) => void = () => {}): Promise<void> {
    return this.exclusive(async () => {
      if (plan.vaultId !== this.vaultId) throw new VaultSailError('binding', '预览属于其他云端库。');
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      const snapshot = await this.scan(state);
      if (!sameIds(plan.revisionIds, snapshot.ops.map(op => op.opId))) throw new VaultSailError('changed', '预览后云端已变化，请重新预览。');
      const actualPaths = new Set([...snapshot.local.keys(), ...snapshot.heads.keys(), ...Object.keys(state.bases)]);
      if (actualPaths.size !== plan.rows.length || plan.rows.some(row => !actualPaths.has(row.path) || (snapshot.local.get(row.path)?.hash ?? null) !== row.localHash)) throw new VaultSailError('changed', '预览后本地已变化，请重新预览。');
      let done = 0; let doneBytes = 0;
      const totalBytes = plan.rows.reduce((sum, row) => sum + (row.action === 'upload' || row.action === 'download' ? row.size : 0), 0);
      this.emit('checking', { path: undefined, doneFiles: 0, totalFiles: plan.rows.length, doneBytes: 0, totalBytes });
      for (const row of plan.rows) {
        this.emit('checking', { path: row.path });
        this.guard();
        if (row.action === 'conflict' || row.action === 'skip') { onProgress(++done, plan.rows.length); this.emit('checking', { doneFiles: done }); continue; }
        if (row.action === 'noop') {
          const head = row.heads[0]; if (row.heads.length === 1) state.bases[row.path] = { hash: head.hash ?? null, heads: [head.opId], fileId: head.fileId };
        } else {
          const currentHeads = buildHeads(await this.remote.revisions(this.vaultId)).get(row.renameFrom ?? row.path) ?? [];
          if (!sameIds(ids(row.heads), ids(currentHeads))) throw new VaultSailError('changed', '执行期间远端目标已变化，请重新预览。');
          const localData = await this.local.read(row.path);
          if ((localData === null ? null : hash(localData)) !== row.localHash) throw new VaultSailError('changed', '执行期间本地目标已变化，请重新预览。');
          this.guard();
          if (row.action === 'upload' || row.action === 'delete-remote') {
            const op: Revision = { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId,
              fileId: row.heads[0]?.fileId ?? state.bases[row.path]?.fileId ?? uuid(), path: row.path, parents: ids(row.heads),
              kind: row.action === 'upload' ? 'update' : 'delete', size: localData?.byteLength ?? 0,
              ...(row.renameFrom ? { previousPath: row.renameFrom } : {}),
              ...(localData ? { hash: hash(localData) } : {}), createdAt: Date.now() };
            const journal: Journal = { id: op.opId, path: row.path, action: 'publish', stage: 'prepared', revision: op, expectedLocal: row.localHash };
            if (localData) { await this.local.stage(op.opId, localData); await this.local.preserve(row.path, localData, op.opId); }
            state.journals.push(journal); await this.store.save(state); this.guard();
            await this.remote.publish(this.vaultId, op, localData ?? undefined, phase => this.emit(phase)); journal.stage = 'published'; await this.store.save(state); this.guard();
            state.bases[row.path] = { hash: op.hash ?? null, heads: [op.opId], fileId: op.fileId };
            state.knownOps = [...new Set([...state.knownOps, op.opId])]; state.journals = []; await this.store.save(state);
          } else {
            const head = row.heads[0]; const journal: Journal = { id: head.opId, path: row.path, action: 'apply', stage: 'prepared', revision: head, expectedLocal: row.localHash };
            state.journals.push(journal); await this.store.save(state);
            this.emit('downloading'); const data = head.kind === 'delete' ? null : await this.remote.blob(this.vaultId, head, () => this.emit('verifying')); this.guard();
            this.emit('applying');
            await this.local.apply(row.path, data, row.localHash, head.opId); journal.stage = 'applied'; await this.store.save(state);
            state.bases[row.path] = { hash: head.hash ?? null, heads: [head.opId], fileId: head.fileId }; state.journals = []; await this.store.save(state);
          }
        }
        if (row.action === 'upload' || row.action === 'download') doneBytes += row.size;
        onProgress(++done, plan.rows.length); this.emit('checking', { doneFiles: done, doneBytes });
      }
      state.knownOps = [...new Set([...state.knownOps, ...snapshot.ops.map(op => op.opId)])]; await this.store.save(state);
    });
  }
  async recover(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); const visible = await this.remote.revisions(this.vaultId); const known = new Set(visible.map(op => op.opId));
      this.emit('checking', { totalFiles: state.journals.length, totalBytes: state.journals.reduce((sum, journal) => sum + journal.revision.size, 0) });
      if (state.knownOps.some(id => !known.has(id))) throw new VaultSailError('visibility', '已知远端记录缺失，恢复暂停。');
      for (const journal of [...state.journals]) {
        this.emit('checking', { path: journal.path });
        this.guard(); const op = journal.revision;
        if (journal.action === 'publish' || journal.action === 'resolve') {
          if (!known.has(op.opId)) {
            const data = op.kind === 'update' ? await this.local.staged(op.opId) : null;
            if ((data ? hash(data) : null) !== (op.hash ?? null)) throw new VaultSailError('changed', '待发布内容已变化，恢复暂停；请保留恢复日志。');
            const heads = buildHeads(visible).get(op.previousPath ?? op.path) ?? [];
            if (!sameIds(ids(heads), [...op.parents].sort())) throw new VaultSailError('changed', '待发布操作的远端依据已变化，恢复暂停。');
            await this.remote.publish(this.vaultId, op, data ?? undefined, phase => this.emit(phase));
          }
          state.knownOps = [...new Set([...state.knownOps, op.opId])];
        }
        if (journal.action === 'apply' || journal.action === 'resolve') {
          const current = await this.local.read(op.path); const currentHash = current ? hash(current) : null;
          if (currentHash !== (op.hash ?? null)) {
            if (currentHash !== journal.expectedLocal) throw new VaultSailError('changed', '本地内容已变化，停止恢复以保留修改。');
            this.emit('downloading'); const data = op.kind === 'update' ? await this.remote.blob(this.vaultId, op, () => this.emit('verifying')) : null; this.guard();
            this.emit('applying');
            await this.local.apply(op.path, data, journal.expectedLocal, op.opId);
          }
        }
        state.bases[op.path] = { hash: op.hash ?? null, heads: [op.opId], fileId: op.fileId };
        state.journals = state.journals.filter(item => item.id !== journal.id); await this.store.save(state);
        this.emit('checking', { doneFiles: this.progress.doneFiles + 1, doneBytes: this.progress.doneBytes + op.size });
      }
    });
  }
  async abandonPending(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); const ops = await this.remote.revisions(this.vaultId); const found = new Set(ops.map(op => op.opId));
      if (state.knownOps.some(id => !found.has(id))) throw new VaultSailError('visibility', '已知远端记录缺失，暂停处理。');
      // Keep baseline, staged contents and recovery points; a subsequent plan sees any published branch.
      state.journals = []; state.knownOps = [...new Set([...state.knownOps, ...found])]; await this.store.save(state);
    });
  }
  async resolve(path: string, choice: 'local' | string, expectedRow?: PlanRow): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      const snapshot = await this.scan(state); const heads = snapshot.heads.get(path) ?? [];
      const localData = await this.local.read(path); const expected = localData ? hash(localData) : null;
      if (expectedRow && (expectedRow.path !== path || expectedRow.localHash !== expected || !sameIds(ids(expectedRow.heads), ids(heads)))) throw new VaultSailError('changed', '冲突预览后内容已变化，请重新预览。');
      let selected = localData;
      if (choice !== 'local') { const head = heads.find(op => op.opId === choice); if (!head) throw new VaultSailError('changed', '选择的远端版本已变化。'); selected = head.kind === 'update' ? await this.remote.blob(this.vaultId, head) : null; }
      if (!selected) throw new VaultSailError('conflict', '首期冲突处理必须选择一个内容版本，删除分支仅保留记录。');
      this.emit('checking', { path, doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: selected.byteLength });
      const op: Revision = { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId, fileId: heads[0]?.fileId ?? uuid(), path,
        parents: ids(heads), kind: 'update', hash: hash(selected), size: selected.byteLength, createdAt: Date.now() };
      // Preserve every competing content before either publishing or replacing the target.
      for (const head of heads) if (head.kind === 'update') await this.local.preserve(path, await this.remote.blob(this.vaultId, head), head.opId);
      if (localData) await this.local.preserve(path, localData, op.opId);
      const latest = buildHeads(await this.remote.revisions(this.vaultId)).get(path) ?? [];
      if (!sameIds(ids(heads), ids(latest))) throw new VaultSailError('changed', '保存副本期间远端发生变化，请重新处理冲突。');
      const now = await this.local.read(path); if ((now ? hash(now) : null) !== expected) throw new VaultSailError('changed', '保存副本期间本地发生变化。');
      const journal: Journal = { id: op.opId, path, action: 'resolve', stage: 'prepared', revision: op, expectedLocal: expected };
      await this.local.stage(op.opId, selected);
      state.journals.push(journal); await this.store.save(state); this.guard();
      await this.remote.publish(this.vaultId, op, selected, phase => this.emit(phase)); journal.stage = 'published'; await this.store.save(state); this.guard();
      this.emit('applying');
      await this.local.apply(path, selected, expected, op.opId); journal.stage = 'applied'; await this.store.save(state);
      state.bases[path] = { hash: op.hash!, heads: [op.opId], fileId: op.fileId }; state.knownOps = [...new Set([...snapshot.ops.map(item => item.opId), op.opId])];
      state.journals = []; await this.store.save(state);
      this.emit('checking', { doneFiles: 1, doneBytes: selected.byteLength });
    });
  }
}
