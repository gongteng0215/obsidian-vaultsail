import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSummary } from '../src/sync/scan-summary.ts';
import { TransferPerformance } from '../src/sync/performance.ts';
import { uuid } from '../src/core/safety.ts';

test('local performance report exports validated numeric aggregates without paths, scope, time or private task fields', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsail-report-private-'));
  try {
    const device = uuid(), context = 'a'.repeat(64), history = path.join(temp, '.vaultsail-state', device, 'history', context);
    fs.mkdirSync(history, { recursive: true });
    const performance = new TransferPerformance(); performance.begin();
    const summary = scanSummary(performance.snapshot(), '0.2.18', false)!;
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(history, `${100 + i}-${uuid()}.json`), JSON.stringify({
      startedAt: 100 + i, status: 'completed', files: [{ path: 'private-note.md', state: 'unchanged' }],
      secret: 'private-token', url: 'https://private.invalid', performance: { ...summary, requestCount: 8, elapsedMs: 1000 + i * 1000, private: 'private-response' },
    }));
    fs.writeFileSync(path.join(history, `200-${uuid()}.json`), '{broken');
    fs.writeFileSync(path.join(history, 'data.json'), '{"credential":"never-read"}');
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/report-local-performance.mjs', temp], { encoding: 'utf8' });
    for (const secret of ['private', device, context, 'startedAt', 'never-read', 'path']) assert.equal(stdout.includes(secret), false);
    const report = JSON.parse(stdout); assert.equal(report.liveRequestsIssued, 0); assert.equal(report.vaults[0].samples, 2); assert.equal(report.vaults[0].invalidSummaries, 1);
    const group = report.vaults[0].groups[0]; assert.equal(group.counts.requestCount.total, 16);
    assert.deepEqual(group.timings.elapsedMs, { samples: 2, median: 1000, min: 1000, max: 2000 }); assert.equal(group.withoutFileTransfers, true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('acceptance collector keeps task/scenario groups separate and reserves P95 for at least ten samples', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsail-special-performance-'));
  const perf = new TransferPerformance(); perf.begin(); const base = scanSummary(perf.snapshot(), '0.2.22', true, 'automatic')!;
  const run = (...args: string[]) => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/acceptance-performance.mjs', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const samples = path.join(temp, 'samples'); fs.mkdirSync(samples);
    const source = path.join(temp, 'private-source.json');
    for (let i = 0; i < 13; i++) {
      fs.writeFileSync(source, JSON.stringify({ ...base, taskType: i < 10 ? 'automatic' : 'manual', elapsedMs: i + 1, secret: 'private-token' }));
      run('record', source, '--case=' + (i < 10 ? 'warm' : 'restart'), '--files=100', '--output=' + path.join(samples, i + '.json'));
    }
    const text = run('summarize', samples), report = JSON.parse(text);
    assert.equal(report.groups.length, 2); assert.equal(text.includes('private'), false);
    const warm = report.groups.find((g: any) => g.scenario === 'warm'), restart = report.groups.find((g: any) => g.scenario === 'restart');
    assert.equal(warm.samples, 10); assert.equal(warm.p95Ms, 10); assert.equal(restart.samples, 3); assert.equal(restart.p95Ms, undefined); assert.equal(restart.minMs, 11); assert.equal(restart.maxMs, 13);
    assert.throws(() => run('record', source, '--case=warm', '--files=100', '--output=' + path.join(samples, '0.json')), 'never overwrite a saved acceptance sample');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
