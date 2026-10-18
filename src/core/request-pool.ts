import { VaultSailError } from './safety.ts';
import { validConcurrency } from './concurrency.ts';

interface Waiter { start(): void; cancel(error: Error): void; }
/** FIFO admission. A caller must retain its lease until the underlying operation actually settles. */
export class RequestPool {
  private limit: number; private active = 0; private waiting: Waiter[] = [];
  private notBefore = 0; private wake?: ReturnType<typeof setTimeout>;
  constructor(limit: number) { if (!validConcurrency(limit)) throw new RangeError('Invalid request limit'); this.limit = limit; }
  configure(limit: number): void { if (!validConcurrency(limit)) throw new RangeError('Invalid request limit'); this.limit = limit; this.pump(); }
  snapshot(): { active: number; waiting: number; limit: number } { return { active: this.active, waiting: this.waiting.length, limit: this.limit }; }
  cooldown(until: number): void { this.notBefore = Math.max(this.notBefore, until); this.pump(); }
  private lease(): () => void { this.active++; let released = false; return () => { if (!released) { released = true; this.active--; this.pump(); } }; }
  private pump(): void {
    if (this.wake) clearTimeout(this.wake); this.wake = undefined;
    if (this.waiting.length && Date.now() < this.notBefore) { this.wake = setTimeout(() => this.pump(), Math.min(2147483647, this.notBefore - Date.now())); return; }
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start();
  }
  acquire(signal?: AbortSignal, timeoutMs = 30000, onWait?: () => void): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new VaultSailError('cancelled', '等待请求已取消。'));
    if (!this.waiting.length && this.active < this.limit && Date.now() >= this.notBefore) return Promise.resolve(this.lease());
    return new Promise((resolve, reject) => {
      let done = false; let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const waiter: Waiter = {
        start: () => { if (!done) { done = true; cleanup(); resolve(this.lease()); } },
        cancel: error => { if (!done) { done = true; cleanup(); const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); reject(error); this.pump(); } },
      };
      const abort = () => waiter.cancel(new VaultSailError('cancelled', '等待请求已取消。'));
      this.waiting.push(waiter);
      timer = setTimeout(() => waiter.cancel(new VaultSailError('timeout', '等待网络请求空位超时，本次请求尚未发送。', true)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      try { onWait?.(); } catch { /* Display callbacks cannot affect admission. */ }
      this.pump();
    });
  }
}
