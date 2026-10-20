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
const durationStats = values => ({ samples: values.length, median: percentile(values, .5), ...(values.length >= 10 ? { p95: percentile(values, .95) } : { min: Math.min(...values), max: Math.max(...values) }) });
const countStats = values => ({ samples: values.length, min: Math.min(...values), max: Math.max(...values), total: values.reduce((a, b) => a + b, 0) });
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
          if (!Number.isSafeInteger(task.startedAt) || !['completed', 'partial', 'failed', 'paused', 'interrupted', 'running'].includes(task.status)) { invalidSummaries++; continue; }
          const noTransfers = Array.isArray(task.files) && task.files.every(file => ['unchanged', 'skipped'].includes(file.state));
          rows.push({ order: task.startedAt, status: task.status, noTransfers, summary });
        } catch { invalidSummaries++; }
      }
    }
  }
  // Keep the most recent 30 across scopes, without exporting scope or time.
  rows.sort((a, b) => b.order - a.order); const latest = rows.slice(0, 30), groups = new Map();
  for (const row of latest) {
    const key = [row.summary.pluginVersion, row.summary.platform, row.summary.taskType ?? 'unrecorded', row.status, row.noTransfers].join('|');
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return { vault: index + 1, samples: latest.length, invalidSummaries, groups: [...groups.values()].map(group => {
    const { pluginVersion, platform } = group[0].summary;
    const directoryRows = group.flatMap(row => row.summary.directories ? [row.summary.directories] : []);
    const requests = {};
    for (const kind of ['account', 'list', 'prepare', 'upload', 'commit', 'metadata', 'download', 'refresh', 'authorize', 'other']) {
      const rows = group.flatMap(row => row.summary.requests ? [row.summary.requests[kind] ?? { count: 0, failed: 0, elapsedMs: 0, maxMs: 0, pending: 0 }] : []);
      if (rows.length) requests[kind] = Object.fromEntries(['count', 'failed', 'elapsedMs', 'maxMs', 'pending'].map(key => [key, key.endsWith('Ms') ? durationStats(rows.map(row => row[key])) : countStats(rows.map(row => row[key]))]));
    }
    return { pluginVersion, platform, taskType: group[0].summary.taskType ?? 'unrecorded', status: group[0].status, withoutFileTransfers: group[0].noTransfers, samples: group.length,
      counts: Object.fromEntries(counters.map(key => [key, countStats(group.map(row => row.summary[key]))])),
      timings: Object.fromEntries(timings.map(key => [key, durationStats(group.map(row => row.summary[key]))])),
      directories: directoryRows.length ? { samples: directoryRows.length, counts: Object.fromEntries(['scans', 'listed', 'cacheHits', 'read', 'missingFingerprints'].map(key => [key, countStats(directoryRows.map(row => row[key]))])),
        details: Object.fromEntries(['devices', 'pages', 'readBytes', 'cacheWrites', 'cacheSaveFailures', 'listingMs', 'metadataMs', 'readingMs', 'validatingMs', 'cacheMs'].flatMap(key => {
          const values = directoryRows.flatMap(row => row.details ? [row.details[key]] : []);
          return values.length ? [[key, key.endsWith('Ms') ? durationStats(values) : countStats(values)]] : [];
        })) } : null, requests: Object.keys(requests).length ? requests : null, requestTimes: 'concurrent-cumulative-not-task-wall-time' };
  }) };
});
const report = { format: 'vaultsail-local-performance', version: 1, source: 'existing-device-history', liveRequestsIssued: 0,
  initialization: 'unrecorded-daily-history-not-controlled-performance-acceptance', vaults };
const text = JSON.stringify(report, null, 2) + '\n';
if (outputArg) fs.writeFileSync(outputArg.slice('--output='.length), text);
console.log(text);
