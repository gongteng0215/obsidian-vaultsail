import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, uuid, VaultSailError } from '../src/core/safety.ts';
import { DiagnosticLog, attachDiagnosticLog, errorDetails, validateDiagnostic, LOG_PENDING_LIMIT, type DiagnosticRecord } from '../src/diagnostics/log.ts';
import { traceRequest } from '../src/diagnostics/network.ts';
import { ObsidianDiagnosticStore, DIAGNOSTIC_SEGMENTS, DIAGNOSTIC_RETENTION_MS, DIAGNOSTIC_SEGMENT_BYTES } from '../src/platform/diagnostic-store.ts';
import { storageAdapter } from '../src/platform/local-io.ts';
import { request } from '../src/providers/http.ts';
import { SyncHistory, type FileHistoryEvent } from '../src/sync/history.ts';

const env = { pluginVersion: '0.2.15', obsidianVersion: '1.11.4', platform: 'desktop' as const, buildId: 'a'.repeat(40) };
function disk() {
  const files = new Map<string, ArrayBuffer>(), dirs = new Set<string>(), removed: string[] = [];
  let renameFailure = false;
  const adapter = { exists: async (p: string) => files.has(p) || dirs.has(p),
    stat: async (p: string) => files.has(p) ? { type: 'file', size: files.get(p)!.byteLength } : dirs.has(p) ? { type: 'folder', size: 0 } : null,
    mkdir: async (p: string) => { if (dirs.has(p) || files.has(p)) throw Object.assign(new Error('private mkdir'), { code: 'EEXIST' }); dirs.add(p); },
    readBinary: async (p: string) => { assert.ok(files.has(p)); return files.get(p)!.slice(0); },
    writeBinary: async (p: string, data: ArrayBuffer) => { files.set(p, data.slice(0)); },
    rename: async (from: string, to: string) => { if (renameFailure) { renameFailure = false; throw Object.assign(new Error('private rename'), { code: 'EPERM' }); }
      assert.ok(files.has(from)); assert.equal(files.has(to), false); files.set(to, files.get(from)!); files.delete(from); },
    remove: async (p: string) => { removed.push(p); files.delete(p); },
    list: async (p: string) => ({ files: [...files.keys()].filter(key => key.startsWith(p + '/') && !key.slice(p.length + 1).includes('/')), folders: [] as string[] }) };
  const app = { vault: { adapter } } as any;
  return { app, adapter, files, removed, failRename: () => { renameFailure = true; } };
}
function item(sequence = 1, at = 1): DiagnosticRecord { return { version: 1, id: uuid(), at, sequence, session: uuid(), scope: 'task', event: 'checkpoint', fields: { phase: 'uploading' } }; }

test('fingerprint diagnosis records numeric format counts without storing server digests or filenames', async () => {
  const rows: DiagnosticRecord[] = [], log = new DiagnosticLog({ append: async records => { rows.push(...records); }, read: async () => ({ records: rows, unreadable: 0 }) });
  const opaque = 'g'.repeat(32), standard = 'a'.repeat(32);
  try {
    await traceRequest(log, async () => ({ status: 200, headers: {}, bytes: bytes('private-response'), json: { list: [
      { md5: opaque, path: 'private-note.md' }, { md5: standard }, {}, { md5: 'bad' }, { isdir: 1 },
    ] } }), { url: 'https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&access_token=private-token' });
    await log.flush(); const row = rows.find(row => row.event === 'finish')!;
    assert.equal(row.fields.digestsOpaque, 1); assert.equal(row.fields.digestsStandard, 1); assert.equal(row.fields.digestsMissing, 1); assert.equal(row.fields.digestsRejected, 1);
    const serialized = JSON.stringify(rows); for (const text of [opaque, standard, 'private-note.md', 'private-response', 'private-token']) assert.equal(serialized.includes(text), false);
  } finally { log.close(); }
});

test('error causes, native codes, stack positions and signatures survive without messages, paths or secrets', () => {
  const native = Object.assign(new Error('EPERM: C:\\private-notes\\private.md https://x.test/?access_token=private-token secret=private-secret'), { code: 'EPERM', syscall: 'rename', errno: -4048 });
  native.stack = 'Error: private-note-body\n at privateToken (plugin:vaultsail:3:123)\n at secret (C:\\private-notes\\note.md:9:4)';
  const mapped = new VaultSailError('state', 'private response', false, 0, native);
  const details = errorDetails(mapped, 'local-salt');
  assert.deepEqual(details.map(value => value.code), ['state', 'EPERM']);
  assert.equal(details[1].syscall, 'rename'); assert.equal(details[1].errno, -4048);
  assert.deepEqual(details[1].frames[0], { source: 'vaultsail', line: 3, column: 123 });
  assert.equal(JSON.stringify(details).includes('private'), false); assert.equal(JSON.stringify(details).includes('local-salt'), false);
  assert.notEqual(details[1].signature, errorDetails(native, 'different-salt')[0].signature);
  (native as Error & { cause?: unknown }).cause = mapped; assert.equal(errorDetails(mapped, 'local-salt').length, 2, 'cyclic causes are bounded');
  assert.doesNotThrow(() => errorDetails({ get message() { throw new Error('secret'); } }, 'salt'));
});

test('stored/exported records are reconstructed from a whitelist, including malicious extra properties', async () => {
  const d = disk(), store = new ObsidianDiagnosticStore(d.app, uuid(), () => 100);
  const log = new DiagnosticLog(store, 'salt', () => 100, env);
  const id = log.record('local', 'failure', { phase: 'private-token', fileRef: 'private-name', status: 403, requestUrl: 'private-url', body: 'private-body' } as any, new Error('private-secret'));
  const report = JSON.parse(await log.report(env)); log.close();
  assert.ok(id); assert.equal(report.records[0].fields.status, 403); assert.equal(JSON.stringify(report).includes('private'), false);
  const injected = { ...item(), requestUrl: 'private-url', environment: { ...env, buildId: 'private' }, errors: [{ name: 'private', code: 'private', signature: 'private', message: 'private', frames: [{ source: 'private', line: 1, column: 2 }] }] };
  assert.equal(JSON.stringify(validateDiagnostic(injected)).includes('private'), false);
});

test('late concurrent network responses retain the originating task and request identity', async () => {
  const d = disk(), store = new ObsidianDiagnosticStore(d.app, uuid()); const log = new DiagnosticLog(store);
  const first = log.start('manual'); let finish!: (value: any) => void;
  const pending = traceRequest(log, () => new Promise(resolve => { finish = resolve; }), { url: 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=private-token' });
  log.end(first, 'failure'); const second = log.start('automatic');
  finish({ status: 200, headers: {}, json: { errno: -6, request_id: '12345678901234567890', error_msg: 'private-response' }, bytes: bytes('private-content') }); await pending; log.end(second, 'success');
  const report = JSON.parse(await log.report(env)); log.close(); const network = report.records.filter((v: DiagnosticRecord) => v.scope === 'network');
  assert.equal(network.length, 2); assert.ok(network.every((v: DiagnosticRecord) => v.fields.taskId === first));
  assert.equal(network[0].fields.requestId, network[1].fields.requestId); assert.equal(network[1].fields.apiCode, -6);
  assert.equal(network[1].fields.serviceRequestId, '12345678901234567890'); assert.equal(JSON.stringify(report).includes('private'), false);
});

test('network error conversion retains native cause; OAuth pending is a normal diagnostic outcome', async () => {
  const d = disk(), log = new DiagnosticLog(new ObsidianDiagnosticStore(d.app, uuid()));
  const native = Object.assign(new Error('private-url'), { code: 'ECONNRESET' });
  await assert.rejects(request(input => traceRequest(log, async () => { throw native; }, input), { url: 'https://pan.baidu.com/private' }), error => {
    assert.ok(error instanceof VaultSailError); assert.equal(error.code, 'network'); assert.equal(error.cause, native); return true;
  });
  const previous = log.lastErrorId;
  await traceRequest(log, async () => ({ status: 400, headers: {}, json: { error: 'authorization_pending' }, bytes: bytes('private') }), { url: 'https://openapi.baidu.com/oauth/2.0/token?code=private' });
  assert.equal(log.lastErrorId, previous); log.close(); await log.flush();
});

test('diagnostic persistence survives restart, interrupted rename and idempotent replay', async () => {
  const d = disk(), device = uuid(), store = new ObsidianDiagnosticStore(d.app, device, () => 100);
  const event = item(1, 100); d.failRename(); await assert.rejects(store.append([event]));
  assert.equal((await new ObsidianDiagnosticStore(d.app, device, () => 100).read()).records[0].id, event.id);
  await store.append([event]); await store.append([event]);
  const log = new DiagnosticLog(new ObsidianDiagnosticStore(d.app, device, () => 100));
  const report = JSON.parse(await log.report(env)); log.close();
  assert.equal(report.records.filter((v: DiagnosticRecord) => v.id === event.id).length, 1);
  assert.equal([...d.files.keys()].filter(path => path.endsWith('.json')).length, 1);
});

test('rotation caps complete/staged segments, expires old logs and only removes its own files', async () => {
  const d = disk(), device = uuid(); let now = 100;
  const store = new ObsidianDiagnosticStore(d.app, device, () => now);
  const foreign = store.root + '/keep-user-file.json'; d.files.set(foreign, bytes('private'));
  for (let i = 1; i <= DIAGNOSTIC_SEGMENTS + 5; i++) await store.append([item(i, now)]);
  let records = (await store.read()).records;
  assert.equal(records.length, DIAGNOSTIC_SEGMENTS / 2); assert.ok(records.some(value => value.sequence === DIAGNOSTIC_SEGMENTS + 5));
  assert.ok(records.every(value => value.sequence > DIAGNOSTIC_SEGMENTS / 2 + 5)); assert.ok(d.files.has(foreign));
  now += DIAGNOSTIC_RETENTION_MS + 1; await store.append([item(99, now)]); records = (await store.read()).records;
  assert.deepEqual(records.map(value => value.sequence), [99]); assert.ok(d.files.has(foreign));
  assert.ok(d.removed.every(path => path.startsWith(store.root + '/') && path !== foreign));
});

test('corrupt/oversized segments are reported without preventing usable logs or importing arbitrary fields', async () => {
  const d = disk(), store = new ObsidianDiagnosticStore(d.app, uuid(), () => 100); await store.append([item(1, 100)]);
  d.files.set(store.root + '/trace-100-2-' + uuid() + '.json', bytes('broken-json-private'));
  d.files.set(store.root + '/trace-100-3-' + uuid() + '.json', new ArrayBuffer(DIAGNOSTIC_SEGMENT_BYTES + 1));
  const read = await store.read(); assert.equal(read.records.length, 1); assert.equal(read.unreadable, 2);
});

test('disk failures stay advisory, pending memory is bounded and a later retry persists the same error ID', async () => {
  const rows: DiagnosticRecord[] = []; let blocked = true;
  const log = new DiagnosticLog({ append: async records => { if (blocked) throw new Error('disk-full-private'); rows.push(...records); }, read: async () => ({ records: rows, unreadable: 0 }) });
  for (let i = 0; i < LOG_PENDING_LIMIT + 10; i++) log.record('task', 'phase', { phase: 'uploading' });
  const id = log.record('task', 'failure', {}, new Error('private'));
  let report = JSON.parse(await log.report(env)); assert.equal(report.storageFailed, true); assert.ok(report.pending <= LOG_PENDING_LIMIT); assert.ok(report.dropped > 0);
  assert.equal(report.storageError[0].name, 'Error');
  assert.ok(report.records.some((v: DiagnosticRecord) => v.id === id)); assert.equal(JSON.stringify(report).includes('private'), false);
  blocked = false; report = JSON.parse(await log.report(env)); assert.equal(report.storageFailed, false); assert.equal(report.pending, 0);
  assert.ok(rows.some(value => value.id === id)); log.close(); await log.flush();
});

test('local adapter failures record operation, alias, native cause and task; log failures do not retry the write', async () => {
  const d = disk(), log = new DiagnosticLog(new ObsidianDiagnosticStore(d.app, uuid())); attachDiagnosticLog(d.app, log);
  const task = log.start('manual'); d.failRename(); d.files.set('private-source.md', bytes('private-text'));
  await assert.rejects(storageAdapter(d.app).rename('private-source.md', 'private-target.md'));
  log.end(task, 'failure'); const report = JSON.parse(await log.report(env)); log.close();
  const failure = report.records.find((v: DiagnosticRecord) => v.scope === 'local' && v.event === 'failure');
  assert.equal(failure.fields.taskId, task); assert.equal(failure.fields.step, 'rename'); assert.equal(failure.fields.fileRef, log.ref('private-source.md'));
  assert.deepEqual(failure.errors.map((e: any) => e.code), ['state', 'EPERM']); assert.ok(d.files.has('private-source.md')); assert.equal(JSON.stringify(report).includes('private'), false);
});

test('per-file diagnostic IDs survive history persistence and advisory failure observers cannot stop tasks', async () => {
  let saved: any; const id = uuid(), device = uuid(), context = 'a'.repeat(64);
  const history = new SyncHistory({ save: async value => { saved = value; }, list: async () => saved ? [saved] : [] }, context, device);
  history.begin('manual'); history.file({ id: uuid(), path: 'note.md', action: 'upload', size: 1, state: 'unconfirmed', reason: 'stopped', code: 'state', diagnosticId: id } as FileHistoryEvent);
  await history.finish(new VaultSailError('state', 'failure')); assert.equal((await history.list())[0].files[0].diagnosticId, id);
  const broken = new SyncHistory({ save: async () => { throw new Error('disk'); }, list: async () => [] }, context, device, '.obsidian', () => { throw new Error('observer'); });
  broken.begin('manual'); await broken.finish(); assert.equal(broken.warning, true);
});

test('routine checks cannot rotate out failure segments; failures retain numeric task settings', async () => {
  const d = disk(), store = new ObsidianDiagnosticStore(d.app, uuid(), () => 100), log = new DiagnosticLog(store, 'salt', () => 100, env);
  const task = log.start('automatic', { concurrency: 8, deletionEnabled: false });
  const id = log.record('task', 'failure', {}, new VaultSailError('state', 'synthetic')); log.end(task, 'failure'); await log.flush();
  for (let i = 2; i < 50; i++) await store.append([item(i, 100 + i)]);
  const restarted = new DiagnosticLog(store); const report = JSON.parse(await restarted.report(env)); log.close(); restarted.close();
  const failure = report.records.find((record: DiagnosticRecord) => record.id === id);
  assert.equal(failure.fields.concurrency, 8); assert.equal(failure.fields.deletionEnabled, false);
  assert.equal(failure.environment.buildId, env.buildId); assert.equal(report.lastErrorId, id);
});

test('a committed segment followed by failed housekeeping cannot block a larger retry batch', async () => {
  const d = disk(), store = new ObsidianDiagnosticStore(d.app, uuid(), () => 100);
  const original = d.adapter.list; let reads = 0;
  d.adapter.list = async p => { if (++reads === 2) throw new Error('cleanup unavailable'); return original(p); };
  const first = item(1, 100), second = item(2, 100); await assert.rejects(store.append([first]));
  await store.append([first, second]);
  const log = new DiagnosticLog(store); const report = JSON.parse(await log.report(env)); log.close();
  assert.equal(report.records.filter((v: DiagnosticRecord) => v.id === first.id).length, 1);
  assert.equal(report.records.filter((v: DiagnosticRecord) => v.id === second.id).length, 1);
});
