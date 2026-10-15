import test from 'node:test';
import assert from 'node:assert/strict';
import { threeWayMerge, mergeText, commonAncestor } from '../src/sync/merge.ts';
import { bytes, uuid } from '../src/core/safety.ts';
import type { Revision } from '../src/sync/remote-vault.ts';
test('three-way text merge preserves disjoint edits, line endings, BOM and identical changes', () => {
  assert.equal(threeWayMerge('a\n\nb\n', 'A\n\nb\n', 'a\n\nB\n')?.text, 'A\n\nB\n');
  assert.equal(threeWayMerge('\uFEFFa\r\n\r\nb\r\n', '\uFEFFA\r\n\r\nb\r\n', '\uFEFFa\r\n\r\nB\r\n')?.text, '\uFEFFA\r\n\r\nB\r\n');
  assert.equal(threeWayMerge('old', 'same', 'same')?.text, 'same');
  assert.equal(threeWayMerge('old', 'old', '')?.text, '');
  assert.equal(mergeText(bytes('\uFEFFtext')), '\uFEFFtext');
});
test('overlap, deletion against editing, concurrent insertions and YAML require explicit choices', () => {
  for (const input of [['a\n', 'A\n', 'B\n'], ['a\nb\n', 'a\n', 'a\nB\n'], ['', 'A', 'B'],
    ['---\nx: 1\n\ny: 1\n---\n', '---\nx: 2\n\ny: 1\n---\n', '---\nx: 1\n\ny: 2\n---\n']]) {
    const result = threeWayMerge(...input as [string, string, string]); assert.equal(result?.clean, false); assert.equal(result?.text, undefined);
    assert.ok(result?.chunks.some(chunk => chunk.kind === 'conflict'));
  }
  assert.equal(mergeText(Uint8Array.from([255]).buffer), undefined); assert.equal(mergeText(bytes('a\0b')), undefined);
  assert.equal(threeWayMerge('a\n'.repeat(3000), 'b\n'.repeat(3000), 'c\n'.repeat(3000)), undefined);
});
test('merge base is the unique maximal common ancestor; criss-cross and unrelated roots remain manual', () => {
  const fileId = uuid(), vaultId = uuid(), deviceId = uuid();
  const node = (parents: string[]): Revision => ({ schemaVersion: 1, opId: uuid(), fileId, vaultId, deviceId, path: 'note.md', parents, kind: 'delete', size: 0, createdAt: Math.random() });
  const root = node([]), a = node([root.opId]), b = node([root.opId]), c = node([a.opId, b.opId]), d = node([a.opId, b.opId]), other = node([]);
  const ops = [root, a, b, c, d, other];
  assert.equal(commonAncestor(ops, [a.opId, b.opId])?.opId, root.opId);
  assert.equal(commonAncestor(ops, [a.opId, c.opId])?.opId, a.opId);
  assert.equal(commonAncestor(ops, [c.opId, d.opId]), undefined);
  assert.equal(commonAncestor(ops, [a.opId, other.opId]), undefined);
});
