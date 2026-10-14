import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { appRoot, checkSize, hash, record, relativePath, sleep, uuid, VaultSailError } from '../core/safety.ts';
import { apiSuccess, request, urlWith, type HttpTransport } from './http.ts';
import type { CloudStorageProvider, RemoteObject, RemotePage } from './cloud-storage-provider';
import { listAll } from './provider-utils.ts';
export { listAll } from './provider-utils.ts';

export interface TokenSource { accessToken(forceRefresh?: boolean): Promise<string>; }
const XPAN = 'https://pan.baidu.com/rest/2.0/xpan/';
const CHUNK = 4 * 1024 * 1024;
export class BaiduProvider implements CloudStorageProvider {
  readonly id = 'baidu'; readonly displayName = '百度网盘'; readonly root: string;
  readonly capabilities = { canList: true, canRead: true, canWrite: true, canDelete: false, supportsConditionalWrites: false };
  private transport: HttpTransport; private auth: TokenSource; private active: () => boolean;
  private objects = new Map<string, RemoteObject>();
  constructor(root: string, transport: HttpTransport, auth: TokenSource, active = () => true) {
    this.root = appRoot(root); this.transport = transport; this.auth = auth; this.active = active;
  }
  isConfigured(): boolean { return this.active(); }
  private guard(): void { if (!this.active()) throw new VaultSailError('cancelled', '任务已暂停，或账号及目录配置已更改。'); }
  private absolute(path: string): string { return path ? this.root + '/' + relativePath(path) : this.root; }
  private async api(endpoint: string, params: Record<string, string>, form?: Record<string, string>, body?: ArrayBuffer, contentType?: string): Promise<Record<string, unknown>> {
    for (let refresh = 0; refresh < 2; refresh++) {
      this.guard(); const token = await this.auth.accessToken(refresh > 0); this.guard();
      try {
        const response = await request(this.transport, { url: urlWith(endpoint, { ...params, access_token: token }),
          method: form || body ? 'POST' : 'GET', headers: form || body ? { 'Content-Type': contentType ?? 'application/x-www-form-urlencoded' } : {},
          body: form ? new URLSearchParams(form).toString() : body });
        this.guard(); return apiSuccess(response.json);
      } catch (error) { if (refresh === 0 && error instanceof VaultSailError && error.code === 'token-expired') continue; throw error; }
    }
    throw new VaultSailError('authentication', '令牌刷新后仍不可用，请重新授权。');
  }
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.guard(); try { return await operation(); }
      catch (error) {
        if (!(error instanceof VaultSailError) || !error.retryable || attempt >= 3) throw error;
        await sleep(Math.max(error.retryAfter, 1000 * 2 ** attempt)); this.guard();
      }
    }
  }
  async profile(): Promise<{ accountId: string; label: string }> {
    const value = await this.retry(() => this.api(XPAN + 'nas', { method: 'uinfo' }));
    if (!((typeof value.uk === 'number' && Number.isSafeInteger(value.uk)) || (typeof value.uk === 'string' && /^\d+$/.test(value.uk)))) throw new VaultSailError('response', '账号标识缺失，不能确认绑定。');
    const accountId = String(value.uk); return { accountId, label: '百度账号 ···' + accountId.slice(-4) };
  }
  async quota(): Promise<{ total: number; used: number }> {
    const value = await this.retry(() => this.api('https://pan.baidu.com/api/quota', { checkfree: '1', checkexpire: '1' }));
    if (typeof value.total !== 'number' || typeof value.used !== 'number' || value.total < 0 || value.used < 0) throw new VaultSailError('response', '配额响应不完整。');
    return { total: value.total, used: value.used };
  }
  async list(directory: string, cursor = '0'): Promise<RemotePage> {
    const offset = Number(cursor); if (!Number.isSafeInteger(offset) || offset < 0) throw new VaultSailError('response', '分页游标无效。');
    const full = this.absolute(directory);
    const value = await this.retry(() => this.api(XPAN + 'file', { method: 'list', dir: full, start: String(offset), limit: '100', order: 'name', desc: '0', web: '0' }));
    if (!Array.isArray(value.list) || value.list.length > 100) throw new VaultSailError('response', '目录列表不完整，不能当成空目录。');
    const objects: RemoteObject[] = value.list.map(raw => {
      const entry = record(raw);
      if (typeof entry.path !== 'string' || !entry.path.startsWith(full + '/') || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.isdir !== 0 && entry.isdir !== 1)) throw new VaultSailError('response', '远端返回了无效或越界文件。');
      const path = entry.path.slice(this.root.length + 1); relativePath(path);
      if (entry.path.slice(full.length + 1).includes('/')) throw new VaultSailError('response', '目录列表返回了非直接子项。');
      const id = typeof entry.fs_id === 'string' && /^\d+$/.test(entry.fs_id) ? entry.fs_id : typeof entry.fs_id === 'number' && Number.isSafeInteger(entry.fs_id) ? String(entry.fs_id) : undefined;
      if (entry.isdir === 0 && !id) throw new VaultSailError('response', '文件标识缺失或精度不足。');
      const object = { path, size: entry.size, isDirectory: entry.isdir === 1, id,
        etag: `${String(entry.md5 ?? '')}:${String(entry.server_mtime ?? '')}:${entry.size}` };
      if (!object.isDirectory) this.objects.set(path, object);
      return object;
    });
    return { objects, complete: objects.length < 100, ...(objects.length === 100 ? { nextCursor: String(offset + 100) } : {}) };
  }
  async listAll(directory: string): Promise<RemoteObject[]> { return listAll(this, directory); }
  private async find(path: string): Promise<RemoteObject | undefined> {
    relativePath(path); const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const cached = this.objects.get(path); if (cached) return cached;
    try { return (await this.listAll(parent)).find(file => file.path === path); }
    catch (error) { if (error instanceof VaultSailError && error.code === 'not-found') return undefined; throw error; }
  }
  async exists(path: string): Promise<boolean> { return Boolean(await this.find(path)); }
  async mkdir(directory: string): Promise<void> {
    const parts = relativePath(directory).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/'); const existing = await this.find(path);
      if (existing) { if (!existing.isDirectory) throw new VaultSailError('collision', '远端目录位置已被文件占用。'); continue; }
      await this.retry(async () => {
        try { const result = await this.api(XPAN + 'file', { method: 'create' }, { path: this.absolute(path), isdir: '1', rtype: '0' });
          if (result.path !== this.absolute(path) || result.isdir !== 1) throw new VaultSailError('response', '目录创建结果不符合请求。'); }
        catch (error) {
          if (error instanceof VaultSailError && (error.retryable || error.code === 'exists')) {
            const found = await this.find(path); if (found?.isDirectory) return;
          }
          throw error;
        }
      });
    }
  }
  async read(path: string): Promise<ArrayBuffer> {
    return this.retry(async () => {
      const file = await this.find(path);
      if (!file || file.isDirectory || !file.id) throw new VaultSailError('not-found', '远端内容对象不存在。');
      checkSize(file.size);
      const metadata = await this.api(XPAN + 'multimedia', { method: 'filemetas', fsids: '[' + file.id + ']', dlink: '1' });
      if (!Array.isArray(metadata.list) || metadata.list.length !== 1) throw new VaultSailError('response', '下载元数据不完整。');
      const entry = record(metadata.list[0]);
      if (typeof entry.size !== 'number') throw new VaultSailError('response', '下载大小元数据缺失。');
      checkSize(entry.size);
      if (entry.path !== this.absolute(path) || String(entry.fs_id) !== file.id || entry.size !== file.size || typeof entry.dlink !== 'string') throw new VaultSailError('response', '下载元数据与目标文件不一致。');
      const link = new URL(entry.dlink);
      if (link.protocol !== 'https:' || link.username || link.password || !['baidu.com', 'baidupcs.com'].some(host => link.hostname === host || link.hostname.endsWith('.' + host))) throw new VaultSailError('response', '下载地址不属于百度官方 HTTPS 服务。');
      this.guard(); link.searchParams.set('access_token', await this.auth.accessToken()); this.guard();
      const response = await request(this.transport, { url: link.toString(), headers: { 'User-Agent': 'pan.baidu.com' } });
      this.guard(); if (response.bytes.byteLength !== file.size) throw new VaultSailError('integrity', '下载长度校验失败，未应用文件。');
      return response.bytes;
    });
  }
  async writeImmutable(path: string, data: ArrayBuffer): Promise<void> {
    relativePath(path); checkSize(data.byteLength); this.guard(); const expected = hash(data);
    const verify = async (): Promise<boolean> => {
      if (!await this.exists(path)) return false;
      if (hash(await this.read(path)) !== expected) throw new VaultSailError('integrity', '不可变对象已存在但内容不同，禁止覆盖。');
      return true;
    };
    if (await verify()) return;
    if (path.includes('/')) await this.mkdir(path.slice(0, path.lastIndexOf('/')));
    await this.retry(async () => {
      if (await verify()) return;
      try {
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < data.byteLength; offset += CHUNK) chunks.push(new Uint8Array(data.slice(offset, offset + CHUNK)));
        if (!chunks.length) chunks.push(new Uint8Array());
        const blocks = chunks.map(chunk => bytesToHex(md5(chunk)));
        const base = { path: this.absolute(path), size: String(data.byteLength), isdir: '0', rtype: '0', block_list: JSON.stringify(blocks) };
        const pre = await this.api(XPAN + 'file', { method: 'precreate' }, { ...base, autoinit: '1' });
        if (pre.return_type === 2) { if (!await verify()) throw new VaultSailError('visibility', '秒传结果尚不可见，请稍后重试。', true); return; }
        if (typeof pre.uploadid !== 'string' || !pre.uploadid || !Array.isArray(pre.block_list) || new Set(pre.block_list).size !== pre.block_list.length) throw new VaultSailError('response', '预上传响应缺少有效分片信息。');
        for (const index of pre.block_list) {
          if (!Number.isInteger(index) || index < 0 || index >= chunks.length) throw new VaultSailError('response', '接口返回无效分片序号。');
          const boundary = 'vaultsail-' + uuid();
          const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`);
          const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`); const chunk = chunks[index];
          const body = new Uint8Array(head.length + chunk.length + tail.length); body.set(head); body.set(chunk, head.length); body.set(tail, head.length + chunk.length);
          const result = await this.api('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2', { method: 'upload', type: 'tmpfile', path: this.absolute(path), uploadid: pre.uploadid, partseq: String(index) }, undefined, body.buffer, 'multipart/form-data; boundary=' + boundary);
          if (result.md5 !== blocks[index]) throw new VaultSailError('integrity', '上传分片 Hash 不一致。');
        }
        const result = await this.api(XPAN + 'file', { method: 'create' }, { ...base, uploadid: pre.uploadid });
        if (result.path !== this.absolute(path) || result.size !== data.byteLength) throw new VaultSailError('response', '创建文件结果与请求不一致。');
        if (!await verify()) throw new VaultSailError('visibility', '已提交对象尚不可见，结果未确认。', true);
      } catch (error) {
        if (error instanceof VaultSailError && (error.retryable || error.code === 'exists')) { if (await verify()) return; }
        throw error;
      }
    });
  }
}
