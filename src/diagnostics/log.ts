import { bytes, hash, uuid, validId } from '../core/safety.ts';

export const LOG_MEMORY_LIMIT = 1000, LOG_BATCH_LIMIT = 24, LOG_PENDING_LIMIT = 512;
const scopes = ['plugin', 'task', 'network', 'local', 'history', 'cache', 'queue', 'engine', 'pairing'] as const;
const events = ['start', 'finish', 'failure', 'retry', 'phase', 'file', 'warning', 'checkpoint', 'recovered'] as const;
export type LogScope = typeof scopes[number];
export type LogEvent = typeof events[number];
const tags = new Set(('automatic manual operation upload download sync recover resolve GET POST HEAD other '
  + 'connecting scanning-remote checking-remote scanning-local checking preparing-upload uploading verifying publishing downloading applying preview-ready completed paused failed '
  + 'queued running succeeded skipped unchanged conflict unconfirmed not-run prepared published applied publish apply '
  + 'account list prepare commit metadata refresh authorize stat exists mkdir readBinary writeBinary rename remove '
  + 'read-note conflict-copy apply-note apply-attachment create-note create-folder trash '
  + 'save-history load-history save-cache load-cache save-state load-state save-recovery queue-save queue-load audit settings credentials session closed startup plan device vault integrity verification activation '
  + 'listing reading validating saving-cache error cancelled timeout write-timeout rate network permission state start success failure pending markdown image pdf video audio binary internal preparing committing verified').split(' '));
const numbers = ['bytes', 'durationMs', 'status', 'apiCode', 'errno', 'attempt', 'waitMs', 'doneFiles', 'totalFiles', 'doneBytes', 'totalBytes',
  'concurrency', 'chunkConcurrency', 'fileLimitMiB', 'remotePollSeconds', 'journals', 'bases', 'knownOps', 'queued', 'active', 'pages', 'listed', 'cacheHits', 'read', 'retryAt', 'failures', 'pathLength', 'pathBytes', 'pathDepth', 'uploadedBytes', 'part', 'totalParts', 'completedParts', 'retryCount'] as const;
const tagFields = ['phase', 'action', 'outcome', 'endpoint', 'method', 'step', 'mode', 'fileKind'] as const;
const refFields = ['fileRef', 'connectionRef', 'operationRef', 'targetRef'] as const;
const idFields = ['taskId', 'historyId', 'requestId'] as const;
export interface LogFields {
  automaticEnabled?: boolean; deletionEnabled?: boolean; incremental?: boolean; remoteCheck?: boolean; fullCheck?: boolean;
  serviceRequestId?: string;
  pathLength?: number; pathBytes?: number; pathDepth?: number; fileKind?: string; targetRef?: string;
  uploadedBytes?: number; part?: number; totalParts?: number; completedParts?: number; retryCount?: number;
  taskId?: string; historyId?: string; requestId?: string; fileRef?: string; connectionRef?: string; operationRef?: string;
  phase?: string; action?: string; outcome?: string; endpoint?: string; method?: string; step?: string; mode?: string;
  bytes?: number; durationMs?: number; status?: number; apiCode?: number; errno?: number; attempt?: number; waitMs?: number;
  doneFiles?: number; totalFiles?: number; doneBytes?: number; totalBytes?: number; concurrency?: number; chunkConcurrency?: number;
  fileLimitMiB?: number; remotePollSeconds?: number; journals?: number; bases?: number; knownOps?: number; queued?: number; active?: number;
  pages?: number; listed?: number; cacheHits?: number; read?: number; retryAt?: number; failures?: number;
}
const errorCodes = new Set(('unknown state collision integrity changed recovery binding configuration permission authentication network timeout write-timeout '
  + 'rate http api response schema size path paused cancelled busy encoding not-found exists visibility credentials-id token-expired '
  + 'authorization_pending slow_down expired_token unsupported_response_type unsupported_grant_type invalid_grant access_denied invalid_client invalid_request oauth credentials '
  + 'EACCES EPERM EBUSY ENOENT ENOSPC EEXIST ENAMETOOLONG EIO EROFS EINVAL EISDIR ENOTDIR EMFILE ENFILE ETXTBSY ETIMEDOUT ECONNRESET ECONNREFUSED ENOTFOUND EAI_AGAIN ERR_NETWORK ERR_FAILED').split(' '));
for (const step of ['session', 'account', 'vault', 'listing', 'upload', 'download', 'integrity', 'credentials', 'settings', 'verification', 'activation']) errorCodes.add('pairing-' + step);
const errorNames = new Set(['Error', 'VaultSailError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'DOMException', 'NetworkError', 'QuotaExceededError', 'SecurityError', 'NotSupportedError']);
const syscalls = new Set(['open', 'read', 'write', 'rename', 'unlink', 'mkdir', 'stat', 'scandir', 'readFile', 'writeFile', 'connect', 'getaddrinfo']);
export interface ErrorDetail {
  name: string; code: string; signature: string; errno?: number; syscall?: string; retryable?: boolean; retryAfterMs?: number;
  frames: { source: 'vaultsail' | 'obsidian' | 'node' | 'runtime'; line: number; column: number }[];
}
export interface LogEnvironment { pluginVersion: string; obsidianVersion: string; platform: 'mobile' | 'desktop'; buildId?: string; }
function environment(value: LogEnvironment): LogEnvironment {
  const version = (v: string) => /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(v) ? v : 'unknown';
  return { pluginVersion: version(value.pluginVersion), obsidianVersion: version(value.obsidianVersion), platform: value.platform === 'mobile' ? 'mobile' : 'desktop',
    ...(typeof value.buildId === 'string' && /^(?:[a-f0-9]{40}(?:-dirty-[a-z0-9]{8,16})?|source|development)$/.test(value.buildId) ? { buildId: value.buildId } : {}) };
}
export interface DiagnosticRecord { version: 1; id: string; at: number; sequence: number; session: string; scope: LogScope; event: LogEvent; fields: LogFields; errors?: ErrorDetail[]; environment?: LogEnvironment; }
export interface DiagnosticStore { append(records: DiagnosticRecord[]): Promise<void>; read(): Promise<{ records: DiagnosticRecord[]; unreadable: number }>; }
function fields(value: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const key of ['automaticEnabled', 'deletionEnabled', 'incremental', 'remoteCheck', 'fullCheck'] as const) if (typeof value[key] === 'boolean') out[key] = value[key];
  if (typeof value.serviceRequestId === 'string' && /^\d{1,32}$/.test(value.serviceRequestId)) out.serviceRequestId = value.serviceRequestId;
  for (const key of numbers) if (Number.isSafeInteger(value[key]) && Math.abs(value[key]!) <= Number.MAX_SAFE_INTEGER) out[key] = value[key];
  for (const key of tagFields) if (typeof value[key] === 'string' && tags.has(value[key]!)) out[key] = value[key];
  for (const key of idFields) if (validId(value[key])) out[key] = value[key];
  for (const key of refFields) if (typeof value[key] === 'string' && /^[a-f0-9]{32}$/.test(value[key]!)) out[key] = value[key];
  return out;
}
function property(value: unknown, key: string): unknown {
  try { return value && (typeof value === 'object' || typeof value === 'function') ? Reflect.get(value, key) : undefined; } catch { return undefined; }
}
/** No raw message, URL, stack line, function name, body or native path is retained. */
export function errorDetails(error: unknown, salt: string): ErrorDetail[] {
  const seen = new Set<unknown>(), out: ErrorDetail[] = [];
  while (error != null && !seen.has(error) && out.length < 4) {
    seen.add(error);
    const name = property(error, 'name'), rawCode = property(error, 'code'), message = property(error, 'message'), stack = property(error, 'stack');
    const candidate = typeof rawCode === 'string' ? rawCode : typeof message === 'string' ? /^(?:Error: )?([A-Z_]+)\b/.exec(message)?.[1] : undefined;
    const errno = property(error, 'errno'), syscall = property(error, 'syscall'), retryable = property(error, 'retryable'), wait = property(error, 'retryAfter');
    const frames: ErrorDetail['frames'] = [];
    if (typeof stack === 'string') for (const line of stack.slice(0, 16000).split('\n').slice(1, 25)) {
      const position = /:(\d{1,9}):(\d{1,9})\)?\s*$/.exec(line); if (!position) continue;
      const source = /(?:plugin:vaultsail[:/]|vaultsail[\\/]main\.js:|obsidian-vaultsail[\\/]src[\\/])/.test(line) ? 'vaultsail'
        : /(?:app\.js|obsidian\.js)/.test(line) ? 'obsidian' : /node:/.test(line) ? 'node' : 'runtime';
      frames.push({ source, line: Number(position[1]), column: Number(position[2]) }); if (frames.length >= 8) break;
    }
    out.push({ name: typeof name === 'string' && errorNames.has(name) ? name : 'Error', code: candidate && errorCodes.has(candidate) ? candidate : 'unknown',
      signature: hash(bytes(salt + '|' + (typeof message === 'string' ? message.slice(0, 4000) : typeof error))).slice(0, 32), frames,
      ...(Number.isSafeInteger(errno) ? { errno: Number(errno) } : {}), ...(typeof syscall === 'string' && syscalls.has(syscall) ? { syscall } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}), ...(Number.isSafeInteger(wait) && Number(wait) >= 0 ? { retryAfterMs: Number(wait) } : {}) });
    error = property(error, 'cause');
  }
  if (!out.length) out.push({ name: 'Error', code: 'unknown', signature: hash(bytes(salt + '|unknown')).slice(0, 32), frames: [] });
  return out;
}
/** Reconstruct stored records using a whitelist too; a tampered log cannot inject private strings into exports. */
export function validateDiagnostic(value: unknown): DiagnosticRecord | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as DiagnosticRecord;
  if (v.version !== 1 || !validId(v.id) || !validId(v.session) || !Number.isSafeInteger(v.at) || v.at < 0 || !Number.isSafeInteger(v.sequence) || v.sequence < 1
    || !scopes.includes(v.scope) || !events.includes(v.event) || !v.fields || typeof v.fields !== 'object') return;
  const errors = Array.isArray(v.errors) ? v.errors.slice(0, 4).map(e => ({ name: errorNames.has(e?.name) ? e.name : 'Error', code: errorCodes.has(e?.code) ? e.code : 'unknown',
    signature: /^[a-f0-9]{32}$/.test(e?.signature) ? e.signature : '0'.repeat(32),
    frames: Array.isArray(e?.frames) ? e.frames.slice(0, 8).filter(f => ['vaultsail', 'obsidian', 'node', 'runtime'].includes(f?.source) && Number.isSafeInteger(f.line) && Number.isSafeInteger(f.column)).map(f => ({ source: f.source, line: f.line, column: f.column })) : [],
    ...(Number.isSafeInteger(e?.errno) ? { errno: e.errno } : {}), ...(syscalls.has(e?.syscall ?? '') ? { syscall: e.syscall } : {}),
    ...(typeof e?.retryable === 'boolean' ? { retryable: e.retryable } : {}), ...(Number.isSafeInteger(e?.retryAfterMs) && e.retryAfterMs! >= 0 ? { retryAfterMs: e.retryAfterMs } : {}) })) : undefined;
  return { version: 1, id: v.id, at: v.at, sequence: v.sequence, session: v.session, scope: v.scope, event: v.event, fields: fields(v.fields), ...(errors?.length ? { errors } : {}),
    ...(v.environment && typeof v.environment === 'object' ? { environment: environment(v.environment) } : {}) };
}

export class DiagnosticLog {
  readonly session = uuid(); private salt: string; private store: DiagnosticStore; private now: () => number;
  private recent: DiagnosticRecord[] = []; private pending: DiagnosticRecord[] = []; private currentTask?: string; private sequence = 0;
  private tasks = new Map<string, LogFields>();
  private timer?: ReturnType<typeof setTimeout>; private saving?: Promise<void>; private closed = false;
  private env?: LogEnvironment;
  storageFailed = false; dropped = 0; lastErrorId?: string;
  private storageError?: ErrorDetail[];
  constructor(store: DiagnosticStore, salt = uuid(), now = () => Date.now(), env?: LogEnvironment) { this.store = store; this.salt = salt; this.now = now; this.env = env; }
  ref(value: string): string { return hash(bytes(this.salt + '|' + value)).slice(0, 32); }
  file(path: string): LogFields {
    const kind = path.startsWith('.vaultsail-state/') ? 'internal' : /\.md$/i.test(path) ? 'markdown' : /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(path) ? 'image'
      : /\.pdf$/i.test(path) ? 'pdf' : /\.(mp4|mov|mkv|webm)$/i.test(path) ? 'video' : /\.(mp3|m4a|wav|ogg)$/i.test(path) ? 'audio' : 'binary';
    return { fileRef: this.ref(path), fileKind: kind, pathLength: path.length, pathBytes: bytes(path).byteLength, pathDepth: path.split('/').length };
  }
  context(): LogFields { return this.currentTask ? { ...this.tasks.get(this.currentTask), taskId: this.currentTask } : {}; }
  start(mode: 'manual' | 'automatic' | 'operation', values: LogFields = {}): string {
    const id = uuid(); this.currentTask = id; this.tasks.set(id, fields({ ...values, taskId: id, mode }));
    while (this.tasks.size > 32) this.tasks.delete(this.tasks.keys().next().value!);
    this.record('task', 'start', { ...values, taskId: id, mode }); return id;
  }
  end(taskId: string, outcome: 'success' | 'failure' | 'cancelled'): void {
    this.record('task', 'finish', { taskId, outcome }); if (this.currentTask === taskId) this.currentTask = undefined; void this.flush();
  }
  record(scope: LogScope, event: LogEvent, values: LogFields = {}, error?: unknown): string | undefined {
    if (this.closed) return;
    try {
      const taskId = Object.hasOwn(values, 'taskId') ? values.taskId : this.currentTask;
      const context = taskId ? this.tasks.get(taskId) ?? { taskId } : {};
      const detail = fields({ ...context, ...values });
      if (scope === 'task' && event === 'checkpoint' && taskId) this.tasks.set(taskId, { ...context, ...detail });
      const item: DiagnosticRecord = { version: 1, id: uuid(), at: this.now(), sequence: ++this.sequence, session: this.session, scope, event,
        fields: detail, ...(error !== undefined ? { errors: errorDetails(error, this.salt) } : {}), ...(this.env ? { environment: environment(this.env) } : {}) };
      this.recent.push(item); if (this.recent.length > LOG_MEMORY_LIMIT) this.recent.shift();
      this.pending.push(item); if (this.pending.length > LOG_PENDING_LIMIT) { this.pending.shift(); this.dropped++; }
      if (event === 'failure') { this.lastErrorId = item.id; void this.flush(); }
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 2000);
      return item.id;
    } catch { this.dropped++; return undefined; }
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.pending.length) {
        const batch = this.pending.slice(0, LOG_BATCH_LIMIT);
        try { await this.store.append(batch); this.storageFailed = false; this.storageError = undefined; }
        catch (error) { this.storageFailed = true; this.storageError = errorDetails(error, this.salt); break; } // Never recursively log a failure of logging itself.
        const saved = new Set(batch.map(item => item.id)); this.pending = this.pending.filter(item => !saved.has(item.id));
      }
    })();
    try { await this.saving; } finally { this.saving = undefined; if (this.pending.length && !this.storageFailed) void this.flush(); }
  }
  async report(currentEnvironment: LogEnvironment): Promise<string> {
    await this.flush(); let stored: DiagnosticRecord[] = [], unreadable = 0;
    try { const result = await this.store.read(); stored = result.records; unreadable = result.unreadable; } catch (error) { this.storageFailed = true; this.storageError = errorDetails(error, this.salt); unreadable++; }
    const merged = new Map([...stored, ...this.recent].map(item => [item.id, item]));
    const records = [...merged.values()].map(validateDiagnostic).filter((v): v is DiagnosticRecord => !!v).sort((a, b) => a.at - b.at || a.session.localeCompare(b.session) || a.sequence - b.sequence).slice(-2000);
    const payload = { format: 'vaultsail-diagnostics', version: 1,
      environment: environment(currentEnvironment),
      generatedAt: this.now(), storageFailed: this.storageFailed, storageError: this.storageError ?? null, pending: this.pending.length, dropped: this.dropped, unreadableSegments: unreadable,
      lastErrorId: this.lastErrorId ?? records.filter(item => item.event === 'failure').at(-1)?.id ?? null, reportTruncated: 0, records };
    let text = JSON.stringify(payload, null, 2);
    while (bytes(text).byteLength > 8 * 1024 * 1024 && payload.records.length > 1) {
      const count = Math.max(1, Math.floor(payload.records.length / 4)); payload.records.splice(0, count); payload.reportTruncated += count; text = JSON.stringify(payload, null, 2);
    }
    return text;
  }
  close(): void { this.record('plugin', 'finish', { outcome: 'closed' }); this.closed = true; void this.flush(); }
}
const logs = new WeakMap<object, DiagnosticLog>();
export function diagnosticLog(owner: object): DiagnosticLog | undefined { return logs.get(owner); }
export function attachDiagnosticLog(owner: object, log: DiagnosticLog): void { logs.set(owner, log); }
