import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestPool } from '../src/core/request-pool.ts';
import { request, type HttpTransport, type HttpResponse } from '../src/providers/http.ts';
import { VaultSailError } from '../src/core/safety.ts';

test('timed out native requests retain leases across reload; aborted or expired queue entries never dispatch', async () => {
  const first = await import('../src/platform/request-pools.ts?before-reload');
  const second = await import('../src/platform/request-pools.ts?after-reload');
  const app = {}, pool = first.requestPools(app).requests; pool.configure(1);
  let releaseNative!: (response: HttpResponse) => void, calls = 0, nativeSettled = Promise.resolve();
  const response = { status: 200, headers: {}, bytes: new ArrayBuffer(0) };
  const transport: HttpTransport = Object.assign(async () => { calls++; if (calls === 1) return new Promise<HttpResponse>(resolve => { releaseNative = resolve; }); return response; },
    { reserve: (_input: unknown, policy: any) => pool.acquire(policy.signal, policy.timeoutMs) });
  await assert.rejects(request(transport, { url: 'https://example.invalid/', method: 'POST' }, false, { timeoutMs: 15, onPending: settled => { nativeSettled = settled; } }), { code: 'write-timeout' });
  assert.equal(second.requestPools(app).requests, pool); assert.equal(pool.snapshot().active, 1);
  const controller = new AbortController();
  const cancelled = request(transport, { url: 'https://example.invalid/' }, false, { signal: controller.signal, timeoutMs: 100 });
  const rejected = assert.rejects(cancelled, { code: 'cancelled' }); assert.equal(pool.snapshot().waiting, 1); controller.abort(); await rejected;
  await assert.rejects(request(transport, { url: 'https://example.invalid/' }, false, { timeoutMs: 15 }), error => (error as any).code === 'timeout' && /尚未发送/.test((error as Error).message));
  assert.equal(calls, 1); releaseNative(response); await nativeSettled; assert.equal(pool.snapshot().active, 0);
  await request(transport, { url: 'https://example.invalid/' }); assert.equal(calls, 2); assert.equal(pool.snapshot().active, 0);
});
test('FIFO request budgets respect shrinkage, idempotent release and shared cooldown', async () => {
  const pool = new RequestPool(2), a = await pool.acquire(), b = await pool.acquire(); pool.configure(1);
  let started = false; const c = pool.acquire().then(release => { started = true; return release; });
  a(); a(); await Promise.resolve(); assert.equal(started, false); b(); const release = await c; release();
  const until = Date.now() + 40; pool.cooldown(until);
  const admitted = await pool.acquire(); assert.ok(Date.now() >= until); admitted(); assert.equal(pool.snapshot().active, 0);
});
test('a pause while queued is checked again at admission and never sends a late request', async () => {
  const pool = new RequestPool(1), held = await pool.acquire(); let calls = 0, active = true;
  const transport: HttpTransport = Object.assign(async () => { calls++; return { status: 200, headers: {}, bytes: new ArrayBuffer(0) }; },
    { reserve: (_input: unknown, policy: any) => pool.acquire(policy.signal, policy.timeoutMs) });
  const pending = request(transport, { url: 'https://example.invalid/' }, false, { beforeStart: () => { if (!active) throw new VaultSailError('cancelled', '任务已暂停。'); } });
  const rejected = assert.rejects(pending, { code: 'cancelled' }); active = false; held(); await rejected;
  assert.equal(calls, 0); assert.equal(pool.snapshot().active, 0);
});
test('HTTP throttling starts the shared cooldown before the next queued request is admitted', async () => {
  const pool = new RequestPool(1); let calls = 0, releaseNative!: () => void, endedAt = 0;
  const gate = new Promise<void>(resolve => { releaseNative = resolve; });
  const transport: HttpTransport = Object.assign(async () => {
    calls++; if (calls === 1) { await gate; endedAt = Date.now(); return { status: 429, headers: {}, bytes: new ArrayBuffer(0) }; }
    assert.ok(Date.now() - endedAt >= 990); return { status: 200, headers: {}, bytes: new ArrayBuffer(0) };
  }, { reserve: (_input: unknown, policy: any) => pool.acquire(policy.signal, policy.timeoutMs), cooldown: (until: number) => pool.cooldown(until) });
  const first = assert.rejects(request(transport, { url: 'https://example.invalid/' }), { code: 'rate' });
  await new Promise(resolve => setTimeout(resolve, 1));
  const next = request(transport, { url: 'https://example.invalid/' }); releaseNative(); await Promise.all([first, next]); assert.equal(calls, 2);
});
