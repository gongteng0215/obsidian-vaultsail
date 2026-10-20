import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acceptanceFiles, EMPTY_DIRECTORIES, MARKER, verifyAcceptance } from '../src/acceptance/dataset.ts';
import { bytes, hash } from '../src/core/safety.ts';

test('deterministic mixed fixtures have valid PNG CRCs and PDF offsets, zero-byte and Unicode cases', () => {
  const files = acceptanceFiles(), counts = Object.fromEntries(['markdown', 'image', 'pdf', 'zero', 'unicode'].map(kind => [kind, files.filter(f => f.kind === kind).length]));
  assert.deepEqual(counts, { markdown: 60, image: 20, pdf: 10, zero: 5, unicode: 5 });
  assert.equal(new Set(files.map(f => f.path)).size, 100); assert.equal(EMPTY_DIRECTORIES.length, 10);
  assert.deepEqual(files.map(f => hash(f.data)), acceptanceFiles().map(f => hash(f.data)));
  for (const file of files) {
    assert.ok(file.data.byteLength < 20 * 1024 * 1024);
    if (file.kind === 'zero') assert.equal(file.data.byteLength, 0);
    if (file.kind === 'image') {
      const data = new Uint8Array(file.data), view = new DataView(file.data);
      assert.equal(Buffer.from(data.subarray(0, 8)).toString('hex'), '89504e470d0a1a0a');
      for (let offset = 8; offset < data.length;) {
        const length = view.getUint32(offset); let crc = 0xffffffff;
        for (const value of data.subarray(offset + 4, offset + 8 + length)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        assert.equal((crc ^ 0xffffffff) >>> 0, view.getUint32(offset + 8 + length)); offset += length + 12;
      }
    }
    if (file.kind === 'pdf') {
      const text = new TextDecoder().decode(file.data), start = Number(text.match(/startxref\n(\d+)/)![1]);
      assert.equal(text.slice(start, start + 4), 'xref');
      const offsets = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map(m => Number(m[1]));
      assert.equal(offsets.length, 5); offsets.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`)));
      assert.match(text, /%%EOF\n$/);
    }
  }
});

test('read-only verifier refuses unrelated vaults then exports only counts for corrupt/missing fixtures', async () => {
  const data = new Map(acceptanceFiles().map(f => [f.path, f.data])); let reads = 0;
  const reader = { stat: async (p: string) => data.has(p) ? { type: 'file' as const, size: data.get(p)!.byteLength } : EMPTY_DIRECTORIES.includes(p) ? { type: 'folder' as const, size: 0 } : null,
    read: async (p: string) => { reads++; return data.get(p)!.slice(0); }, list: async (p: string) => ({ files: [], folders: EMPTY_DIRECTORIES.filter(d => d.startsWith(p + '/') && !d.slice(p.length + 1).includes('/')) }) };
  const marker = data.get(MARKER)!; data.delete(MARKER);
  const refused = await verifyAcceptance(reader, '0.2.22', true); assert.equal(refused.markerValid, false); assert.equal(reads, 0);
  data.set(MARKER, marker);
  const good = await verifyAcceptance(reader, '0.2.22', true); assert.equal(good.passedFiles, 100); assert.equal(good.passedDirectories, 10);
  const [one, two, three] = acceptanceFiles().slice(1, 4);
  data.delete(one.path); data.set(two.path, bytes('short')); const changed = new Uint8Array(three.data.slice(0)); changed[0] ^= 1; data.set(three.path, changed.buffer);
  const bad = await verifyAcceptance(reader, '0.2.22', true);
  assert.equal(bad.passedFiles, 97); assert.equal(bad.failures.missing, 1); assert.equal(bad.failures.size, 1); assert.equal(bad.failures.hash, 1);
  const report = JSON.stringify(bad); for (const file of acceptanceFiles()) assert.equal(report.includes(file.path), false);
  assert.equal(report.includes(hash(marker)), false); assert.equal(report.includes('Synthetic'), false);
});

test('CLI generates only in a new dedicated folder, separates content manifest and verifies desktop/mobile data', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsail-acceptance-')), target = path.join(temp, 'fixture');
  const run = (...args: string[]) => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/acceptance-dataset.mjs', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    run('generate', target, '--desktop'); const manifest = JSON.parse(fs.readFileSync(path.join(target, 'content-hashes.json'), 'utf8'));
    assert.equal(manifest.files.length, 101); assert.ok(manifest.files.at(-1).size > 20 * 1024 * 1024);
    const report = JSON.parse(run('verify', path.join(target, 'vault'), '--mobile'));
    assert.equal(report.passedFiles, 100); assert.equal(report.passedDirectories, 10); assert.equal(report.desktopAttachment, 'present-over-mobile-limit');
    assert.throws(() => run('generate', target)); assert.equal(manifest.files.length, 101);
    assert.equal(fs.existsSync(path.join(target, 'vault', 'content-hashes.json')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
