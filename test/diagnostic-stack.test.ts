import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { uuid } from '../src/core/safety.ts';

test('stack resolution checks the matching build and bundle/map hashes before locating source positions', () => {
  const folder = path.resolve('dist/test/stack-' + uuid()); mkdirSync(folder, { recursive: true });
  const main = "throw new Error('synthetic');", map = JSON.stringify({ version: 3, file: 'main.js', sources: ['src/repro.ts'], sourcesContent: [main], names: [], mappings: 'AAAA' });
  const digest = (text: string) => createHash('sha256').update(text).digest('hex'), buildId = 'a'.repeat(40);
  writeFileSync(path.join(folder, 'main.js'), main); writeFileSync(path.join(folder, 'main.js.map'), map);
  writeFileSync(path.join(folder, 'build.json'), JSON.stringify({ format: 'vaultsail-build', version: 1, buildId, mainSha256: digest(main), mapSha256: digest(map) }));
  const report = path.join(folder, 'report.json'), output = path.join(folder, 'resolved.json'), id = uuid();
  writeFileSync(report, JSON.stringify({ format: 'vaultsail-diagnostics', version: 1, records: [
    { id, environment: { buildId }, errors: [{ frames: [{ source: 'vaultsail', line: 1, column: 1 }] }] },
    { id: uuid(), environment: { buildId: 'b'.repeat(40) }, errors: [{ frames: [{ source: 'vaultsail', line: 1, column: 1 }] }] },
  ] }));
  execFileSync(process.execPath, ['scripts/resolve-diagnostic-stack.mjs', report, folder, output]);
  const resolved = JSON.parse(readFileSync(output, 'utf8')); assert.equal(resolved.resolved, 1); assert.equal(resolved.skippedBuilds, 1);
  assert.deepEqual(resolved.positions[0], { diagnosticId: id, cause: 0, frame: 0, source: 'src/repro.ts', line: 1, column: 1 });
  writeFileSync(path.join(folder, 'main.js'), main + '// changed');
  assert.throws(() => execFileSync(process.execPath, ['scripts/resolve-diagnostic-stack.mjs', report, folder, output], { stdio: 'pipe' }), /checksum mismatch/);
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).format, 'vaultsail-diagnostics');
});
