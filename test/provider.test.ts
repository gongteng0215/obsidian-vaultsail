import assert from 'node:assert/strict';
import test from 'node:test';
import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { BaiduProvider, listAll } from '../src/providers/baidu-provider.ts';
import { bytes, hash, MAX_FILE_SIZE, VaultSailError } from '../src/core/safety.ts';
import { request, type HttpRequest, type HttpResponse } from '../src/providers/http.ts';

function harness() {
  const root = '/apps/中文应用'; const dirs = new Set([root]); const files = new Map<string, ArrayBuffer>(); const ids = new Map<string, string>();
  const uploads = new Map<string, { path: string; chunks: Map<number, ArrayBuffer>; blocks: string[]; size: number }>();
  let lost = false; let rejectToken = false; let permissions = false; let refreshes = 0; let createCalls = 0;
  const response = (value: unknown): HttpResponse => ({ status: 200, headers: {}, json: value, bytes: bytes(JSON.stringify(value)) });
  const transport = async (input: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(input.url); const query = url.searchParams; const body = new URLSearchParams(typeof input.body === 'string' ? input.body : '');
    if (url.pathname.startsWith('/file/')) {
      assert.equal(input.headers?.['User-Agent'], 'pan.baidu.com'); return { status: 200, headers: {}, bytes: files.get(decodeURIComponent(url.pathname.slice(6)))!.slice(0) };
    }
    assert.ok(['pan.baidu.com', 'd.pcs.baidu.com'].includes(url.hostname)); assert.equal(query.get('access_token'), 'private-access');
    if (rejectToken) { rejectToken = false; return response({ errno: 20016 }); }
    if (permissions) return response({ errno: -6, errmsg: 'private-access' });
    switch (query.get('method')) {
      case 'uinfo': return response({ errno: 0, uk: 123456, baidu_name: 'private-name' });
      case 'list': {
        const dir = query.get('dir')!; if (!dirs.has(dir)) return response({ errno: -9 });
        const prefix = dir + '/'; const entries = [...files.keys(), ...dirs].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map(path => ({ path, size: files.get(path)?.byteLength ?? 0, isdir: dirs.has(path) ? 1 : 0, fs_id: ids.get(path) ?? '0' })).sort((a, b) => a.path.localeCompare(b.path));
        const offset = Number(query.get('start')); return response({ errno: 0, list: entries.slice(offset, offset + Number(query.get('limit'))) });
      }
      case 'precreate': {
        assert.equal(body.get('rtype'), '0'); const path = body.get('path')!;
        if (files.has(path)) return response({ errno: -8 });
        const id = String(uploads.size + 1); const blocks: string[] = JSON.parse(body.get('block_list')!);
        uploads.set(id, { path, chunks: new Map(), blocks, size: Number(body.get('size')) });
        return response({ errno: 0, uploadid: id, return_type: 1, block_list: blocks.map((_, i) => i) });
      }
      case 'upload': {
        assert.equal(query.get('type'), 'tmpfile'); const upload = uploads.get(query.get('uploadid')!)!;
        assert.equal(query.get('path'), upload.path); const boundary = input.headers!['Content-Type'].split('boundary=')[1];
        const data = Buffer.from(input.body as ArrayBuffer); const start = data.indexOf('\r\n\r\n') + 4; const end = data.length - Buffer.byteLength('\r\n--' + boundary + '--\r\n');
        const chunk = data.subarray(start, end); const copy = Uint8Array.from(chunk).buffer; const index = Number(query.get('partseq'));
        assert.equal(bytesToHex(md5(chunk)), upload.blocks[index]); assert.ok(chunk.byteLength <= 4 * 1024 * 1024); upload.chunks.set(index, copy);
        return response({ errno: 0, md5: upload.blocks[index] });
      }
      case 'create': {
        assert.equal(body.get('rtype'), '0'); const path = body.get('path')!;
        if (body.get('isdir') === '1') { dirs.add(path); return response({ errno: 0, path, isdir: 1 }); }
        createCalls++; if (files.has(path)) return response({ errno: -8 });
        const upload = uploads.get(body.get('uploadid')!)!; assert.equal(upload.path, path);
        const data = new Uint8Array(upload.size); let offset = 0;
        for (let i = 0; i < upload.blocks.length; i++) { const chunk = new Uint8Array(upload.chunks.get(i)!); data.set(chunk, offset); offset += chunk.length; }
        assert.equal(offset, upload.size); files.set(path, data.buffer); ids.set(path, String(ids.size + 1));
        if (lost) { lost = false; throw new Error('private-access response lost'); }
        return response({ errno: 0, path, size: data.byteLength, fs_id: ids.get(path) });
      }
      case 'filemetas': {
        const requested = String(JSON.parse(query.get('fsids')!)[0]); const path = [...ids].find(([, id]) => id === requested)![0];
        return response({ errno: 0, list: [{ path, fs_id: requested, size: files.get(path)!.byteLength, dlink: 'https://d.pcs.baidu.com/file/' + encodeURIComponent(path) }] });
      }
      default: throw new Error('unexpected endpoint');
    }
  };
  const provider = new BaiduProvider(root, transport, { accessToken: async force => { if (force) refreshes++; return 'private-access'; } });
  return { provider, files, dirs, uploads, ids, transport, setLost: () => { lost = true; }, setExpired: () => { rejectToken = true; }, setPermissions: () => { permissions = true; }, counts: () => ({ refreshes, createCalls }) };
}
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
