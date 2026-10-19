import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SourceMap } from 'node:module';

const [reportPath, buildDirectory, outputPath] = process.argv.slice(2);
if (!reportPath || !buildDirectory || !outputPath) throw new Error('Usage: node scripts/resolve-diagnostic-stack.mjs <redacted-report.json> <dist/debug/build-id> <output.json>');
if (resolve(reportPath) === resolve(outputPath)) throw new Error('Choose a separate output file; preserve the original report.');
const metadata = JSON.parse(readFileSync(join(buildDirectory, 'build.json'), 'utf8'));
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (metadata.format !== 'vaultsail-build' || metadata.version !== 1
  || digest(join(buildDirectory, 'main.js')) !== metadata.mainSha256 || digest(join(buildDirectory, 'main.js.map')) !== metadata.mapSha256) throw new Error('Build archive checksum mismatch.');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (report.format !== 'vaultsail-diagnostics' || report.version !== 1 || !Array.isArray(report.records)) throw new Error('Unsupported report format.');
const map = new SourceMap(JSON.parse(readFileSync(join(buildDirectory, 'main.js.map'), 'utf8')));
let resolved = 0, skippedBuilds = 0;
const positions = [];
for (const record of report.records) {
  if (record.environment?.buildId !== metadata.buildId) { skippedBuilds++; continue; }
  for (const [cause, error] of (record.errors ?? []).entries()) for (const [frame, position] of (error.frames ?? []).entries()) {
    if (position.source !== 'vaultsail' || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) || position.line < 1 || position.column < 1) continue;
    const entry = map.findEntry(position.line - 1, position.column - 1);
    if (!entry.originalSource) continue;
    const source = entry.originalSource.replace(/\\/g, '/').replace(/^.*\/(src|node_modules)\//, '$1/');
    if (!/^(src|node_modules)\//.test(source)) continue;
    positions.push({ diagnosticId: record.id, cause, frame, source, line: entry.originalLine + 1, column: entry.originalColumn + 1 }); resolved++;
  }
}
writeFileSync(outputPath, JSON.stringify({ format: 'vaultsail-resolved-stack', version: 1, buildId: metadata.buildId, mainSha256: metadata.mainSha256, resolved, skippedBuilds, positions }, null, 2));
console.log(`Resolved ${resolved} positions; skipped ${skippedBuilds} records from other builds. Original report preserved.`);
