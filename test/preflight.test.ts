import assert from 'node:assert/strict';
import test from 'node:test';
import { scanInventories, formatPreflight, type PreflightStatus } from '../src/sync/preflight.ts';
import { baiduHarness } from './fixtures/baidu.ts';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { bytes, hash, VaultSailError } from '../src/core/safety.ts';
import { RequestPool } from '../src/core/request-pool.ts';
import type { HttpTransport, RequestPolicy } from '../src/providers/http.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import { RemoteDirectoryStore } from '../src/sync/directories.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('preflight publishes independent stages immediately and ignores throwing or mutating observers', async () => {
  for (const fast of ['files', 'directories'] as const) {
    const release = deferred(), ready = deferred(), states: PreflightStatus[] = [];
    const short = async () => { ready.resolve(); return 1; }, long = async () => { await release.promise; return 2; };
    const result = scanInventories(fast === 'files' ? short : long, fast === 'directories' ? short : long, status => { states.push({ ...status }); status.files = 'failed'; throw Error('observer'); });
    assert.equal(formatPreflight(states[0]), '正在检查文件与目录');
    await ready.promise; await Promise.resolve(); await Promise.resolve();
    assert.equal(states.at(-1)![fast], 'completed'); assert.match(formatPreflight(states.at(-1)), /等待.*检查/);
    release.resolve(); await result; assert.equal(formatPreflight(states.at(-1)), '检查完成，准备处理变更');
    assert.deepEqual(states[0], { files: 'running', directories: 'running' });
  }
});

test('parallel file and directory inventories still respect a one-request shared budget', async () => {
  const h = baiduHarness(), vault = await new RemoteVaultStore(h.provider).create('synthetic');
  await h.provider.mkdir(`vaultsail/vaults/${vault.vaultId}/directories`);
  const pool = new RequestPool(1); let active = 0, peak = 0;
  const transport: HttpTransport = Object.assign(async (input: Parameters<HttpTransport>[0]) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await h.transport(input); }
    finally { active--; }
  }, { reserve: (_input: unknown, policy: RequestPolicy) => pool.acquire(policy.signal, policy.timeoutMs) });
  const provider = new BaiduProvider('/apps/中文应用', transport, { accessToken: async () => 'private-access' });
  const [files, folders] = await scanInventories(() => new RemoteVaultStore(provider).revisions(vault.vaultId), () => new RemoteDirectoryStore(provider, vault.vaultId).revisions());
  assert.deepEqual(files, []); assert.deepEqual(folders, []); assert.equal(peak, 1); assert.equal(active, 0); assert.equal(pool.snapshot().active, 0);
});

test('parallel preflight starts both checks and drains delayed failure before releasing its caller', async () => {
  for (const failing of ['files', 'directories']) {
    const entered = deferred(), release = deferred(); let drained = false, settled = false;
    const failure = new VaultSailError('response', 'Incomplete inventory');
    const bad = async () => { await entered.promise; throw failure; };
    const slow = async () => { entered.resolve(); await release.promise; drained = true; return 1; };
    const result = scanInventories(failing === 'files' ? bad : slow, failing === 'directories' ? bad : slow);
    void result.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise; await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false); release.resolve();
    await assert.rejects(result, error => error === failure); assert.equal(drained, true);
  }
});

test('a synchronously thrown preflight check still starts and drains the other check', async () => {
  let drained = false;
  await assert.rejects(scanInventories(() => { throw Error('failed'); }, async () => { await Promise.resolve(); drained = true; return 2; }));
  assert.equal(drained, true);
});

test('simultaneous identical pages share only their in-flight request and return independent objects', async () => {
  const h = baiduHarness(), entered = deferred(), release = deferred(); let calls = 0;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    if (new URL(input.url).searchParams.get('method') === 'list') { calls++; entered.resolve(); await release.promise; }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' });
  h.files.set('/apps/中文应用/probe.bin', bytes('x')); h.ids.set('/apps/中文应用/probe.bin', '1');
  const a = provider.list(''), b = provider.list(''); await entered.promise; release.resolve();
  const [left, right] = await Promise.all([a, b]); assert.equal(calls, 1);
  left.objects[0].path = 'mutated'; assert.equal(right.objects[0].path, 'probe.bin');
  await provider.list(''); assert.equal(calls, 2, 'a later check must contact the server again');
  h.files.set('/apps/中文应用/new.bin', bytes('new')); h.ids.set('/apps/中文应用/new.bin', '2');
  assert.equal((await provider.list('')).objects.length, 2);
});

test('failed shared pages are evicted and cancelled consumers cannot return a successful inventory', async () => {
  const h = baiduHarness(); let failed = true, calls = 0, active = true;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    calls++; if (failed) return { status: 200, headers: {}, json: { errno: -6 }, bytes: bytes('{}') };
    const response = await h.transport(input); active = false; return response;
  }, { accessToken: async () => 'private-access' }, () => active);
  const results = await Promise.allSettled([provider.list(''), provider.list('')]);
  assert.equal(calls, 1); assert.ok(results.every(r => r.status === 'rejected'));
  failed = false; await assert.rejects(provider.list(''), { code: 'cancelled' }); assert.equal(calls, 2);
});

test('lost-write verification bypasses an overlapping stale ordinary page', async () => {
  const h = baiduHarness(), release = deferred(), entered = deferred(); let pending: Promise<unknown> | undefined, arm = false, sharedCalls = 0;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const method = new URL(input.url).searchParams.get('method');
    if (method === 'list' && arm && sharedCalls++ === 0) {
      entered.resolve(); await release.promise;
      return { status: 200, headers: {}, json: { errno: 0, list: [] }, bytes: bytes('{}') };
    }
    try { return await h.transport(input); }
    catch (error) {
      if (method === 'create') {
        arm = true; pending = provider.list(''); await entered.promise;
      }
      throw error;
    }
  }, { accessToken: async () => 'private-access' });
  h.setLost(); const data = bytes('confirmed write');
  try { await provider.writeImmutable('probe.bin', data); assert.ok(sharedCalls >= 2, 'verification must issue a fresh request'); assert.equal(hash(h.files.get('/apps/中文应用/probe.bin')!), hash(data)); }
  finally { release.resolve(); await pending; }
  assert.equal(h.counts().createCalls, 1, 'unknown results must never create a second upload');
});
