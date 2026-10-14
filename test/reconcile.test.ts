import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileFile } from '../src/core/reconcile.ts';
import type { FileVersion, ThreeWayFileState } from '../src/core/types.ts';
const A: FileVersion = { hash: 'a', size: 1 };
const B: FileVersion = { hash: 'b', size: 1 };
const C: FileVersion = { hash: 'c', size: 1 };
const op = (base: FileVersion | null, local: FileVersion | null, remote: FileVersion | null) =>
  reconcileFile({ path: 'test.md', base, local, remote } satisfies ThreeWayFileState).operation;

test('nothing exists', () => assert.equal(op(null, null, null), 'noop'));
test('new local file uploads', () => assert.equal(op(null, A, null), 'upload'));
test('new remote file downloads', () => assert.equal(op(null, null, A), 'download'));
test('identical concurrent initial files do not conflict', () => assert.equal(op(null, A, A), 'noop'));
test('different concurrent initial files conflict', () => assert.equal(op(null, A, B), 'conflict'));
test('unchanged files do not sync', () => assert.equal(op(A, A, A), 'noop'));
test('changed local content uploads', () => assert.equal(op(A, B, A), 'upload'));
test('changed remote content downloads', () => assert.equal(op(A, A, B), 'download'));
test('both changed differently conflict', () => assert.equal(op(A, B, C), 'conflict'));
test('both changed identically converge', () => assert.equal(op(A, B, B), 'noop'));
test('local delete creates remote delete proposal', () => assert.equal(op(A, null, A), 'delete-remote'));
test('remote delete creates local delete proposal', () => assert.equal(op(A, A, null), 'delete-local'));
test('delete versus edit conflicts', () => assert.equal(op(A, null, B), 'conflict'));
test('edit versus delete conflicts', () => assert.equal(op(A, B, null), 'conflict'));
test('both removed do not sync', () => assert.equal(op(A, null, null), 'noop'));
