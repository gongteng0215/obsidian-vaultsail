import { assertNoCollisions, checkSize, checkSizeValue, hash, included, jsonBytes, MAX_FILE_SIZE, safeMessage, uuid, validId, VaultSailError } from '../core/safety.ts';
import { reconcileFile } from '../core/reconcile.ts';
import { buildHeads, RemoteVaultStore, validateRevision, type Revision } from './remote-vault.ts';
import type { SyncProgress, ProgressPhase, FileUploadProgress } from './progress.ts';
import { DEFAULT_TRANSFER_CONCURRENCY, MAX_TRANSFER_CONCURRENCY, mapConcurrent, TRANSFER_BATCH_BYTES, validConcurrency } from '../core/concurrency.ts';
import { AUTO_MERGE_DEVICE, automaticMergeId, commonAncestor, mergeText, threeWayMerge, type TextMerge } from './merge.ts';
import { failureState, historyCode, type FileHistoryEvent, type HistoryAction, type HistoryReason, type HistoryState } from './history.ts';

export interface LocalFiles {
  paths(): Promise<string[]>;
  stat(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<ArrayBuffer | null>;
  apply(path: string, data: ArrayBuffer | null, expected: string | null, recoveryId: string): Promise<void>;
  preserve(path: string, data: ArrayBuffer, id: string): Promise<string>;
  stage(id: string, data: ArrayBuffer): Promise<void>;
  staged(id: string): Promise<ArrayBuffer | null>;
  readConflictCopy(path: string, versionKey: string): Promise<ArrayBuffer | null>;
  writeConflictCopy(path: string, versionKey: string, data: ArrayBuffer): Promise<void>;
}
export interface Baseline { hash: string | null; heads: string[]; fileId: string; }
export interface Journal {
  id: string; path: string; action: 'publish' | 'apply' | 'resolve'; stage: 'prepared' | 'published' | 'applied';
  revision: Revision; expectedLocal: string | null; dataHash?: string;
  allowBranch?: true;
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
  renameConflict?: boolean;
  blocked?: BlockedFile;
}
export interface BlockedFile { path: string; size: number; reason: 'size' | 'related'; message: string; }
export interface SyncPlan { vaultId: string; mode: 'upload' | 'download' | 'sync'; deletionEnabled: boolean; revisionIds: string[]; rows: PlanRow[]; }
export interface SyncResult {
  incomingChanges: number; preservedConflicts: number; uploadedFiles: number; downloadedFiles: number; deletedFiles: number;
  autoMergedFiles: number;
  blockedFiles: number;
}
export interface ConflictDetails { row: PlanRow; local?: string; base?: string; versions: { id: string; label: string; text?: string; size: number }[]; merge?: TextMerge; mergeLabels?: [string, string]; }
type Snapshot = { ops: Revision[]; heads: Map<string, Revision[]>; local: Map<string, { hash: string; size: number }>; present: Set<string>; blocked: Map<string, BlockedFile> };
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
    if (journal.allowBranch !== undefined && (journal.allowBranch !== true || journal.action !== 'publish')) throw new VaultSailError('state', '恢复日志分支标识无效。');
  }
  return state;
}
const ids = (heads: Revision[]) => heads.map(head => head.opId).sort();
const sameIds = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false; const left = [...a].sort(); const right = [...b].sort(); return left.every((id, i) => id === right[i]);
};
export class SyncEngine {
  private remote: RemoteVaultStore; private local: LocalFiles; private store: StateStore; readonly vaultId: string;
  private stopped = false; private running = false; private configDir: string;
  private report: (progress: SyncProgress) => void;
  private progress!: SyncProgress;
  private prepared?: { plan: SyncPlan; snapshot: Snapshot };
  private concurrency: number;
  private localIndex?: Map<string, { hash: string; size: number }>;
  private dirtyPaths = new Map<string, number>(); private changeSequence = 0; private remoteSignature?: string;
  private headGroups = new WeakMap<Pick<Snapshot, 'heads'>, Map<string, Revision[]>>();
  private blocked = new Map<string, BlockedFile>();
  private fileRecords = new Map<string, FileHistoryEvent>();
  private onFile: (event: FileHistoryEvent) => void;
  private fileLimit: number;
  private uploads = new Map<string, FileUploadProgress>();
  blockedFiles(): BlockedFile[] { return [...this.blocked.values()].map(file => ({ ...file })); }
  constructor(remote: RemoteVaultStore, local: LocalFiles, store: StateStore, vaultId: string, configDir = '.obsidian', report: (progress: SyncProgress) => void = () => {}, concurrency = DEFAULT_TRANSFER_CONCURRENCY,
    onFile: (event: FileHistoryEvent) => void = () => {}, fileLimit = MAX_FILE_SIZE) {
    checkSize(0, fileLimit); this.fileLimit = fileLimit;
    if (!validConcurrency(concurrency)) throw new VaultSailError('configuration', `传输并发数必须为 1–${MAX_TRANSFER_CONCURRENCY} 之间的整数。`);
    this.concurrency = concurrency;
    this.remote = remote; this.local = local; this.store = store; this.vaultId = vaultId; this.configDir = configDir;
    this.report = report;
    this.onFile = onFile;
  }
  private recordFile(path: string, action: HistoryAction, size: number, state: HistoryState, reason: HistoryReason = 'planned', error?: unknown): void {
    const event: FileHistoryEvent = { id: this.fileRecords.get(path)?.id ?? uuid(), path, action, size, state, reason, ...(error ? { code: historyCode(error) } : {}) };
    this.fileRecords.set(path, event);
    try { this.onFile({ ...event }); } catch { /* Display history must not affect verified sync. */ }
  }
  private recordRow(row: PlanRow, state: HistoryState, action: HistoryAction = row.action, reason: HistoryReason = row.blocked?.reason === 'size' ? 'oversized' : row.blocked ? 'related' : row.action === 'noop' ? 'unchanged' : row.action === 'skip' ? 'policy' : 'planned', error?: unknown): void {
    this.recordFile(row.path, action, row.size, state, reason, error);
  }
  private emit(phase: ProgressPhase, update: Partial<SyncProgress> = {}): void {
    this.progress = { ...this.progress, ...update, phase, updatedAt: Date.now(), uploads: [...this.uploads.values()].map(upload => ({ ...upload })) };
    // Observers must never interrupt a journaled write or affect its result.
    try { this.report({ ...this.progress }); } catch { /* UI is advisory. */ }
  }
  private async publishRevision(op: Revision, data?: ArrayBuffer, onPhase: (phase: 'uploading' | 'publishing') => void = phase => this.emit(phase)): Promise<void> {
    if (op.kind === 'update') this.uploads.set(op.opId, { path: op.path, stage: 'preparing', uploadedBytes: 0, totalBytes: op.size, completedParts: 0, totalParts: 0, attempt: 1 });
    this.emit(op.kind === 'update' ? 'preparing-upload' : 'publishing', { path: op.path });
    await this.remote.publish(this.vaultId, op, data, phase => {
      const upload = this.uploads.get(op.opId);
      if (upload) this.uploads.set(op.opId, { ...upload, stage: phase === 'publishing' ? 'publishing' : upload.stage });
      onPhase(phase);
    }, progress => {
      if (!this.running) return;
      this.uploads.set(op.opId, { ...progress, path: op.path });
      this.emit(progress.stage === 'preparing' ? 'preparing-upload' : ['verifying', 'verified'].includes(progress.stage) ? 'verifying' : 'uploading', { path: op.path });
    });
    this.uploads.delete(op.opId); this.emit(this.progress.phase);
  }
  pause(): void { this.stopped = true; }
  configureConcurrency(value: number): void {
    if (this.running) throw new VaultSailError('busy', '请等待当前任务结束后修改并发数。');
    if (!validConcurrency(value)) throw new VaultSailError('configuration', `传输并发数必须为 1–${MAX_TRANSFER_CONCURRENCY} 之间的整数。`);
    this.concurrency = value; this.remote.setReadConcurrency(value);
  }
  get pauseRequested(): boolean { return this.running && this.stopped; }
  private guard(): void { if (this.stopped) throw new VaultSailError('paused', '任务已暂停，未完成操作保留在恢复日志中。'); }
  private async exclusive<T>(run: () => Promise<T>, successPhase: 'completed' | 'preview-ready' = 'completed'): Promise<T> {
    if (this.running) throw new VaultSailError('busy', '当前库已有任务在运行。');
    this.running = true; this.stopped = false; this.fileRecords.clear();
    this.uploads.clear();
    this.progress = { phase: 'checking', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0, startedAt: Date.now(), updatedAt: Date.now(), activeFiles: 0, concurrency: this.concurrency, blockedFiles: this.blocked.size };
    this.emit('checking');
    try { const value = await run(); this.emit(successPhase, { path: undefined }); return value; }
    catch (error) {
      for (const file of this.fileRecords.values()) if (file.state === 'running' || file.state === 'queued') this.recordFile(file.path, file.action, file.size,
        file.state === 'queued' ? 'not-run' : failureState(error), 'stopped', error);
      this.emit(error instanceof VaultSailError && ['paused', 'cancelled'].includes(error.code) ? 'paused' : 'failed', { message: safeMessage(error) }); throw error;
    }
    finally { this.running = false; }
  }
  private async state(): Promise<SyncState> {
    const state = await this.store.load(); return validateState(state, this.vaultId, state.deviceId);
  }
  markDirty(path?: string): void {
    if (!path || this.dirtyPaths.size >= 10000) { this.localIndex = undefined; this.dirtyPaths.clear(); }
    else this.dirtyPaths.set(path, ++this.changeSequence);
  }
  private async applyLocal(path: string, data: ArrayBuffer | null, expected: string | null, recoveryId: string): Promise<void> {
    await this.local.apply(path, data, expected, recoveryId);
    if (data === null) this.localIndex?.delete(path); else this.localIndex?.set(path, { hash: hash(data), size: data.byteLength });
  }
  async changedFromBaseline(paths: string[]): Promise<string[]> {
    const state = await this.state(), changed: string[] = [];
    if (state.journals.length) return paths;
    for (const path of paths) {
      const stat = await this.local.stat(path);
      if (stat) { checkSizeValue(stat.size); if (stat.size > this.fileLimit) { changed.push(path); continue; } }
      const sequence = this.dirtyPaths.get(path), data = await this.local.read(path);
      if (!state.bases[path] || (data === null ? null : hash(data)) !== state.bases[path].hash) changed.push(path);
      else if (this.dirtyPaths.get(path) === sequence) this.dirtyPaths.delete(path);
    }
    return changed;
  }
  private signature(ops: Revision[]): string { return hash(jsonBytes([...ops].sort((a, b) => a.opId.localeCompare(b.opId)))); }
  private conflictHeads(snapshot: Pick<Snapshot, 'heads'>, path: string): Revision[] {
    let groups = this.headGroups.get(snapshot);
    if (!groups) { groups = new Map(); for (const heads of snapshot.heads.values()) for (const head of heads) if (head.kind === 'update') groups.set(head.fileId, [...groups.get(head.fileId) ?? [], head]); this.headGroups.set(snapshot, groups); }
    const own = snapshot.heads.get(path) ?? [], related = own.filter(head => head.kind === 'update').flatMap(head => groups!.get(head.fileId) ?? []);
    return related.some(head => head.path !== path) ? [...new Map([...related, ...own].map(head => [head.opId, head])).values()] : own;
  }
  private retiredSource(snapshot: Snapshot, path: string, heads: Revision[]): boolean {
    return heads.length === 1 && heads[0].kind === 'delete' && snapshot.ops.some(op => op.opId === heads[0].opId && op.path !== path);
  }
  async recoverPending(): Promise<void> {
    if ((await this.state()).journals.length) {
      try { await this.recover(); }
      catch (error) { if (error instanceof VaultSailError && error.code === 'changed') throw new VaultSailError('recovery', '未完成任务遇到新的编辑，内容已保留，请先处理旧任务。'); throw error; }
    }
  }
  async syncAutomatic(paths: string[], remote: boolean, full: boolean, deletionEnabled = false): Promise<SyncResult> {
    paths.forEach(path => this.markDirty(path));
    await this.recoverPending();
    let ops: Revision[] | undefined;
    if (remote && !full && this.localIndex) {
      ops = await this.exclusive(async () => { this.emit('checking-remote'); return this.remote.revisions(this.vaultId, undefined, true); });
      if (!paths.length && this.signature(ops) === this.remoteSignature) return { incomingChanges: 0, preservedConflicts: 0, uploadedFiles: 0, downloadedFiles: 0, deletedFiles: 0, autoMergedFiles: 0, blockedFiles: this.blocked.size };
    }
    return this.sync(deletionEnabled, { incremental: !full, ops });
  }
  private async scan(state: SyncState, options: { incremental?: boolean; ops?: Revision[]; allowRenames?: boolean } = {}): Promise<Snapshot> {
    this.emit('scanning-remote', { path: undefined }); this.guard();
    const ops = options.ops ?? await this.remote.revisions(this.vaultId, (doneFiles, totalFiles) => this.emit('scanning-remote', { doneFiles, totalFiles }), options.allowRenames); this.guard();
    const found = new Set(ops.map(op => op.opId));
    if (state.knownOps.some(id => !found.has(id))) throw new VaultSailError('visibility', '之前确认的远端记录暂不可见，停止写入。');
    const heads = buildHeads(ops, options.allowRenames); const paths = (await this.local.paths()).filter(path => included(path, this.configDir));
    assertNoCollisions(paths); const local = new Map<string, { hash: string; size: number }>(), present = new Set(paths), blocked = new Map<string, BlockedFile>();
    const oversized = (path: string, size: number): BlockedFile => ({ path, size, reason: 'size', message: `超过本机 ${this.fileLimit / (1024 * 1024)} MiB 上限，未读取或传输；文件和原有基线保留。` });
    // A smaller-budget device can read the version graph without fetching bodies.
    // Include live rename branches, which may reside at another path.
    const headSnapshot = { heads };
    for (const [path] of heads) {
      const versions = this.conflictHeads(headSnapshot, path);
      const largest = Math.max(0, ...versions.map(head => head.size));
      if (largest > this.fileLimit) blocked.set(path, oversized(path, largest));
    }
    let oversizedLocal = false;
    let scanned = 0; this.emit('scanning-local', { totalFiles: paths.length, doneFiles: 0 });
    const changes = new Map(this.dirtyPaths);
    for (const path of paths) {
      this.emit('scanning-local', { path });
      this.guard(); const stat = await this.local.stat(path);
      if (!stat) throw new VaultSailError('changed', '扫描期间本地文件发生变化，请重新预览。');
      checkSizeValue(stat.size);
      if (stat.size > this.fileLimit) {
        oversizedLocal = true; blocked.set(path, oversized(path, stat.size));
        this.emit('scanning-local', { doneFiles: ++scanned }); continue;
      }
      if (blocked.has(path)) { this.emit('scanning-local', { doneFiles: ++scanned }); continue; }
      const cached = options.incremental && !changes.has(path) ? this.localIndex?.get(path) : undefined;
      const base = state.bases[path], versions = heads.get(path) ?? [];
      if (cached && cached.size === stat.size && base && sameIds(base.heads, ids(versions))) { local.set(path, cached); this.emit('scanning-local', { doneFiles: ++scanned }); continue; }
      this.guard(); const data = await this.local.read(path);
      if (data === null) throw new VaultSailError('changed', '扫描期间本地文件发生变化，请重新预览。');
      checkSize(data.byteLength, this.fileLimit);
      if (data.byteLength !== stat.size) throw new VaultSailError('changed', '扫描期间本地文件大小发生变化，请重新预览。');
      local.set(path, { hash: hash(data), size: data.byteLength });
      this.emit('scanning-local', { doneFiles: ++scanned });
    }
    this.localIndex = new Map(local);
    for (const [path, sequence] of changes) if (this.dirtyPaths.get(path) === sequence) this.dirtyPaths.delete(path);
    assertNoCollisions([...new Set([...paths, ...heads.keys()])]);
    for (const path of heads.keys()) if (!included(path, this.configDir)) throw new VaultSailError('path', '远端路径属于排除目录。');
    if (blocked.size) {
      const candidates = new Set([...present, ...heads.keys(), ...Object.keys(state.bases)]);
      // Without an oversized source hash, a missing baseline path may be its
      // rename source. Freeze deletion/rename inference instead of guessing.
      for (const [path, base] of Object.entries(state.bases)) if (oversizedLocal && base.hash !== null && !present.has(path) && !blocked.has(path)) blocked.set(path, { path, size: heads.get(path)?.[0]?.size ?? 0, reason: 'related', message: '存在未校验的超限文件，暂缓判断此缺失路径的删除或重命名；基线保留。' });
      const identities = new Set<string>();
      for (const path of blocked.keys()) {
        if (state.bases[path]) identities.add(state.bases[path].fileId);
        for (const head of heads.get(path) ?? []) identities.add(head.fileId);
      }
      for (const op of ops) if (blocked.has(op.path) || (op.previousPath && blocked.has(op.previousPath))) identities.add(op.fileId);
      for (const path of candidates) if (!blocked.has(path) && ((state.bases[path] && identities.has(state.bases[path].fileId)) || (heads.get(path) ?? []).some(head => identities.has(head.fileId)))) {
        blocked.set(path, { path, size: local.get(path)?.size ?? heads.get(path)?.[0]?.size ?? 0, reason: 'related', message: '与超限或尚未确认的文件身份关联，暂缓应用、删除及重命名；基线保留。' });
      }
    }
    this.blocked = blocked; this.emit('scanning-local', { blockedFiles: blocked.size });
    return { ops, heads, local, present, blocked };
  }
  async preview(mode: SyncPlan['mode'], deletionEnabled = false, options: { incremental?: boolean; ops?: Revision[]; allowRenames?: boolean } = {}): Promise<SyncPlan> {
    return this.exclusive(async () => {
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '有未完成操作，请先恢复任务。');
      const snapshot = await this.scan(state, options); const rows: PlanRow[] = [];
      const operationIds = new Set(snapshot.ops.map(op => op.opId));
      const renames = new Map<string, string>();
      if (mode === 'sync') {
        const removed = new Map<string, string[]>(); const additions = new Map<string, number>();
        for (const [oldPath, base] of Object.entries(state.bases)) {
          const heads = snapshot.heads.get(oldPath) ?? [];
          if (!snapshot.blocked.has(oldPath) && base.hash && !snapshot.present.has(oldPath) && heads.length === 1 && heads[0].kind === 'update' && heads[0].hash === base.hash && sameIds(base.heads, ids(heads)))
            removed.set(base.hash, [...(removed.get(base.hash) ?? []), oldPath]);
        }
        for (const [path, local] of snapshot.local) if (!snapshot.blocked.has(path) && !snapshot.heads.has(path) && !state.bases[path]) additions.set(local.hash, (additions.get(local.hash) ?? 0) + 1);
        for (const [path, local] of snapshot.local) if (!snapshot.blocked.has(path) && !snapshot.heads.has(path) && !state.bases[path]) {
          const candidates = removed.get(local.hash) ?? [];
          if (candidates.length === 1 && additions.get(local.hash) === 1) renames.set(path, candidates[0]);
        }
      }
      const renamedSources = new Set(renames.values());
      for (const path of [...new Set([...snapshot.present, ...snapshot.heads.keys(), ...Object.keys(state.bases)])].sort()) {
        const renameFrom = renames.get(path);
        const local = snapshot.local.get(path); const ownHeads = snapshot.heads.get(renameFrom ?? path) ?? [];
        const relatedHeads = options.allowRenames ? this.conflictHeads(snapshot, renameFrom ?? path) : ownHeads;
        const renameConflict = new Set(relatedHeads.filter(head => head.kind === 'update').map(head => head.path)).size > 1;
        const heads = renameConflict ? relatedHeads : ownHeads; const base = state.bases[path]; const head = heads[0];
        if (base && !base.heads.every(id => operationIds.has(id))) throw new VaultSailError('state', '基线引用的远端版本缺失。');
        if (base && !head) throw new VaultSailError('visibility', '基线文件的远端版本缺失。');
        const blocked = snapshot.blocked.get(path);
        if (blocked) { rows.push({ path, action: 'skip', reason: blocked.message, localHash: local?.hash ?? null, size: blocked.size, heads, blocked }); continue; }
        let action: PlanRow['action'] = 'noop'; let reason = '双方内容一致';
        if (renameConflict) { action = 'conflict'; reason = '并发重命名：解决后以此路径作为最终文件名'; }
        else if (local && local.hash !== base?.hash && this.retiredSource(snapshot, path, heads)) { action = 'upload'; reason = '重新使用退役的旧文件名，创建独立文件身份'; }
        else if (renameFrom) { action = 'upload'; reason = '识别到唯一的同内容重命名，保留文件身份'; }
        else if (renamedSources.has(path)) { action = 'skip'; reason = '源路径由重命名操作处理'; }
        else if (base && head && base.fileId !== head.fileId) { action = 'conflict'; reason = '同一路径的文件身份已变化，需手动确认'; }
        else if (heads.length > 1) { action = 'conflict'; reason = '云端有并发版本，需保留并处理所有分支'; }
        else if (local && head?.kind === 'update' && local.hash === head.hash) {
          if (local.size !== head.size) throw new VaultSailError('integrity', '远端版本大小与相同内容 Hash 矛盾。'); action = 'noop';
        }
        else if (mode === 'upload') {
          if (!local) { action = 'skip'; reason = '手动上传不传播删除'; }
          else if (head && base && head.kind === 'update' && base.hash === head.hash && sameIds(base.heads, ids(heads))) { action = 'upload'; reason = '只有本地修改，云端仍是已验证的基线'; }
          else if (head) { action = 'conflict'; reason = '同名内容不同，需确认后保留恢复副本'; }
          else { action = 'upload'; reason = '上传本地新文件'; }
        } else if (mode === 'download') {
          if (head?.kind !== 'update') { action = 'skip'; reason = '手动下载不传播删除'; }
          else if (local && base && local.hash === base.hash) { action = 'download'; reason = '只有云端修改，本地仍是已验证的基线'; }
          else if (local) { action = 'conflict'; reason = '同名内容不同，需确认后保留恢复副本'; }
          else { action = 'download'; reason = '下载远端新文件'; }
        } else {
          const decision = reconcileFile({ path, base: base?.hash ? { hash: base.hash, size: 0 } : null,
            local: local ? { hash: local.hash, size: 0 } : null, remote: head?.kind === 'update' ? { hash: head.hash!, size: 0 } : null });
          action = decision.operation; reason = ({ upload: '本地修改，远端未变', download: '远端修改，本地未变', conflict: '双方均已修改', 'delete-local': '远端明确记录了删除', 'delete-remote': '本地删除，远端未变', noop: '双方内容一致' })[decision.operation];
          if ((action === 'delete-local' || action === 'delete-remote') && (!deletionEnabled || !base)) { action = 'skip'; reason = '删除传播关闭或缺少可信基线'; }
        }
        rows.push({ path, action, reason, localHash: local?.hash ?? null, size: action === 'download' ? head?.size ?? 0 : local?.size ?? head?.size ?? 0, heads, ...(renameFrom ? { renameFrom } : {}), ...(renameConflict ? { renameConflict: true } : {}) });
      }
      this.emit('preview-ready', { doneFiles: rows.length, totalFiles: rows.length, path: undefined });
      const plan: SyncPlan = { vaultId: this.vaultId, mode, deletionEnabled, revisionIds: snapshot.ops.map(op => op.opId).sort(), rows };
      this.prepared = { plan, snapshot }; return plan;
    }, 'preview-ready');
  }
  async execute(plan: SyncPlan, onProgress: (done: number, total: number) => void = () => {}, autoConflicts = false): Promise<SyncResult> {
    return this.executePlan(plan, onProgress, autoConflicts);
  }
  async sync(deletionEnabled = false, options: { incremental?: boolean; ops?: Revision[] } = {}): Promise<SyncResult> {
    const plan = await this.preview('sync', deletionEnabled, { ...options, allowRenames: true }); const prepared = this.prepared;
    if (!prepared || prepared.plan !== plan) throw new VaultSailError('changed', '同步依据已变化，请重试。');
    this.prepared = undefined;
    return this.executePlan(plan, () => {}, true, prepared.snapshot, options.incremental === true);
  }
  private async executePlan(plan: SyncPlan, onProgress: (done: number, total: number) => void, autoConflicts: boolean, prepared?: Snapshot, incremental = false): Promise<SyncResult> {
    return this.exclusive(async () => {
      if (plan.vaultId !== this.vaultId) throw new VaultSailError('binding', '预览属于其他云端库。');
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      const snapshot = prepared ?? await this.scan(state, { allowRenames: plan.rows.some(row => row.renameConflict) });
      if (!sameIds(plan.revisionIds, snapshot.ops.map(op => op.opId))) throw new VaultSailError('changed', '预览后云端已变化，请重新预览。');
      const actualPaths = new Set([...snapshot.present, ...snapshot.heads.keys(), ...Object.keys(state.bases)]);
      if (prepared) {
        const nowPaths = new Set((await this.local.paths()).filter(path => included(path, this.configDir)));
        if (!sameIds([...nowPaths].sort(), [...snapshot.present].sort())) throw new VaultSailError('changed', '扫描后本地文件列表已变化，请重试。');
      }
      if (actualPaths.size !== plan.rows.length || plan.rows.some(row => !actualPaths.has(row.path) || (snapshot.local.get(row.path)?.hash ?? null) !== row.localHash)) throw new VaultSailError('changed', '预览后本地已变化，请重新预览。');
      if (plan.rows.some(row => Boolean(row.blocked) !== snapshot.blocked.has(row.path) || (snapshot.blocked.has(row.path) && row.action !== 'skip'))) throw new VaultSailError('changed', '跳过文件的状态已变化，请重新预览。');
      let done = 0; let doneBytes = 0; let preservedConflicts = 0; let autoMergedFiles = 0;
      const notifyDone = () => { try { onProgress(done, plan.rows.length); } catch { /* UI callbacks cannot fail a journal commit. */ } };
      let uploadedFiles = 0; let downloadedFiles = 0; let deletedFiles = 0;
      const published = new Set<string>();
      const startIds = new Set(plan.revisionIds);
      const conflictBytes = (row: PlanRow) => row.heads.reduce((sum, head) => sum + (head.kind === 'update' ? head.size : 0), 0) + (row.localHash ? row.size : 0);
      const totalBytes = plan.rows.reduce((sum, row) => sum + (row.action === 'upload' || row.action === 'download' ? row.size : row.action === 'conflict' && autoConflicts ? conflictBytes(row) : 0), 0);
      this.emit('checking', { path: undefined, doneFiles: 0, totalFiles: plan.rows.length, doneBytes: 0, totalBytes, blockedFiles: snapshot.blocked.size });
      for (const row of plan.rows) this.recordRow(row, 'queued');
      // Persist every operation intent before starting parallel network writes.
      // Local apply/baseline/log commits remain serialized across all workers.
      const transferBatch = async (rows: PlanRow[]) => {
        const jobs: { row: PlanRow; journal: Journal; data: ArrayBuffer | null }[] = [];
        for (const row of rows) {
          this.recordRow(row, 'running');
          this.emit(row.action === 'upload' ? 'preparing-upload' : 'checking', { path: row.path });
          try {
          this.guard(); const data = await this.local.read(row.path);
          if ((data === null ? null : hash(data)) !== row.localHash) throw new VaultSailError('changed', '传输前本地内容已变化，请重新预览。');
          if (!sameIds(ids(row.heads), ids(snapshot.heads.get(row.path) ?? []))) throw new VaultSailError('changed', '传输依据已变化，请重新预览。');
          const upload = row.action === 'upload';
          if (upload && !data) throw new VaultSailError('changed', '待上传文件已不存在，请重新预览。');
          const freshIdentity = upload && this.retiredSource(snapshot, row.path, row.heads);
          const revision: Revision = upload ? { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId,
            fileId: freshIdentity ? uuid() : row.heads[0]?.fileId ?? state.bases[row.path]?.fileId ?? uuid(), path: row.path, parents: freshIdentity ? [] : ids(row.heads),
            kind: 'update', size: data!.byteLength, hash: hash(data!), createdAt: Date.now() } : row.heads[0];
          const journal: Journal = { id: revision.opId, path: row.path, action: upload ? 'publish' : 'apply', stage: 'prepared', revision, expectedLocal: row.localHash };
          if (freshIdentity) journal.allowBranch = true;
          if (upload) { await this.local.stage(revision.opId, data!); await this.local.preserve(row.path, data!, revision.opId); }
          state.journals.push(journal); await this.store.save(state);
          jobs.push({ row, journal, data: upload ? data : null });
          this.recordRow(row, 'queued');
          } catch (error) { this.recordRow(row, failureState(error), row.action, 'stopped', error); throw error; }
        }
        let commitTail = Promise.resolve(); let commitFailed = false; let commitError: unknown;
        const commit = (action: () => Promise<void>) => {
          const current = commitTail.then(async () => {
            if (commitFailed) throw commitError;
            try { await action(); } catch (error) { commitFailed = true; commitError = error; throw error; }
          });
          commitTail = current.catch(() => {}); return current;
        };
        const active = new Set<string>();
        await mapConcurrent(jobs, this.concurrency, async ({ row, journal, data }) => {
          const op = journal.revision;
          const report = (phase: ProgressPhase) => { this.recordRow(row, 'running'); this.emit(phase, { path: row.path, activeFiles: active.size, concurrency: this.concurrency }); };
          this.guard(); active.add(row.path);
          try {
            this.recordRow(row, 'running');
            let downloaded: ArrayBuffer | undefined;
            if (row.action === 'upload') await this.publishRevision(op, data!, report);
            else { report('downloading'); downloaded = await this.remote.blob(this.vaultId, op, () => report('verifying')); }
            await commit(async () => {
              this.guard();
              if (row.action === 'upload') { journal.stage = 'published'; await this.store.save(state); this.guard(); published.add(op.opId); }
              else { report('applying'); await this.applyLocal(row.path, downloaded!, row.localHash, op.opId); journal.stage = 'applied'; await this.store.save(state); }
              state.bases[row.path] = { hash: op.hash!, heads: [op.opId], fileId: op.fileId };
              state.knownOps = [...new Set([...state.knownOps, op.opId])];
              state.journals = state.journals.filter(item => item !== journal); await this.store.save(state);
              this.recordRow(row, 'succeeded');
              doneBytes += row.size; if (row.action === 'upload') uploadedFiles++; else downloadedFiles++;
              done++; notifyDone();
            });
          } catch (error) { this.recordRow(row, failureState(error), row.action, 'stopped', error); throw error; }
          finally { active.delete(row.path); this.emit('checking', { path: undefined, activeFiles: active.size, doneFiles: done, doneBytes }); }
        });
      };
      let batch: PlanRow[] = []; let batchBytes = 0;
      const flush = async () => { if (batch.length) { const rows = batch; batch = []; batchBytes = 0; await transferBatch(rows); } };
      for (const row of plan.rows) {
        if (row.blocked) {
          // Still present, not verified: do not read, infer deletion, or advance
          // this file's baseline. Independent files can finish normally.
          await flush(); this.guard(); this.recordRow(row, 'skipped'); done++; notifyDone(); this.emit('checking', { path: row.path, doneFiles: done }); continue;
        }
        if ((row.action === 'upload' || row.action === 'download') && !row.renameFrom) {
          const weight = row.size + (row.action === 'download' ? snapshot.local.get(row.path)?.size ?? 0 : 0);
          if (row.size > MAX_FILE_SIZE || (snapshot.local.get(row.path)?.size ?? 0) > MAX_FILE_SIZE) {
            await flush(); await transferBatch([row]); continue;
          }
          if (batch.length && (batch.length >= this.concurrency || batchBytes + weight > TRANSFER_BATCH_BYTES)) await flush();
          batch.push(row); batchBytes += weight; continue;
        }
        await flush();
        this.emit('checking', { path: row.path });
        this.recordRow(row, 'running');
        this.guard();
        if (prepared && (!incremental || row.action !== 'noop' || this.dirtyPaths.has(row.path))) {
          const current = await this.local.read(row.path);
          if ((current === null ? null : hash(current)) !== row.localHash) throw new VaultSailError('changed', '扫描后本地内容已变化，修改已保留，请重试。');
        }
        if (row.action === 'conflict') {
          if (autoConflicts) {
            if (row.renameConflict) {
              for (const head of row.heads) if (head.kind === 'update') await this.ensureConflictCopy(row.path, head.deviceId.slice(0, 8) + '-' + head.opId, head.hash!, () => this.remote.blob(this.vaultId, head));
              this.recordRow(row, 'conflict', 'conflict', 'preserved'); preservedConflicts++; done++; notifyDone(); this.emit('checking', { doneFiles: done }); continue;
            }
            const merged = plan.mode === 'sync' ? await this.autoMerge(row, state, snapshot) : undefined;
            if (merged) { for (const id of merged) published.add(id); autoMergedFiles++; }
            else { const opId = await this.preserveConflict(row, state, plan.mode !== 'download'); if (opId) published.add(opId); preservedConflicts++; this.recordRow(row, 'conflict', 'conflict', 'preserved'); }
            doneBytes += conflictBytes(row);
          }
          if (!autoConflicts) this.recordRow(row, 'conflict', 'conflict', 'review');
          done++; notifyDone(); this.emit('checking', { doneFiles: done, doneBytes }); continue;
        }
        if (row.action === 'skip') { this.recordRow(row, 'skipped'); done++; notifyDone(); this.emit('checking', { doneFiles: done }); continue; }
        if (row.action === 'noop') {
          const head = row.heads[0]; if (row.heads.length === 1) state.bases[row.path] = { hash: head.hash ?? null, heads: [head.opId], fileId: head.fileId };
        } else {
          const currentHeads = snapshot.heads.get(row.renameFrom ?? row.path) ?? [];
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
            await this.publishRevision(op, localData ?? undefined, phase => this.emit(phase)); journal.stage = 'published'; await this.store.save(state); this.guard();
            published.add(op.opId);
            state.bases[row.path] = { hash: op.hash ?? null, heads: [op.opId], fileId: op.fileId };
            state.knownOps = [...new Set([...state.knownOps, op.opId])]; state.journals = []; await this.store.save(state);
          } else {
            const head = row.heads[0]; const journal: Journal = { id: head.opId, path: row.path, action: 'apply', stage: 'prepared', revision: head, expectedLocal: row.localHash };
            state.journals.push(journal); await this.store.save(state);
            this.emit('downloading'); const data = head.kind === 'delete' ? null : await this.remote.blob(this.vaultId, head, () => this.emit('verifying')); this.guard();
            this.emit('applying');
            await this.applyLocal(row.path, data, row.localHash, head.opId); journal.stage = 'applied'; await this.store.save(state);
            state.bases[row.path] = { hash: head.hash ?? null, heads: [head.opId], fileId: head.fileId }; state.journals = []; await this.store.save(state);
          }
        }
        if (row.action === 'upload' || row.action === 'download') doneBytes += row.size;
        if (row.action === 'upload') uploadedFiles++;
        if (row.action === 'download') downloadedFiles++;
        if (row.action === 'delete-local' || row.action === 'delete-remote') deletedFiles++;
        this.recordRow(row, row.action === 'noop' ? 'unchanged' : 'succeeded');
        done++; notifyDone(); this.emit('checking', { doneFiles: done, doneBytes });
      }
      await flush();
      // Immutable parent-linked publications preserve concurrent writers as branches.
      // Verify the complete inventory at batch boundaries instead of for every file.
      const readOnly = plan.rows.every(row => row.action === 'noop' || row.action === 'skip');
      if (!readOnly) this.emit('checking-remote', { path: undefined });
      // A no-change plan applies no remote content or local file writes. Its
      // baseline remains at the verified initial snapshot; later publications
      // are discovered on the next sync, without repeating this entire scan.
      const finalOps = readOnly ? snapshot.ops : await this.remote.revisions(this.vaultId, undefined, true); const found = new Set(finalOps.map(op => op.opId));
      this.emit('checking');
      if ([...state.knownOps, ...snapshot.ops.map(op => op.opId), ...published].some(id => !found.has(id))) throw new VaultSailError('visibility', '批次结束时已验证版本不可见，任务状态保留，请重试。');
      state.knownOps = [...new Set([...state.knownOps, ...found])]; await this.store.save(state);
      if (!finalOps.some(op => !startIds.has(op.opId) && !published.has(op.opId))) this.remoteSignature = this.signature(finalOps);
      return { incomingChanges: finalOps.filter(op => !startIds.has(op.opId) && !published.has(op.opId)).length,
        preservedConflicts, uploadedFiles, downloadedFiles, deletedFiles, autoMergedFiles, blockedFiles: snapshot.blocked.size };
    });
  }
  private async material(row: PlanRow, state: SyncState, snapshot: Snapshot): Promise<ConflictDetails> {
    if (snapshot.blocked.has(row.path)) throw new VaultSailError('size', '此文件或关联路径尚不可传输，请先处理跳过清单。');
    const data = await this.local.read(row.path);
    if ((data === null ? null : hash(data)) !== row.localHash) throw new VaultSailError('changed', '冲突内容已变化，请重新查看。');
    const local = data === null ? undefined : mergeText(data), versions: ConflictDetails['versions'] = [];
    for (const [index, head] of row.heads.entries()) {
      const value = index < 16 && head.kind === 'update' && head.size <= 256 * 1024 ? await this.remote.blob(this.vaultId, head) : undefined;
      versions.push({ id: head.opId, label: (row.renameConflict ? head.path + ' · ' : '') + head.deviceId.slice(0, 8) + ' · ' + head.opId.slice(0, 8) + (head.kind === 'delete' ? '（删除记录）' : ''), size: head.size,
        ...(value ? { text: mergeText(value) } : {}) });
    }
    const result: ConflictDetails = { row, local, versions };
    if (data === null && state.bases[row.path] !== undefined) return result;
    if (!row.path.toLowerCase().endsWith('.md') || row.heads.some(head => head.kind !== 'update' || head.previousPath) || new Set(row.heads.map(head => head.fileId)).size !== 1) return result;
    let tips: string[] = [], left: string | undefined, right: string | undefined;
    if (row.heads.length === 1 && state.bases[row.path]?.heads.length === 1 && data !== null) {
      tips = [state.bases[row.path].heads[0], row.heads[0].opId]; left = local; right = versions[0].text;
      result.mergeLabels = ['本机当前内容', versions[0].label];
    } else if (row.heads.length === 2 && (data === null || row.heads.some(head => head.hash === row.localHash) || state.bases[row.path]?.hash === row.localHash)) {
      tips = row.heads.map(head => head.opId); left = versions[0].text; right = versions[1].text;
      result.mergeLabels = [versions[0].label, versions[1].label];
    }
    const ancestor = commonAncestor(snapshot.ops, tips);
    if (!ancestor || ancestor.kind !== 'update' || ancestor.size > 256 * 1024 || ancestor.fileId !== row.heads[0]?.fileId || left === undefined || right === undefined) return result;
    result.base = mergeText(await this.remote.blob(this.vaultId, ancestor));
    if (result.base !== undefined) result.merge = threeWayMerge(result.base, left, right);
    return result;
  }
  async describeConflict(row: PlanRow): Promise<ConflictDetails> {
    return this.exclusive(async () => {
      const state = await this.state(); const snapshot = await this.scan(state, { allowRenames: true });
      if (!sameIds(ids(this.conflictHeads(snapshot, row.path)), ids(row.heads))) throw new VaultSailError('changed', '远端冲突已变化，请重新查看。');
      return this.material(row, state, snapshot);
    });
  }
  private async publishLocalBranch(row: PlanRow, state: SyncState, snapshot: Snapshot): Promise<Snapshot> {
    if (this.retiredSource(snapshot, row.path, row.heads)) return snapshot;
    if (row.localHash !== null && !row.heads.some(head => head.hash === row.localHash) && state.bases[row.path]?.hash !== row.localHash) {
      const opId = await this.preserveConflict(row, state, true);
      if (opId) {
        const ops = await this.remote.revisions(this.vaultId, undefined, true), heads = buildHeads(ops, true), next = { ...snapshot, ops, heads };
        if (!sameIds(ids(this.conflictHeads(next, row.path)), [...ids(row.heads), opId])) throw new VaultSailError('changed', '保存本地分支时远端出现新修改，内容已保留，请重新查看。');
        return next;
      }
    }
    return snapshot;
  }
  private async autoMerge(row: PlanRow, state: SyncState, snapshot: Snapshot): Promise<string[] | undefined> {
    if (!row.path.toLowerCase().endsWith('.md') || row.size > 256 * 1024 || row.heads.some(head => head.size > 256 * 1024)) return undefined;
    if (row.heads.length > 1 && row.heads.every(head => head.kind === 'update' && head.hash === row.heads[0].hash && head.size === row.heads[0].size)
      && (row.localHash === row.heads[0].hash || row.localHash === state.bases[row.path]?.hash || (row.localHash === null && !state.bases[row.path]))) {
      const selected = await this.remote.blob(this.vaultId, row.heads[0]);
      return [await this.commitResolution(state, snapshot, row.path, selected, row.localHash, true)];
    }
    if (row.heads.length > 2) return undefined;
    const details = await this.material(row, state, snapshot);
    if (!details.merge?.clean || details.merge.text === undefined) return undefined;
    const updated = await this.publishLocalBranch(row, state, snapshot);
    const before = new Set(snapshot.ops.map(op => op.opId));
    const op = await this.commitResolution(state, updated, row.path, new TextEncoder().encode(details.merge.text).buffer, row.localHash, true);
    return [...updated.ops.filter(op => !before.has(op.opId)).map(op => op.opId), op];
  }
  private async ensureConflictCopy(path: string, key: string, expected: string, load: () => Promise<ArrayBuffer>): Promise<string> {
    let existing = await this.local.readConflictCopy(path, key);
    if (existing && hash(existing) !== expected) {
      // A user may edit a visible copy. Keep that edit and store the original under another key.
      key = 'preserved-' + hash(new TextEncoder().encode(key + '|' + expected).buffer as ArrayBuffer);
      existing = await this.local.readConflictCopy(path, key);
      if (existing && hash(existing) !== expected) { key = uuid(); existing = null; }
    }
    if (!existing) {
      const data = await load(); if (hash(data) !== expected) throw new VaultSailError('integrity', '冲突版本校验失败。');
      await this.local.writeConflictCopy(path, key, data);
    }
    return key;
  }
  private async preserveConflict(row: PlanRow, state: SyncState, publishLocal: boolean): Promise<string | undefined> {
    const local = await this.local.read(row.path); const localHash = local === null ? null : hash(local);
    if (localHash !== row.localHash) throw new VaultSailError('changed', '保留冲突前本地已变化，请重试。');
    const copies = new Map<string, string>();
    for (const head of row.heads) if (head.kind === 'update') {
      const copyKey = head.deviceId.slice(0, 8) + '-' + head.opId;
      copies.set(head.opId, await this.ensureConflictCopy(row.path, copyKey, head.hash!, () => this.remote.blob(this.vaultId, head, () => this.emit('verifying'))));
      this.guard();
    }
    if (local && localHash) await this.ensureConflictCopy(row.path, 'local-' + state.deviceId.slice(0, 8) + '-' + localHash, localHash, async () => local);
    const now = await this.local.read(row.path); if ((now === null ? null : hash(now)) !== localHash) throw new VaultSailError('changed', '保存冲突副本时笔记已变化，修改已保留。');
    const base = state.bases[row.path];
    const sameContent = row.heads.find(head => head.kind === 'update' && head.hash === localHash);
    // An unchanged receiver need not create a new branch for its old baseline.
    // Select a reproducible primary only after every competing version has a verified copy.
    if (!sameContent && ((base && base.hash === localHash) || (!base && !local))) {
      const chosen = row.heads.filter(head => head.kind === 'update').sort((a, b) => a.opId.localeCompare(b.opId))[0];
      if (chosen) {
        const data = await this.local.readConflictCopy(row.path, copies.get(chosen.opId)!);
        if (!data || hash(data) !== chosen.hash) throw new VaultSailError('integrity', '待应用的冲突版本未校验。');
        const journal: Journal = { id: chosen.opId, path: row.path, action: 'apply', stage: 'prepared', revision: chosen, expectedLocal: localHash };
        state.journals.push(journal); await this.store.save(state); this.guard(); this.emit('applying');
        await this.applyLocal(row.path, data, localHash, chosen.opId); journal.stage = 'applied'; await this.store.save(state); this.guard();
        state.bases[row.path] = { hash: chosen.hash!, heads: [chosen.opId], fileId: chosen.fileId }; state.journals = []; await this.store.save(state);
      }
      return undefined;
    }
    if (!local || !localHash) return undefined; // A deletion never wins over preserved content automatically.
    if (sameContent) { state.bases[row.path] = { hash: localHash, heads: [sameContent.opId], fileId: sameContent.fileId }; await this.store.save(state); return undefined; }
    if (!publishLocal) return undefined;
    const op: Revision = { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId, fileId: base?.fileId ?? row.heads[0]?.fileId ?? uuid(),
      path: row.path, parents: base?.heads ?? [], kind: 'update', hash: localHash, size: local.byteLength, createdAt: Date.now() };
    await this.local.stage(op.opId, local); await this.local.preserve(row.path, local, op.opId);
    const journal: Journal = { id: op.opId, path: row.path, action: 'publish', stage: 'prepared', revision: op, expectedLocal: localHash, allowBranch: true };
    state.journals.push(journal); await this.store.save(state); this.guard();
    await this.publishRevision(op, local, phase => this.emit(phase)); journal.stage = 'published'; await this.store.save(state); this.guard();
    state.bases[row.path] = { hash: localHash, heads: [op.opId], fileId: op.fileId }; state.knownOps = [...new Set([...state.knownOps, op.opId])];
    state.journals = []; await this.store.save(state); return op.opId;
  }
  async recover(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); this.emit('checking-remote', { path: undefined });
      const visible = await this.remote.revisions(this.vaultId, undefined, true); const known = new Set(visible.map(op => op.opId));
      this.emit('checking', { totalFiles: state.journals.length, totalBytes: state.journals.reduce((sum, journal) => sum + journal.revision.size, 0) });
      if (state.knownOps.some(id => !known.has(id))) throw new VaultSailError('visibility', '已知远端记录缺失，恢复暂停。');
      for (const journal of [...state.journals]) {
        this.emit('checking', { path: journal.path });
        this.guard(); const op = journal.revision;
        this.recordFile(op.path, 'recover', op.size, 'running', 'recovered');
        checkSize(op.size, this.fileLimit);
        if (journal.action === 'publish' || journal.action === 'resolve') {
          if (!known.has(op.opId)) {
            const data = op.kind === 'update' ? await this.local.staged(op.opId) : null;
            if ((data ? hash(data) : null) !== (op.hash ?? null)) throw new VaultSailError('changed', '待发布内容已变化，恢复暂停；请保留恢复日志。');
            const snapshot = { ops: visible, heads: buildHeads(visible, true), local: new Map<string, { hash: string; size: number }>() };
            const heads = journal.action === 'resolve' ? this.conflictHeads(snapshot, op.path) : snapshot.heads.get(op.previousPath ?? op.path) ?? [];
            if (journal.allowBranch) buildHeads([...visible, op], true);
            else if (!sameIds(ids(heads), [...op.parents].sort())) throw new VaultSailError('changed', '待发布操作的远端依据已变化，恢复暂停。');
            await this.publishRevision(op, data ?? undefined, phase => this.emit(phase));
          }
          state.knownOps = [...new Set([...state.knownOps, op.opId])];
        }
        if (journal.action === 'apply' || journal.action === 'resolve') {
          const current = await this.local.read(op.path); const currentHash = current ? hash(current) : null;
          if (currentHash !== (op.hash ?? null)) {
            if (currentHash !== journal.expectedLocal) throw new VaultSailError('changed', '本地内容已变化，停止恢复以保留修改。');
            this.emit('downloading'); const data = op.kind === 'update' ? await this.remote.blob(this.vaultId, op, () => this.emit('verifying')) : null; this.guard();
            this.emit('applying');
            await this.applyLocal(op.path, data, journal.expectedLocal, op.opId);
          }
        }
        state.bases[op.path] = { hash: op.hash ?? null, heads: [op.opId], fileId: op.fileId };
        state.journals = state.journals.filter(item => item.id !== journal.id); await this.store.save(state);
        this.recordFile(op.path, 'recover', op.size, 'succeeded', 'recovered');
        this.emit('checking', { doneFiles: this.progress.doneFiles + 1, doneBytes: this.progress.doneBytes + op.size });
      }
    });
  }
  async abandonPending(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); this.emit('checking-remote', { path: undefined });
      const ops = await this.remote.revisions(this.vaultId, undefined, true); const found = new Set(ops.map(op => op.opId));
      this.emit('checking');
      if (state.knownOps.some(id => !found.has(id))) throw new VaultSailError('visibility', '已知远端记录缺失，暂停处理。');
      // Keep baseline, staged contents and recovery points; a subsequent plan sees any published branch.
      state.journals = []; state.knownOps = [...new Set([...state.knownOps, ...found])]; await this.store.save(state);
    });
  }
  async resolve(path: string, choice: 'local' | string, expectedRow?: PlanRow, mergedData?: ArrayBuffer): Promise<void> {
    return this.exclusive(async () => {
      this.recordFile(path, 'resolve', expectedRow?.size ?? 0, 'running', 'resolved');
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      const snapshot = await this.scan(state, { allowRenames: true }); const heads = this.conflictHeads(snapshot, path);
      if (snapshot.blocked.has(path)) throw new VaultSailError('size', '此文件或关联路径尚不可传输，请先处理跳过清单。');
      const localData = await this.local.read(path); const expected = localData ? hash(localData) : null;
      if (expectedRow && (expectedRow.path !== path || expectedRow.localHash !== expected || !sameIds(ids(expectedRow.heads), ids(heads)))) throw new VaultSailError('changed', '冲突预览后内容已变化，请重新预览。');
      let selected = localData;
      if (mergedData !== undefined) { if (!expectedRow) throw new VaultSailError('changed', '合并内容需要有效的冲突预览。'); checkSize(mergedData.byteLength, this.fileLimit); selected = mergedData; }
      else if (choice !== 'local') { const head = heads.find(op => op.opId === choice); if (!head) throw new VaultSailError('changed', '选择的远端版本已变化。'); selected = head.kind === 'update' ? await this.remote.blob(this.vaultId, head) : null; }
      if (!selected) throw new VaultSailError('conflict', '首期冲突处理必须选择一个内容版本，删除分支仅保留记录。');
      const row = expectedRow ?? { path, action: 'conflict', reason: '', localHash: expected, size: localData?.byteLength ?? 0, heads };
      const updated = await this.publishLocalBranch(row, state, snapshot);
      await this.commitResolution(state, updated, path, selected, expected);
    });
  }
  async resolveBoth(row: PlanRow, otherChoice: string, copyPath: string, primaryChoice = 'local'): Promise<void> {
    return this.exclusive(async () => {
      this.recordFile(row.path, 'resolve', row.size, 'running', 'resolved');
      if (!included(copyPath, this.configDir) || copyPath === row.path) throw new VaultSailError('path', '请输入正常笔记目录中的新文件名。');
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      if (row.renameConflict) throw new VaultSailError('conflict', '请先选择最终文件名并统一版本，再复制为两篇。');
      const snapshot = await this.scan(state, { allowRenames: true }), heads = this.conflictHeads(snapshot, row.path);
      if (snapshot.blocked.has(row.path)) throw new VaultSailError('size', '此文件或关联路径尚不可传输，请先处理跳过清单。');
      const localData = await this.local.read(row.path);
      if ((localData === null ? null : hash(localData)) !== row.localHash || !sameIds(ids(heads), ids(row.heads))) throw new VaultSailError('changed', '冲突内容已变化，请重新查看。');
      assertNoCollisions([...new Set([...snapshot.present, ...snapshot.heads.keys()]), copyPath]);
      const choose = async (choice: string) => {
        if (choice === 'local') return localData;
        const head = heads.find(op => op.opId === choice);
        if (!head || head.kind !== 'update') throw new VaultSailError('conflict', '请选择有效的内容版本。');
        return this.remote.blob(this.vaultId, head);
      };
      const selected = await choose(primaryChoice), other = await choose(otherChoice);
      if (selected === null || other === null) throw new VaultSailError('conflict', '保留为两篇需要两个内容版本。');
      const updated = await this.publishLocalBranch(row, state, snapshot);
      const visible = await this.remote.revisions(this.vaultId, undefined, true);
      if (buildHeads(visible, true).has(copyPath)) throw new VaultSailError('collision', '新文件名已被远端使用，请换一个名称。');
      const op: Revision = { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId, fileId: uuid(), path: copyPath,
        parents: [], kind: 'update', hash: hash(other), size: other.byteLength, createdAt: Date.now() };
      const journal: Journal = { id: op.opId, path: copyPath, action: 'resolve', stage: 'prepared', revision: op, expectedLocal: null };
      this.recordFile(copyPath, 'upload', other.byteLength, 'running');
      await this.local.stage(op.opId, other); state.journals.push(journal); await this.store.save(state); this.guard();
      await this.publishRevision(op, other); journal.stage = 'published'; await this.store.save(state); this.guard();
      await this.applyLocal(copyPath, other, null, op.opId); journal.stage = 'applied'; await this.store.save(state);
      state.bases[copyPath] = { hash: op.hash!, heads: [op.opId], fileId: op.fileId }; state.knownOps = [...new Set([...state.knownOps, op.opId])];
      state.journals = state.journals.filter(item => item.id !== op.opId); await this.store.save(state);
      this.recordFile(copyPath, 'upload', other.byteLength, 'succeeded');
      await this.commitResolution(state, updated, row.path, selected, row.localHash);
    });
  }
  async resolveDelete(row: PlanRow, deletionEnabled: boolean): Promise<void> {
    if (!deletionEnabled || row.renameConflict) throw new VaultSailError('configuration', '删除传播未开启，或需要先解决文件名冲突。');
    return this.exclusive(async () => {
      this.recordFile(row.path, 'resolve', row.size, 'running', 'resolved');
      const state = await this.state(); if (state.journals.length) throw new VaultSailError('recovery', '请先恢复未完成任务。');
      const snapshot = await this.scan(state, { allowRenames: true }), heads = this.conflictHeads(snapshot, row.path);
      if (snapshot.blocked.has(row.path)) throw new VaultSailError('size', '此文件或关联路径尚不可传输，请先处理跳过清单。');
      const data = await this.local.read(row.path);
      if (!sameIds(ids(heads), ids(row.heads)) || (data === null ? null : hash(data)) !== row.localHash) throw new VaultSailError('changed', '删除确认前内容已变化，请重新查看。');
      await this.commitResolution(state, snapshot, row.path, null, row.localHash);
    });
  }
  private async commitResolution(state: SyncState, snapshot: Snapshot, path: string, selected: ArrayBuffer | null, expected: string | null, automatic = false): Promise<string> {
      this.recordFile(path, automatic ? 'merge' : 'resolve', selected?.byteLength ?? 0, 'running', automatic ? 'merged' : 'resolved');
      const heads = this.conflictHeads(snapshot, path), localData = await this.local.read(path);
      if ((localData === null ? null : hash(localData)) !== expected) throw new VaultSailError('changed', '解决前本地内容已变化，草稿已保留。');
      this.emit('checking', { path, doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: selected?.byteLength ?? 0 });
      const op: Revision = { schemaVersion: 1, vaultId: this.vaultId, opId: uuid(), deviceId: state.deviceId, fileId: heads[0]?.fileId ?? uuid(), path,
        parents: ids(heads), kind: selected === null ? 'delete' : 'update', ...(selected === null ? {} : { hash: hash(selected) }), size: selected?.byteLength ?? 0, createdAt: Date.now() };
      const freshIdentity = selected !== null && this.retiredSource(snapshot, path, heads);
      if (freshIdentity) { op.fileId = uuid(); op.parents = []; }
      if (automatic) {
        op.fileId = heads.map(head => head.fileId).sort()[0]; op.deviceId = AUTO_MERGE_DEVICE;
        op.createdAt = Math.max(0, ...heads.map(head => head.createdAt));
        op.opId = automaticMergeId(this.vaultId, path, op.parents, op.hash!, op.fileId);
      }
      const otherPath = heads.find(head => head.fileId === op.fileId && head.path !== path)?.path;
      if (otherPath) op.previousPath = otherPath;
      // Preserve every competing content before either publishing or replacing the target.
      for (const head of heads) if (head.kind === 'update') await this.local.preserve(path, await this.remote.blob(this.vaultId, head), head.opId);
      if (localData) await this.local.preserve(path, localData, op.opId);
      this.emit('checking-remote', { path: undefined });
      const latestOps = await this.remote.revisions(this.vaultId, undefined, true);
      const latest = this.conflictHeads({ heads: buildHeads(latestOps, true) }, path);
      this.emit('checking', { path });
      const alreadyMerged = automatic && latest.length === 1 && latest[0].opId === op.opId;
      if (alreadyMerged && hash(jsonBytes(validateRevision(latest[0], this.vaultId))) !== hash(jsonBytes(validateRevision(op, this.vaultId)))) throw new VaultSailError('integrity', '自动合并标识对应的内容不一致，已停止。');
      if (!alreadyMerged && !sameIds(ids(heads), ids(latest))) throw new VaultSailError('changed', '保存副本期间远端发生变化，请重新处理冲突。');
      const now = await this.local.read(path); if ((now ? hash(now) : null) !== expected) throw new VaultSailError('changed', '保存副本期间本地发生变化。');
      const journal: Journal = { id: op.opId, path, action: 'resolve', stage: 'prepared', revision: op, expectedLocal: expected };
      if (freshIdentity) journal.allowBranch = true;
      if (selected !== null) await this.local.stage(op.opId, selected);
      state.journals.push(journal); await this.store.save(state); this.guard();
      await this.publishRevision(op, selected ?? undefined, phase => this.emit(phase)); journal.stage = 'published'; await this.store.save(state); this.guard();
      this.emit('applying');
      await this.applyLocal(path, selected, expected, op.opId); journal.stage = 'applied'; await this.store.save(state);
      state.bases[path] = { hash: op.hash ?? null, heads: [op.opId], fileId: op.fileId }; state.knownOps = [...new Set([...state.knownOps, ...snapshot.ops.map(item => item.opId), op.opId])];
      state.journals = []; await this.store.save(state);
      this.recordFile(path, automatic ? 'merge' : 'resolve', selected?.byteLength ?? 0, 'succeeded', automatic ? 'merged' : 'resolved');
      this.emit('checking', { doneFiles: 1, doneBytes: selected?.byteLength ?? 0 });
      return op.opId;
  }
}
