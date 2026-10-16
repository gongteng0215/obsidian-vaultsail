// Isolated synthetic benchmark. No account, credentials or user files are read.
// Keep outside npm test so CI/mobile verification does not allocate this buffer.
import assert from 'node:assert/strict';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { hash, MAX_ATTACHMENT_SIZE, uuid } from '../src/core/safety.ts';
import { RemoteVaultStore } from '../src/sync/remote-vault.ts';
import { baiduHarness } from '../test/fixtures/baidu.ts';

const sizeMiB = Number(process.argv[2] ?? 339);
if (!Number.isInteger(sizeMiB) || sizeMiB < 21 || sizeMiB > 512) throw new Error('Expected 21–512 MiB');
let peakRss = 0, peakBuffers = 0;
const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakBuffers = Math.max(peakBuffers, memory.arrayBuffers); };
const started = performance.now(), h = baiduHarness();
const provider = new BaiduProvider('/apps/中文应用', async input => { sample(); const response = await h.transport(input); sample(); return response; }, { accessToken: async () => 'private-access' }, undefined, undefined, { maxFileSize: MAX_ATTACHMENT_SIZE });
const remote = new RemoteVaultStore(provider), vault = await remote.create('synthetic-desktop-benchmark');
const file = new Uint8Array(sizeMiB * 1024 * 1024); file.fill(83); sample();
const revision = { schemaVersion: 1, vaultId: vault.vaultId, opId: uuid(), deviceId: uuid(), fileId: uuid(), path: 'synthetic.mp4', parents: [], kind: 'update', hash: hash(file.buffer), size: file.byteLength, createdAt: Date.now() };
await remote.publish(vault.vaultId, revision, file.buffer); sample();
const revisions = await remote.revisions(vault.vaultId); assert.equal(revisions.length, 1); assert.equal(revisions[0].size, file.byteLength);
const downloaded = await remote.blob(vault.vaultId, revisions[0]); sample();
assert.equal(hash(downloaded), revision.hash);
assert.equal([...h.uploads.values()].find(upload => upload.size === file.byteLength).chunks.size, Math.ceil(sizeMiB / 4));
assert.equal(h.counts().refreshes, 0);
console.log(JSON.stringify({ simulated: true, sizeMiB, chunks: Math.ceil(sizeMiB / 4), hashVerified: true, publishedRecords: revisions.length, refreshes: h.counts().refreshes, elapsedSeconds: Math.round((performance.now() - started) / 100) / 10, peakRssMiB: Math.ceil(peakRss / 1024 / 1024), peakArrayBuffersMiB: Math.ceil(peakBuffers / 1024 / 1024) }));
