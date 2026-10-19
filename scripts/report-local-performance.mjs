// Read numeric history summaries only. No credentials, notes or network access.
import fs from 'node:fs';
import path from 'node:path';
import { validateScanSummary } from '../src/sync/scan-summary.ts';

const args = process.argv.slice(2), outputArg = args.find(arg => arg.startsWith('--output='));
const roots = args.filter(arg => !arg.startsWith('--'));
if (!roots.length || args.some(arg => arg.startsWith('--') && !arg.startsWith('--output='))) throw Error('Usage: node --experimental-strip-types scripts/report-local-performance.mjs <vault> [<vault>] --output=<report.json>');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const historyFile = /^\d{1,16}-[a-f0-9-]{36}\.json$/;
const directories = root => fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()) : [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const counters = ['requestCount', 'refreshCount', 'retryCount', 'scans', 'listed', 'cacheHits', 'read', 'readBytes', 'cacheWrites', 'cacheSaveFailures'];
const timings = ['elapsedMs', 'connectingMs', 'remoteMs', 'localMs', 'transferMs', 'listingMs', 'metadataMs', 'readingMs', 'cacheMs'];
const vaults = roots.map((root, index) => {
  const rows = []; let invalidSummaries = 0;
  const state = path.join(path.resolve(root), '.vaultsail-state');
  for (const device of directories(state).filter(entry => uuid.test(entry.name))) {
    const history = path.join(state, device.name, 'history');
    for (const context of directories(history).filter(entry => /^[a-f0-9]{64}$/.test(entry.name))) {
      const folder = path.join(history, context.name);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !historyFile.test(entry.name)) continue;
        const source = path.join(folder, entry.name);
        try {
          if (fs.statSync(source).size > 2 * 1024 * 1024) { invalidSummaries++; continue; }
          const task = JSON.parse(fs.readFileSync(source, 'utf8')), summary = validateScanSummary(task.performance);
          if (!summary) { invalidSummaries++; continue; }
          if (!Number.isSafeInteger(task.startedAt) || !['completed', 'failed', 'paused', 'interrupted', 'running'].includes(task.status)) { invalidSummaries++; continue; }
          const noTransfers = Array.isArray(task.files) && task.files.every(file => ['unchanged', 'skipped'].includes(file.state));
          rows.push({ order: task.startedAt, status: task.status, noTransfers, summary });
        } catch { invalidSummaries++; }
      }
    }
  }
  // Keep the most recent 30 across scopes, without exporting scope or time.
  rows.sort((a, b) => b.order - a.order); const latest = rows.slice(0, 30), groups = new Map();
  for (const row of latest) {
    const key = [row.summary.pluginVersion, row.summary.platform, row.status, row.noTransfers].join('|');
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return { vault: index + 1, samples: latest.length, invalidSummaries, groups: [...groups.values()].map(group => {
    const { pluginVersion, platform } = group[0].summary;
    return { pluginVersion, platform, status: group[0].status, withoutFileTransfers: group[0].noTransfers, samples: group.length,
      counts: Object.fromEntries(counters.map(key => { const values = group.map(row => row.summary[key]); return [key, { min: Math.min(...values), max: Math.max(...values), total: values.reduce((a, b) => a + b, 0) }]; })),
      timings: Object.fromEntries(timings.map(key => { const values = group.map(row => row.summary[key]); return [key, { median: percentile(values, .5), p95: percentile(values, .95) }]; })) };
  }) };
});
const report = { format: 'vaultsail-local-performance', version: 1, source: 'existing-device-history', liveRequestsIssued: 0, vaults };
const text = JSON.stringify(report, null, 2) + '\n';
if (outputArg) fs.writeFileSync(outputArg.slice('--output='.length), text);
console.log(text);
