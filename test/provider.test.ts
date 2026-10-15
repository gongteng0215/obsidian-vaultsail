import assert from 'node:assert/strict';
import test from 'node:test';
import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { BaiduProvider, listAll } from '../src/providers/baidu-provider.ts';
import { bytes, hash, MAX_FILE_SIZE, uuid, VaultSailError } from '../src/core/safety.ts';
import { RemoteVaultStore, type Revision } from '../src/sync/remote-vault.ts';
import { apiSuccess, request, type HttpRequest, type HttpResponse } from '../src/providers/http.ts';

import { baiduHarness as harness } from './fixtures/baidu.ts';
test('a previously verified operation cannot be silently rewritten into a different valid operation', async () => {
  const h = harness(), remote = new RemoteVaultStore(h.provider), vault = await remote.create('不可变历史');
  const data = bytes('same content'); const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId: uuid(), fileId: uuid(), path: 'note.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
  await remote.publish(vault.vaultId, op, data); await remote.revisions(vault.vaultId);
  const path = '/apps/中文应用/' + remote.base(vault.vaultId) + '/ops/' + op.deviceId + '/' + op.opId + '.json';
  h.files.set(path, bytes(JSON.stringify({ ...op, createdAt: 2 })));
  await assert.rejects(remote.revisions(vault.vaultId), { code: 'integrity' });
});

test('missing listing digests use batched fresh metadata and survive restart without downloading unchanged history', async () => {
  const h = harness(), remote = new RemoteVaultStore(h.provider), vault = await remote.create('缺少列表摘要'), deviceId = uuid();
  for (let i = 0; i < 107; i++) {
    const data = bytes('data-' + i);
    const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId, fileId: uuid(), path: `note-${i}.md`,
      parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
    await remote.publish(vault.vaultId, op, data);
  }
  let saved: unknown, reads = 0; const batches: number[] = [];
  const disk = { load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
  const transport = async (input: HttpRequest) => {
    const url = new URL(input.url), result = await h.transport(input);
    if (url.searchParams.get('method') === 'list') for (const entry of (result.json as { list: Record<string, unknown>[] }).list) delete entry.md5;
    if (url.searchParams.get('method') === 'filemetas') batches.push(JSON.parse(url.searchParams.get('fsids')!).length);
    if (url.pathname.startsWith('/file/') && decodeURIComponent(url.pathname).includes('/ops/')) reads++;
    return result;
  };
  const fresh = () => new RemoteVaultStore(new BaiduProvider('/apps/中文应用', transport, { accessToken: async () => 'private-access' }), disk);
  await fresh().revisions(vault.vaultId); assert.equal(reads, 107); assert.deepEqual(batches, [1, 100, 7]);
  assert.equal((saved as { entries: unknown[] }).entries.length, 107);
  reads = 0; batches.length = 0; await fresh().revisions(vault.vaultId);
  assert.equal(reads, 0, 'restart reuses cached records after fresh batch fingerprints'); assert.deepEqual(batches, [1, 100, 7]);
});

test('incomplete, duplicate, mismatched or failed metadata batches stop scanning; absent digests safely reread records', async () => {
  for (const fault of ['missing', 'duplicate', 'path', 'size', 'permission', 'no-digest'] as const) {
    const h = harness(); await h.provider.writeImmutable('records/a', bytes('A')); await h.provider.writeImmutable('records/b', bytes('B'));
    let downloads = 0;
    const provider = new BaiduProvider('/apps/中文应用', async input => {
      const url = new URL(input.url); if (url.pathname.startsWith('/file/')) downloads++;
      const result = await h.transport(input);
      if (url.searchParams.get('method') === 'list') for (const entry of (result.json as { list: Record<string, unknown>[] }).list) delete entry.md5;
      if (url.searchParams.get('method') === 'filemetas') {
        const list = (result.json as { list: Record<string, unknown>[] }).list;
        if (fault === 'missing') list.pop();
        if (fault === 'duplicate') list[1] = list[0];
        if (fault === 'path') list[0].path = '/apps/中文应用/outside';
        if (fault === 'size') list[0].size = 123;
        if (fault === 'permission') result.json = { errno: -6 };
        if (fault === 'no-digest') for (const entry of list) delete entry.md5;
      }
      return result;
    }, { accessToken: async () => 'private-access' });
    const entries = (await provider.listAll('records'));
    if (fault === 'no-digest') {
      const inspected = await provider.inspect(entries); assert.ok(inspected.every(entry => entry.etag === undefined));
      await provider.read('records/a'); assert.equal(downloads, 1);
    } else { await assert.rejects(provider.inspect(entries), { code: fault === 'permission' ? 'permission' : 'response' }); assert.equal(downloads, 0); }
  }
});

test('Baidu adapter performs exact multipart and verifies 0B, 1KB, 4MiB and 20MiB roundtrips', async () => {
  const h = harness(); assert.equal((await h.provider.profile()).label, '百度账号 ···3456');
  for (const size of [0, 1024, 4 * 1024 * 1024, MAX_FILE_SIZE]) {
    const data = new Uint8Array(size); data.fill(31); const path = 'isolated/中文/' + size + '.bin';
    await h.provider.writeImmutable(path, data.buffer); assert.equal(hash(await h.provider.read(path)), hash(data.buffer));
  }
  assert.equal(h.counts().createCalls, 4); assert.equal([...h.uploads.values()].at(-1)!.chunks.size, 5);
});
test('lost create response is verified before retry and immutable conflicts never overwrite', async () => {
  const h = harness(); h.setLost(); await h.provider.writeImmutable('test/file.bin', bytes('A'));
  assert.equal(h.counts().createCalls, 1); await h.provider.writeImmutable('test/file.bin', bytes('A')); assert.equal(h.counts().createCalls, 1);
  await assert.rejects(h.provider.writeImmutable('test/file.bin', bytes('B')), { code: 'integrity' }); assert.equal(hash(h.files.get('/apps/中文应用/test/file.bin')!), hash(bytes('A')));
});
test('small note publication reduces request overhead while both content and record receive full readback', async () => {
  const h = harness(); let counts = new Map<string, number>();
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const url = new URL(input.url); const key = url.pathname.startsWith('/file/') ? 'download' : url.searchParams.get('method')!;
    counts.set(key, (counts.get(key) ?? 0) + 1); return h.transport(input);
  }, { accessToken: async () => 'private-access' });
  const remote = new RemoteVaultStore(provider); const vault = await remote.create('请求预算测试'); const deviceId = uuid();
  for (let i = 0; i < 2; i++) {
    counts = new Map(); await remote.revisions(vault.vaultId); const data = bytes('synthetic-note-' + i);
    const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId, fileId: uuid(), path: 'note-' + i + '.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
    await remote.publish(vault.vaultId, op, data);
    assert.ok([...counts.values()].reduce((sum, count) => sum + count, 0) <= 20, 'small files should not repeat ancestor checks');
    assert.ok(counts.get('list')! <= 6); assert.equal(counts.get('download'), 2, 'content and operation record must both be downloaded and verified');
  }
  // Fresh listings discover new operations written through a separate device/provider.
  const other = new RemoteVaultStore(new BaiduProvider('/apps/中文应用', h.transport, { accessToken: async () => 'private-access' }));
  const data = bytes('other-device'); const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId: uuid(), fileId: uuid(), path: 'other.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
  await other.publish(vault.vaultId, op, data); assert.equal((await remote.revisions(vault.vaultId)).length, 3);
});
test('verified fingerprints are invalidated by fresh changed metadata or missing server digests', async () => {
  const h = harness(); const path = 'cache/note.bin'; await h.provider.writeImmutable(path, bytes('A'));
  const entry = (await h.provider.listAll('cache'))[0]; assert.equal(h.provider.verifiedContentHash(entry), hash(bytes('A')));
  assert.equal(h.provider.verifiedContentHash({ ...entry, id: 'another-id' }), undefined);
  assert.equal(h.provider.verifiedContentHash({ ...entry, etag: undefined }), undefined);
  h.files.set('/apps/中文应用/' + path, bytes('B')); const changed = (await h.provider.listAll('cache'))[0];
  assert.equal(h.provider.verifiedContentHash(changed), undefined);
  await assert.rejects(h.provider.writeImmutable(path, bytes('A')), { code: 'integrity' });
});

test('concurrent missing-file lookups share full pagination, discard failures and never retain an absence cache', async () => {
  const h = harness(); h.dirs.add('/apps/中文应用/shared');
  for (let i = 0; i < 135; i++) { const path = '/apps/中文应用/shared/' + i; h.files.set(path, bytes('x')); h.ids.set(path, String(i + 1)); }
  let lists = 0, fail = false;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    if (new URL(input.url).searchParams.get('method') === 'list') {
      lists++; if (fail) return { status: 403, headers: {}, json: { errno: -6 }, bytes: bytes('synthetic failure') };
    }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, (_, i) => provider.exists('shared/missing-' + i))), Array(8).fill(false));
  assert.equal(lists, 2, 'eight overlapping lookups share both pages, rather than making sixteen requests');
  h.files.set('/apps/中文应用/shared/missing-0', bytes('new')); h.ids.set('/apps/中文应用/shared/missing-0', '500');
  assert.equal(await provider.exists('shared/missing-0'), true, 'later lookups must see newly published files');
  fail = true; const results = await Promise.allSettled([provider.exists('shared/new-a'), provider.exists('shared/new-b')]);
  assert.ok(results.every(result => result.status === 'rejected')); fail = false;
  assert.equal(await provider.exists('shared/new-a'), false, 'failed shared lookups must not poison future requests');
});

test('repeated immutable content reuses full verification only after fresh matching metadata; missing digest or corruption forces readback', async () => {
  const h = harness(); let downloads = 0, lists = 0, omitDigest = false;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const url = new URL(input.url); if (url.pathname.startsWith('/file/')) downloads++;
    const result = await h.transport(input);
    if (url.searchParams.get('method') === 'list') {
      lists++; if (omitDigest) for (const entry of (result.json as { list: Record<string, unknown>[] }).list) delete entry.md5;
    }
    return result;
  }, { accessToken: async () => 'private-access' });
  await provider.writeImmutable('reuse/content', bytes('A')); assert.equal(downloads, 1);
  const before = lists; await provider.writeImmutable('reuse/content', bytes('A'));
  assert.ok(lists > before, 'a new server fingerprint is required'); assert.equal(downloads, 1, 'unchanged verified content needs no second download');
  omitDigest = true; await provider.writeImmutable('reuse/content', bytes('A')); assert.equal(downloads, 2);
  omitDigest = false; h.files.set('/apps/中文应用/reuse/content', bytes('B'));
  await assert.rejects(provider.writeImmutable('reuse/content', bytes('A')), { code: 'integrity' }); assert.equal(downloads, 3);
});
test('persisted revision cache survives a provider restart but corrupt cache or changed remote metadata forces verified reads', async () => {
  const h = harness(); let saved: unknown;
  const disk = { load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
  const remote = new RemoteVaultStore(h.provider, disk); const vault = await remote.create('重启缓存'); const data = bytes('note');
  const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId: uuid(), fileId: uuid(), path: 'note.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
  await remote.publish(vault.vaultId, op, data); await remote.revisions(vault.vaultId);
  let opReads = 0;
  const transport = async (input: HttpRequest) => { const url = new URL(input.url); if (url.pathname.startsWith('/file/') && decodeURIComponent(url.pathname).includes('/ops/')) opReads++; return h.transport(input); };
  const fresh = () => new RemoteVaultStore(new BaiduProvider('/apps/中文应用', transport, { accessToken: async () => 'private-access' }), disk);
  const restarted = fresh(); assert.equal((await restarted.revisions(vault.vaultId)).length, 1); assert.equal(opReads, 0);
  (saved as { entries: { digest: string }[] }).entries[0].digest = 'broken'; await fresh().revisions(vault.vaultId); assert.equal(opReads, 1);
  const path = '/apps/中文应用/' + remote.base(vault.vaultId) + '/ops/' + op.deviceId + '/' + op.opId + '.json';
  h.files.set(path, bytes(JSON.stringify({ ...op, schemaVersion: 2 }))); await assert.rejects(restarted.revisions(vault.vaultId), { code: 'schema' }); assert.equal(opReads, 2);
});
test('vault and revision caches stop on same-size corruption, and uncoded fingerprints never hide changes', async () => {
  for (const omitFingerprint of [false, true]) {
    const h = harness(); const provider = new BaiduProvider('/apps/中文应用', async input => {
      const result = await h.transport(input);
      if (omitFingerprint && input.url.includes('method=list')) for (const entry of (result.json as { list?: Record<string, unknown>[] }).list ?? []) { delete entry.md5; delete entry.server_mtime; }
      return result;
    }, { accessToken: async () => 'private-access' });
    const remote = new RemoteVaultStore(provider); const vault = await remote.create('缓存校验'); const data = bytes('note');
    const op: Revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId: uuid(), fileId: uuid(), path: 'note.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
    await remote.publish(vault.vaultId, op, data); await remote.revisions(vault.vaultId);
    const opPath = '/apps/中文应用/' + remote.base(vault.vaultId) + '/ops/' + op.deviceId + '/' + op.opId + '.json';
    const original = h.files.get(opPath)!; h.files.set(opPath, bytes(new TextDecoder().decode(original).replace('"schemaVersion":1', '"schemaVersion":2')));
    assert.equal(h.files.get(opPath)!.byteLength, original.byteLength); await assert.rejects(remote.revisions(vault.vaultId), { code: 'schema' });
    h.files.set(opPath, original);
    const manifestPath = '/apps/中文应用/' + remote.base(vault.vaultId) + '/vault.json';
    const manifest = h.files.get(manifestPath)!; h.files.set(manifestPath, bytes(new TextDecoder().decode(manifest).replace('"schemaVersion":1', '"schemaVersion":2')));
    assert.equal(h.files.get(manifestPath)!.byteLength, manifest.byteLength); await assert.rejects(remote.get(vault.vaultId), { code: 'schema' });
  }
});
test('only explicit expiry refreshes token; permission errors remain distinct and sanitized', async () => {
  const h = harness(); h.setExpired(); await h.provider.profile(); assert.equal(h.counts().refreshes, 1);
  h.setPermissions(); await assert.rejects(h.provider.profile(), e => e instanceof VaultSailError && e.code === 'permission' && !e.message.includes('private-access')); assert.equal(h.counts().refreshes, 1);
});
test('pagination reads all pages including full final page and refuses malformed or duplicate inventories', async () => {
  const h = harness(); for (let i = 0; i < 200; i++) h.dirs.add('/apps/中文应用/d' + String(i).padStart(3, '0'));
  assert.equal((await h.provider.listAll('')).length, 200);
  const malformed = new BaiduProvider('/apps/test', async () => ({ status: 200, headers: {}, bytes: new ArrayBuffer(0), json: { errno: 0 } }), { accessToken: async () => 'token' });
  await assert.rejects(malformed.listAll(''), { code: 'response' });
  const duplicate = { ...h.provider, list: async () => ({ objects: [{ path: 'same', size: 0, isDirectory: true }], complete: false, nextCursor: '100' }) };
  await assert.rejects(listAll(duplicate as BaiduProvider, ''), { code: 'response' });
});
test('Baidu response envelopes accept PCS digest-only success and reject explicit or malformed errors', () => {
  const md5 = 'ab56b4d92b40713acc5af89985d4b786';
  assert.equal(apiSuccess({ md5 }, 'pcs-upload').md5, md5);
  assert.equal(apiSuccess({ errno: 0, md5 }, 'pcs-upload').md5, md5);
  for (const field of ['errno', 'error_code', 'error_no']) {
    assert.throws(() => apiSuccess({ [field]: 31045, md5 }, 'pcs-upload'), { code: 'permission' });
    assert.throws(() => apiSuccess({ errno: 0, [field]: -6, list: [] }), { code: 'permission' });
    assert.throws(() => apiSuccess({ [field]: '0', md5 }, 'pcs-upload'), { code: 'response' });
  }
  assert.throws(() => apiSuccess({ md5 }), { code: 'response' });
  assert.throws(() => apiSuccess({ list: [] }), { code: 'response' });
  for (const value of [{}, { errno: 0 }, { md5: 'bad' }, { md5, error: 'private-access' }]) assert.throws(() => apiSuccess(value, 'pcs-upload'));
  assert.equal(apiSuccess({ error_code: 0, list: [] }).error_code, 0);
});
test('gateway errors retain their real code and safe API stage, including HTTP 403', async () => {
  for (const status of [200, 403]) {
    let refreshes = 0;
    const provider = new BaiduProvider('/apps/test', async () => ({ status, headers: {}, bytes: new ArrayBuffer(0), json: { error_code: 31045, error_msg: 'private-access' } }),
      { accessToken: async force => { if (force) refreshes++; return 'private-access'; } });
    await assert.rejects(provider.listAll(''), e => e instanceof VaultSailError && e.code === 'permission' && e.message.startsWith('读取云端目录：') && !e.message.includes('private-access'));
    assert.equal(refreshes, 0);
  }
  const provider = new BaiduProvider('/apps/test', async () => ({ status: 403, headers: {}, bytes: new ArrayBuffer(0), json: { errno: 0, list: [] } }), { accessToken: async () => 'token' });
  await assert.rejects(provider.listAll(''), { code: 'http' });
});
test('PCS malformed, rejected and mismatched digests never publish file metadata', async () => {
  for (const reply of [{}, { md5: 'bad' }, { md5: '0'.repeat(32) }, { error_code: 31045, md5: '0'.repeat(32) }]) {
    const h = harness();
    const provider = new BaiduProvider('/apps/中文应用', async input => input.url.includes('method=upload')
      ? { status: 200, headers: {}, bytes: new ArrayBuffer(0), json: reply } : h.transport(input), { accessToken: async () => 'private-access' });
    await assert.rejects(provider.writeImmutable('vaultsail/vaults/test/vault.json', bytes('{}')));
    assert.equal(h.counts().createCalls, 0); assert.equal(h.files.size, 0);
  }
});
test('download refuses unrelated CDN links and oversized objects before reading bytes', async () => {
  const h = harness(); await h.provider.writeImmutable('test/file.bin', bytes('A'));
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const result = await h.transport(input);
    if (input.url.includes('method=filemetas')) (result.json as { list: { dlink: string }[] }).list[0].dlink = 'https://evil.example/download';
    return result;
  }, { accessToken: async () => 'private-access' });
  await assert.rejects(provider.read('test/file.bin'), { code: 'response' });
  h.files.set('/apps/中文应用/test/file.bin', new ArrayBuffer(MAX_FILE_SIZE + 1)); await assert.rejects(h.provider.read('test/file.bin'), { code: 'size' });
});
test('HTTP retry-after is honored and transport errors never expose credentials', async () => {
  await assert.rejects(request(async () => ({ status: 429, headers: { 'Retry-After': '9' }, bytes: new ArrayBuffer(0) }), { url: 'https://example.invalid/?token=private' }), e => e instanceof VaultSailError && e.retryAfter === 9000);
  await assert.rejects(request(async () => { throw new Error('private-token'); }, { url: 'https://example.invalid/?token=private' }), e => e instanceof VaultSailError && !e.message.includes('private'));
});
test('hanging authorization request times out and cancellation does not wait for the native transport', async () => {
  const hanging = async (): Promise<HttpResponse> => new Promise(() => {});
  await assert.rejects(request(hanging, { url: 'https://example.invalid' }, true, { timeoutMs: 15 }), { code: 'timeout' });
  const controller = new AbortController();
  const pending = request(hanging, { url: 'https://example.invalid' }, true, { timeoutMs: 10000, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});
test('file requests have bounded waits and disconnect releases a hanging native request without accepting late results', async () => {
  const h = harness(); const controller = new AbortController(); let started = false;
  let release!: (value: HttpResponse) => void;
  const provider = new BaiduProvider('/apps/中文应用', () => { started = true; return new Promise(resolve => { release = resolve; }); },
    { accessToken: async () => 'private-access' }, () => true, undefined, { apiTimeoutMs: 1000, signal: controller.signal });
  const pending = provider.listAll(''); const rejected = assert.rejects(pending, { code: 'cancelled' });
  for (let i = 0; i < 20 && !started; i++) await Promise.resolve(); assert.equal(started, true); controller.abort(); await rejected;
  release(await h.transport({ url: 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=%2Fapps%2F%E4%B8%AD%E6%96%87%E5%BA%94%E7%94%A8&access_token=private-access' }));
  await assert.rejects(request(async () => new Promise(() => {}), { url: 'https://example.invalid/file' }, false, { timeoutMs: 10 }), { code: 'timeout' });
});
test('lost final write response times out but a verified remote result avoids duplicate submission', async () => {
  const h = harness(); let finalWrites = 0;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const body = new URLSearchParams(typeof input.body === 'string' ? input.body : '');
    if (new URL(input.url).searchParams.get('method') === 'create' && body.get('isdir') === '0') {
      finalWrites++; await h.transport(input); return new Promise<HttpResponse>(() => {});
    }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' }, () => true, undefined, { apiTimeoutMs: 15 });
  await provider.writeImmutable('test/file.bin', bytes('A'));
  assert.equal(finalWrites, 1); assert.equal(h.counts().createCalls, 1); assert.equal(hash(await provider.read('test/file.bin')), hash(bytes('A')));
});
test('unconfirmed writes stop after timeout instead of resubmitting while native writes may still be running', async () => {
  const h = harness(); let finalWrites = 0; let lateWrite!: () => Promise<HttpResponse>;
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const body = new URLSearchParams(typeof input.body === 'string' ? input.body : '');
    if (new URL(input.url).searchParams.get('method') === 'create' && body.get('isdir') === '0') {
      finalWrites++; return new Promise<HttpResponse>(resolve => { lateWrite = async () => { const result = await h.transport(input); resolve(result); return result; }; });
    }
    return h.transport(input);
  }, { accessToken: async () => 'private-access' }, () => true, undefined, { apiTimeoutMs: 15 });
  await assert.rejects(provider.writeImmutable('test/file.bin', bytes('A')), e => e instanceof VaultSailError && e.code === 'write-timeout' && !e.retryable);
  assert.equal(finalWrites, 1); assert.equal(h.files.size, 0); await lateWrite();
  await provider.writeImmutable('test/file.bin', bytes('A')); assert.equal(finalWrites, 1); assert.equal(h.counts().createCalls, 1);
});
test('pause and disconnect interrupt long rate-limit backoff without issuing another request', async () => {
  for (const disconnect of [false, true]) {
    const controller = new AbortController(); let active = true; let calls = 0; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider = new BaiduProvider('/apps/test', async () => { calls++; entered(); return { status: 429, headers: { 'retry-after': '3600' }, bytes: new ArrayBuffer(0) }; },
      { accessToken: async () => 'private-access' }, () => active, undefined, { signal: controller.signal });
    const rejected = assert.rejects(provider.profile(), { code: 'cancelled' });
    await started; await new Promise(resolve => setTimeout(resolve, 5));
    if (disconnect) controller.abort(); else active = false;
    await rejected; assert.equal(calls, 1);
  }
});
test('parallel identical content shares one upload and shared parent directories are created once', async () => {
  const h = harness(); const directories = new Map<string, number>();
  const provider = new BaiduProvider('/apps/中文应用', async input => {
    const body = new URLSearchParams(typeof input.body === 'string' ? input.body : '');
    if (new URL(input.url).searchParams.get('method') === 'create' && body.get('isdir') === '1') {
      const path = body.get('path')!; directories.set(path, (directories.get(path) ?? 0) + 1);
    }
    await new Promise(resolve => setTimeout(resolve, 1)); return h.transport(input);
  }, { accessToken: async () => 'private-access' });
  await Promise.all([provider.writeImmutable('shared/nested/a.bin', bytes('A')), provider.writeImmutable('shared/nested/a.bin', bytes('A')),
    provider.writeImmutable('shared/nested/b.bin', bytes('B'))]);
  assert.equal(h.counts().createCalls, 2); assert.ok([...directories.values()].every(value => value === 1));
  const first = provider.writeImmutable('shared/unique.bin', bytes('first'));
  await assert.rejects(provider.writeImmutable('shared/unique.bin', bytes('second')), { code: 'integrity' }); await first;
  assert.equal(hash(await provider.read('shared/unique.bin')), hash(bytes('first')));
});
