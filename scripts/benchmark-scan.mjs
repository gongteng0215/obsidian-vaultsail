import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { baiduHarness } from '../test/fixtures/baidu.ts';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import { SyncEngine, newState } from '../src/sync/engine.ts';
import { bytes, hash, uuid } from '../src/core/safety.ts';

const baselineRef = process.argv[2] ?? '9b9e6ba997877d2c73db8c0a947582689e23d0a6', latencyMs = 10, repeats = 3;
const folder = path.resolve('dist/benchmark-scan'); mkdirSync(folder, { recursive: true });
const sources = ['src/providers/baidu-provider.ts', 'src/sync/remote-vault.ts', 'src/sync/engine.ts'];
const overrides = new Map(sources.map((source, i) => [path.resolve(source), path.join(folder, `source-${i}.ts`)]));
for (const source of sources) writeFileSync(overrides.get(path.resolve(source)), execFileSync('git', ['show', `${baselineRef}:${source}`], { encoding: 'utf8' }));
const built = await build({ stdin: { contents: sources.map((source, i) => `export { ${['BaiduProvider', 'RemoteVaultStore', 'SyncEngine, newState'][i]} } from ${JSON.stringify(path.resolve(source))};`).join('\n'), resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'baseline', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const original = [...overrides].find(([, file]) => file === args.importer)?.[0];
      const resolved = path.isAbsolute(args.path) ? args.path : original && args.path.startsWith('.') ? path.resolve(path.dirname(original), args.path) : undefined;
      return resolved ? { path: overrides.get(resolved) ?? resolved } : undefined;
    });
  } }] });
const bundle = path.join(folder, 'baseline.mjs'); writeFileSync(bundle, built.outputFiles[0].text);
const baseline = await import(pathToFileURL(bundle).href), current = { BaiduProvider, RemoteVaultStore, SyncEngine, newState };

async function measure(implementation) {
  const h = baiduHarness(), seed = new RemoteVaultStore(h.provider), vault = await seed.create('scan benchmark'), deviceId = uuid();
  const notes = new Map();
  for (let i = 0; i < 7; i++) {
    const data = bytes('note-content-' + i), file = `note-${i}.md`; notes.set(file, data);
    await seed.publish(vault.vaultId, { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId, fileId: uuid(), path: file,
      parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 }, data);
  }
  let saved, state = implementation.newState(), counts;
  const disk = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const store = { load: async () => structuredClone(state), save: async value => { state = structuredClone(value); } };
  const local = { paths: async () => [...notes.keys()], read: async file => notes.get(file)?.slice(0) ?? null };
  const fresh = () => {
    const provider = new implementation.BaiduProvider('/apps/中文应用', async input => {
      const url = new URL(input.url); counts.requests++;
      if (url.pathname.startsWith('/file/')) counts.downloads++;
      if (url.searchParams.get('method') === 'filemetas') counts.metadata++;
      if (url.searchParams.get('method') === 'list') counts.lists++;
      await new Promise(resolve => setTimeout(resolve, latencyMs)); const result = await h.transport(input);
      if (url.searchParams.get('method') === 'list') for (const row of result.json.list ?? []) delete row.md5;
      return result;
    }, { accessToken: async () => 'private-access' });
    return { provider, engine: new implementation.SyncEngine(new implementation.RemoteVaultStore(provider, disk, 8), local, store, vault.vaultId) };
  };
  let task = fresh(); const result = {};
  for (const stage of ['cold', 'warm', 'restart']) {
    if (stage === 'restart') task = fresh();
    counts = { requests: 0, downloads: 0, metadata: 0, lists: 0 }; const start = performance.now();
    await task.provider.profile(); await task.engine.sync();
    result[stage] = { elapsedMs: Math.round(performance.now() - start), ...counts, cachedRecords: saved.entries.length };
  }
  assert.equal((await seed.revisions(vault.vaultId)).length, 7);
  for (const op of await seed.revisions(vault.vaultId)) assert.equal(hash(await seed.blob(vault.vaultId, op)), hash(notes.get(op.path)));
  return result;
}
const rows = [];
for (let i = 0; i < repeats; i++) rows.push({ before: await measure(baseline), after: await measure(current) });
const average = side => Object.fromEntries(['cold', 'warm', 'restart'].map(stage => [stage,
  Object.fromEntries(Object.keys(rows[0][side][stage]).map(field => [field, Math.round(rows.reduce((sum, row) => sum + row[side][stage][field], 0) / repeats)]))]));
const report = { version: '0.1.23', baselineRef, measuredAt: new Date().toISOString(), simulated: true,
  scenario: '7 unchanged notes; list omits MD5, filemetas returns MD5; account check included', latencyMs, repeats, before: average('before'), after: average('after'), rows };
writeFileSync('docs/benchmarks/0.1.23-scan.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
