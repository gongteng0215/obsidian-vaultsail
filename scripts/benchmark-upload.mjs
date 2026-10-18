// Synthetic API benchmark only: never uses credentials, notes, or a real cloud account.
// node --expose-gc --experimental-strip-types scripts/benchmark-upload.mjs --mib 64 --rounds 3
import fs from 'node:fs';
import { BaiduProvider } from '../src/providers/baidu-provider.ts';
import { baiduHarness } from '../test/fixtures/baidu.ts';
import { RequestPool } from '../src/core/request-pool.ts';
import { hash, MAX_ATTACHMENT_SIZE } from '../src/core/safety.ts';
const args = new Map(); for (let n = 2; n < process.argv.length; n += 2) args.set(process.argv[n], Number(process.argv[n + 1]));
const mib = args.get('--mib') ?? 64, rounds = args.get('--rounds') ?? 3, latencyMs = args.get('--latency') ?? 80;
if (!Number.isInteger(mib) || mib < 1 || mib > 512 || !Number.isInteger(rounds) || rounds < 1 || rounds > 5 || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 1000) throw new Error('Invalid benchmark parameters');
const source = new Uint8Array(mib * 1024 * 1024); source.fill(23); const expected = hash(source.buffer), results = [];
async function run(concurrency, round) {
  const h = baiduHarness(), network = new RequestPool(8); let active = 0, peak = 0, requests = 0, slices = 0, firstUpload, lastUpload;
  let sampledPeakRssMiB = process.memoryUsage().rss / 1048576;
  const timer = setInterval(() => { sampledPeakRssMiB = Math.max(sampledPeakRssMiB, process.memoryUsage().rss / 1048576); }, 25);
  const transport = Object.assign(async input => {
    requests++; const slice = new URL(input.url).searchParams.get('method') === 'upload';
    if (slice) { active++; peak = Math.max(peak, active); firstUpload ??= performance.now(); slices++; }
    try { if (slice) await new Promise(resolve => setTimeout(resolve, latencyMs)); return await h.transport(input); }
    finally { if (slice) { active--; lastUpload = performance.now(); } }
  }, { reserve: (_input, policy) => network.acquire(policy.signal, policy.timeoutMs) });
  const provider = new BaiduProvider('/apps/中文应用', transport, { accessToken: async () => 'private-access' }, undefined, undefined,
    { maxFileSize: MAX_ATTACHMENT_SIZE, chunkConcurrency: concurrency, uploadSlots: new RequestPool(8) });
  const started = performance.now();
  try {
    await provider.writeImmutable('benchmark/video.mp4', source.buffer); const overallMs = performance.now() - started;
    if (hash(h.files.get('/apps/中文应用/benchmark/video.mp4')) !== expected) throw new Error('Final content hash differs');
    return { concurrency, round, overallMs, uploadMs: lastUpload - firstUpload, requests, slices, peakSlices: peak, sampledPeakRssMiB, integrity: true };
  } finally { clearInterval(timer); h.files.clear(); h.uploads.clear(); }
}
for (let round = 1; round <= rounds; round++) for (const concurrency of round % 2 ? [1, 2] : [2, 1]) {
  global.gc?.(); const result = await run(concurrency, round); results.push(result); console.log(JSON.stringify(result));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [1, 2].map(concurrency => { const rows = results.filter(row => row.concurrency === concurrency); return { concurrency, medianOverallMs: median(rows.map(row => row.overallMs)), medianUploadMs: median(rows.map(row => row.uploadMs)) }; });
const report = { scope: 'Synthetic Baidu API with fixed per-slice latency; not real cloud throughput or native Obsidian memory certification', mib, rounds, latencyMs, sha256: expected, results, summary };
fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync(`dist/upload-performance-${mib}MiB.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ summary }));
