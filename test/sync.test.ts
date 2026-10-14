import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, hash, assertNoCollisions, appRoot, included, MAX_FILE_SIZE, uuid, VaultSailError } from '../src/core/safety.ts';
import { RemoteVaultStore, buildHeads, validateRevision, type Revision } from '../src/sync/remote-vault.ts';
import { SyncEngine, newState, type LocalFiles, type StateStore, type SyncState } from '../src/sync/engine.ts';
import type { CloudStorageProvider, RemotePage } from '../src/providers/cloud-storage-provider.ts';

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
async function setup() {
  const cloud = new MemoryCloud(); const remote = new RemoteVaultStore(cloud); const vault = await remote.create('测试库');
  const a = new MemoryLocal(); const b = new MemoryLocal(); const sa = new MemoryState(); const sb = new MemoryState();
  const ea = new SyncEngine(remote, a, sa, vault.vaultId); const eb = new SyncEngine(remote, b, sb, vault.vaultId);
  return { cloud, remote, vault, a, b, sa, sb, ea, eb };
}
test('100 mixed files roundtrip, zero bytes and Chinese paths; repeat produces no new events', async () => {
  const { a, b, ea, eb, cloud } = await setup();
  for (let i = 0; i < 100; i++) a.files.set(`中文/目录/文件${i}.${i % 3 === 0 ? 'md' : i % 3 === 1 ? 'png' : 'pdf'}`, i ? bytes('mixed-content-' + i) : new ArrayBuffer(0));
  a.files.set('.obsidian/private.json', bytes('secret')); a.files.set('.vaultsail-state/private.json', bytes('state'));
  const upload = await ea.preview('upload'); assert.equal(upload.rows.length, 100); await ea.execute(upload);
  const download = await eb.preview('download'); assert.equal(download.rows.filter(row => row.action === 'download').length, 100); await eb.execute(download);
  for (const [path, data] of a.files) if (included(path)) assert.equal(hash(b.files.get(path)!), hash(data));
  assert.equal(b.files.size, 100); const count = cloud.published; await ea.execute(await ea.preview('sync')); await eb.execute(await eb.preview('sync')); assert.equal(cloud.published, count);
});
test('manual transfer conflicts instead of overwriting; resolution saves every competing version', async () => {
  const { a, b, ea, eb, remote, vault } = await setup();
  a.files.set('note.md', bytes('A')); await ea.execute(await ea.preview('upload')); b.files.set('note.md', bytes('B'));
  const plan = await eb.preview('download'); assert.equal(plan.rows[0].action, 'conflict'); await eb.execute(plan); assert.equal(hash(b.files.get('note.md')!), hash(bytes('B')));
  await eb.resolve('note.md', plan.rows[0].heads[0].opId);
  assert.equal(hash(b.files.get('note.md')!), hash(bytes('A'))); assert.equal(b.recovery.size, 2);
  assert.equal(buildHeads(await remote.revisions(vault.vaultId)).get('note.md')!.length, 1);
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
