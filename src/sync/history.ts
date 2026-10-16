import { included, relativePath, uuid, validId, VaultSailError } from '../core/safety.ts';

export const HISTORY_TASK_LIMIT = 30;
export const HISTORY_FILE_LIMIT = 1000;
export const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
export const HISTORY_ACTIONS = { upload: '上传', download: '下载', 'delete-local': '本地删除', 'delete-remote': '云端删除记录', conflict: '冲突处理', merge: '自动合并', resolve: '解决冲突', recover: '恢复任务', skip: '跳过', noop: '无变化' } as const;
export const HISTORY_STATES = { queued: '等待', running: '处理中', succeeded: '成功', skipped: '跳过', unchanged: '无变化', conflict: '有冲突', failed: '失败', paused: '已暂停', unconfirmed: '未确认，需核验', 'not-run': '未执行' } as const;
export const HISTORY_REASONS = { planned: '按已核验计划处理', oversized: '超过 20 MiB，未传输，原文件与基线保留', related: '关联路径保护，暂缓删除、改名或应用', unchanged: '内容一致，无需传输', policy: '按同步方向、删除开关或改名规则跳过', review: '存在竞争版本，尚未应用或解决', preserved: '竞争内容已保留，等待解决', merged: '已发布合并版本', resolved: '已发布解决版本', recovered: '已核验并恢复操作', stopped: '任务停止，未完成项需重新检查' } as const;
export const HISTORY_CODES = { network: '网络异常', timeout: '请求超时', 'write-timeout': '写入结果尚未确认', permission: '权限不足', authentication: '授权异常', configuration: '配置异常', binding: '连接或库绑定变化', changed: '文件或版本依据变化', integrity: '内容校验失败', visibility: '云端结果暂不可见', response: '接口响应异常', schema: '格式不支持或损坏', state: '本地状态异常', recovery: '需要恢复未完成任务', size: '文件大小不支持', path: '路径不安全', collision: '路径冲突', paused: '用户暂停', cancelled: '操作停止', rate: '接口限流', http: 'HTTP 请求异常', unknown: '操作异常，原始详情未保存' } as const;
export type HistoryAction = keyof typeof HISTORY_ACTIONS;
export type HistoryState = keyof typeof HISTORY_STATES;
export type HistoryReason = keyof typeof HISTORY_REASONS;
export type HistoryCode = keyof typeof HISTORY_CODES;
export type HistoryMode = 'manual' | 'automatic' | 'upload' | 'download' | 'recover' | 'resolve';
export interface FileHistoryEvent { id: string; path: string; action: HistoryAction; size: number; state: HistoryState; reason: HistoryReason; code?: string; }
export interface FileHistoryRow extends Omit<FileHistoryEvent, 'code'> { code?: HistoryCode; startedAt?: number; updatedAt: number; }
export interface SyncHistoryTask {
  version: 1; id: string; context: string; deviceId: string; sequence: number; mode: HistoryMode;
  startedAt: number; updatedAt: number; endedAt?: number; status: 'running' | 'completed' | 'partial' | 'failed' | 'paused' | 'interrupted';
  code?: HistoryCode; truncated: boolean; files: FileHistoryRow[];
}
export interface HistoryStore { save(task: SyncHistoryTask): Promise<void>; list(): Promise<SyncHistoryTask[]>; warning?: boolean; }
const has = (object: object, key: unknown): key is string => typeof key === 'string' && Object.hasOwn(object, key);
export function historyCode(error: unknown): HistoryCode { const code = error instanceof VaultSailError ? error.code : 'unknown'; return has(HISTORY_CODES, code) ? code as HistoryCode : 'unknown'; }
export function failureState(error: unknown): HistoryState {
  const code = historyCode(error);
  return ['paused', 'cancelled'].includes(code) ? 'paused' : ['network', 'timeout', 'write-timeout', 'visibility', 'state', 'integrity', 'unknown'].includes(code) ? 'unconfirmed' : 'failed';
}
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function validateHistory(value: unknown, context: string, deviceId: string, configDir = '.obsidian'): SyncHistoryTask {
  const task = value as SyncHistoryTask;
  if (!task || task.version !== 1 || task.context !== context || task.deviceId !== deviceId || !validId(task.id)
    || !time(task.sequence) || !time(task.startedAt) || !time(task.updatedAt) || (task.endedAt !== undefined && !time(task.endedAt))
    || !['manual', 'automatic', 'upload', 'download', 'recover', 'resolve'].includes(task.mode)
    || !['running', 'completed', 'partial', 'failed', 'paused', 'interrupted'].includes(task.status)
    || typeof task.truncated !== 'boolean' || !Array.isArray(task.files) || task.files.length > HISTORY_FILE_LIMIT
    || (task.code !== undefined && !has(HISTORY_CODES, task.code))) throw new Error('Invalid local sync history');
  const ids = new Set<string>();
  const files = task.files.map(row => {
    if (!row || !validId(row.id) || ids.has(row.id) || typeof row.path !== 'string' || !included(relativePath(row.path), configDir)
      || !time(row.size) || !time(row.updatedAt) || (row.startedAt !== undefined && !time(row.startedAt))
      || !has(HISTORY_ACTIONS, row.action) || !has(HISTORY_STATES, row.state) || !has(HISTORY_REASONS, row.reason)
      || (row.code !== undefined && !has(HISTORY_CODES, row.code))) throw new Error('Invalid local history file');
    ids.add(row.id);
    // Whitelist fields: no raw exceptions, requests, bodies, tokens or URLs.
    return { id: row.id, path: row.path, action: row.action, size: row.size, state: row.state, reason: row.reason, updatedAt: row.updatedAt,
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}), ...(row.code ? { code: row.code } : {}) };
  });
  return { version: 1, id: task.id, context, deviceId, sequence: task.sequence, mode: task.mode, startedAt: task.startedAt, updatedAt: task.updatedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}), status: task.status, truncated: task.truncated, files, ...(task.code ? { code: task.code } : {}) };
}
export function interruptedHistory(task: SyncHistoryTask): SyncHistoryTask {
  const copy = structuredClone(task);
  if (copy.status === 'running') { copy.status = 'interrupted'; for (const row of copy.files) {
    if (row.state === 'running') { row.state = 'unconfirmed'; row.reason = 'stopped'; }
    else if (row.state === 'queued') { row.state = 'not-run'; row.reason = 'stopped'; }
  } }
  return copy;
}

/** Display history is advisory and never used as a baseline or recovery journal. */
export class SyncHistory {
  private active?: SyncHistoryTask; private recent = new Map<string, SyncHistoryTask>();
  private rows = new Map<string, FileHistoryRow>(); private timer?: ReturnType<typeof setTimeout>;
  private saving = Promise.resolve(); private listeners = new Set<() => void>();
  private reservedBytes = 2048;
  private sawPartial = false;
  warning = false;
  readonly store: HistoryStore; readonly context: string; readonly deviceId: string; private configDir: string;
  constructor(store: HistoryStore, context: string, deviceId: string, configDir = '.obsidian') { this.store = store; this.context = context; this.deviceId = deviceId; this.configDir = configDir; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot stop sync. */ } } }
  private schedule(): void { this.notify(); if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000); }
  begin(mode: HistoryMode): void {
    if (this.active) throw new Error('History task already active');
    this.rows.clear(); this.reservedBytes = 2048; this.sawPartial = false; this.active = { version: 1, id: uuid(), context: this.context, deviceId: this.deviceId, sequence: 0, mode,
      startedAt: Date.now(), updatedAt: Date.now(), status: 'running', truncated: false, files: [] };
    this.schedule(); void this.flush();
  }
  file(event: FileHistoryEvent): void {
    if (!this.active) return;
    try {
      if (['skipped', 'conflict', 'failed', 'paused', 'unconfirmed', 'not-run'].includes(event.state)) this.sawPartial = true;
      const old = this.rows.get(event.id);
      if (!old && (this.rows.size >= HISTORY_FILE_LIMIT || this.reservedBytes + 3 * event.path.length + 512 > HISTORY_BYTE_LIMIT)) { this.active.truncated = true; this.active.sequence++; this.schedule(); return; }
      const row: FileHistoryRow = { id: event.id, path: event.path, action: event.action, size: event.size, state: event.state, reason: event.reason,
        updatedAt: Date.now(), ...(old?.startedAt !== undefined ? { startedAt: old.startedAt } : event.state === 'running' ? { startedAt: Date.now() } : {}),
        ...(event.code && has(HISTORY_CODES, event.code) ? { code: event.code as HistoryCode } : {}) };
      validateHistory({ ...this.active, files: [row] }, this.context, this.deviceId, this.configDir);
      if (!old) this.reservedBytes += 3 * row.path.length + 512;
      this.rows.set(row.id, row); this.active.files = [...this.rows.values()]; this.active.updatedAt = row.updatedAt; this.active.sequence++; this.schedule();
    } catch { this.warning = true; this.notify(); }
  }
  async finish(error?: unknown, failed = error !== undefined): Promise<void> {
    const task = this.active; if (!task) return;
    for (const row of task.files) {
      if (row.state === 'queued') { row.state = 'not-run'; row.reason = 'stopped'; }
      else if (row.state === 'running') { row.state = failed ? failureState(error) : 'unconfirmed'; row.reason = 'stopped'; if (failed) row.code = historyCode(error); }
    }
    task.endedAt = Date.now(); task.updatedAt = task.endedAt; task.sequence++;
    task.status = failed ? ['paused', 'cancelled'].includes(historyCode(error)) ? 'paused' : 'failed'
      : this.sawPartial || task.files.some(row => ['skipped', 'conflict', 'failed', 'paused', 'unconfirmed', 'not-run'].includes(row.state)) ? 'partial' : 'completed';
    if (failed) task.code = historyCode(error);
    this.recent.set(task.id, structuredClone(task));
    while (this.recent.size > HISTORY_TASK_LIMIT) this.recent.delete(this.recent.keys().next().value!);
    this.active = undefined; this.notify(); await this.flush(task);
  }
  async flush(task = this.active): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!task) return this.saving;
    const snapshot = structuredClone(task);
    this.saving = this.saving.then(async () => { try { await this.store.save(snapshot); } catch { this.warning = true; this.notify(); } });
    await this.saving;
  }
  async list(): Promise<SyncHistoryTask[]> {
    let stored: SyncHistoryTask[] = [];
    try { stored = await this.store.list(); this.warning ||= this.store.warning === true; } catch { this.warning = true; }
    const tasks = new Map(stored.map(task => [task.id, interruptedHistory(task)]));
    for (const task of this.recent.values()) tasks.set(task.id, structuredClone(task));
    if (this.active) tasks.set(this.active.id, structuredClone(this.active));
    return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).slice(0, HISTORY_TASK_LIMIT);
  }
  current(): SyncHistoryTask | undefined { return this.active ? structuredClone(this.active) : undefined; }
  snapshots(): SyncHistoryTask[] { return [...this.recent.values(), ...(this.active ? [this.active] : [])].map(task => structuredClone(task)); }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; void this.flush(); this.listeners.clear(); }
}
