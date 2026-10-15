import assert from 'node:assert/strict';
import test from 'node:test';
import { mapConcurrent } from '../src/core/concurrency.ts';

test('worker pool bounds concurrency and returns results in input order', async () => {
  let active = 0; let peak = 0;
  const result = await mapConcurrent([0, 1, 2, 3, 4, 5, 6], 3, async value => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return value * 2;
  });
  assert.equal(peak, 3); assert.deepEqual(result, [0, 2, 4, 6, 8, 10, 12]);
});
test('worker failure stops dispatching and drains every started operation before rejecting', async () => {
  const started: number[] = []; const finished: number[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let settled = false;
  const pending = mapConcurrent([0, 1, 2, 3, 4, 5], 3, async value => {
    started.push(value); if (value === 0) throw new Error('synthetic'); await gate; finished.push(value);
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /synthetic/); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false); assert.deepEqual(started, [0, 1, 2]); release(); await rejected; assert.deepEqual(finished, [1, 2]);
});
