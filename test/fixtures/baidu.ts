import assert from 'node:assert/strict';
import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { BaiduProvider } from '../../src/providers/baidu-provider.ts';
import { bytes } from '../../src/core/safety.ts';
import type { HttpRequest, HttpResponse } from '../../src/providers/http.ts';

export function baiduHarness() {
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
          .map(path => ({ path, size: files.get(path)?.byteLength ?? 0, isdir: dirs.has(path) ? 1 : 0, fs_id: ids.get(path) ?? '0',
            ...(files.has(path) ? { md5: bytesToHex(md5(new Uint8Array(files.get(path)!))), server_mtime: 123 } : {}) })).sort((a, b) => a.path.localeCompare(b.path));
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
        return response({ md5: upload.blocks[index], request_id: 123456 });
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
        return response({ errno: 0, path, size: data.byteLength, fs_id: ids.get(path), md5: bytesToHex(md5(data)), mtime: 123 });
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
