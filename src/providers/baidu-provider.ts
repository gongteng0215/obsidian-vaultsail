import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { appRoot, checkSize, MAX_FILE_SIZE, hash, record, relativePath, sleep, uuid, VaultSailError } from '../core/safety.ts';
import { apiSuccess, request, urlWith, type HttpTransport, type RequestPolicy } from './http.ts';
import { RequestPool } from '../core/request-pool.ts';
import { mapConcurrent } from '../core/concurrency.ts';
import { validChunkConcurrency } from '../config.ts';
import type { CloudStorageProvider, ObjectTransferProgress, TransferObserver, RemoteObject, RemotePage } from './cloud-storage-provider';
import { listAll } from './provider-utils.ts';
export { listAll } from './provider-utils.ts';

export interface TokenSource { accessToken(forceRefresh?: boolean, rejectedToken?: string): Promise<string>; }
export interface BaiduRequestPolicy { apiTimeoutMs?: number; transferTimeoutMs?: number; signal?: AbortSignal; onRetry?: (waitedMs: number) => void; maxFileSize?: number; chunkConcurrency?: number; uploadSlots?: RequestPool; }
const XPAN = 'https://pan.baidu.com/rest/2.0/xpan/';
const CHUNK = 4 * 1024 * 1024;
export class BaiduProvider implements CloudStorageProvider {
  readonly id = 'baidu'; readonly displayName = '百度网盘'; readonly root: string;
  readonly capabilities = { canList: true, canRead: true, canWrite: true, canDelete: false, supportsConditionalWrites: false };
  private transport: HttpTransport; private auth: TokenSource; private active: () => boolean;
  private objects = new Map<string, RemoteObject>();
  private verified = new Map<string, { fingerprint: string; hash: string }>();
  private onActivity: (phase: 'verifying' | 'downloading') => void;
  private requestPolicy: BaiduRequestPolicy;
  private uploadSlots: RequestPool;
  private pendingDirectories = new Map<string, Promise<void>>();
  private pendingWrites = new Map<string, { hash: string; operation: Promise<void>; observers: Set<TransferObserver>; latest: ObjectTransferProgress }>();
  private pendingLookups = new Map<string, Promise<RemoteObject[]>>();
  private downloadLinks = new Map<string, { id: string; size: number; etag?: string; url: string; expiresAt: number }>();
  constructor(root: string, transport: HttpTransport, auth: TokenSource, active = () => true,
    onActivity: (phase: 'verifying' | 'downloading') => void = () => {}, requestPolicy: BaiduRequestPolicy = {}) {
    this.root = appRoot(root); this.transport = transport; this.auth = auth; this.active = active;
    this.requestPolicy = requestPolicy;
    if (!validChunkConcurrency(requestPolicy.chunkConcurrency ?? 1)) throw new VaultSailError('configuration', '分片并发必须为 1–4。');
    this.uploadSlots = requestPolicy.uploadSlots ?? new RequestPool(8);
    checkSize(0, requestPolicy.maxFileSize);
    this.onActivity = phase => { try { onActivity(phase); } catch { /* A progress view cannot affect transfer integrity. */ } };
  }
  isConfigured(): boolean { return this.active(); }
  private guard(): void { if (!this.active() || this.requestPolicy.signal?.aborted) throw new VaultSailError('cancelled', '任务已暂停，或账号及目录配置已更改。'); }
  private absolute(path: string): string { return path ? this.root + '/' + relativePath(path) : this.root; }
  private bodyLimit(path: string): number {
    // Raising attachment budgets must not permit enormous metadata downloads.
    return /^vaultsail\/vaults\/[^/]+\/(?:vault\.json|ops\/[^/]+\/[^/]+\.json)$/.test(path)
      ? 1024 * 1024 : this.requestPolicy.maxFileSize ?? MAX_FILE_SIZE;
  }
  private etag(value: Record<string, unknown>, size: number): string | undefined {
    if (typeof value.md5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(value.md5)) return undefined;
    return `${String(value.fs_id ?? '')}:${value.md5.toLowerCase()}:${String(value.server_mtime ?? value.mtime ?? '')}:${size}`;
  }
  private fingerprint(object: RemoteObject): string | undefined {
    return object.id && object.etag ? `${object.id}:${object.etag}:${object.size}` : undefined;
  }
  verifiedContentHash(object: RemoteObject): string | undefined {
    const fingerprint = this.fingerprint(object); const verified = this.verified.get(object.path);
    return fingerprint && verified?.fingerprint === fingerprint ? verified.hash : undefined;
  }
  private async api(endpoint: string, params: Record<string, string>, form?: Record<string, string>, body?: ArrayBuffer, contentType?: string,
    activity?: Pick<RequestPolicy, 'onPending' | 'onQueued' | 'onStarted'>): Promise<Record<string, unknown>> {
    const sliceUpload = endpoint === 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2' && params.method === 'upload';
    const stage = sliceUpload ? '上传文件分片' : params.method === 'uinfo' ? '读取百度账号' : params.method === 'list' ? '读取云端目录'
      : params.method === 'precreate' ? '申请文件上传' : params.method === 'filemetas' ? '读取下载信息'
      : params.method === 'create' ? form?.isdir === '1' ? '创建云端目录' : '提交云端文件' : '读取网盘配额';
    let rejectedToken: string | undefined;
    for (let refresh = 0; refresh < 2; refresh++) {
      this.guard(); const token = await this.auth.accessToken(refresh > 0, rejectedToken); this.guard();
      try {
        const response = await request(this.transport, { url: urlWith(endpoint, { ...params, access_token: token }),
          method: form || body ? 'POST' : 'GET', headers: form || body ? { 'Content-Type': contentType ?? 'application/x-www-form-urlencoded' } : {},
          body: form ? new URLSearchParams(form).toString() : body }, true, {
          timeoutMs: sliceUpload ? this.requestPolicy.transferTimeoutMs ?? 120_000 : this.requestPolicy.apiTimeoutMs ?? 30_000,
          signal: this.requestPolicy.signal,
          beforeStart: () => this.guard(),
          ...activity,
        });
        this.guard(); const value = apiSuccess(response.json, sliceUpload ? 'pcs-upload' : 'xpan');
        if (response.status >= 400) throw new VaultSailError('http', `接口请求未通过（HTTP ${response.status}）。`);
        return value;
      } catch (error) {
        if (refresh === 0 && error instanceof VaultSailError && error.code === 'token-expired') { rejectedToken = token; continue; }
        if (error instanceof VaultSailError) throw new VaultSailError(error.code, `${stage}：${error.message}`, error.retryable, error.retryAfter);
        throw error;
      }
    }
    throw new VaultSailError('authentication', '令牌刷新后仍不可用，请重新授权。');
  }
  private async retry<T>(operation: () => Promise<T>, options: { onWait?: (until: number, nextAttempt: number) => void; guard?: () => void; } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.guard(); options.guard?.(); try { return await operation(); }
      catch (error) {
        if (!(error instanceof VaultSailError) || !error.retryable || attempt >= 3) throw error;
        this.guard();
        // Respect the complete server delay, but let pause/disconnect stop a
        // backoff instead of keeping the task busy until the countdown expires.
        let remaining = Math.max(error.retryAfter, 1000 * 2 ** attempt);
        const started = Date.now();
        this.transport.cooldown?.(started + remaining);
        try { options.onWait?.(started + remaining, attempt + 2); } catch { /* UI only. */ }
        try {
          while (remaining > 0) {
            const interval = Math.min(remaining, 250);
            await sleep(interval, this.requestPolicy.signal); this.guard(); options.guard?.(); remaining -= interval;
          }
        } finally { try { this.requestPolicy.onRetry?.(Math.max(0, Date.now() - started)); } catch { /* Diagnostics are advisory. */ } }
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
        etag: this.etag(entry, entry.size) };
      this.objects.set(path, object);
      return object;
    });
    return { objects, complete: objects.length < 100, ...(objects.length === 100 ? { nextCursor: String(offset + 100) } : {}) };
  }
  async listAll(directory: string): Promise<RemoteObject[]> { return listAll(this, directory); }
  private downloadUrl(value: unknown): string {
    if (typeof value !== 'string') throw new VaultSailError('response', '下载地址缺失。');
    let link: URL; try { link = new URL(value); } catch { throw new VaultSailError('response', '下载地址无效。'); }
    if (link.protocol !== 'https:' || link.username || link.password || !['baidu.com', 'baidupcs.com'].some(host => link.hostname === host || link.hostname.endsWith('.' + host))) throw new VaultSailError('response', '下载地址不属于百度官方 HTTPS 服务。');
    return link.toString();
  }
  private async metadata(files: RemoteObject[]): Promise<RemoteObject[]> {
    if (!files.length || files.length > 100 || files.some(file => file.isDirectory || !file.id) || new Set(files.map(file => file.id)).size !== files.length)
      throw new VaultSailError('response', '批量元数据请求无效。');
    const response = await this.retry(() => this.api(XPAN + 'multimedia', { method: 'filemetas', fsids: '[' + files.map(file => file.id).join(',') + ']', dlink: '1' }));
    if (!Array.isArray(response.list) || response.list.length !== files.length) throw new VaultSailError('response', '下载元数据不完整。');
    const byId = new Map<string, Record<string, unknown>>();
    for (const raw of response.list) {
      const entry = record(raw); const id = typeof entry.fs_id === 'string' && /^\d+$/.test(entry.fs_id) ? entry.fs_id
        : typeof entry.fs_id === 'number' && Number.isSafeInteger(entry.fs_id) ? String(entry.fs_id) : undefined;
      if (!id || byId.has(id)) throw new VaultSailError('response', '元数据包含无效或重复文件标识。');
      byId.set(id, entry);
    }
    // Validate the complete batch before publishing any cache entries.
    const verified = files.map(file => {
      const entry = byId.get(file.id!);
      if (!entry || typeof entry.size !== 'number') throw new VaultSailError('response', '下载大小元数据缺失。');
      checkSize(entry.size, this.bodyLimit(file.path));
      if (!entry || entry.path !== this.absolute(file.path) || entry.size !== file.size || (entry.isdir !== undefined && entry.isdir !== 0)) throw new VaultSailError('response', '下载元数据与目标文件不一致。');
      checkSize(file.size, this.bodyLimit(file.path));
      const inspectedTag = this.etag(entry, file.size);
      const prefix = typeof entry.md5 === 'string' ? `${file.id}:${entry.md5.toLowerCase()}:` : undefined;
      const etag = prefix && file.etag?.startsWith(prefix) ? file.etag : inspectedTag ?? file.etag;
      return { file: { ...file, etag }, url: this.downloadUrl(entry.dlink) };
    });
    this.guard();
    for (const { file, url } of verified) {
      this.objects.set(file.path, file);
      // A short lifetime, scoped to this provider/connection, avoids persisting
      // token-bearing links and lets cold scans share a batch's download links.
      this.downloadLinks.set(file.path, { id: file.id!, size: file.size, etag: file.etag, url, expiresAt: Date.now() + 60_000 });
    }
    return verified.map(entry => entry.file);
  }
  async inspect(objects: RemoteObject[]): Promise<RemoteObject[]> {
    const result = objects.map(object => ({ ...object }));
    const missing = result.flatMap((file, index) => !file.isDirectory && file.etag === undefined ? [{ file, index }] : []);
    for (let start = 0; start < missing.length; start += 100) {
      const batch = missing.slice(start, start + 100), inspected = await this.metadata(batch.map(row => row.file));
      batch.forEach((row, index) => { result[row.index] = inspected[index]; });
    }
    return result;
  }
  private async lookup(directory: string, fresh: boolean): Promise<RemoteObject[]> {
    // Share only overlapping ordinary lookups, never retain an absence cache.
    // Recovery/uncertain-write verification must start a new server listing.
    if (fresh) return this.listAll(directory);
    const pending = this.pendingLookups.get(directory); if (pending) return pending;
    const operation = this.listAll(directory); this.pendingLookups.set(directory, operation);
    try { return await operation; } finally { if (this.pendingLookups.get(directory) === operation) this.pendingLookups.delete(directory); }
  }
  private async find(path: string, fresh = false): Promise<RemoteObject | undefined> {
    relativePath(path); const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const cached = this.objects.get(path); if (cached && !fresh) return cached;
    try {
      const found = (await this.lookup(parent, fresh)).find(file => file.path === path);
      if (!found) { this.objects.delete(path); this.verified.delete(path); }
      return found;
    }
    catch (error) { if (error instanceof VaultSailError && error.code === 'not-found') { this.objects.delete(path); this.verified.delete(path); return undefined; } throw error; }
  }
  async exists(path: string): Promise<boolean> { return Boolean(await this.find(path)); }
  async mkdir(directory: string): Promise<void> {
    const parts = relativePath(directory).split('/');
    for (let i = 1; i <= parts.length; i++) await this.ensureDirectory(parts.slice(0, i).join('/'));
  }
  private async ensureDirectory(path: string): Promise<void> {
    const pending = this.pendingDirectories.get(path); if (pending) return pending;
    const operation = this.createDirectory(path); this.pendingDirectories.set(path, operation);
    try { await operation; } finally { if (this.pendingDirectories.get(path) === operation) this.pendingDirectories.delete(path); }
  }
  private async createDirectory(path: string): Promise<void> {
      const existing = await this.find(path);
      if (existing) { if (!existing.isDirectory) throw new VaultSailError('collision', '远端目录位置已被文件占用。'); return; }
      await this.retry(async () => {
        try { const result = await this.api(XPAN + 'file', { method: 'create' }, { path: this.absolute(path), isdir: '1', rtype: '0' });
          if (result.path !== this.absolute(path) || result.isdir !== 1) throw new VaultSailError('response', '目录创建结果不符合请求。');
          this.objects.set(path, { path, size: 0, isDirectory: true }); }
        catch (error) {
          if (error instanceof VaultSailError && error.code === 'write-timeout') {
            try { if ((await this.find(path, true))?.isDirectory) return; } catch { /* Keep the unknown write non-retryable. */ }
            throw error;
          }
          if (error instanceof VaultSailError && (error.retryable || error.code === 'exists')) {
            const found = await this.find(path, true); if (found?.isDirectory) return;
          }
          throw error;
        }
      });
  }
  async read(path: string, phase: 'downloading' | 'verifying' = 'downloading'): Promise<ArrayBuffer> {
    this.onActivity(phase);
    return this.retry(async () => {
      const file = await this.find(path);
      if (!file || file.isDirectory || !file.id) throw new VaultSailError('not-found', '远端内容对象不存在。');
      checkSize(file.size, this.bodyLimit(path));
      let cached = this.downloadLinks.get(path);
      if (!cached || cached.id !== file.id || cached.size !== file.size || cached.etag !== file.etag || cached.expiresAt <= Date.now()) {
        await this.metadata([file]); cached = this.downloadLinks.get(path)!;
      }
      const link = new URL(cached.url);
      this.downloadLinks.delete(path);
      this.guard(); link.searchParams.set('access_token', await this.auth.accessToken()); this.guard();
      let response;
      try { response = await request(this.transport, { url: link.toString(), headers: { 'User-Agent': 'pan.baidu.com' } }, false,
        { timeoutMs: this.requestPolicy.transferTimeoutMs ?? 120_000, signal: this.requestPolicy.signal, beforeStart: () => this.guard() }); }
      catch (error) { this.downloadLinks.delete(path); throw error; }
      this.guard(); if (response.bytes.byteLength !== file.size) throw new VaultSailError('integrity', '下载长度校验失败，未应用文件。');
      return response.bytes;
    });
  }
  private observe(observer: TransferObserver | undefined, progress: ObjectTransferProgress): void {
    try { observer?.({ ...progress, ...(progress.activeParts ? { activeParts: [...progress.activeParts] } : {}),
      ...(progress.waitingParts ? { waitingParts: progress.waitingParts.map(part => ({ ...part })) } : {}) }); } catch { /* A detached view cannot interrupt an immutable write. */ }
  }
  async writeImmutable(path: string, data: ArrayBuffer, onProgress?: TransferObserver): Promise<void> {
    relativePath(path); checkSize(data.byteLength, this.bodyLimit(path)); this.guard(); const expected = hash(data);
    const pending = this.pendingWrites.get(path);
    if (pending) {
      if (pending.hash !== expected) throw new VaultSailError('integrity', '同一不可变对象出现不同内容，已停止写入。');
      if (onProgress) { pending.observers.add(onProgress); this.observe(onProgress, pending.latest); }
      try { await pending.operation; } finally { if (onProgress) pending.observers.delete(onProgress); }
      return;
    }
    const latest: ObjectTransferProgress = { stage: 'preparing', uploadedBytes: 0, transferredBytes: 0, totalBytes: data.byteLength, completedParts: 0, totalParts: Math.max(1, Math.ceil(data.byteLength / CHUNK)), preparedParts: 0, attempt: 1 };
    const entry = { hash: expected, operation: Promise.resolve(), observers: new Set(onProgress ? [onProgress] : []), latest };
    const notify: TransferObserver = progress => { entry.latest = { ...progress }; for (const observer of entry.observers) this.observe(observer, progress); };
    const operation = this.writeObject(path, data, expected, notify); entry.operation = operation; this.pendingWrites.set(path, entry); notify(latest);
    try { await operation; } finally { if (this.pendingWrites.get(path)?.operation === operation) this.pendingWrites.delete(path); }
  }
  private async writeObject(path: string, data: ArrayBuffer, expected: string, onProgress: TransferObserver): Promise<void> {
    let progress: ObjectTransferProgress = { stage: 'preparing', uploadedBytes: 0, transferredBytes: 0, totalBytes: data.byteLength, completedParts: 0, totalParts: Math.max(1, Math.ceil(data.byteLength / CHUNK)), preparedParts: 0, attempt: 1 };
    const report = (update: Partial<ObjectTransferProgress>) => { progress = { ...progress, ...update }; onProgress(progress); };
    const verify = async (fresh = false): Promise<boolean> => {
      // Reuse a prior full SHA-256 verification only after fresh server metadata
      // confirms the same object ID, digest, size and modification fingerprint.
      const file = await this.find(path, fresh || this.verified.has(path));
      if (!file) return false;
      if (this.verifiedContentHash(file) === expected) { report({ stage: 'verified', uploadedBytes: data.byteLength, completedParts: progress.totalParts, currentPart: undefined }); return true; }
      report({ stage: 'verifying', currentPart: undefined });
      if (hash(await this.read(path, 'verifying')) !== expected) throw new VaultSailError('integrity', '不可变对象已存在但内容不同，禁止覆盖。');
      const object = this.objects.get(path); const fingerprint = object && this.fingerprint(object);
      if (fingerprint) this.verified.set(path, { fingerprint, hash: expected });
      report({ stage: 'verified', uploadedBytes: data.byteLength, completedParts: progress.totalParts, currentPart: undefined });
      return true;
    };
    if (await verify()) return;
    if (path.includes('/')) await this.mkdir(path.slice(0, path.lastIndexOf('/')));
    // This call owns one stable source. Retry the session without repeating all block hashing.
    const source = new Uint8Array(data), blocks: string[] = [];
    report({ stage: 'preparing' });
    for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
      this.guard(); blocks.push(bytesToHex(md5(source.subarray(offset, offset + CHUNK)))); report({ preparedParts: blocks.length });
      if (data.byteLength > CHUNK) await sleep(0, this.requestPolicy.signal);
    }
    if (!blocks.length) blocks.push(bytesToHex(md5(new Uint8Array())));
    let firstAttempt = true;
    let attempt = 0;
    let sessionCreated = false;
    await this.retry(async () => {
      if (!firstAttempt && await verify(true)) return;
      firstAttempt = false;
      report({ stage: 'preparing', uploadedBytes: 0, transferredBytes: 0, completedParts: 0, preparedParts: blocks.length, currentPart: undefined, activeParts: [], waitingParts: [], retryAt: undefined, waitingForSlot: false, requestPending: false, retryCount: 0, attempt: ++attempt });
      try {
        const base = { path: this.absolute(path), size: String(data.byteLength), isdir: '0', rtype: '0', block_list: JSON.stringify(blocks) };
        const pre = await this.api(XPAN + 'file', { method: 'precreate' }, { ...base, autoinit: '1' });
        if (pre.return_type === 2) { if (!await verify()) throw new VaultSailError('visibility', '秒传结果尚不可见，请稍后重试。', true); return; }
        if (typeof pre.uploadid !== 'string' || !pre.uploadid || !Array.isArray(pre.block_list) || new Set(pre.block_list).size !== pre.block_list.length) throw new VaultSailError('response', '预上传响应缺少有效分片信息。');
        if (pre.block_list.some(index => !Number.isInteger(index) || index < 0 || index >= blocks.length)) throw new VaultSailError('response', '接口返回无效分片序号。');
        sessionCreated = true;
        const requested = new Set<number>(pre.block_list as number[]), acknowledged = new Set<number>(); let acknowledgedBytes = 0;
        for (let index = 0; index < blocks.length; index++) if (!requested.has(index)) { acknowledged.add(index); acknowledgedBytes += Math.max(0, Math.min(CHUNK, data.byteLength - index * CHUNK)); }
        report({ stage: 'uploading', uploadedBytes: acknowledgedBytes, completedParts: acknowledged.size });
        const activeParts = new Set<number>(), queuedParts = new Set<number>(), pendingParts = new Set<number>();
        const waiting = new Map<number, { part: number; until: number; attempt: number }>(); let retries = 0; let batchFailure: unknown;
        const detail = () => { const active = [...activeParts].sort((a, b) => a - b); report({ activeParts: active, currentPart: active[0],
          waitingParts: [...waiting.values()], waitingForSlot: queuedParts.size > 0, requestPending: pendingParts.size > 0, retryCount: retries }); };
        const check = () => { this.guard(); if (batchFailure) throw batchFailure; };
        await mapConcurrent(pre.block_list as number[], this.requestPolicy.chunkConcurrency ?? 1, async index => {
          const part = index + 1;
          try {
            await this.retry(async () => {
              check(); waiting.delete(part); queuedParts.add(part); detail();
              let release: (() => void) | undefined; const natives: Promise<void>[] = []; let nativeCount = 0;
              try {
                release = await this.uploadSlots.acquire(this.requestPolicy.signal, this.requestPolicy.transferTimeoutMs ?? 120000);
                check();
                const boundary = 'vaultsail-' + uuid();
                const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`);
                const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`); const chunk = source.subarray(index * CHUNK, (index + 1) * CHUNK);
                const body = new Uint8Array(head.length + chunk.length + tail.length); body.set(head); body.set(chunk, head.length); body.set(tail, head.length + chunk.length);
                let result;
                try { result = await this.api('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2', { method: 'upload', type: 'tmpfile', path: this.absolute(path), uploadid: pre.uploadid as string, partseq: String(index) }, undefined, body.buffer, 'multipart/form-data; boundary=' + boundary, {
                  onQueued: () => { queuedParts.add(part); activeParts.delete(part); detail(); },
                  onStarted: () => { queuedParts.delete(part); activeParts.add(part); detail(); },
                  onPending: settled => { nativeCount++; const done = settled.then(() => { nativeCount--; }); natives.push(done); },
                }); } catch (error) {
                  if (error instanceof VaultSailError && error.code === 'network') throw new VaultSailError('write-timeout', '分片请求异常，远端结果待核验；本轮未提交文件，任务已保留。');
                  throw error;
                }
                if (String(result.md5).toLowerCase() !== blocks[index]) throw new VaultSailError('integrity', '上传分片 Hash 不一致。');
                check();
                if (!acknowledged.has(index)) { acknowledged.add(index); acknowledgedBytes += chunk.byteLength;
                  report({ uploadedBytes: acknowledgedBytes, transferredBytes: (progress.transferredBytes ?? 0) + chunk.byteLength, completedParts: acknowledged.size }); }
              } catch (error) {
                // Stop sibling workers before draining an uncertain native write.
                // A timed-out request may otherwise hold this worker while siblings start more slices.
                if (!(error instanceof VaultSailError) || !error.retryable) batchFailure ??= error;
                throw error;
              } finally {
                if (nativeCount) { pendingParts.add(part); detail(); }
                await Promise.allSettled(natives); release?.();
                pendingParts.delete(part); activeParts.delete(part); queuedParts.delete(part); detail();
              }
            }, { guard: check, onWait: (until, nextAttempt) => { retries++; waiting.set(part, { part, until, attempt: nextAttempt }); detail(); } });
          } catch (error) {
            const failure = error instanceof VaultSailError && error.retryable ? new VaultSailError(error.code, error.message, false, error.retryAfter) : error;
            batchFailure ??= failure; waiting.delete(part); detail(); throw failure;
          }
        });
        report({ stage: 'committing', currentPart: undefined });
        const result = await this.retry(async () => {
          report({ retryAt: undefined });
          try { return await this.api(XPAN + 'file', { method: 'create' }, { ...base, uploadid: pre.uploadid as string }); }
          catch (error) { if (error instanceof VaultSailError && error.retryable && await verify(true)) return undefined; throw error; }
        }, { onWait: until => report({ stage: 'committing', retryAt: until, retryCount: (progress.retryCount ?? 0) + 1 }) });
        if (!result) return;
        if (result.path !== this.absolute(path) || result.size !== data.byteLength) throw new VaultSailError('response', '创建文件结果与请求不一致。');
        const id = typeof result.fs_id === 'string' && /^\d+$/.test(result.fs_id) ? result.fs_id
          : typeof result.fs_id === 'number' && Number.isSafeInteger(result.fs_id) ? String(result.fs_id) : undefined;
        if (id) this.objects.set(path, { path, size: data.byteLength, id, isDirectory: false, etag: this.etag(result, data.byteLength) });
        if (!await verify()) throw new VaultSailError('visibility', '已提交对象尚不可见，结果未确认。', true);
      } catch (error) {
        if (error instanceof VaultSailError && error.code === 'write-timeout') {
          // A timeout cannot stop Obsidian's native write. Only accept a verified
          // result; an absent or unreadable object must not trigger a second write.
          try { if (await verify(true)) return; } catch { /* Preserve the original uncertain-write result. */ }
          throw error;
        }
        if (error instanceof VaultSailError && (error.retryable || error.code === 'exists')) { if (await verify(true)) return; }
        if (sessionCreated && error instanceof VaultSailError && error.retryable) throw new VaultSailError(error.code, error.message, false, error.retryAfter);
        throw error;
      }
    }, { onWait: until => report({ retryAt: until, retryCount: (progress.retryCount ?? 0) + 1 }) });
  }
}
