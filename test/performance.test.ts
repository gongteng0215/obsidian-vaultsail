import assert from 'node:assert/strict';
import test from 'node:test';
import { TransferPerformance, formatPerformance } from '../src/sync/performance.ts';
import { bytes } from '../src/core/safety.ts';
import type { HttpResponse } from '../src/providers/http.ts';
import { AuthManager } from '../src/auth/auth-manager.ts';
import { scanSummary, validateScanSummary, formatScanSummary } from '../src/sync/scan-summary.ts';

test('directory and request summaries remain separate, optional fields fail independently and no arbitrary content survives', async () => {
  const trace = new TransferPerformance(); trace.begin();
  trace.scan({ listed: 7, cacheHits: 6, read: 1, missingFingerprints: 0 });
  trace.scan({ listed: 10, cacheHits: 9, read: 1, missingFingerprints: 1 }, true);
  await trace.transport(async () => ({ ...response(), json: { errno: -6, errmsg: 'private-secret' } }), { url: 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=private-secret' });
  const summary = scanSummary(trace.snapshot(), '0.2.22', false, 'automatic')!;
  assert.equal(summary.listed, 7); assert.equal(summary.directories!.listed, 10); assert.equal(summary.requests!.list!.failed, 1); assert.equal(summary.taskType, 'automatic');
  assert.equal(JSON.stringify(summary).includes('private'), false);
  const bad = validateScanSummary({ ...summary, requests: { list: { ...summary.requests!.list!, path: 'private' }, download: { count: NaN } }, directories: { scans: -1 }, taskType: 'private' })!;
  assert.equal(bad.directories, undefined); assert.equal(bad.taskType, undefined); assert.equal(bad.requests!.download, undefined); assert.equal(JSON.stringify(bad).includes('private'), false);
  const legacy = { ...summary }; delete legacy.directories; delete legacy.requests; delete legacy.taskType;
  assert.ok(validateScanSummary(legacy)); assert.match(formatScanSummary(legacy), /目录记录：未记录/); assert.match(formatScanSummary(legacy), /请求分类：未记录/);
  const snapshot = trace.snapshot()!; snapshot.directories!.listed = 999; assert.equal(trace.snapshot()!.directories!.listed, 10);
});

const response = (): HttpResponse => ({ status: 200, headers: {}, bytes: bytes('private-response') });
test('transfer timing separates wall stages from overlapping requests and counts refreshes without retaining private data', async () => {
  let now = 0; const trace = new TransferPerformance(() => now); trace.begin(); trace.phase('connecting');
  now = 100; trace.phase('scanning-remote');
  let finish!: (value: HttpResponse) => void;
  const pending = trace.transport(() => new Promise(resolve => { finish = resolve; }), { url: 'https://d.pcs.baidu.com/private-note?access_token=private-token' });
  now = 150;
  await trace.transport(async () => { now = 250; return response(); }, {
    url: 'https://openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token&client_secret=private-secret&refresh_token=private-refresh', body: 'private-body',
  });
  now = 300; trace.phase('scanning-local');
  now = 400; trace.phase('uploading'); now = 500; finish(response()); await pending;
  now = 600; trace.phase('completed'); trace.finish();
  const report = trace.snapshot()!;
  assert.equal(report.elapsedMs, 600); assert.deepEqual(report.stages, { connecting: 100, remote: 200, local: 100, transfer: 200 });
  assert.equal(report.requests.download?.elapsedMs, 400); assert.equal(report.requests.refresh?.elapsedMs, 100);
  assert.equal(report.requestCount, 2); assert.equal(report.refreshCount, 1);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.match(formatPerformance(report), /网络请求 2 次 · 令牌刷新 1 次/);
  now = 9000; assert.deepEqual(trace.snapshot(), report);
});

test('ordinary token reuse issues zero authorization requests; eight concurrent refresh callers produce one measured refresh', async () => {
  const trace = new TransferPerformance(); const values = new Map([['secret', 'private-secret']]);
  const auth = new AuthManager(input => trace.transport(async () => ({ ...response(), json: {
    access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'netdisk',
  } }), input), { get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: key => { values.delete(key); } },
  () => ({ appKey: 'private-app', secretRef: 'secret', sessionRef: 'session' }));
  auth.restoreSession({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 });
  trace.begin(); await Promise.all(Array.from({ length: 8 }, () => auth.accessToken()));
  assert.equal(trace.snapshot()!.requestCount, 0);
  auth.restoreSession({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: 1 });
  await Promise.all(Array.from({ length: 8 }, () => auth.accessToken()));
  trace.retry(1250); trace.finish(); const report = trace.snapshot()!;
  assert.equal(report.requestCount, 1); assert.equal(report.refreshCount, 1);
  assert.equal(report.retryCount, 1); assert.equal(report.retryWaitMs, 1250);
  assert.match(formatPerformance(report), /失败\/限流等待 1 次（累计 1.3 秒）/);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('cache hit reporting accumulates scans without retaining version paths and resets for a new transfer', () => {
  const trace = new TransferPerformance(); trace.begin();
  trace.scan({ listed: 7, cacheHits: 0, read: 7, missingFingerprints: 0 });
  trace.scan({ listed: 7, cacheHits: 7, read: 0, missingFingerprints: 0 });
  assert.equal(trace.snapshot()!.scans, 2); assert.match(formatPerformance(trace.snapshot()), /版本缓存命中 7\/14 条 · 实际读取 7 条/);
  trace.finish(); trace.scan({ listed: 100, cacheHits: 0, read: 100, missingFingerprints: 100 }); assert.equal(trace.snapshot()!.scans, 2);
  trace.begin(); assert.equal(trace.snapshot()!.versions.listed, 0);
});

test('failed and pending native requests remain safe and late completions cannot alter frozen reports or the next transfer', async () => {
  let now = 0; const trace = new TransferPerformance(() => now); trace.begin(); trace.phase('uploading');
  let finish!: (value: HttpResponse) => void;
  const pending = trace.transport(() => new Promise(resolve => { finish = resolve; }), { url: 'https://d.pcs.baidu.com/private' });
  now = 100;
  await assert.rejects(trace.transport(async () => { now = 200; throw new Error('private-secret'); }, { url: 'https://pan.baidu.com/rest/2.0/xpan/file?method=list' }));
  trace.finish(); const report = trace.snapshot()!;
  assert.equal(report.requests.list?.failed, 1); assert.equal(report.requests.download?.pending, 1);
  assert.equal(report.requests.download?.elapsedMs, 200); assert.equal(JSON.stringify(report).includes('private'), false);
  now = 400; trace.begin(); trace.phase('connecting'); now = 450; finish(response()); await pending;
  assert.equal(trace.snapshot()!.requestCount, 0); assert.equal(trace.snapshot()!.elapsedMs, 50);
  assert.equal(report.requests.download?.pending, 1);
});

test('terminal phases between sync passes do not double count stages or reset the request report', async () => {
  let now = 0; const trace = new TransferPerformance(() => now); trace.begin(); trace.phase('scanning-remote');
  now = 50; trace.phase('completed'); now = 60; trace.phase('scanning-remote');
  now = 100; trace.finish();
  assert.equal(trace.snapshot()!.stages.remote, 90); assert.equal(trace.snapshot()!.elapsedMs, 100);
  trace.begin(); assert.equal(trace.snapshot()!.elapsedMs, 0);
});
