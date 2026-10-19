import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, uuid, VaultSailError } from '../src/core/safety.ts';
import { HISTORY_BYTE_LIMIT, HISTORY_FILE_LIMIT, HISTORY_TASK_LIMIT, SyncHistory, validateHistory, type FileHistoryEvent, type HistoryStore, type SyncHistoryTask } from '../src/sync/history.ts';
import { ObsidianHistoryStore } from '../src/platform/sync-history-store.ts';
import { scanSummary } from '../src/sync/scan-summary.ts';
import { TransferPerformance } from '../src/sync/performance.ts';

const context = 'a'.repeat(64), device = uuid();
function task(startedAt = 1): SyncHistoryTask { return { version: 1, id: uuid(), context, deviceId: device, sequence: 0, mode: 'manual', startedAt, updatedAt: startedAt, status: 'running', truncated: false, files: [] }; }
function event(state: FileHistoryEvent['state'] = 'running'): FileHistoryEvent { return { id: uuid(), path: '中文/note.md', action: 'upload', size: 12, state, reason: 'planned' }; }
function memoryStore(): HistoryStore & { tasks: Map<string, SyncHistoryTask> } {
  const tasks = new Map<string, SyncHistoryTask>(); return { tasks, save: async task => { tasks.set(task.id, structuredClone(task)); }, list: async () => [...tasks.values()].map(task => structuredClone(task)) };
}
function disk() {
  const files = new Map<string, ArrayBuffer>(), dirs = new Set<string>(), removed: string[] = [];
  const adapter = { exists: async (path: string) => files.has(path) || dirs.has(path), mkdir: async (path: string) => { dirs.add(path); },
    stat: async (path: string) => files.has(path) ? { type: 'file', size: files.get(path)!.byteLength } : dirs.has(path) ? { type: 'folder', size: 0 } : null,
    readBinary: async (path: string) => { assert.ok(files.has(path)); return files.get(path)!.slice(0); },
    writeBinary: async (path: string, data: ArrayBuffer) => { files.set(path, data.slice(0)); },
    rename: async (from: string, to: string) => { assert.ok(files.has(from)); assert.equal(files.has(to), false); files.set(to, files.get(from)!); files.delete(from); },
    remove: async (path: string) => { removed.push(path); files.delete(path); },
    list: async (path: string) => ({ files: [...files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')), folders: [] as string[] }) };
  return { files, adapter, removed, app: { vault: { configDir: '.obsidian', adapter } } as any };
}

test('file results stay live, persist across recorder restart, and separate skipped files from success', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device); let notifications = 0;
  history.subscribe(() => { notifications++; }); history.begin('manual');
  const file = event('queued'); history.file(file); history.file({ ...file, state: 'running' });
  assert.equal(history.current()!.files[0].state, 'running');
  history.file({ ...file, state: 'succeeded' }); history.file({ ...event('skipped'), path: 'large.mp4', reason: 'oversized' });
  await history.finish(); assert.ok(notifications >= 4);
  const records = await new SyncHistory(store, context, device).list();
  assert.equal(records[0].status, 'partial'); assert.deepEqual(records[0].files.map(row => row.state), ['succeeded', 'skipped']);
  assert.equal(records[0].files[0].id, file.id); assert.ok(records[0].endedAt);
});

test('numeric performance summaries persist across history restart without becoming recovery state', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device), performance = new TransferPerformance();
  performance.begin(); performance.scan({ listed: 7, cacheHits: 7, read: 0, missingFingerprints: 0 }); performance.finish();
  history.begin('automatic'); history.setPerformance(scanSummary(performance.snapshot(), '0.2.9', false)); await history.finish();
  const records = await new SyncHistory(store, context, device).list();
  assert.equal(records[0].performance?.listed, 7); assert.equal(records[0].performance?.cacheHits, 7); assert.equal(records[0].performance?.read, 0);
  history.begin('manual'); await history.finish(); const latest = await history.list();
  assert.equal(latest[0].performance, undefined, 'a later task without measurements never inherits the old summary');
});

test('raw credentials/errors and excluded paths cannot enter serialized history', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device), secret = 'secret-token-in-raw-error';
  history.begin('automatic'); history.file({ ...event(), rawResponse: secret } as FileHistoryEvent);
  history.file({ ...event(), path: '.obsidian/private.json' });
  await history.finish(new VaultSailError('network', secret));
  const saved = JSON.stringify(await store.list()); assert.equal(saved.includes(secret), false); assert.equal(saved.includes('.obsidian/private.json'), false);
  const record = (await store.list())[0]; assert.equal(record.code, 'network'); assert.equal(record.files[0].state, 'unconfirmed'); assert.equal(history.warning, true);
  const injected = { ...task(), accessToken: secret, files: [{ ...event('succeeded'), updatedAt: 1, request: secret }] };
  assert.equal(JSON.stringify(validateHistory(injected, context, device)).includes(secret), false);
  assert.throws(() => validateHistory(injected, 'b'.repeat(64), device));
  const primitive = new SyncHistory(memoryStore(), context, device); primitive.begin('manual'); await primitive.finish(undefined, true);
  assert.equal((await primitive.list())[0].status, 'failed'); assert.equal((await primitive.list())[0].code, 'unknown');
});

test('interrupted records distinguish unconfirmed work and never claim queued files were transferred', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device); history.begin('manual');
  history.file(event('running')); history.file({ ...event('queued'), path: 'later.md' }); await history.flush(); history.dispose();
  const rows = await new SyncHistory(store, context, device).list();
  assert.equal(rows[0].status, 'interrupted'); assert.deepEqual(rows[0].files.map(row => row.state), ['unconfirmed', 'not-run']);
  assert.equal(rows[0].endedAt, undefined); assert.ok(rows[0].updatedAt >= rows[0].startedAt);
});

test('history storage failure stays advisory and task/entry caps are explicit', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device); store.save = async () => { throw new Error('disk unavailable'); };
  history.begin('manual'); const file = event(); history.file(file); history.file({ ...file, state: 'succeeded' });
  await history.finish(); assert.equal(history.warning, true); assert.equal((await history.list())[0].files[0].state, 'succeeded');
  const bounded = new SyncHistory(memoryStore(), context, device); bounded.begin('manual');
  for (let i = 0; i <= HISTORY_FILE_LIMIT; i++) bounded.file({ ...event('unchanged'), path: `note-${i}.md`, action: 'noop', reason: 'unchanged' });
  await bounded.finish(); const result = (await bounded.list())[0]; assert.equal(result.files.length, HISTORY_FILE_LIMIT); assert.equal(result.truncated, true);
});

test('long Unicode paths stay under the byte cap and omitted skipped rows still mark partial results', async () => {
  const store = memoryStore(), history = new SyncHistory(store, context, device); history.begin('manual');
  for (let i = 0; i < HISTORY_FILE_LIMIT; i++) history.file({ ...event('unchanged'), path: '中'.repeat(950) + i + '.md', action: 'noop', reason: 'unchanged' });
  history.file({ ...event('skipped'), path: 'omitted.mp4', action: 'skip', reason: 'oversized' });
  await history.finish(); const result = (await history.list())[0];
  assert.equal(result.status, 'partial'); assert.equal(result.truncated, true); assert.ok(result.files.length < HISTORY_FILE_LIMIT);
  assert.ok(bytes(JSON.stringify(result)).byteLength <= HISTORY_BYTE_LIMIT);
});

test('native history store recovers a staged record after interruption and refuses stale saves', async () => {
  const d = disk(), store = new ObsidianHistoryStore(d.app, device, context), first = task();
  await store.save(first); const rename = d.adapter.rename; let fail = true;
  d.adapter.rename = async (from, to) => { if (fail && from.endsWith('.next')) { fail = false; throw new Error('crash'); } await rename(from, to); };
  const newer = { ...first, sequence: 2, status: 'completed' as const, endedAt: 2, updatedAt: 2 };
  await assert.rejects(store.save(newer));
  assert.equal((await new ObsidianHistoryStore(d.app, device, context).list())[0].sequence, 2);
  d.adapter.rename = rename; await store.save({ ...newer, sequence: 3 }); await store.save(first);
  assert.equal((await store.list())[0].sequence, 3);
});

test('history retention only removes owned scoped records and accounts remain isolated', async () => {
  const d = disk(), store = new ObsidianHistoryStore(d.app, device, context);
  d.files.set('ordinary-note.md', bytes('keep')); d.files.set(store.root + '/not-owned.json', bytes('keep'));
  for (let i = 0; i <= HISTORY_TASK_LIMIT; i++) await store.save({ ...task(i), status: 'completed', endedAt: i });
  assert.equal((await store.list()).length, HISTORY_TASK_LIMIT); assert.equal(d.files.has('ordinary-note.md'), true); assert.equal(d.files.has(store.root + '/not-owned.json'), true);
  assert.ok(d.removed.every(path => path.startsWith(store.root + '/') && !path.endsWith('/not-owned.json')));
  assert.deepEqual(await new ObsidianHistoryStore(d.app, device, 'b'.repeat(64)).list(), []);
  const record = task(40); d.files.set(store.root + `/40-${record.id}.json`, bytes('{corrupt'));
  const rows = await store.list(); assert.ok(rows.length); assert.equal(store.warning, true);
});

test('history persistence is serialized across instances without blocking sync task locks', async () => {
  const d = disk(), a = new ObsidianHistoryStore(d.app, device, context), b = new ObsidianHistoryStore(d.app, device, context);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const write = d.adapter.writeBinary; d.adapter.writeBinary = async (path, data) => { started(); await gate; await write(path, data); };
  const saving = a.save(task()); await ready; let listed = false; const reading = b.list().then(result => { listed = true; return result; });
  await Promise.resolve(); assert.equal(listed, false); release(); await saving; assert.equal((await reading).length, 1);
});
