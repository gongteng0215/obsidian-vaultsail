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

const baselineRef = 'd49f7d39d8c162e51a5dd03efcad890986863024';
const side = process.argv[2] ?? 'current', size = Number(process.argv[3] ?? 49), rounds = Number(process.argv[4] ?? 3), latencyMs = 3;
assert.ok(['baseline', 'current'].includes(side) && Number.isSafeInteger(size) && size > 0 && size <= 1000 && Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 5);
const sources = ['src/providers/baidu-provider.ts', 'src/sync/directories.ts'];
const bundle = await build({ stdin: { contents: "export { BaiduProvider } from './src/providers/baidu-provider.ts'; export { RemoteVaultStore } from './src/sync/remote-vault.ts'; export { SyncEngine, newState } from './src/sync/engine.ts'; export { DirectorySync, RemoteDirectoryStore, newDirectoryState } from './src/sync/directories.ts';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: side === 'baseline' ? [{ name: 'baseline', setup(builder) { builder.onLoad({ filter: /\.ts$/ }, args => {
    const relative = path.relative(process.cwd(), args.path).replaceAll('\\', '/');
    return sources.includes(relative) ? { contents: execFileSync('git', ['show', `${baselineRef}:${relative}`], { encoding: 'utf8' }), loader: 'ts' } : undefined;
  }); } }] : [] });
fs.mkdirSync('dist/benchmark-remote-cache', { recursive: true });
const modulePath = path.resolve('dist/benchmark-remote-cache/' + side + '.mjs'); fs.writeFileSync(modulePath, bundle.outputFiles[0].text);
const impl = await import(pathToFileURL(modulePath).href);

async function measure() {
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
  let filesSaved, directoriesSaved, counts;
  const disk = kind => ({ load: async () => structuredClone(kind === 'files' ? filesSaved : directoriesSaved), save: async value => { counts.cacheWrites++; if (kind === 'files') filesSaved = structuredClone(value); else directoriesSaved = structuredClone(value); } });
  const local = { paths: async () => [...notes.keys()], stat: async p => notes.has(p) ? { size: notes.get(p).byteLength } : null, read: async p => notes.get(p)?.slice(0) ?? null };
  const folders = { paths: async () => [...dirs], files: async () => [...notes.keys()], present: async p => dirs.has(p), empty: async () => true, create: async () => { throw Error('Unexpected write'); }, removeEmpty: async () => { throw Error('Unexpected delete'); } };
  const fresh = () => {
    const provider = new impl.BaiduProvider('/apps/中文应用', async input => {
      const url = new URL(input.url), method = url.searchParams.get('method'); counts.requests++;
      if (method === 'list') counts.lists++; if (method === 'filemetas') counts.metadata++;
      if (url.pathname.startsWith('/file/')) { counts.downloads++; if (decodeURIComponent(url.pathname).includes('/ops/')) counts.fileRecords++; if (decodeURIComponent(url.pathname).includes('/directories/')) counts.directoryRecords++; }
      await new Promise(resolve => setTimeout(resolve, latencyMs)); const response = await h.transport(input);
      if (['list', 'filemetas'].includes(method)) for (const entry of response.json.list ?? []) if (typeof entry.md5 === 'string') entry.md5 = entry.md5.slice(0, 8) + 'g' + entry.md5.slice(9);
      return response;
    }, { accessToken: async () => 'private-access' });
    const remote = new impl.RemoteVaultStore(provider, disk('files'), 8), directories = new impl.RemoteDirectoryStore(provider, vaultId, 8, disk('directories'));
    return { provider, remote, directories, engine: new impl.SyncEngine(remote, local, { load: async () => structuredClone(state), save: async () => {} }, vaultId), folderSync: new impl.DirectorySync(directories, folders, { load: async () => structuredClone(directoryState), save: async () => {} }, vaultId, devices[0]) };
  };
  let task = fresh(); const result = {};
  for (const scenario of ['cold', 'warm', 'restart', 'browse', 'browse-repeat']) {
    if (scenario === 'restart' || scenario.startsWith('browse')) task = fresh();
    counts = { requests: 0, lists: 0, metadata: 0, downloads: 0, fileRecords: 0, directoryRecords: 0, cacheWrites: 0 };
    const start = performance.now(); await task.provider.profile();
    if (scenario.startsWith('browse')) {
      const [records] = side === 'current' ? await Promise.all([task.remote.revisions(vaultId), task.directories.revisions()])
        : [await task.remote.revisions(vaultId), await task.directories.revisions()]; assert.equal(records.length, size);
    } else {
      const plan = await task.folderSync.preview('sync', false); await task.engine.sync();
      if (!await task.folderSync.finishUnchanged?.(plan, false)) await task.folderSync.sync('sync', false);
    }
    result[scenario] = { elapsedMs: Math.round(performance.now() - start), ...counts };
  }
  return result;
}
const rows = []; for (let i = 0; i < rounds; i++) rows.push(await measure());
const summary = Object.fromEntries(Object.keys(rows[0]).map(scenario => { const times = rows.map(r => r[scenario].elapsedMs).sort((a, b) => a - b); return [scenario, { ...rows[0][scenario], medianMs: times[Math.floor(times.length / 2)], p95Ms: times.at(-1) }]; }));
const report = { baselineRef, side, simulated: true, scenario: 'Opaque server digest; two devices; unchanged notes and directory records; scan + browse', size, latencyMs, rounds, summary, rows };
fs.mkdirSync('dist/benchmark-remote-cache', { recursive: true });
fs.writeFileSync(`dist/benchmark-remote-cache/${side}-${size}.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ side, size, summary }));
