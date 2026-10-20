import fs from 'node:fs';
import assert from 'node:assert/strict';
const sizes = [7, 100, 1000], reports = [];
for (const size of sizes) {
  const pair = ['baseline', 'current'].map(side => JSON.parse(fs.readFileSync(`dist/benchmark-reliability/paired-${side}-${size}.json`, 'utf8')));
  for (const report of pair) { assert.equal(report.simulated, true); assert.equal(report.rounds, 10); assert.equal(report.rows.length, 10); assert.equal(report.size, size); assert.match(report.implementationSha256, /^[a-f0-9]{64}$/); }
  for (let round = 0; round < 10; round++) for (const scenario of Object.keys(pair[0].rows[round])) {
    assert.equal(pair[0].rows[round][scenario].requests, pair[1].rows[round][scenario].requests);
    if (['warm', 'restart', 'browse', 'browse-repeat'].includes(scenario)) for (const report of pair) {
      for (const key of ['fileRecords', 'directoryRecords', 'cacheWrites']) assert.equal(report.rows[round][scenario][key], 0);
    }
  }
  reports.push(...pair);
}
const regressions = sizes.flatMap(size => {
  const [before, after] = reports.filter(r => r.size === size);
  return Object.keys(before.summary).flatMap(scenario => after.summary[scenario].medianMs > before.summary[scenario].medianMs * 1.25 + 15 ? [{ size, scenario }] : []);
});
assert.equal(regressions.length, 0, 'Investigate substantial synthetic timing regressions before delivery');
const output = { format: 'vaultsail-reliability-benchmark', version: 1, baselineVersion: '0.2.21', previewVersion: '0.2.22', simulated: true,
  liveBaiduRequestsIssued: 0, clock: 'host-monotonic-elapsed', injectedLatencyMs: 3,
  checks: { sameScenarioRequestCountsEqual: true, unchangedHistoryBodyDownloads: 0, unchangedCacheWrites: 0, substantialSyntheticTimingRegressions: 0 }, reports };
fs.writeFileSync('docs/benchmarks/0.2.22-reliability.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ pairedRounds: 30, measuredTasks: 420, simulated: true, checks: output.checks }));
