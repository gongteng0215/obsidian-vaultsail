import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, conflictCopyPath, hash, assertNoCollisions, appRoot, included, MAX_FILE_SIZE, uuid, VaultSailError } from '../src/core/safety.ts';
import { RemoteVaultStore, buildHeads, validateRevision, type Revision } from '../src/sync/remote-vault.ts';
import { SyncEngine, newState, type LocalFiles, type StateStore, type SyncState } from '../src/sync/engine.ts';
import type { CloudStorageProvider, RemotePage } from '../src/providers/cloud-storage-provider.ts';
import type { SyncProgress } from '../src/sync/progress.ts';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { baiduHarness } from './fixtures/baidu.ts';

class MemoryCloud implements CloudStorageProvider {
  readonly id = 'mock'; readonly displayName = 'mock'; readonly root = '/apps/test';
  readonly capabilities = { canList: true, canRead: true, canWrite: true, canDelete: false, supportsConditionalWrites: false };
  files = new Map<string, ArrayBuffer>(); dirs = new Set<string>(); published = 0; failAfterPublish = false; badListing = false;
  isConfigured(): boolean { return true; }
  async list(dir: string, cursor = '0'): Promise<RemotePage> {
    if (this.badListing) throw new VaultSailError('response', 'incomplete list');
    if (dir && !this.dirs.has(dir)) throw new VaultSailError('not-found', 'missing');
    const prefix = dir ? dir + '/' : '';
    const objects = [...this.files].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([path, data]) => ({ path, size: data.byteLength, isDirectory: false }));
    objects.push(...[...this.dirs].filter(p => p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes('/')).map(path => ({ path, size: 0, isDirectory: true })));
    objects.sort((a, b) => a.path.localeCompare(b.path)); const offset = Number(cursor); const page = objects.slice(offset, offset + 40);
    return { objects: page, complete: page.length < 40, ...(page.length === 40 ? { nextCursor: String(offset + 40) } : {}) };
  }
  async read(path: string): Promise<ArrayBuffer> { const data = this.files.get(path); if (!data) throw new VaultSailError('not-found', 'missing'); return data.slice(0); }
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string): Promise<void> { const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/')); }
  async writeImmutable(path: string, data: ArrayBuffer): Promise<void> {
    const old = this.files.get(path); if (old && hash(old) !== hash(data)) throw new VaultSailError('integrity', 'collision');
    if (path.includes('/')) await this.mkdir(path.slice(0, path.lastIndexOf('/')));
    if (!old) { this.files.set(path, data.slice(0)); if (path.includes('/ops/')) this.published++; }
    if (path.includes('/ops/') && this.failAfterPublish) { this.failAfterPublish = false; throw new VaultSailError('network', 'response lost'); }
  }
}
class MemoryLocal implements LocalFiles {
  files = new Map<string, ArrayBuffer>(); recovery = new Map<string, ArrayBuffer>(); staging = new Map<string, ArrayBuffer>(); failApply = false;
  async paths(): Promise<string[]> { return [...this.files.keys()]; }
  async read(path: string): Promise<ArrayBuffer | null> { return this.files.get(path)?.slice(0) ?? null; }
  async stage(id: string, data: ArrayBuffer): Promise<void> { this.staging.set(id, data.slice(0)); }
  async staged(id: string): Promise<ArrayBuffer | null> { return this.staging.get(id)?.slice(0) ?? null; }
  async readConflictCopy(path: string, id: string): Promise<ArrayBuffer | null> { return this.files.get(conflictCopyPath(path, id))?.slice(0) ?? null; }
  async writeConflictCopy(path: string, id: string, data: ArrayBuffer): Promise<void> {
    const target = conflictCopyPath(path, id); const old = this.files.get(target);
    if (old && hash(old) !== hash(data)) throw new VaultSailError('integrity', 'edited copy'); this.files.set(target, data.slice(0));
  }
  async preserve(path: string, data: ArrayBuffer, id: string): Promise<string> { const key = id + '/' + path; this.recovery.set(key, data.slice(0)); return key; }
  async apply(path: string, data: ArrayBuffer | null, expected: string | null, id: string): Promise<void> {
    if (this.failApply) { this.failApply = false; throw new VaultSailError('network', 'interrupted'); }
    const old = this.files.get(path); if ((old ? hash(old) : null) !== expected) throw new VaultSailError('changed', 'edited');
    if (old) await this.preserve(path, old, id); if (data) this.files.set(path, data.slice(0)); else this.files.delete(path);
  }
}
class MemoryState implements StateStore {
  value: SyncState = newState();
  async load(): Promise<SyncState> { return structuredClone(this.value); }
  async save(state: SyncState): Promise<void> { this.value = structuredClone(state); }
}
async function setup(concurrency = 3) {
  const cloud = new MemoryCloud(); const remote = new RemoteVaultStore(cloud, undefined, concurrency); const vault = await remote.create('测试库');
  const a = new MemoryLocal(); const b = new MemoryLocal(); const sa = new MemoryState(); const sb = new MemoryState();
  const ea = new SyncEngine(remote, a, sa, vault.vaultId, '.obsidian', () => {}, concurrency); const eb = new SyncEngine(remote, b, sb, vault.vaultId, '.obsidian', () => {}, concurrency);
  return { cloud, remote, vault, a, b, sa, sb, ea, eb };
}

test('seven unchanged notes scan once, batch missing fingerprints and use persisted cache on later scans', async () => {
  const h = baiduHarness(), writer = new RemoteVaultStore(h.provider), vault = await writer.create('七篇笔记'), deviceId = uuid();
  const local = new MemoryLocal(), state = new MemoryState(); let saved: unknown;
  for (let i = 0; i < 7; i++) {
    const data = bytes('note-content-' + i), path = `note-${i}.md`; local.files.set(path, data);
    await writer.publish(vault.vaultId, { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId, fileId: uuid(), path,
      parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 }, data);
  }
  let requests = 0, downloads = 0; const scans: { listed: number; cacheHits: number; read: number }[] = [];
  const disk = { load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
  const provider = () => new BaiduProvider('/apps/中文应用', async input => {
    requests++; const url = new URL(input.url); if (url.pathname.startsWith('/file/')) downloads++;
    const result = await h.transport(input);
    if (url.searchParams.get('method') === 'list') for (const entry of (result.json as { list?: Record<string, unknown>[] }).list ?? []) delete entry.md5;
    return result;
  }, { accessToken: async () => 'private-access' });
  const fresh = () => new SyncEngine(new RemoteVaultStore(provider(), disk, 8, stats => scans.push(stats)), local, state, vault.vaultId);
  const engine = fresh(); const initialPublished = h.counts().createCalls;
  await engine.sync(); assert.equal(scans.length, 1); assert.equal(requests, 13); assert.equal(downloads, 8);
  assert.equal(scans[0].read, 7); assert.equal(state.value.knownOps.length, 7);
  requests = downloads = 0; await engine.sync(); assert.equal(requests, 5); assert.equal(downloads, 0); assert.equal(scans[1].cacheHits, 7);
  requests = downloads = 0; await fresh().sync(); assert.equal(requests, 6); assert.equal(downloads, 1); assert.equal(scans[2].cacheHits, 7);
  assert.equal(h.counts().createCalls, initialPublished, 'no-change scans never publish records or content');
  local.files.set('note-0.md', bytes('local edit')); await engine.sync();
  assert.equal((await writer.revisions(vault.vaultId)).length, 8);
});
test('default engines transfer and read history with eight concurrent jobs and preserve all file hashes', async () => {
  const cloud = new MemoryCloud(); const remote = new RemoteVaultStore(cloud); const vault = await remote.create('默认并发');
  const a = new MemoryLocal(), b = new MemoryLocal(), sa = new MemoryState(), sb = new MemoryState();
  const ea = new SyncEngine(remote, a, sa, vault.vaultId), eb = new SyncEngine(new RemoteVaultStore(cloud), b, sb, vault.vaultId);
  for (let i = 0; i < 16; i++) a.files.set(`note-${i}.md`, bytes('content-' + i));
  let active = 0; let peak = 0; const write = cloud.writeImmutable.bind(cloud), read = cloud.read.bind(cloud);
  cloud.writeImmutable = async (path, data) => { active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); await write(path, data); } finally { active--; } };
  await ea.sync(); assert.equal(peak, 8); peak = 0;
  let historyActive = 0, historyPeak = 0, downloadActive = 0, downloadPeak = 0;
  cloud.read = async path => {
    active++; peak = Math.max(peak, active);
    const history = path.includes('/ops/'), content = path.includes('/blobs/');
    if (history) { historyActive++; historyPeak = Math.max(historyPeak, historyActive); }
    if (content) { downloadActive++; downloadPeak = Math.max(downloadPeak, downloadActive); }
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await read(path); }
    finally { active--; if (history) historyActive--; if (content) downloadActive--; }
  };
  await eb.sync(); assert.equal(peak, 8); assert.equal(historyPeak, 8); assert.equal(downloadPeak, 8); assert.equal(b.files.size, 16);
  assert.equal(sa.value.journals.length, 0); assert.equal(sb.value.journals.length, 0);
  for (const [path, data] of a.files) assert.equal(hash(b.files.get(path)!), hash(data));
});
test('three file transfers overlap while journal saves and local application remain serialized', async () => {
  const { a, b, ea, eb, cloud, sa, sb } = await setup();
  for (let i = 0; i < 9; i++) a.files.set(`note-${i}.md`, bytes('content-' + i));
  let active = 0; let peak = 0; let saving = 0; let applying = 0; let maxJournals = 0;
  const write = cloud.writeImmutable.bind(cloud); const read = cloud.read.bind(cloud);
  cloud.writeImmutable = async (path, data) => { active++; peak = Math.max(peak, active); try { await new Promise(resolve => setTimeout(resolve, 5)); await write(path, data); } finally { active--; } };
  for (const store of [sa, sb]) { const save = store.save.bind(store); store.save = async state => {
    assert.equal(saving++, 0, 'state saves must never overlap'); maxJournals = Math.max(maxJournals, state.journals.length);
    try { await new Promise(resolve => setTimeout(resolve, 1)); await save(state); } finally { saving--; }
  }; }
  const uploaded = await ea.execute(await ea.preview('upload'), () => { throw new Error('detached observer'); });
  assert.equal(uploaded.uploadedFiles, 9); assert.equal(peak, 3); assert.equal(maxJournals, 3);
  peak = 0; cloud.read = async path => { if (!path.includes('/blobs/')) return read(path); active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await read(path); } finally { active--; } };
  const apply = b.apply.bind(b); b.apply = async (...args) => { assert.equal(applying++, 0, 'local writes must never overlap');
    try { await new Promise(resolve => setTimeout(resolve, 1)); await apply(...args); } finally { applying--; } };
  const downloaded = await eb.sync(); assert.equal(downloaded.downloadedFiles, 9); assert.equal(peak, 3);
  assert.equal(sa.value.journals.length, 0); assert.equal(sb.value.journals.length, 0);
  for (const [path, data] of a.files) assert.equal(hash(b.files.get(path)!), hash(data));
  const count = cloud.published; await ea.sync(); await eb.sync(); assert.equal(cloud.published, count);
});
test('changing the idle concurrency applies to an existing preview and remains bounded at four', async () => {
  const { a, ea, cloud } = await setup(); for (let i = 0; i < 8; i++) a.files.set(`note-${i}.md`, bytes('data-' + i));
  const plan = await ea.preview('upload'); ea.configureConcurrency(4);
  let active = 0; let peak = 0; const write = cloud.writeImmutable.bind(cloud);
  cloud.writeImmutable = async (path, data) => { active++; peak = Math.max(peak, active);
    try { assert.throws(() => ea.configureConcurrency(2), { code: 'busy' }); await new Promise(resolve => setTimeout(resolve, 2)); await write(path, data); } finally { active--; } };
  const result = await ea.execute(plan); assert.equal(result.uploadedFiles, 8); assert.equal(peak, 4);
});

test('parallel response loss drains in-flight files and recovers their original operation IDs', async () => {
  const { a, ea, cloud, sa } = await setup(); for (let i = 0; i < 6; i++) a.files.set(`note-${i}.md`, bytes('data-' + i));
  const write = cloud.writeImmutable.bind(cloud); const started: string[] = []; let release!: () => void; let lost = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cloud.writeImmutable = async (path, data) => {
    if (path.includes('/blobs/')) { started.push(path); if (started.length > 1) await gate; }
    await write(path, data);
    if (path.includes('/ops/') && !lost) { lost = true; throw new VaultSailError('network', 'response lost'); }
  };
  let settled = false; const rejected = assert.rejects(ea.sync().finally(() => { settled = true; }), { code: 'network' });
  for (let i = 0; i < 200 && !lost; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(lost, true); assert.equal(started.length, 3); assert.equal(settled, false); release(); await rejected;
  assert.equal(cloud.published, 3); assert.equal(sa.value.journals.length, 1);
  const oldId = sa.value.journals[0].id; await ea.recover(); assert.equal(cloud.published, 3); assert.ok(sa.value.knownOps.includes(oldId));
  await ea.sync(); assert.equal(cloud.published, 6); assert.equal(sa.value.journals.length, 0);
});

test('a failed state commit leaves other prepared journals recoverable without later workers overwriting them', async () => {
  const { a, ea, cloud, sa } = await setup(); for (let i = 0; i < 3; i++) a.files.set(`note-${i}.md`, bytes('data-' + i));
  const save = sa.save.bind(sa); let failed = false;
  sa.save = async state => { if (!failed && state.journals.some(j => j.stage === 'published')) { failed = true; throw new VaultSailError('state', 'synthetic disk failure'); } await save(state); };
  await assert.rejects(ea.sync(), { code: 'state' }); assert.equal(sa.value.journals.length, 3); assert.equal(cloud.published, 3);
  await ea.recover(); assert.equal(sa.value.journals.length, 0); assert.equal(cloud.published, 3);
  await ea.sync(); assert.equal(cloud.published, 3);
});

test('large attachment batches reduce concurrency and keep verified content intact', async () => {
  const { a, ea, cloud } = await setup();
  for (let i = 0; i < 3; i++) { const data = new Uint8Array(9 * 1024 * 1024); data.fill(i); a.files.set(`large-${i}.bin`, data.buffer); }
  let active = 0; let peak = 0; const write = cloud.writeImmutable.bind(cloud);
  cloud.writeImmutable = async (path, data) => { active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); await write(path, data); } finally { active--; } };
  const result = await ea.sync(); assert.equal(peak, 2); assert.equal(result.uploadedFiles, 3);
  for (const data of a.files.values()) assert.ok([...cloud.files.keys()].some(path => path.endsWith('/blobs/' + hash(data))));
});

test('cold history enumeration reads three records concurrently and reports verified record counts', async () => {
  const { a, ea, cloud, vault } = await setup(); for (let i = 0; i < 9; i++) a.files.set(`note-${i}.md`, bytes('data-' + i)); await ea.sync();
  let active = 0; let peak = 0; const read = cloud.read.bind(cloud); const counts: number[] = [];
  cloud.read = async path => { if (!path.includes('/ops/')) return read(path); active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 3)); return await read(path); } finally { active--; } };
  const records = await new RemoteVaultStore(cloud, undefined, 3).revisions(vault.vaultId, (done, total) => { assert.equal(total, 9); counts.push(done); });
  assert.equal(records.length, 9); assert.equal(peak, 3); assert.deepEqual(counts, [0,1,2,3,4,5,6,7,8,9]);
});
test('pause drains three in-flight publications and recovery does not duplicate their versions', async () => {
  const { a, ea, cloud, sa } = await setup(); for (let i = 0; i < 6; i++) a.files.set(`note-${i}.md`, bytes('data-' + i));
  const write = cloud.writeImmutable.bind(cloud); let started = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cloud.writeImmutable = async (path, data) => { if (path.includes('/blobs/')) { started++; await gate; } await write(path, data); };
  let settled = false; const rejected = assert.rejects(ea.sync().finally(() => { settled = true; }), { code: 'paused' });
  for (let i = 0; i < 200 && started < 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(started, 3); ea.pause(); assert.equal(settled, false); release(); await rejected;
  assert.equal(started, 3); assert.equal(sa.value.journals.length, 3); assert.equal(cloud.published, 3);
  await ea.recover(); assert.equal(cloud.published, 3); await ea.sync(); assert.equal(cloud.published, 6);
});
test('editing a note during parallel download preserves the edit and leaves unapplied operations recoverable', async () => {
  const { a, b, ea, eb, cloud, sb } = await setup(); for (let i = 0; i < 3; i++) a.files.set(`note-${i}.md`, bytes('old-' + i));
  await ea.sync(); await eb.sync(); for (let i = 0; i < 3; i++) a.files.set(`note-${i}.md`, bytes('new-' + i)); await ea.sync();
  const read = cloud.read.bind(cloud); let started = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cloud.read = async path => { if (path.includes('/blobs/')) { started++; await gate; } return read(path); };
  const rejected = assert.rejects(eb.sync(), { code: 'changed' });
  for (let i = 0; i < 200 && started < 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(started, 3); b.files.set('note-0.md', bytes('user edit')); release(); await rejected;
  assert.equal(hash(b.files.get('note-0.md')!), hash(bytes('user edit'))); assert.equal(sb.value.journals.length, 3);
  await assert.rejects(eb.recover(), { code: 'changed' }); assert.equal(hash(b.files.get('note-0.md')!), hash(bytes('user edit')));
});
test('100 mixed files roundtrip, zero bytes and Chinese paths; repeat produces no new events', async () => {
  const { a, b, ea, eb, cloud } = await setup();
  for (let i = 0; i < 100; i++) a.files.set(`中文/目录/文件${i}.${i % 3 === 0 ? 'md' : i % 3 === 1 ? 'png' : 'pdf'}`, i ? bytes('mixed-content-' + i) : new ArrayBuffer(0));
  a.files.set('.obsidian/private.json', bytes('secret')); a.files.set('.vaultsail-state/private.json', bytes('state'));
  const upload = await ea.preview('upload'); assert.equal(upload.rows.length, 100); const uploaded = await ea.execute(upload);
  assert.equal(uploaded.uploadedFiles, 100); assert.equal(uploaded.downloadedFiles, 0);
  const download = await eb.preview('download'); assert.equal(download.rows.filter(row => row.action === 'download').length, 100); const downloaded = await eb.execute(download);
  assert.equal(downloaded.downloadedFiles, 100); assert.equal(downloaded.uploadedFiles, 0);
  for (const [path, data] of a.files) if (included(path)) assert.equal(hash(b.files.get(path)!), hash(data));
  assert.equal(b.files.size, 100); const count = cloud.published; await ea.execute(await ea.preview('sync')); await eb.execute(await eb.preview('sync')); assert.equal(cloud.published, count);
});
test('pause waits for the current publication and recovery completes it without duplicate operations', async () => {
  const { remote, vault, a, sa, cloud } = await setup(); const events: SyncProgress[] = [];
  const engine = new SyncEngine(remote, a, sa, vault.vaultId, '.obsidian', event => events.push(event));
  a.files.set('note.md', bytes('content')); const publish = remote.publish.bind(remote);
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  remote.publish = async (...args: Parameters<typeof publish>) => { entered(); await gate; return publish(...args); };
  let settled = false; const rejected = assert.rejects(engine.sync().finally(() => { settled = true; }), { code: 'paused' });
  await started; engine.pause(); assert.equal(engine.pauseRequested, true); assert.equal(settled, false); release(); await rejected;
  assert.equal(events.at(-1)!.phase, 'paused'); assert.equal(engine.pauseRequested, false);
  assert.equal(sa.value.journals.length, 1); assert.equal(cloud.published, 1);
  await engine.recover(); assert.equal(sa.value.journals.length, 0); assert.equal(cloud.published, 1);
  const repeated = await engine.sync(); assert.equal(repeated.uploadedFiles, 0); assert.equal(repeated.downloadedFiles, 0);
});
test('progress reports real stages and verified bytes; failure never advances completion and observer errors do not interrupt writes', async () => {
  const { remote, vault, a, b, sa, sb, cloud } = await setup(); const events: SyncProgress[] = [];
  a.files.set('note.md', bytes('hello')); a.files.set('zero.md', new ArrayBuffer(0));
  const engine = new SyncEngine(remote, a, sa, vault.vaultId, '.obsidian', event => { events.push(event); });
  const plan = await engine.preview('upload'); assert.equal(events.at(-1)!.phase, 'preview-ready'); assert.equal(cloud.published, 0);
  events.length = 0; await engine.execute(plan);
  for (const phase of ['scanning-remote', 'scanning-local', 'uploading', 'publishing', 'completed']) assert.ok(events.some(event => event.phase === phase));
  assert.equal(events.at(-1)!.doneFiles, 2); assert.equal(events.at(-1)!.totalFiles, 2); assert.equal(events.at(-1)!.doneBytes, 5);
  const download = new SyncEngine(remote, b, sb, vault.vaultId, '.obsidian', event => { events.push(event); });
  events.length = 0; const downloadPlan = await download.preview('download'); events.length = 0; await download.execute(downloadPlan);
  for (const phase of ['downloading', 'verifying', 'applying', 'completed']) assert.ok(events.some(event => event.phase === phase));
  a.files.set('next.md', bytes('more')); const next = await engine.preview('upload'); events.length = 0; cloud.failAfterPublish = true;
  await assert.rejects(engine.execute(next)); assert.equal(events.at(-1)!.phase, 'failed'); assert.ok(events.at(-1)!.doneBytes < events.at(-1)!.totalBytes);
  const observerFailure = new SyncEngine(remote, a, sa, vault.vaultId, '.obsidian', () => { throw new Error('view detached'); });
  await observerFailure.recover(); assert.equal(sa.value.journals.length, 0);
});
test('manual transfer conflicts instead of overwriting; resolution saves every competing version', async () => {
  const { a, b, ea, eb, remote, vault } = await setup();
  a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload')); b.files.set('note.md', bytes('B'));
  const plan = await eb.preview('download'); assert.equal(plan.rows[0].action, 'conflict'); await eb.execute(plan); assert.equal(hash(b.files.get('note.md')!), hash(bytes('B')));
  await eb.resolve('note.md', plan.rows[0].heads[0].opId);
  assert.equal(hash(b.files.get('note.md')!), hash(bytes('A'))); assert.equal(b.recovery.size, 2);
  assert.equal(buildHeads(await remote.revisions(vault.vaultId)).get('note.md')!.length, 1);
});
test('one-click sync handles single-sided changes automatically and visible copies preserve concurrent edits without duplicate versions', async () => {
  const { a, b, ea, eb, cloud, remote, vault } = await setup();
  a.files.set('note.md', bytes('initial')); await ea.sync(); await eb.sync();
  a.files.set('note.md', bytes('local changed')); await ea.sync(); await eb.sync(); assert.equal(hash(b.files.get('note.md')!), hash(bytes('local changed')));
  a.files.set('note.md', bytes('A')); b.files.set('note.md', bytes('B')); await ea.sync();
  const conflict = await eb.sync(); assert.equal(conflict.preservedConflicts, 1); assert.equal(hash(b.files.get('note.md')!), hash(bytes('B')));
  assert.ok([...b.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('A'))));
  assert.ok([...b.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('B'))));
  await ea.sync(); const count = cloud.published;
  for (let i = 0; i < 3; i++) { await ea.sync(); await eb.sync(); }
  assert.equal(cloud.published, count); assert.equal(buildHeads(await remote.revisions(vault.vaultId)).get('note.md')!.length, 2);
  assert.equal(hash(a.files.get('note.md')!), hash(bytes('A'))); assert.equal(hash(b.files.get('note.md')!), hash(bytes('B')));
  const copy = [...b.files].find(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('A')))![0];
  b.files.set(copy, bytes('edited conflict copy')); await eb.sync(); assert.equal(hash(b.files.get(copy)!), hash(bytes('edited conflict copy')));
  assert.ok([...b.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('A')))); assert.equal(cloud.published, count);
  const c = new MemoryLocal(); const sc = new MemoryState(); const ec = new SyncEngine(remote, c, sc, vault.vaultId);
  await ec.sync(); assert.ok(c.files.has('note.md')); assert.equal(cloud.published, count);
  assert.ok([...c.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('A'))));
  assert.ok([...c.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('B'))));
});
test('directional transfer uses a verified baseline for normal updates and download conflict preservation never uploads local content', async () => {
  const { a, b, ea, eb, cloud } = await setup(); a.files.set('note.md', bytes('A')); await ea.sync(); await eb.sync();
  a.files.set('note.md', bytes('longer local edit')); const upload = await ea.preview('upload'); assert.equal(upload.rows[0].action, 'upload'); await ea.execute(upload);
  const download = await eb.preview('download'); assert.equal(download.rows[0].action, 'download'); assert.equal(download.rows[0].size, bytes('longer local edit').byteLength); await eb.execute(download);
  b.files.set('note.md', bytes('my work')); a.files.set('note.md', bytes('new cloud edit')); await ea.sync(); const count = cloud.published;
  await eb.execute(await eb.preview('download'), () => {}, true); assert.equal(cloud.published, count); assert.equal(hash(b.files.get('note.md')!), hash(bytes('my work')));
  assert.ok([...b.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('new cloud edit'))));
});
test('automatic conflict branches recover a failure before publication with the same operation ID', async () => {
  const { a, b, ea, eb, cloud, sb } = await setup(); a.files.set('note.md', bytes('base')); await ea.sync(); await eb.sync();
  a.files.set('note.md', bytes('A')); b.files.set('note.md', bytes('B')); await ea.sync();
  const original = cloud.writeImmutable.bind(cloud); let fail = true;
  cloud.writeImmutable = async (path, data) => { if (fail && path.includes('/ops/')) { fail = false; throw new VaultSailError('network', 'before publish'); } await original(path, data); };
  await assert.rejects(eb.sync()); const id = sb.value.journals[0].id; assert.equal(sb.value.journals[0].allowBranch, true);
  await eb.recover(); assert.equal(sb.value.journals.length, 0); assert.ok(sb.value.knownOps.includes(id));
  const count = cloud.published; await eb.sync(); assert.equal(cloud.published, count); assert.equal(hash(b.files.get('note.md')!), hash(bytes('B')));
});
test('batch boundary checks discover a concurrent writer and keep both immutable branches', async () => {
  const { a, ea, cloud, remote, vault } = await setup(); a.files.set('first.md', bytes('1')); a.files.set('second.md', bytes('2')); await ea.sync();
  const base = buildHeads(await remote.revisions(vault.vaultId)).get('second.md')![0];
  a.files.set('first.md', bytes('first new')); a.files.set('second.md', bytes('local second'));
  const original = cloud.writeImmutable.bind(cloud); let inserted = false;
  cloud.writeImmutable = async (path, data) => {
    await original(path, data);
    if (!inserted && path.includes('/ops/')) { inserted = true; const value = bytes('concurrent second');
      await remote.publish(vault.vaultId, { ...base, opId: uuid(), deviceId: uuid(), parents: [base.opId], hash: hash(value), size: value.byteLength }, value); }
  };
  const result = await ea.sync(); assert.equal(result.incomingChanges, 1);
  const heads = buildHeads(await remote.revisions(vault.vaultId)).get('second.md')!; assert.equal(heads.length, 2);
  await ea.sync(); assert.ok([...a.files].some(([p, data]) => p.startsWith('VaultSail-conflicts/') && hash(data) === hash(bytes('concurrent second'))));
  assert.equal(hash(a.files.get('second.md')!), hash(bytes('local second')));
});
test('two offline editors publish concurrent branches; reordered clocks do not choose a winner', async () => {
  const { a, b, ea, eb, remote, vault } = await setup(); a.files.set('note.md', bytes('base'));
  await ea.execute(await ea.preview('upload')); await eb.execute(await eb.preview('download'));
  a.files.set('note.md', bytes('A')); b.files.set('note.md', bytes('B'));
  const pa = await ea.preview('sync'); const pb = await eb.preview('sync');
  await ea.execute(pa); await assert.rejects(eb.execute(pb), { code: 'changed' });
  const base = pb.rows[0].heads[0];
  const op: Revision = { ...base, opId: uuid(), deviceId: uuid(), parents: [base.opId], hash: hash(bytes('B')), size: 1, createdAt: 1 };
  await remote.publish(vault.vaultId, op, bytes('B'));
  const heads = buildHeads((await remote.revisions(vault.vaultId)).reverse()); assert.equal(heads.get('note.md')!.length, 2);
  assert.equal((await ea.preview('sync')).rows[0].action, 'conflict'); assert.equal((await eb.preview('sync')).rows[0].action, 'conflict');
  await eb.resolve('note.md', 'local'); assert.equal(buildHeads(await remote.revisions(vault.vaultId)).get('note.md')!.length, 1);
});
test('deletion stays off by default; enabled deletion publishes tombstone and backs up receiver', async () => {
  const { a, b, ea, eb, cloud } = await setup(); a.files.set('note.md', bytes('base'));
  await ea.execute(await ea.preview('upload')); await eb.execute(await eb.preview('download')); a.files.delete('note.md');
  assert.equal((await ea.preview('sync')).rows[0].action, 'skip'); const count = cloud.files.size;
  await ea.execute(await ea.preview('sync', true)); assert.ok(cloud.files.size > count);
  assert.equal((await eb.preview('sync')).rows[0].action, 'skip'); await eb.execute(await eb.preview('sync', true));
  assert.equal(b.files.has('note.md'), false); assert.equal(b.recovery.size, 1);
});
test('local and remote changes after preview prevent writes', async () => {
  const { a, ea, remote, vault } = await setup(); a.files.set('note.md', bytes('before'));
  const plan = await ea.preview('upload'); a.files.set('note.md', bytes('after')); await assert.rejects(ea.execute(plan), { code: 'changed' });
  assert.equal((await remote.revisions(vault.vaultId)).length, 0);
});
test('response lost after publication recovers original operation without duplicate history', async () => {
  const { a, ea, sa, cloud } = await setup(); a.files.set('note.md', bytes('before')); cloud.failAfterPublish = true;
  await assert.rejects(ea.execute(await ea.preview('upload')), { code: 'network' }); assert.equal(sa.value.journals.length, 1);
  a.files.set('note.md', bytes('later edit')); await ea.recover(); assert.equal(sa.value.journals.length, 0); assert.equal(cloud.published, 1);
  assert.equal((await ea.preview('sync')).rows[0].action, 'upload');
});
test('interrupted local apply recovers and corruption cannot become a note', async () => {
  const { a, b, ea, eb, sb, cloud, remote, vault } = await setup(); a.files.set('note.md', bytes('valid'));
  await ea.execute(await ea.preview('upload')); b.failApply = true;
  await assert.rejects(eb.execute(await eb.preview('download')), { code: 'network' }); assert.equal(sb.value.journals.length, 1);
  await eb.recover(); assert.equal(hash(b.files.get('note.md')!), hash(bytes('valid'))); assert.equal(sb.value.journals.length, 0);
  const op = (await remote.revisions(vault.vaultId))[0]; cloud.files.set(remote.base(vault.vaultId) + '/blobs/' + op.hash, bytes('broken'));
  b.files.delete('note.md'); await assert.rejects(eb.execute(await eb.preview('download')), { code: 'integrity' }); assert.equal(b.files.has('note.md'), false);
});
test('published conflict resolution recovers local application after interruption', async () => {
  const { a, b, ea, eb, sb, cloud } = await setup(); a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload')); b.files.set('note.md', bytes('B'));
  const row = (await eb.preview('download')).rows[0]; b.failApply = true;
  await assert.rejects(eb.resolve(row.path, row.heads[0].opId), { code: 'network' }); assert.equal(sb.value.journals[0].stage, 'published');
  await eb.recover(); assert.equal(hash(b.files.get('note.md')!), hash(bytes('A'))); assert.equal(cloud.published, 2);
});
test('missing parents, cycles, unknown schemas and duplicate IDs stop graph construction', async () => {
  const { a, ea, remote, vault } = await setup(); a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload'));
  const op = (await remote.revisions(vault.vaultId))[0];
  assert.throws(() => buildHeads([{ ...op, parents: [uuid()] }]), { code: 'schema' });
  assert.throws(() => buildHeads([{ ...op, parents: [op.opId] }]), { code: 'schema' });
  assert.throws(() => buildHeads([op, op]), { code: 'schema' });
  assert.throws(() => validateRevision({ ...op, schemaVersion: 2 }, vault.vaultId), { code: 'schema' });
});
test('failed or regressing remote inventory cannot be interpreted as empty', async () => {
  const { a, ea, cloud } = await setup(); a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload'));
  cloud.badListing = true; await assert.rejects(ea.preview('sync'), { code: 'response' }); cloud.badListing = false;
  const opPath = [...cloud.files.keys()].find(path => path.includes('/ops/'))!; cloud.files.delete(opPath);
  await assert.rejects(ea.preview('sync'), { code: 'visibility' }); assert.equal(a.files.has('note.md'), true);
});
test('independent vaults and devices never share baseline or transfer destinations', async () => {
  const { a, ea, cloud, remote, vault } = await setup(); a.files.set('private.md', bytes('vault-one')); await ea.execute(await ea.preview('upload'));
  const second = await remote.create('second'); const local = new MemoryLocal(); const state = new MemoryState(); const engine = new SyncEngine(remote, local, state, second.vaultId);
  assert.equal((await engine.preview('download')).rows.length, 0); local.files.set('other.md', bytes('vault-two')); await engine.execute(await engine.preview('upload'));
  assert.equal((await remote.revisions(vault.vaultId)).length, 1); assert.equal((await remote.revisions(second.vaultId)).length, 1); assert.equal(cloud.published, 2);
});
test('path traversal, reserved filenames and Unicode/case collisions are blocked', () => {
  for (const path of ['../outside', '/absolute', 'folder/CON.txt', 'folder/a.', 'C:\\secret']) assert.throws(() => assertNoCollisions([path]), { code: 'path' });
  assert.throws(() => assertNoCollisions(['Note.md', 'note.md']), { code: 'collision' });
  assert.throws(() => assertNoCollisions(['é.md', 'e\u0301.md']), { code: 'collision' });
  assert.throws(() => assertNoCollisions(['notes', 'notes/a.md']), { code: 'collision' });
  assert.equal(appRoot('/apps/中文应用/测试'), '/apps/中文应用/测试'); assert.equal(included('custom-config/private', 'custom-config'), false);
});
test('large files and corrupt baseline stop transfer before publication', async () => {
  const { a, ea, sa, cloud } = await setup(); a.files.set('large.bin', new ArrayBuffer(MAX_FILE_SIZE + 1));
  await assert.rejects(ea.preview('upload'), { code: 'size' }); assert.equal(cloud.published, 0); a.files.clear();
  sa.value.schemaVersion = 2 as 1; await assert.rejects(ea.preview('sync'), { code: 'state' });
});
test('changed conflict preview cannot silently resolve the latest local edit', async () => {
  const { a, b, ea, eb } = await setup(); a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload')); b.files.set('note.md', bytes('B'));
  const row = (await eb.preview('download')).rows[0]; b.files.set('note.md', bytes('later'));
  await assert.rejects(eb.resolve(row.path, 'local', row), { code: 'changed' }); assert.equal(hash(b.files.get('note.md')!), hash(bytes('later')));
});
test('100 reproducible interrupted publication and local application recover without lost bytes', async () => {
  for (let i = 0; i < 100; i++) {
    const { a, b, ea, eb, cloud, sa, sb } = await setup(); const expected = bytes('case-' + i); a.files.set('note.md', expected);
    if (i % 2 === 0) { cloud.failAfterPublish = true; await assert.rejects(ea.execute(await ea.preview('upload'))); await ea.recover(); }
    else await ea.execute(await ea.preview('upload'));
    b.failApply = true; await assert.rejects(eb.execute(await eb.preview('download'))); await eb.recover();
    assert.equal(hash(b.files.get('note.md')!), hash(expected)); assert.equal(sa.value.journals.length, 0); assert.equal(sb.value.journals.length, 0); assert.equal(cloud.published, 1);
  }
});
test('explicitly ending an old task preserves staged content and replans the divergence', async () => {
  const { a, b, ea, eb, sb } = await setup(); a.files.set('note.md', bytes('remote')); await ea.execute(await ea.preview('upload')); b.failApply = true;
  await assert.rejects(eb.execute(await eb.preview('download'))); b.files.set('note.md', bytes('new-local-edit'));
  await assert.rejects(eb.recover(), { code: 'changed' }); await eb.abandonPending(); assert.equal(sb.value.journals.length, 0);
  assert.equal((await eb.preview('download')).rows[0].action, 'conflict'); assert.equal(hash(b.files.get('note.md')!), hash(bytes('new-local-edit')));
});
test('unique same-content rename preserves file identity; old receiver path is removed only when deletion is enabled', async () => {
  const { a, b, ea, eb, remote, vault } = await setup(); a.files.set('old.md', bytes('same')); await ea.execute(await ea.preview('upload')); await eb.execute(await eb.preview('download'));
  const initial = (await remote.revisions(vault.vaultId))[0]; a.files.delete('old.md'); a.files.set('renamed.md', bytes('same'));
  const rename = await ea.preview('sync'); assert.equal(rename.rows.find(row => row.path === 'renamed.md')?.renameFrom, 'old.md'); await ea.execute(rename);
  const latest = (await remote.revisions(vault.vaultId)).find(op => op.previousPath)!; assert.equal(latest.fileId, initial.fileId);
  const defaultPlan = await eb.preview('sync'); assert.equal(defaultPlan.rows.find(row => row.path === 'old.md')?.action, 'skip');
  await eb.execute(defaultPlan); assert.equal(b.files.has('old.md'), true); assert.equal(b.files.has('renamed.md'), true);
  await eb.execute(await eb.preview('sync', true)); assert.equal(b.files.has('old.md'), false); assert.equal(b.files.has('renamed.md'), true);
  assert.equal((await ea.preview('sync')).rows.every(row => row.action === 'noop'), true);
});
test('concurrent renames retain immutable branches and stop applying ambiguous paths', async () => {
  const { a, ea, remote, vault } = await setup(); a.files.set('old.md', bytes('same')); await ea.execute(await ea.preview('upload')); const parent = (await remote.revisions(vault.vaultId))[0];
  for (const target of ['first.md', 'second.md']) await remote.publish(vault.vaultId, { ...parent, path: target, previousPath: 'old.md', opId: uuid(), deviceId: uuid(), parents: [parent.opId] }, bytes('same'));
  await assert.rejects(ea.preview('sync'), { code: 'rename-conflict' }); assert.equal(a.files.has('old.md'), true);
});
