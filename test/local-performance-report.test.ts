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
    assert.deepEqual(group.timings.elapsedMs, { median: 1000, p95: 2000 }); assert.equal(group.withoutFileTransfers, true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
