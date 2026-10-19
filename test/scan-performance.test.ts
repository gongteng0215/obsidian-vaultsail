import assert from 'node:assert/strict';
import test from 'node:test';
import { baiduHarness } from './fixtures/baidu.ts';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { RemoteVaultStore, type RevisionScanProgress } from '../src/sync/remote-vault.ts';
import { bytes, hash, jsonBytes, uuid } from '../src/core/safety.ts';
import { scanSummary, validateScanSummary } from '../src/sync/scan-summary.ts';
import { TransferPerformance } from '../src/sync/performance.ts';
import { validateHistory } from '../src/sync/history.ts';

function seed(count = 7, devices = 1) {
  const h = baiduHarness(), vaultId = uuid(), deviceIds = Array.from({ length: devices }, () => uuid()), base = `vaultsail/vaults/${vaultId}`;
  const put = (path: string, data: ArrayBuffer) => {
    const full = '/apps/中文应用/' + path, parts = full.split('/'); for (let i = 3; i < parts.length; i++) h.dirs.add(parts.slice(0, i).join('/'));
    h.files.set(full, data); if (!h.ids.has(full)) h.ids.set(full, String(h.ids.size + 1)); return full;
  };
  put(base + '/vault.json', jsonBytes({ schemaVersion: 1, vaultId, displayName: 'test', createdAt: 1 }));
  const ops = Array.from({ length: count }, (_, i) => {
    const op = { schemaVersion: 1, vaultId, opId: uuid(), deviceId: deviceIds[i % devices], fileId: uuid(), path: `notes/${i}.md`, parents: [], kind: 'update', hash: hash(bytes('body-' + i)), size: 6, createdAt: 1 };
    put(`${base}/ops/${op.deviceId}/${op.opId}.json`, jsonBytes(op)); return op;
  });
  return { h, vaultId, base, deviceIds, ops, put };
}

test('cold scan prepares at most 100 reads; warm/restart reuse records and never rewrite unchanged cache', async () => {
  const { h, vaultId } = seed(205); let saved: unknown, writes = 0, metadata = 0, downloads = 0; const batchSizes: number[] = [];
  const disk = { load: async () => saved, save: async (v: unknown) => { saved = structuredClone(v); writes++; } };
  const fresh = () => new RemoteVaultStore(new BaiduProvider('/apps/中文应用', async input => {
    const q = new URL(input.url); if (q.searchParams.get('method') === 'filemetas') { metadata++; batchSizes.push(JSON.parse(q.searchParams.get('fsids')!).length); }
    if (q.pathname.startsWith('/file/')) downloads++; return h.transport(input);
  }, { accessToken: async () => 'private-access' }), disk);
  const store = fresh(), phases: RevisionScanProgress[] = [];
  assert.equal((await store.revisions(vaultId, undefined, false, p => phases.push(p))).length, 205);
  assert.equal(metadata, 4, 'one vault metadata call and three record windows'); assert.deepEqual(batchSizes, [1, 100, 100, 5]); assert.equal(writes, 1);
  const oldDownloads = downloads; await store.revisions(vaultId); assert.equal(downloads, oldDownloads); assert.equal(writes, 1);
  await fresh().revisions(vaultId); assert.equal(downloads, oldDownloads + 1, 'only vault metadata needs a cold read'); assert.equal(writes, 1);
  assert.ok(phases.some(p => p.phase === 'listing' && p.pages >= 4)); assert.equal(phases.at(-1)!.phase, 'completed');
});

test('missing fingerprints, cache corruption and cache save failure retain verified fallback and retry', async () => {
  const { h, vaultId } = seed(); let saved: unknown = { schemaVersion: 'corrupt' }, writes = 0, fail = true;
  const disk = { load: async () => saved, save: async (v: unknown) => { writes++; if (fail) { fail = false; throw Error('disk'); } saved = structuredClone(v); } };
  const provider = new BaiduProvider('/apps/中文应用', async input => { const result = await h.transport(input); const method = new URL(input.url).searchParams.get('method');
    if (method === 'list') for (const row of (result.json as any).list ?? []) delete row.md5;
    if (method === 'filemetas') for (const row of (result.json as any).list ?? []) delete row.md5;
    return result;
  }, { accessToken: async () => 'private-access' });
  let last: any; const store = new RemoteVaultStore(provider, disk, 8, s => { last = s; });
  await store.revisions(vaultId); assert.equal(last.read, 7); assert.equal(last.details.cacheSaveFailures, 1);
  await store.revisions(vaultId); assert.equal(last.read, 7); assert.equal(writes, 2);
  await store.revisions(vaultId); assert.equal(writes, 2, 'the empty persistable set is unchanged');
  let refused = 0;
  const strong = new RemoteVaultStore(h.provider, { load: async () => undefined, save: async () => ++refused === 1 ? false : true }, 8, s => { last = s; });
  await strong.revisions(vaultId); assert.equal(last.details.cacheWrites, 0); assert.equal(last.details.cacheSaveFailures, 1);
  await strong.revisions(vaultId); assert.equal(refused, 2); assert.equal(last.details.cacheWrites, 1);
  await strong.revisions(vaultId); assert.equal(refused, 2);
});

test('device directories overlap within four workers, discover new publishers, and failed pages never save a complete cache', async () => {
  const { h, vaultId, base, put } = seed(12, 4); let active = 0, peak = 0, fail = false, writes = 0;
  const provider = new BaiduProvider('/apps/中文应用', async input => { const q = new URL(input.url), directory = q.searchParams.get('dir') ?? '';
    if (q.searchParams.get('method') !== 'list' || !directory.includes('/ops/')) return h.transport(input);
    active++; peak = Math.max(peak, active);
    try { await new Promise(r => setTimeout(r, 3)); if (fail) throw Error('page failed'); return await h.transport(input); } finally { active--; }
  }, { accessToken: async () => 'private-access' });
  const store = new RemoteVaultStore(provider, { load: async () => undefined, save: async () => { writes++; } });
  await store.revisions(vaultId); assert.equal(peak, 4); assert.equal(writes, 1);
  peak = 0; store.setReadConcurrency(1); await store.revisions(vaultId); assert.equal(peak, 1); assert.equal(writes, 1); store.setReadConcurrency(8);
  const deviceId = uuid(), opId = uuid(); put(`${base}/ops/${deviceId}/${opId}.json`, jsonBytes({ schemaVersion: 1, vaultId, deviceId, opId, fileId: uuid(), path: 'new.md', parents: [], kind: 'update', hash: hash(bytes('new')), size: 3, createdAt: 1 }));
  assert.equal((await store.revisions(vaultId)).length, 13); assert.equal(writes, 2);
  fail = true; await assert.rejects(store.revisions(vaultId)); assert.equal(writes, 2); assert.equal(active, 0);
});

test('metadata digest or path changes cannot publish a successful scan; expired links are re-prepared', async () => {
  for (const corruption of ['digest', 'path']) {
    const { h, vaultId } = seed(1); let writes = 0;
    const provider = new BaiduProvider('/apps/中文应用', async input => { const result = await h.transport(input);
      if (new URL(input.url).searchParams.get('method') === 'filemetas') for (const row of (result.json as any).list) {
        if (corruption === 'digest') row.md5 = '0'.repeat(32); else row.path = '/apps/中文应用/unrelated';
      } return result;
    }, { accessToken: async () => 'private-access' });
    await assert.rejects(new RemoteVaultStore(provider, { load: async () => undefined, save: async () => { writes++; } }).revisions(vaultId)); assert.equal(writes, 0);
  }
  const { h, base, ops } = seed(1); let metadata = 0; const provider = new BaiduProvider('/apps/中文应用', async input => { if (new URL(input.url).searchParams.get('method') === 'filemetas') metadata++; return h.transport(input); }, { accessToken: async () => 'private-access' });
  const objects = (await provider.list(`${base}/ops/${ops[0].deviceId}`)).objects;
  await provider.prepareReads(objects); await provider.prepareReads(objects); assert.equal(metadata, 1);
  const oldNow = Date.now; try { Date.now = () => oldNow() + 61000; await provider.prepareReads(objects); } finally { Date.now = oldNow; }
  assert.equal(metadata, 2); await provider.read(objects[0].path); assert.equal(metadata, 2);
});

test('history performance whitelist survives reload, drops invalid summaries, and excludes arbitrary private fields', () => {
  const perf = new TransferPerformance(); perf.begin(); const summary = scanSummary(perf.snapshot(), '0.2.9', false)!;
  const safe = validateScanSummary({ ...summary, secret: 'never-export', url: 'private-url' })!; assert.equal(JSON.stringify(safe).includes('private'), false);
  const context = 'test', deviceId = uuid(), task = { version: 1, id: uuid(), context, deviceId, sequence: 1, startedAt: 1, updatedAt: 2, mode: 'manual', status: 'completed', truncated: false, files: [], performance: safe };
  assert.deepEqual(validateHistory(task, context, deviceId).performance, safe);
  assert.equal(validateHistory({ ...task, performance: { ...safe, elapsedMs: NaN } }, context, deviceId).performance, undefined);
  assert.equal(validateHistory({ ...task, performance: undefined }, context, deviceId).performance, undefined);
});

test('10,000 valid operations remain readable; an extra operation fails before content reads or cache publication', async () => {
  const { h, vaultId, base } = seed(0), deviceId = uuid(); let count = 10000, reads = 0, writes = 0;
  const records = Array.from({ length: 10001 }, (_, i) => {
    const opId = uuid(), data = jsonBytes({ schemaVersion: 1, vaultId, deviceId, opId, fileId: uuid(), path: `notes/${i}.md`, parents: [], kind: 'update', hash: hash(bytes('x')), size: 1, createdAt: 1 });
    return { data, entry: { path: `${base}/ops/${deviceId}/${opId}.json`, size: data.byteLength, etag: 'stable-' + opId, isDirectory: false } };
  });
  const byPath = new Map(records.map(row => [row.entry.path, row.data]));
  const provider = Object.create(h.provider);
  provider.list = async (directory: string, cursor = '0') => {
    if (directory === base + '/ops') return { objects: [{ path: `${base}/ops/${deviceId}`, size: 0, isDirectory: true }], complete: true };
    if (directory !== `${base}/ops/${deviceId}`) return h.provider.list(directory, cursor);
    const start = Number(cursor), end = Math.min(start + 100, count);
    return { objects: records.slice(start, end).map(row => row.entry), complete: end === count, ...(end < count ? { nextCursor: String(end) } : {}) };
  };
  provider.inspect = undefined; provider.prepareReads = undefined;
  provider.read = async (path: string) => { if (byPath.has(path)) { reads++; return byPath.get(path)!.slice(0); } return h.provider.read(path); };
  const store = new RemoteVaultStore(provider, { load: async () => undefined, save: async () => { writes++; } });
  assert.equal((await store.revisions(vaultId)).length, 10000); assert.equal(reads, 10000); assert.equal(writes, 1);
  count++; await assert.rejects(store.revisions(vaultId), { code: 'schema' }); assert.equal(reads, 10000); assert.equal(writes, 1);
});
