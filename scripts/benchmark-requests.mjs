import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { baiduHarness } from '../test/fixtures/baidu.ts';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import { bytes, hash, uuid } from '../src/core/safety.ts';

// An API emulator, not a Baidu account speed test. A fixed service capacity
// makes redundant request pressure visible while keeping data/latency equal.
const baselineRef = process.argv[2] ?? 'HEAD', latencyMs = 10, serviceSlots = 4, concurrency = 8, repeats = 3;
const folder = path.resolve('dist/benchmark-requests'); mkdirSync(folder, { recursive: true });
const baselinePath = path.join(folder, 'baseline.ts');
writeFileSync(baselinePath, execFileSync('git', ['show', baselineRef + ':src/providers/baidu-provider.ts'], { encoding: 'utf8' }));
const built = await build({ entryPoints: [baselinePath], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'baseline-relative-imports', setup(builder) {
    builder.onResolve({ filter: /^\.\.?\// }, args => args.importer === baselinePath
      ? { path: path.resolve('src/providers', args.path) } : undefined);
  } }] });
const baselineBundle = path.join(folder, 'baseline.mjs'); writeFileSync(baselineBundle, built.outputFiles[0].text);
const { BaiduProvider: Baseline } = await import(pathToFileURL(baselineBundle).href);

async function measure(Provider, reuse) {
  const h = baiduHarness(); let enabled = false, active = 0, total = 0, downloads = 0, lists = 0;
  const queue = [];
  const transport = async input => {
    if (!enabled) return h.transport(input);
    total++; const url = new URL(input.url);
    if (url.pathname.startsWith('/file/')) downloads++;
    if (url.searchParams.get('method') === 'list') lists++;
    if (active >= serviceSlots) await new Promise(resolve => queue.push(resolve)); else active++;
    try { await new Promise(resolve => setTimeout(resolve, latencyMs)); return await h.transport(input); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  };
  const remote = new RemoteVaultStore(new Provider('/apps/中文应用', transport, { accessToken: async () => 'private-access' }));
  const vault = await remote.create('synthetic benchmark'), deviceId = uuid();
  const files = reuse ? 16 : 8, inputs = Array.from({ length: files }, (_, i) => bytes(String(i % 8).padEnd(1024, 'x')));
  enabled = true; const start = performance.now();
  for (let start = 0; start < files; start += concurrency) await Promise.all(inputs.slice(start, start + concurrency).map((data, offset) => {
    const op = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId, fileId: uuid(), path: `note-${start + offset}.md`,
      parents: [], kind: 'update', hash: hash(data), size: data.byteLength, createdAt: 1 };
    return remote.publish(vault.vaultId, op, data);
  }));
  const elapsedMs = Math.round(performance.now() - start); enabled = false;
  const revisions = await remote.revisions(vault.vaultId); assert.equal(revisions.length, files);
  for (const op of revisions) assert.equal(hash(await remote.blob(vault.vaultId, op)), op.hash);
  return { elapsedMs, requests: total, lists, downloads, verifiedFiles: files };
}
const results = [];
for (const reuse of [false, true]) {
  const rows = [];
  for (let repeat = 0; repeat < repeats; repeat++) rows.push({ before: await measure(Baseline, reuse), after: await measure(BaiduProvider, reuse) });
  const average = key => Object.fromEntries(Object.keys(rows[0][key]).map(field => [field, Math.round(rows.reduce((sum, row) => sum + row[key][field], 0) / repeats)]));
  results.push({ scenario: reuse ? '16 notes, 8 reused blobs across batches' : '8 notes, unique blobs', before: average('before'), after: average('after'), rows });
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const report = { version, baselineRef, measuredAt: new Date().toISOString(), simulated: true, latencyMs, serviceSlots, concurrency, repeats, results };
mkdirSync('docs/benchmarks', { recursive: true });
writeFileSync(`docs/benchmarks/${version}-requests.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
