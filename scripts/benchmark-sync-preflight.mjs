import './node-host.mjs';
// Synthetic transport only. No accounts, tokens, user notes or live Baidu requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { baiduHarness } from '../test/fixtures/baidu.ts';
import { bytes, hash, jsonBytes, uuid } from '../src/core/safety.ts';

const baselineRef = 'bd6a1cea6b71fd0b1606c5926bb5011614f45307';
const selected = process.argv[2] ?? 'current', size = Number(process.argv[3] ?? 49), rounds = Number(process.argv[4] ?? 3), latencyMs = Number(process.argv[5] ?? 3);
assert.ok(['baseline', 'current', 'compare'].includes(selected) && Number.isSafeInteger(size) && size > 0 && size <= 1000 && Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 20 && Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 100);

async function loadImplementation(side) {
const bundle = await build({ stdin: { contents: "export { BaiduProvider } from './src/providers/baidu-provider.ts'; export { RemoteVaultStore } from './src/sync/remote-vault.ts'; export { SyncEngine, newState } from './src/sync/engine.ts'; export { DirectorySync, RemoteDirectoryStore, newDirectoryState } from './src/sync/directories.ts';" + (side === 'current' ? " export { scanInventories } from './src/sync/preflight.ts';" : ''), resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: side === 'baseline' ? [{ name: 'baseline', setup(builder) { builder.onLoad({ filter: /\.ts$/ }, args => {
    const relative = path.relative(process.cwd(), args.path).replaceAll('\\', '/');
    return relative.startsWith('src/') ? { contents: execFileSync('git', ['show', `${baselineRef}:${relative}`], { encoding: 'utf8' }), loader: 'ts' } : undefined;
  }); } }] : [] });
fs.mkdirSync('dist/benchmark-sync-preflight', { recursive: true });
const modulePath = path.resolve('dist/benchmark-sync-preflight/' + side + '.mjs'); fs.writeFileSync(modulePath, bundle.outputFiles[0].text);
return import(pathToFileURL(modulePath).href);
}

async function measure(impl, side) {
  const h = baiduHarness(), vaultId = uuid(), devices = [uuid(), uuid()], base = 'vaultsail/vaults/' + vaultId;
  const put = (relative, data) => {
    const full = '/apps/中文应用/' + relative, parts = full.split('/');
    for (let i = 3; i < parts.length; i++) h.dirs.add(parts.slice(0, i).join('/'));
    h.files.set(full, data); if (!h.ids.has(full)) h.ids.set(full, String(h.ids.size + 1));
  };
  put(base + '/vault.json', jsonBytes({ schemaVersion: 1, vaultId, displayName: 'synthetic', createdAt: 1 }));
  const notes = new Map(), dirs = new Set(), state = impl.newState(devices[0]), directoryState = impl.newDirectoryState(vaultId, devices[0]);
  for (let i = 0; i < size; i++) {
    const data = bytes('synthetic-' + i), op = { schemaVersion: 1, vaultId, deviceId: devices[i % 2], fileId: uuid(), opId: uuid(), path: 'note-' + i + '.md', parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
    put(base + '/blobs/' + op.hash, data); put(base + '/ops/' + op.deviceId + '/' + op.opId + '.json', jsonBytes(op));
    notes.set(op.path, data); state.bases[op.path] = { hash: op.hash, heads: [op.opId], fileId: op.fileId }; state.knownOps.push(op.opId);
  }
  for (let i = 0; i < Math.max(1, Math.ceil(size / 8)); i++) {
    const op = { version: 1, vaultId, deviceId: devices[0], opId: uuid(), path: 'empty-' + i, parents: [], kind: 'create', createdAt: 1 };
    put(base + '/directories/' + op.deviceId + '/' + op.opId + '.json', jsonBytes(op)); dirs.add(op.path); directoryState.bases[op.path] = { present: true, heads: [op.opId] };
  }
  let filesSaved, directoriesSaved, counts, savedState = structuredClone(state); const staging = new Map();
  const disk = kind => ({ load: async () => structuredClone(kind === 'files' ? filesSaved : directoriesSaved), save: async value => { counts.cacheWrites++; if (kind === 'files') filesSaved = structuredClone(value); else directoriesSaved = structuredClone(value); } });
  const local = { apply: async (p, data, expected) => { assert.equal(notes.has(p) ? hash(notes.get(p)) : null, expected); if (data) notes.set(p, data.slice(0)); else notes.delete(p); }, preserve: async () => 'recovery', stage: async (id, data) => staging.set(id, data.slice(0)), staged: async id => staging.get(id)?.slice(0) ?? null, readConflictCopy: async () => null, writeConflictCopy: async () => {}, paths: async () => [...notes.keys()], stat: async p => notes.has(p) ? { size: notes.get(p).byteLength } : null, read: async p => notes.get(p)?.slice(0) ?? null };
  const folders = { paths: async () => [...dirs], files: async () => [...notes.keys()], present: async p => dirs.has(p), empty: async () => true, create: async () => { throw Error('Unexpected write'); }, removeEmpty: async () => { throw Error('Unexpected delete'); } };
  const fresh = () => {
    const provider = new impl.BaiduProvider('/apps/中文应用', async input => {
      const url = new URL(input.url), method = url.searchParams.get('method'); counts.requests++;
      if (method === 'list') counts.lists++; if (method === 'filemetas') counts.metadata++;
      if (url.pathname.startsWith('/file/')) { counts.downloads++; if (decodeURIComponent(url.pathname).includes('/ops/')) counts.fileRecords++; if (decodeURIComponent(url.pathname).includes('/directories/')) counts.directoryRecords++; }
      await new Promise(resolve => setTimeout(resolve, latencyMs)); const response = await h.transport(input);
      
      return response;
    }, { accessToken: async () => 'private-access' });
    const remote = new impl.RemoteVaultStore(provider, disk('files'), 8), directories = new impl.RemoteDirectoryStore(provider, vaultId, 8, disk('directories'));
    return { provider, remote, directories, engine: new impl.SyncEngine(remote, local, { load: async () => structuredClone(savedState), save: async v => { savedState = structuredClone(v); } }, vaultId), folderSync: new impl.DirectorySync(directories, folders, { load: async () => structuredClone(directoryState), save: async () => {} }, vaultId, devices[0]) };
  };
  let task = fresh(); const result = {};
  for (const scenario of ['cold', 'warm', 'restart', 'local-edit', 'remote-edit', 'browse', 'browse-repeat']) {
    if (scenario === 'restart' || scenario === 'browse' || scenario === 'browse-repeat' && side === 'baseline') task = fresh();
    if (scenario === 'local-edit') notes.set('note-0.md', bytes('synthetic-local-edit'));
    if (scenario === 'remote-edit') { const current = Object.values(savedState.bases).length && savedState.bases['note-0.md']; const data = bytes('synthetic-remote-edit'), op = { schemaVersion: 1, vaultId, deviceId: devices[1], fileId: current.fileId, opId: uuid(), path: 'note-0.md', parents: [...current.heads], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 2 }; put(base + '/blobs/' + op.hash, data); put(base + '/ops/' + op.deviceId + '/' + op.opId + '.json', jsonBytes(op)); }
    counts = { requests: 0, lists: 0, metadata: 0, downloads: 0, fileRecords: 0, directoryRecords: 0, cacheWrites: 0 };
    const start = performance.now(); await task.provider.profile();
    if (scenario.startsWith('browse')) {
      const [records] = await Promise.all([task.remote.revisions(vaultId), task.directories.revisions()]); assert.ok(records.length >= size);
    } else {
      let plan; if (side === 'current') { const [ops, folders] = await impl.scanInventories(() => task.engine.prepareRemote(), () => task.folderSync.preview('sync', false)); plan = folders; await task.engine.sync(false, { ops }); } else { plan = await task.folderSync.preview('sync', false); await task.engine.sync(); }
      if (scenario === 'remote-edit') assert.equal(hash(notes.get('note-0.md')), hash(bytes('synthetic-remote-edit')));
      if (!await task.folderSync.finishUnchanged?.(plan, false)) await task.folderSync.sync('sync', false);
    }
    result[scenario] = { elapsedMs: Math.round(performance.now() - start), ...counts };
  }
  return result;
}

const sides = selected === 'compare' ? ['baseline', 'current'] : [selected];
const implementations = Object.fromEntries(await Promise.all(sides.map(async side => [side, await loadImplementation(side)])));
const results = Object.fromEntries(sides.map(side => [side, []]));
for (let i = 0; i < rounds; i++) {
  // Alternate order in the same process to expose host load/timer noise.
  for (const side of i % 2 ? [...sides].reverse() : sides) results[side].push(await measure(implementations[side], side));
}
const reports = sides.map(side => {
  const rows = results[side];
  const summary = Object.fromEntries(Object.keys(rows[0]).map(scenario => { const times = rows.map(r => r[scenario].elapsedMs).sort((a, b) => a - b); return [scenario, { ...rows[0][scenario], medianMs: times[Math.ceil(times.length / 2) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1] }]; }));
  return { baselineRef, side, simulated: true, scenario: '0.2.18 versus parallel preflight; trusted server digests; two devices; reload and single-file edits', size, latencyMs, rounds, summary, rows };
});
for (const report of reports) { fs.writeFileSync(`dist/benchmark-sync-preflight/${selected === 'compare' ? 'paired-' : ''}${report.side}-${size}.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ side: report.side, size, summary: report.summary })); }
