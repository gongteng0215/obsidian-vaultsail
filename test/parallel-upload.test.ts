import assert from 'node:assert/strict';
import test from 'node:test';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { RequestPool } from '../src/core/request-pool.ts';
import { hash } from '../src/core/safety.ts';
import { baiduHarness } from './fixtures/baidu.ts';
import type { ObjectTransferProgress } from '../src/providers/cloud-storage-provider.ts';
import type { HttpTransport, RequestPolicy, HttpRequest } from '../src/providers/http.ts';
const tick = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean) => { for (let n = 0; n < 300 && !predicate(); n++) await tick(); assert.ok(predicate(), 'operation must reach the expected state'); };

test('two slices really overlap, out-of-order tails count exactly, and final commit waits for every slice', async t => {
  const h = baiduHarness(), data = new Uint8Array(8 * 1024 * 1024 + 7); data.fill(19);
  let releaseFirst!: () => void, releaseSecond!: () => void, active = 0, peak = 0;
  const gates = [new Promise<void>(resolve => { releaseFirst = resolve; }), new Promise<void>(resolve => { releaseSecond = resolve; })];
  t.after(() => { releaseFirst(); releaseSecond(); }); const events: ObjectTransferProgress[] = [];
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const query = new URL(input.url).searchParams;
    if (query.get('method') !== 'upload') return h.transport(input);
    active++; peak = Math.max(peak, active);
    try { const part = Number(query.get('partseq')); if (part < 2) await gates[part]; return await h.transport(input); } finally { active--; }
  }, { accessToken: async () => 'private-access' }, undefined, undefined, { chunkConcurrency: 2 });
  const operation = provider.writeImmutable('parallel/video.mp4', data.buffer, event => events.push(event));
  await waitFor(() => active === 2); assert.equal(peak, 2); assert.deepEqual(events.at(-1)!.activeParts, [1, 2]); releaseSecond();
  await waitFor(() => events.at(-1)!.completedParts === 2);
  assert.equal(events.at(-1)!.uploadedBytes, 4 * 1024 * 1024 + 7); assert.equal(h.counts().createCalls, 0);
  releaseFirst(); await operation; assert.equal(h.counts().createCalls, 1); assert.equal(events.at(-1)!.uploadedBytes, data.byteLength);
  assert.equal(hash(await provider.read('parallel/video.mp4')), hash(data.buffer));
});

test('shared network and multipart budgets bound multiple providers before allocating request bodies', async () => {
  const h = baiduHarness(), network = new RequestPool(2), bodies = new RequestPool(1); let active = 0, peak = 0, uploads = 0, uploadPeak = 0;
  const transport: HttpTransport = Object.assign(async (input: HttpRequest) => {
    active++; peak = Math.max(peak, active); const slice = new URL(input.url).searchParams.get('method') === 'upload';
    if (slice) { uploads++; uploadPeak = Math.max(uploadPeak, uploads); }
    try { if (slice) await tick(10); return await h.transport(input); } finally { active--; if (slice) uploads--; }
  }, { reserve: (_input: HttpRequest, policy: RequestPolicy) => network.acquire(policy.signal, policy.timeoutMs) });
  const make = () => new BaiduProvider('/apps/中文应用', transport, { accessToken: async () => 'private-access' }, undefined, undefined, { chunkConcurrency: 4, uploadSlots: bodies });
  const data = new Uint8Array(4 * 1024 * 1024 + 1); data.fill(7);
  await Promise.all([make().writeImmutable('shared/a.bin', data.buffer), make().writeImmutable('shared/b.bin', data.buffer)]);
  assert.ok(peak <= 2); assert.equal(uploadPeak, 1); assert.equal(bodies.snapshot().active, 0); assert.equal(network.snapshot().active, 0); assert.equal(h.counts().createCalls, 2);
});

test('slice timeout or disconnect retains body credits and drains native requests before the file returns', async t => {
  for (const fault of ['timeout', 'disconnect'] as const) {
    const h = baiduHarness(), bodies = new RequestPool(2), controller = new AbortController(); let active = 0, release!: () => void, returned = false;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release()); const events: ObjectTransferProgress[] = [];
    const provider = new BaiduProvider('/apps/中文应用', async input => {
      if (new URL(input.url).searchParams.get('method') === 'upload') { active++; await gate; }
      return h.transport(input);
    }, { accessToken: async () => 'private-access' }, undefined, undefined, { chunkConcurrency: 2, uploadSlots: bodies, transferTimeoutMs: 15, signal: controller.signal });
    const operation = provider.writeImmutable('pending/video.mp4', new ArrayBuffer(4 * 1024 * 1024 + 1), event => events.push(event));
    const rejected = assert.rejects(operation, { code: fault === 'timeout' ? 'write-timeout' : 'cancelled' }).then(() => { returned = true; });
    await waitFor(() => active === 2); if (fault === 'disconnect') controller.abort(); await tick(30);
    assert.equal(returned, false); assert.equal(bodies.snapshot().active, 2); assert.ok(events.some(event => event.requestPending)); assert.equal(h.counts().createCalls, 0);
    release(); await rejected; assert.equal(bodies.snapshot().active, 0); assert.equal(h.counts().createCalls, 0);
  }
});

test('create throttling retries the existing session without sending successful slices again', async () => {
  const h = baiduHarness(); let throttled = false, slices = 0;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const method = new URL(input.url).searchParams.get('method'); if (method === 'upload') slices++;
    if (method === 'create' && new URLSearchParams(String(input.body)).get('isdir') === '0' && !throttled) { throttled = true; return { status: 429, headers: {}, bytes: new ArrayBuffer(0) }; }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' }, undefined, undefined, { chunkConcurrency: 2 });
  await provider.writeImmutable('commit/video.mp4', new ArrayBuffer(4 * 1024 * 1024 + 1));
  assert.equal(h.uploads.size, 1); assert.equal(slices, 2); assert.equal(h.counts().createCalls, 1);
});

test('a timed-out slice stops new sibling work before its native request finishes', async t => {
  const h = baiduHarness(); let releaseNative!: () => void, releaseSibling!: () => void, sessionReady = false, sliceTokens = 0;
  const native = new Promise<void>(resolve => { releaseNative = resolve; });
  const sibling = new Promise<void>(resolve => { releaseSibling = resolve; });
  t.after(() => { releaseNative(); releaseSibling(); });
  const calls: number[] = [], events: ObjectTransferProgress[] = [];
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const query = new URL(input.url).searchParams;
    if (query.get('method') === 'precreate') sessionReady = true;
    if (query.get('method') === 'upload') {
      const part = Number(query.get('partseq')); calls.push(part);
      if (part === 0) await native; else if (part === 1) await sibling;
    }
    return h.transport(input);
  }, { accessToken: async () => { if (sessionReady && ++sliceTokens === 2) await tick(20); return 'private-access'; } }, undefined, undefined, { chunkConcurrency: 2, transferTimeoutMs: 30 });
  const operation = provider.writeImmutable('stop/video.mp4', new ArrayBuffer(8 * 1024 * 1024 + 1), event => events.push(event));
  const rejected = assert.rejects(operation, { code: 'write-timeout' });
  await waitFor(() => calls.length === 2); await waitFor(() => events.some(event => event.requestPending));
  releaseSibling(); await tick(10);
  assert.deepEqual(calls, [0, 1], 'a completed sibling must not start the next slice while failure is draining');
  releaseNative(); await rejected; assert.equal(h.counts().createCalls, 0);
});
test('exhausted slice retries stop the session without reuploading acknowledged parts', async () => {
  const h = baiduHarness(), calls = [0, 0];
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const query = new URL(input.url).searchParams;
    if (query.get('method') === 'upload') { const index = Number(query.get('partseq')); calls[index]++;
      if (index === 1) return { status: 429, headers: {}, bytes: new ArrayBuffer(0) }; }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' });
  await assert.rejects(provider.writeImmutable('failure/video.mp4', new ArrayBuffer(4 * 1024 * 1024 + 1)), error => (error as any).code === 'rate' && !(error as any).retryable);
  assert.deepEqual(calls, [1, 4]); assert.equal(h.uploads.size, 1); assert.equal(h.counts().createCalls, 0);
});
