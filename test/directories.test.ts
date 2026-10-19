import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, hash, uuid, VaultSailError } from '../src/core/safety.ts';
import { DirectorySync, RemoteDirectoryStore, directoryHeads, directoryPresent, newDirectoryState, validateDirectoryRevision, validateDirectoryState, type DirectoryRevision, type DirectoryState, type LocalDirectories } from '../src/sync/directories.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import type { CloudStorageProvider } from '../src/providers/cloud-storage-provider.ts';
import type { RemoteObject } from '../src/providers/cloud-storage-provider.ts';
import type { FileHistoryEvent } from '../src/sync/history.ts';

class Cloud implements CloudStorageProvider {
  id = 'mock'; displayName = 'mock'; root = '/apps/test'; capabilities = { canList: true, canRead: true, canWrite: true, canDelete: false, supportsConditionalWrites: false };
  data = new Map<string, ArrayBuffer>(); dirs = new Set<string>(); reads = 0; lost = false; failList = false; duplicatePage = false; pageSize = 3;
  isConfigured() { return true; }
  async mkdir(path: string) { const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/')); }
  async exists(path: string) { return this.data.has(path) || this.dirs.has(path); }
  async read(path: string) { this.reads++; const data = this.data.get(path); if (!data) throw new VaultSailError('not-found', 'missing'); return data.slice(0); }
  async list(path: string, cursor = '0') {
    if (this.failList) throw new VaultSailError('network', 'list failed');
    if (!this.dirs.has(path)) throw new VaultSailError('not-found', 'missing');
    const prefix = path + '/';
    const objects = [...this.data].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([p, data]) => ({ path: p, size: data.byteLength, isDirectory: false, etag: hash(data) }));
    objects.push(...[...this.dirs].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => ({ path: p, size: 0, isDirectory: true, etag: 'dir' })));
    objects.sort((a, b) => a.path.localeCompare(b.path));
    const offset = this.duplicatePage ? 0 : Number(cursor), page = objects.slice(offset, offset + this.pageSize);
    return { objects: page, complete: offset + page.length >= objects.length, ...(offset + page.length < objects.length ? { nextCursor: String(Number(cursor) + this.pageSize) } : {}) };
  }
  async writeImmutable(path: string, data: ArrayBuffer) {
    const old = this.data.get(path); if (old && hash(old) !== hash(data)) throw new VaultSailError('integrity', 'collision');
    await this.mkdir(path.slice(0, path.lastIndexOf('/'))); this.data.set(path, data.slice(0));
    if (this.lost && path.includes('/directories/')) { this.lost = false; throw new VaultSailError('write-timeout', 'lost response'); }
  }
}
class Local implements LocalDirectories {
  dirs = new Set<string>(); notes = new Set<string>(); race?: () => void;
  async paths() { return [...this.dirs]; } async files() { return [...this.notes]; }
  async present(path: string) { if (this.notes.has(path)) throw new VaultSailError('collision', 'file'); return this.dirs.has(path); }
  async empty(path: string) { return ![...this.dirs, ...this.notes].some(p => p.startsWith(path + '/')); }
  async create(path: string) { if (this.notes.has(path)) throw new VaultSailError('collision', 'file'); const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/')); }
  async removeEmpty(path: string) { this.race?.(); this.race = undefined; if (!await this.empty(path)) return false; this.dirs.delete(path); return true; }
}
class State {
  value: DirectoryState; fail = false; writes = 0;
  constructor(vaultId: string, deviceId: string) { this.value = newDirectoryState(vaultId, deviceId); }
  async load() { return structuredClone(this.value); }
  async save(state: DirectoryState) { if (this.fail) { this.fail = false; throw new VaultSailError('state', 'save failed'); } this.writes++; this.value = structuredClone(state); }
}
async function setup() {
  const cloud = new Cloud(), vault = await new RemoteVaultStore(cloud).create('空目录测试');
  const a = new Local(), b = new Local(), da = uuid(), db = uuid(), sa = new State(vault.vaultId, da), sb = new State(vault.vaultId, db), events: FileHistoryEvent[] = [];
  const ra = new RemoteDirectoryStore(cloud, vault.vaultId), rb = new RemoteDirectoryStore(cloud, vault.vaultId);
  const ea = new DirectorySync(ra, a, sa, vault.vaultId, da, '.obsidian', () => {}, event => events.push(event));
  const eb = new DirectorySync(rb, b, sb, vault.vaultId, db);
  return { cloud, vault, a, b, sa, sb, ea, eb, ra, rb, events, da, db };
}

test('empty Chinese nested folders transfer without fake notes, stay idempotent, and older file clients keep working', async () => {
  const h = await setup(); await h.a.create('论文/调研研究'); await h.a.create('论文/学姐指导');
  const plan = await h.ea.preview('upload', false); assert.equal(plan.rows.filter(row => row.action === 'publish-directory').length, 3);
  await h.ea.execute(plan, false); await h.eb.sync('sync', false);
  assert.deepEqual([...h.b.dirs].sort(), [...h.a.dirs].sort()); assert.equal(h.b.notes.size, 0);
  await h.ea.sync('sync', false);
  const count = h.cloud.data.size, writes = h.sa.writes, reads = h.cloud.reads;
  await h.ea.sync('sync', false); await h.ea.sync('sync', false);
  assert.equal(h.cloud.data.size, count); assert.equal(h.sa.writes, writes); assert.equal(h.cloud.reads, reads);
  assert.deepEqual(await new RemoteVaultStore(h.cloud).revisions(h.vault.vaultId), []);
  assert.ok(h.events.some(event => event.action === 'publish-directory' && event.state === 'succeeded'));
});
test('deletion disabled neither publishes tombstones nor resurrects locally removed folders; opt-in deletes empty children first', async () => {
  const h = await setup(); await h.a.create('父/子'); await h.ea.sync('sync', false); await h.eb.sync('sync', false);
  h.a.dirs.clear(); const count = h.cloud.data.size;
  await h.ea.sync('sync', false); assert.equal(h.a.dirs.size, 0); assert.equal(h.cloud.data.size, count);
  await h.ea.sync('sync', true); await h.eb.sync('sync', false); assert.equal(h.b.dirs.size, 2);
  await h.eb.sync('sync', true); assert.equal(h.b.dirs.size, 0);
  assert.ok([...directoryHeads(await h.ra.revisions()).values()].every(heads => !directoryPresent(heads)));
});
test('remote delete never removes a directory containing new notes and republishes preservation', async () => {
  const h = await setup(); await h.a.create('保留'); await h.ea.sync('sync', true); await h.eb.sync('sync', true);
  h.a.dirs.clear(); await h.ea.sync('sync', true); h.b.notes.add('保留/新笔记.md');
  await h.eb.sync('sync', true); assert.ok(h.b.dirs.has('保留')); assert.ok(h.b.notes.has('保留/新笔记.md'));
  await h.ea.sync('sync', true); assert.ok(h.a.dirs.has('保留'));
});
test('a note appearing during empty removal survives and the history reports a skip', async () => {
  const h = await setup(); await h.a.create('目录'); await h.ea.sync('sync', true); await h.eb.sync('sync', true);
  h.b.dirs.clear(); await h.eb.sync('sync', true);
  h.a.race = () => h.a.notes.add('目录/不能丢.md');
  const result = await h.ea.sync('sync', true);
  assert.equal(result.deleted, 0); assert.equal(result.skipped, 1); assert.ok(h.a.notes.has('目录/不能丢.md'));
  assert.equal(h.events.at(-1)?.state, 'skipped');
});
test('lost directory commit responses recover one operation ID after reload', async () => {
  const h = await setup(); await h.a.create('恢复'); h.cloud.lost = true;
  await assert.rejects(h.ea.sync('sync', false), { code: 'write-timeout' });
  const id = h.sa.value.pending!.revision!.opId, count = h.cloud.data.size;
  const restarted = new DirectorySync(new RemoteDirectoryStore(h.cloud, h.vault.vaultId), h.a, h.sa, h.vault.vaultId, h.da);
  await restarted.sync('sync', false); assert.equal(h.sa.value.pending, undefined); assert.equal(h.cloud.data.size, count);
  assert.equal((await h.ra.revisions()).filter(op => op.opId === id).length, 1);
});
test('a failed pending save publishes nothing, and corrupt state does not become an empty baseline', async () => {
  const h = await setup(); await h.a.create('安全'); h.sa.fail = true; const count = h.cloud.data.size;
  await assert.rejects(h.ea.sync('sync', false), { code: 'state' }); assert.equal(h.cloud.data.size, count);
  h.sa.value.bases['安全'] = { present: true, heads: ['bad'] };
  await assert.rejects(h.ea.sync('sync', false), { code: 'state' });
});
test('directional previews respect direction and reject subsequent local or remote changes', async () => {
  const h = await setup(); await h.a.create('本地');
  assert.equal((await h.ea.preview('download', false)).rows[0].action, 'skip-directory');
  const plan = await h.ea.preview('upload', false); await h.a.create('后来');
  await assert.rejects(h.ea.execute(plan, false), { code: 'changed' });
  await h.ea.sync('sync', false);
  assert.ok((await h.eb.preview('upload', false)).rows.every(row => row.action === 'skip-directory'));
  const stale = await h.eb.preview('sync', false); await h.a.create('远端新目录'); await h.ea.sync('sync', false);
  await assert.rejects(h.eb.execute(stale, false), { code: 'changed' }); assert.equal(h.b.dirs.size, 0);
});
test('concurrent create/delete branches preserve creation without using timestamps and converge', async () => {
  const h = await setup(); await h.a.create('分支'); await h.ea.sync('sync', true); await h.eb.sync('sync', true);
  const old = (await h.ra.revisions())[0];
  await h.ra.publish({ ...old, opId: uuid(), deviceId: h.da, parents: [old.opId], kind: 'delete', createdAt: Number.MAX_SAFE_INTEGER });
  await h.rb.publish({ ...old, opId: uuid(), deviceId: h.db, parents: [old.opId], kind: 'create', createdAt: 0 });
  const heads = directoryHeads(await h.ra.revisions()).get('分支')!; assert.equal(heads.length, 2); assert.equal(directoryPresent(heads), true);
  await h.eb.sync('sync', true); await h.ea.sync('sync', true);
  assert.equal(directoryHeads(await h.ra.revisions()).get('分支')!.length, 1); assert.ok(h.a.dirs.has('分支')); assert.ok(h.b.dirs.has('分支'));
});
test('failed or repeated pagination is never an empty directory inventory', async () => {
  const h = await setup(); for (let i = 0; i < 7; i++) await h.a.create('目录' + i); await h.ea.sync('sync', false);
  h.cloud.failList = true; await assert.rejects(h.eb.sync('sync', true), { code: 'network' }); assert.equal(h.b.dirs.size, 0);
  h.cloud.failList = false; h.cloud.duplicatePage = true; await assert.rejects(h.eb.sync('sync', true), { code: 'response' }); assert.equal(h.b.dirs.size, 0);
});
test('directory paths, parent graphs, identity and corrupted records are rejected', async () => {
  const h = await setup(); const op: DirectoryRevision = { version: 1, vaultId: h.vault.vaultId, deviceId: h.da, opId: uuid(), path: '合法', parents: [], kind: 'create', createdAt: 1 };
  for (const path of ['../越界', 'con', '.obsidian', 'VaultSail-conflicts', 'VaultSail-配置']) assert.throws(() => validateDirectoryRevision({ ...op, path }, h.vault.vaultId));
  assert.throws(() => directoryHeads([{ ...op, parents: [uuid()] }]), { code: 'schema' });
  assert.throws(() => directoryHeads([{ ...op, parents: [op.opId] }]), { code: 'schema' });
  assert.throws(() => directoryHeads([op, op]), { code: 'schema' });
  assert.throws(() => validateDirectoryState({ ...h.sa.value, deviceId: h.db }, h.vault.vaultId, h.da), { code: 'state' });
  await h.a.create('Foo'); await h.ra.publish({ ...op, path: 'foo/子' });
  await assert.rejects(h.ea.sync('sync', false), { code: 'collision' });
});
test('same-name files block directory publication before any destructive action', async () => {
  const h = await setup(); await h.a.create('目录'); await h.ea.sync('sync', false); h.b.notes.add('目录');
  await assert.rejects(h.eb.sync('sync', true), { code: 'collision' }); assert.ok(h.b.notes.has('目录'));
});
test('independent vault directory records and baselines never cross scopes', async () => {
  const h = await setup(), other = await new RemoteVaultStore(h.cloud).create('第二库');
  await h.a.create('第一库'); await h.ea.sync('sync', false);
  assert.deepEqual(await new RemoteDirectoryStore(h.cloud, other.vaultId).revisions(), []);
  const raw = [...h.cloud.data].find(([path]) => path.includes('/directories/'))!; h.cloud.data.set(raw[0], bytes('{}'));
  await assert.rejects(h.rb.revisions());
});
test('previously verified records disappearing cannot be treated as remote absence', async () => {
  const h = await setup(); await h.a.create('已知'); await h.ea.sync('sync', false); await h.eb.sync('sync', false);
  const entry = [...h.cloud.data].find(([path]) => path.includes('/directories/'))!; h.cloud.data.delete(entry[0]);
  const count = h.cloud.data.size;
  await assert.rejects(h.ea.sync('sync', true), { code: 'visibility' }); assert.equal(h.cloud.data.size, count); assert.ok(h.a.dirs.has('已知'));
});
test('same-ID record mutations invalidate a preview instead of changing its meaning', async () => {
  const h = await setup(); await h.a.create('目录'); await h.ea.sync('sync', false);
  const plan = await h.eb.preview('download', false), op = (await h.ra.revisions())[0];
  const entry = [...h.cloud.data].find(([path]) => path.endsWith(op.opId + '.json'))!;
  h.cloud.data.set(entry[0], bytes(JSON.stringify({ ...op, kind: 'delete' })));
  await assert.rejects(h.eb.execute(plan, false), { code: 'integrity' }); assert.equal(h.b.dirs.size, 0);
});
test('interrupted local directory creation recovers after reload, including child folders', async () => {
  const h = await setup(); await h.a.create('父/子'); await h.ea.sync('sync', false);
  const create = h.b.create.bind(h.b); let once = true;
  h.b.create = async path => { await create(path); if (once) { once = false; throw new VaultSailError('state', 'crash after local commit'); } };
  await assert.rejects(h.eb.sync('download', false), { code: 'state' }); assert.ok(h.sb.value.pending);
  await new DirectorySync(h.rb, h.b, h.sb, h.vault.vaultId, h.db).sync('download', false);
  assert.equal(h.sb.value.pending, undefined); assert.ok(h.b.dirs.has('父/子'));
});
test('deletion disabled during recovery blocks pending deletion; ending the old task never publishes it', async () => {
  const h = await setup(); await h.a.create('目录'); await h.ea.sync('sync', true); h.a.dirs.clear();
  const publish = h.ra.publish.bind(h.ra); let once = true;
  h.ra.publish = async op => { if (once && op.kind === 'delete') { once = false; throw new VaultSailError('network', 'before publication'); } await publish(op); };
  await assert.rejects(h.ea.sync('sync', true), { code: 'network' }); const count = h.cloud.data.size;
  await assert.rejects(h.ea.recover(false), { code: 'recovery' }); assert.equal(h.cloud.data.size, count);
  await h.ea.abandonPending(); assert.equal(h.sa.value.pending, undefined); await h.ea.sync('sync', false); assert.equal(h.cloud.data.size, count);
});
test('pause between directory operations leaves recoverable intent; presentation failure cannot stop sync', async () => {
  const h = await setup(); await h.a.create('暂停'); let paused = false;
  const sync = new DirectorySync(h.ra, h.a, h.sa, h.vault.vaultId, h.da, '.obsidian', () => { if (paused) throw new VaultSailError('paused', 'pause'); }, () => { throw new Error('view detached'); });
  const save = h.sa.save.bind(h.sa); h.sa.save = async state => { await save(state); if (state.pending) paused = true; };
  await assert.rejects(sync.sync('sync', false), { code: 'paused' }); assert.ok(h.sa.value.pending);
  h.sa.save = save; paused = false; await sync.sync('sync', false); assert.equal(h.sa.value.pending, undefined);
});
test('cold directory reads prepare no more than 100 links at a time; warm reads reuse trusted fingerprints', async () => {
  const h = await setup(); h.cloud.pageSize = 40;
  for (let i = 0; i < 205; i++) await h.ra.publish({ version: 1, vaultId: h.vault.vaultId, deviceId: h.da, opId: uuid(), path: '目录' + i, parents: [], kind: 'create', createdAt: i });
  const batches: number[] = [];
  const cloud = h.cloud as Cloud & { prepareReads: (objects: RemoteObject[]) => Promise<RemoteObject[]> };
  cloud.prepareReads = async objects => { batches.push(objects.length); return objects; };
  const reader = new RemoteDirectoryStore(cloud, h.vault.vaultId);
  assert.equal((await reader.revisions()).length, 205); assert.deepEqual(batches, [100, 100, 5]);
  const reads = cloud.reads; batches.length = 0; await reader.revisions(); assert.equal(cloud.reads, reads); assert.deepEqual(batches, []);
  cloud.prepareReads = async objects => objects.map(object => ({ ...object, size: object.size + 1 }));
  await assert.rejects(new RemoteDirectoryStore(cloud, h.vault.vaultId).revisions(), { code: 'changed' });
});
