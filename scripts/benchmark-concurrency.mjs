import './node-host.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SyncEngine, newState } from '../src/sync/engine.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import { hash, VaultSailError } from '../src/core/safety.ts';

const latencyMs = 20, files = 12, repeats = 3;
class Cloud {
  id = 'benchmark'; displayName = 'Synthetic cloud'; root = '/apps/benchmark';
  capabilities = { canList: true, canRead: true, canWrite: true, canDelete: false, supportsConditionalWrites: false };
  files = new Map(); dirs = new Set(); active = 0; peak = 0; calls = 0;
  isConfigured() { return true; }
  async wait() { this.calls++; this.active++; this.peak = Math.max(this.peak, this.active); await new Promise(r => setTimeout(r, latencyMs)); this.active--; }
  async mkdir(path) { const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/')); }
  async exists(path) { return this.files.has(path) || this.dirs.has(path); }
  async list(dir, cursor = '0') {
    if (dir && !this.dirs.has(dir)) throw new VaultSailError('not-found', 'missing');
    const prefix = dir ? dir + '/' : '';
    const objects = [...this.files].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([path, data]) => ({ path, size: data.byteLength, isDirectory: false }));
    objects.push(...[...this.dirs].filter(p => p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes('/')).map(path => ({ path, size: 0, isDirectory: true })));
    objects.sort((a, b) => a.path.localeCompare(b.path)); const offset = Number(cursor), page = objects.slice(offset, offset + 100);
    return { objects: page, complete: page.length < 100, ...(page.length === 100 ? { nextCursor: String(offset + 100) } : {}) };
  }
  async read(path) { await this.wait(); const data = this.files.get(path); if (!data) throw new VaultSailError('not-found', 'missing'); return data.slice(0); }
  async writeImmutable(path, data) {
    await this.wait(); const old = this.files.get(path); if (old && hash(old) !== hash(data)) throw new VaultSailError('integrity', 'collision');
    if (path.includes('/')) await this.mkdir(path.slice(0, path.lastIndexOf('/'))); this.files.set(path, data.slice(0));
    assert.equal(hash(await this.read(path)), hash(data));
  }
  reset() { this.peak = this.active; this.calls = 0; }
}
class Local {
  files = new Map(); copies = new Map(); staging = new Map();
  async paths() { return [...this.files.keys()]; }
  async read(path) { return this.files.get(path)?.slice(0) ?? null; }
  async stage(id, data) { this.staging.set(id, data.slice(0)); }
  async staged(id) { return this.staging.get(id)?.slice(0) ?? null; }
  async preserve(path, data, id) { this.copies.set(id + '/' + path, data.slice(0)); return id; }
  async readConflictCopy(path, key) { return this.copies.get(key + '/' + path) ?? null; }
  async writeConflictCopy(path, key, data) { this.copies.set(key + '/' + path, data.slice(0)); }
  async apply(path, data, expected, id) { const old = await this.read(path); assert.equal(old === null ? null : hash(old), expected); if (old) await this.preserve(path, old, id); if (data === null) this.files.delete(path); else this.files.set(path, data.slice(0)); }
}
class State { value = newState(); async load() { return structuredClone(this.value); } async save(value) { this.value = structuredClone(value); } }
const results = [];
for (const concurrency of [1, 3]) for (let repeat = 0; repeat < repeats; repeat++) {
  const cloud = new Cloud(), remote = new RemoteVaultStore(cloud, undefined, concurrency), vault = await remote.create('Synthetic benchmark');
  const source = new Local(), target = new Local();
  for (let i = 0; i < files; i++) { const data = new Uint8Array(1024); data.fill(31); data[0] = i; source.files.set(`note-${String(i).padStart(2, '0')}.md`, data.buffer); }
  const upload = new SyncEngine(remote, source, new State(), vault.vaultId, '.obsidian', () => {}, concurrency);
  const download = new SyncEngine(new RemoteVaultStore(cloud, undefined, concurrency), target, new State(), vault.vaultId, '.obsidian', () => {}, concurrency);
  cloud.reset(); let started = performance.now(); await upload.sync();
  const uploadResult = { ms: Math.round(performance.now() - started), peak: cloud.peak, calls: cloud.calls };
  cloud.reset(); started = performance.now(); await download.sync();
  const downloadResult = { ms: Math.round(performance.now() - started), peak: cloud.peak, calls: cloud.calls };
  assert.equal(target.files.size, files); for (const [path, data] of source.files) assert.equal(hash(target.files.get(path)), hash(data));
  results.push({ concurrency, repeat: repeat + 1, upload: uploadResult, download: downloadResult, hashesVerified: files });
}
const mean = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
const summary = [1, 3].map(concurrency => { const rows = results.filter(row => row.concurrency === concurrency); return { concurrency,
  uploadMs: mean(rows.map(row => row.upload.ms)), downloadMs: mean(rows.map(row => row.download.ms)), peakUpload: Math.max(...rows.map(row => row.upload.peak)), peakDownload: Math.max(...rows.map(row => row.download.peak)) }; });
const report = { synthetic: true, measuredAt: new Date().toISOString(), latencyMs, files, bytesPerFile: 1024, repeats, description: 'Synthetic cloud read/write delay; complete readback/hash verification; excludes real Baidu bandwidth, OAuth and local disk latency.', summary, results };
mkdirSync('dist', { recursive: true }); writeFileSync('dist/concurrency-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
