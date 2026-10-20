// Explicitly labelled samples; never infer cold/warm state from task duration.
import fs from 'node:fs';
import path from 'node:path';
import { validateScanSummary } from '../src/sync/scan-summary.ts';
const cases = ['cold', 'warm', 'restart', 'local-edit', 'remote-edit', 'browse', 'browse-repeat'];
const [mode, source, ...args] = process.argv.slice(2);
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const validScenario = value => cases.includes(value);
const validSize = value => [7, 100, 1000].includes(value);
const read = file => { if (fs.statSync(file).size > 8 * 1024 * 1024) throw Error('Oversized report'); return JSON.parse(fs.readFileSync(file, 'utf8')); };
if (mode === 'record') {
  const scenario = flag('case'), files = Number(flag('files')), output = flag('output');
  if (!source || !validScenario(scenario) || !validSize(files) || !output || args.some(arg => !/^--(case|files|output)=/.test(arg))) throw Error('Usage: record <export.json> --case=warm --files=100 --output=<new-sample.json>');
  const raw = read(source), summary = validateScanSummary(raw.format === 'vaultsail-performance' ? raw.current ?? raw.recent?.[0] : raw);
  if (raw.format === 'vaultsail-performance' && raw.currentStatus !== 'completed') throw Error('Only a completed task can enter the controlled performance comparison.');
  if (!summary?.taskType) throw Error('A recorded task type from 0.2.22 is required; do not mix unlabeled historical tasks.');
  if (summary.requests && Object.values(summary.requests).some(row => row.pending)) throw Error('Wait for native requests to finish before recording a timing sample.');
  fs.writeFileSync(output, JSON.stringify({ format: 'vaultsail-performance-sample', version: 1, scenario, files, summary }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ recorded: true, scenario, files }));
} else if (mode === 'summarize') {
  if (!source || args.length) throw Error('Usage: summarize <dedicated sample folder for ONE network environment>');
  const groups = new Map(); let invalid = 0;
  for (const file of fs.readdirSync(source, { withFileTypes: true })) {
    if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.json')) continue;
    try {
      const raw = read(path.join(source, file.name)), summary = validateScanSummary(raw.summary);
      if (raw.format !== 'vaultsail-performance-sample' || raw.version !== 1 || !validScenario(raw.scenario) || !validSize(raw.files) || !summary?.taskType) { invalid++; continue; }
      const key = [summary.pluginVersion, summary.platform, summary.taskType, raw.scenario, raw.files].join('|');
      const rows = groups.get(key) ?? []; rows.push({ scenario: raw.scenario, files: raw.files, summary }); groups.set(key, rows);
    } catch { invalid++; }
  }
  const report = { format: 'vaultsail-acceptance-performance', version: 1, liveRequestsIssued: 0, invalid,
    networkGrouping: 'one-network-environment-per-input-folder', requestTimes: 'concurrent-cumulative-not-wall-time',
    groups: [...groups.values()].map(rows => {
      const first = rows[0], values = rows.map(r => r.summary.elapsedMs).sort((a, b) => a - b), n = values.length;
      return { pluginVersion: first.summary.pluginVersion, platform: first.summary.platform, taskType: first.summary.taskType, scenario: first.scenario, files: first.files, samples: n,
        medianMs: values[Math.ceil(n / 2) - 1], ...(n >= 10 ? { p95Ms: values[Math.ceil(n * .95) - 1] } : { minMs: values[0], maxMs: values.at(-1) }),
        summaries: rows.map(r => r.summary) };
    }) };
  console.log(JSON.stringify(report, null, 2));
} else throw Error('Use record or summarize. Reports contain only fixed labels and validated numeric summaries.');
