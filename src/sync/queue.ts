import { included, relativePath, VaultSailError } from '../core/safety.ts';
export interface QueueBatch { paths: string[]; remote: boolean; full: boolean; manual: boolean; }
export interface QueueState { version: 1; sequence: number; dirty: Record<string, number>; remote: number; full: number; manual: number; paused: boolean; retryAt: number; failures: number; blocked: boolean; }
export interface QueueOptions {
  load(): unknown; save(state: QueueState): void; run(batch: QueueBatch): Promise<void>; canRun(): boolean; enabled(): boolean; pollMs(): number;
  change?(): void; now?: () => number; random?: () => number; timer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear?: (id: ReturnType<typeof setTimeout>) => void;
}
const empty = (): QueueState => ({ version: 1, sequence: 0, dirty: Object.create(null), remote: 0, full: 0, manual: 0, paused: false, retryAt: 0, failures: 0, blocked: false });
export class SyncQueue {
  get activity(): 'idle' | 'queued' | 'running' {
    if (this.disposed) return 'idle';
    if (this.running) return 'running';
    return !this.state.paused && !this.blocked && this.pending() && (this.options.enabled() || this.state.manual > 0) ? 'queued' : 'idle';
  }
  private options: QueueOptions; private state = empty(); private timer?: ReturnType<typeof setTimeout>;
  private running = false; private disposed = false; private suspended = false; private first = 0; private last = 0;
  private remoteDue = 0; private fullDue = 0; private retryAt = 0; private failures = 0; private blocked = false;
  constructor(options: QueueOptions) {
    this.options = options;
    try {
      const raw = options.load() as QueueState;
      if (raw?.version === 1 && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 && raw.sequence < 1e12 && typeof raw.dirty === 'object' && raw.dirty && !Array.isArray(raw.dirty)
        && Object.keys(raw.dirty).length <= 2000 && ['remote', 'full', 'manual'].every(key => Number.isSafeInteger(raw[key as 'remote']) && raw[key as 'remote'] >= 0 && raw[key as 'remote'] <= raw.sequence)
        && Object.entries(raw.dirty).every(([path, value]) => relativePath(path) && included(path) && Number.isSafeInteger(value) && value > 0 && value <= raw.sequence))
        this.state = { ...raw, dirty: Object.assign(Object.create(null), raw.dirty), paused: raw.paused === true,
          retryAt: Number.isSafeInteger(raw.retryAt) && raw.retryAt >= 0 ? raw.retryAt : 0,
          failures: Number.isSafeInteger(raw.failures) && raw.failures >= 0 ? raw.failures : 0, blocked: raw.blocked === true };
    } catch { /* Startup's full reconciliation covers invalid pending state. */ }
    this.retryAt = this.state.retryAt; this.failures = this.state.failures; this.blocked = this.state.blocked;
    this.resetDue();
    if (options.enabled()) this.request('full');
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private resetDue(): void { const now = this.now(); this.remoteDue = now + this.options.pollMs() * (1 + (this.options.random?.() ?? Math.random()) * .1); this.fullDue = now + 600_000; }
  private notify(): void {
    try { this.options.save({ ...this.state, dirty: { ...this.state.dirty }, retryAt: this.retryAt, failures: this.failures, blocked: this.blocked }); } catch { this.blocked = true; }
    try { this.options.change?.(); } catch { /* A detached view cannot affect scheduling. */ }
  }
  request(reason: 'local' | 'remote' | 'full' | 'manual', path?: string): void {
    if (this.disposed || (!this.options.enabled() && reason !== 'manual')) return;
    if (reason === 'local' && path) { try { relativePath(path); if (!included(path)) return; } catch { return; } }
    const now = this.now(), hadPending = this.pending(); const sequence = ++this.state.sequence;
    if (reason === 'local' && path && Object.keys(this.state.dirty).length < 2000) this.state.dirty[path] = sequence;
    else if (reason === 'local') this.state.full = sequence;
    else this.state[reason] = sequence;
    if (!hadPending) this.first = now; this.last = now;
    if (reason === 'manual') { this.state.paused = false; this.blocked = false; this.retryAt = 0; this.failures = 0; }
    this.notify(); this.arm();
  }
  private pending(): boolean { return !!(this.state.remote || this.state.full || this.state.manual || Object.keys(this.state.dirty).length); }
  private arm(): void {
    if (this.timer) (this.options.clear ?? clearTimeout)(this.timer); this.timer = undefined;
    if (this.disposed || this.running || this.state.paused || this.suspended || this.blocked) return;
    if (!this.options.enabled() && !this.state.manual) return;
    const now = this.now();
    let due = Math.min(this.remoteDue, this.fullDue);
    if (this.pending()) due = this.state.manual || this.state.remote || this.state.full ? now : Math.min(this.last + 2000, this.first + 15000);
    due = Math.max(due, this.retryAt);
    this.timer = (this.options.timer ?? setTimeout)(() => { this.timer = undefined; void this.pump(); }, Math.max(25, Math.min(60_000, due - now)));
  }
  async pump(): Promise<void> {
    if (this.disposed || this.running || this.state.paused || this.suspended || this.blocked || (!this.options.enabled() && !this.state.manual)) return;
    const now = this.now();
    if (this.options.enabled() && now >= this.fullDue) { this.state.full = ++this.state.sequence; this.fullDue = now + 600_000; }
    if (this.options.enabled() && now >= this.remoteDue) { this.state.remote = ++this.state.sequence; this.remoteDue = now + this.options.pollMs(); }
    if (!this.pending() || now < this.retryAt || (!this.state.manual && !this.state.remote && !this.state.full && now < Math.min(this.last + 2000, this.first + 15000))) { this.arm(); return; }
    if (!this.options.canRun()) { this.retryAt = now + 500; this.arm(); return; }
    const captured = structuredClone(this.state); this.running = true; this.notify();
    try {
      await this.options.run({ paths: Object.keys(captured.dirty), remote: !!captured.remote, full: !!captured.full, manual: !!captured.manual });
      for (const [path, sequence] of Object.entries(captured.dirty)) if (this.state.dirty[path] === sequence) delete this.state.dirty[path];
      for (const key of ['remote', 'full', 'manual'] as const) if (this.state[key] === captured[key]) this.state[key] = 0;
      if (captured.full) this.fullDue = this.now() + 600_000;
      this.failures = 0; this.retryAt = 0;
    } catch (error) {
      if (error instanceof VaultSailError && ['network', 'timeout', 'rate', 'busy', 'changed'].includes(error.code)) {
        this.failures++; this.retryAt = this.now() + Math.max(error.retryAfter, Math.min(300_000, 5000 * 2 ** Math.min(this.failures - 1, 6))) * (1 + (this.options.random?.() ?? Math.random()) * .2);
      } else if (error instanceof VaultSailError && ['paused', 'cancelled'].includes(error.code)) {
        // Explicit pauses are recorded by pause(). A background pause whose
        // request drains after foreground resume must not become a user pause.
        if (!this.suspended && !this.state.paused) this.retryAt = this.now() + 1000;
      }
      else this.blocked = true;
    } finally {
      this.running = false; this.remoteDue = this.now() + this.options.pollMs() * (1 + (this.options.random?.() ?? Math.random()) * .1);
      if (!this.disposed) { this.notify(); this.arm(); }
    }
  }
  pause(): void { this.state.paused = true; this.notify(); this.arm(); }
  suspend(value: boolean): void { this.suspended = value; if (!value && this.options.enabled()) this.request('full'); this.arm(); }
  dispose(): void { this.disposed = true; if (this.timer) (this.options.clear ?? clearTimeout)(this.timer); this.timer = undefined; }
  summary(): string {
    return this.state.paused ? '自动任务已暂停，点击立即同步继续。' : this.suspended ? '应用在后台，待办已保留。' : this.blocked ? '自动任务已停止，请查看错误或恢复未完成任务。'
      : this.running ? `队列执行中 · 已记录 ${Object.keys(this.state.dirty).length} 个路径` : this.retryAt > this.now() ? '等待网络或限流重试，待办已保留。'
        : this.pending() ? `等待检查 ${Object.keys(this.state.dirty).length} 个路径` : '等待文件变化或远端检查。';
  }
}
