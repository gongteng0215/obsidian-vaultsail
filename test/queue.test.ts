import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncQueue, type QueueBatch, type QueueState } from '../src/sync/queue.ts';
import { scanInventories } from '../src/sync/preflight.ts';
import { VaultSailError } from '../src/core/safety.ts';
function fixture(run: (batch: QueueBatch) => Promise<void> = async () => {}) {
  let now = 1000, saved: QueueState | undefined, enabled = true, available = true; const batches: QueueBatch[] = [];
  const options = { load: () => saved, save: (value: QueueState) => { saved = structuredClone(value); },
    run: async (batch: QueueBatch) => { batches.push(batch); await run(batch); }, canRun: () => available, enabled: () => enabled, pollMs: () => 60_000,
    now: () => now, random: () => 0, timer: (() => 1 as unknown as ReturnType<typeof setTimeout>), clear: () => {} };
  let queue = new SyncQueue(options);
  return { get queue() { return queue; }, batches, get saved() { return saved!; }, time: (value: number) => { now = value; }, enabled: (value: boolean) => { enabled = value; }, available: (value: boolean) => { available = value; }, restart: () => { queue.dispose(); queue = new SyncQueue(options); } };
}

test('a failed parallel preflight holds the queue until reads drain and retains intervening edits across reload', async () => {
  let fail = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const f = fixture(async () => {
    if (fail) await scanInventories(async () => { throw new VaultSailError('response', 'incomplete file inventory'); }, async () => { entered(); await gate; });
  });
  await f.queue.pump(); fail = true; f.queue.request('manual'); const running = f.queue.pump(); await ready;
  f.queue.request('local', 'during-preflight.md'); f.queue.request('remote'); await f.queue.pump();
  assert.equal(f.queue.activity, 'running'); assert.equal(f.batches.length, 2);
  release(); await running; assert.equal(f.saved.blocked, true); assert.ok(f.saved.dirty['during-preflight.md']);
  f.restart(); await f.queue.pump(); assert.equal(f.batches.length, 2, 'reload must preserve a blocking inventory error');
  fail = false; f.queue.request('manual'); await f.queue.pump();
  assert.ok(f.batches.at(-1)!.paths.includes('during-preflight.md')); assert.equal(f.batches.at(-1)!.remote, true);
  assert.deepEqual(Object.keys(f.saved.dirty), []); assert.equal(f.saved.blocked, false);
});
test('burst edits coalesce by path, stay quiet for two seconds and have a maximum wait', async () => {
  const f = fixture(); await f.queue.pump(); f.batches.length = 0;
  for (let i = 0; i < 100; i++) f.queue.request('local', 'note.md');
  f.time(2999); await f.queue.pump(); assert.equal(f.batches.length, 0);
  f.time(3000); await f.queue.pump(); assert.deepEqual(f.batches[0].paths, ['note.md']); assert.equal(Object.keys(f.saved.dirty).length, 0);
  for (let i = 0; i < 16; i++) { f.time(4000 + i * 1000); f.queue.request('local', 'note.md'); await f.queue.pump(); }
  assert.equal(f.batches.length, 2);
});

test('queue reload keeps prototype-like note names as ordinary own pending paths', async () => {
  const f = fixture(); await f.queue.pump(); f.queue.request('local', '__proto__');
  f.restart(); await f.queue.pump(); f.batches.length = 0;
  f.queue.request('local', '__proto__'); f.queue.request('local', 'constructor');
  f.time(3000); await f.queue.pump();
  assert.deepEqual(f.batches.at(-1)!.paths.sort(), ['__proto__', 'constructor']); f.queue.dispose();
});
test('edits arriving during a task survive acknowledgement; manual requests join the next single task', async () => {
  let release!: () => void, block = false; const f = fixture(async () => { if (block) await new Promise<void>(resolve => { release = resolve; }); });
  await f.queue.pump(); block = true; f.queue.request('manual'); const running = f.queue.pump();
  f.queue.request('local', 'note.md'); f.queue.request('manual'); await f.queue.pump(); assert.equal(f.batches.length, 2);
  block = false; release(); await running; assert.ok(f.saved.dirty['note.md']); assert.ok(f.saved.manual);
  await f.queue.pump(); assert.equal(f.batches.length, 3); assert.equal(f.batches[2].manual, true); assert.equal(Object.keys(f.saved.dirty).length, 0);
});
test('remote polling runs without local edits, busy work waits, pause survives restart and background suspension resumes with a full check', async () => {
  const f = fixture(); await f.queue.pump(); f.time(61_000); f.available(false); await f.queue.pump(); assert.equal(f.batches.length, 1);
  f.available(true); f.time(61_500); await f.queue.pump(); assert.equal(f.batches[1].remote, true);
  f.queue.pause(); f.restart(); f.time(500_000); await f.queue.pump(); assert.equal(f.batches.length, 2);
  f.queue.request('manual'); await f.queue.pump(); assert.equal(f.batches.length, 3);
  f.queue.suspend(true); f.queue.request('local', 'note.md'); f.time(600_000); await f.queue.pump(); assert.equal(f.batches.length, 3);
  f.queue.suspend(false); await f.queue.pump(); assert.equal(f.batches[3].full, true);
});
test('retry-after survives restart; permission/integrity failures stop automatic retries until an explicit manual request', async () => {
  let error: Error | undefined = new VaultSailError('rate', 'safe', true, 120_000);
  const f = fixture(async () => { if (error) throw error; }); await f.queue.pump(); assert.equal(f.saved.retryAt, 121_000);
  f.restart(); f.time(120_999); await f.queue.pump(); assert.equal(f.batches.length, 1);
  error = new VaultSailError('integrity', 'safe'); f.time(121_000); await f.queue.pump(); f.restart(); f.time(999_999); await f.queue.pump(); assert.equal(f.batches.length, 2);
  error = undefined; f.queue.request('manual'); await f.queue.pump(); assert.equal(f.batches.length, 3);
});
test('excluded paths never queue, malformed state falls back to full reconciliation, disabled mode permits explicit manual sync only', async () => {
  const f = fixture(); await f.queue.pump();
  for (const path of ['.obsidian/settings.json', '.vaultsail-state/log.json', '../escape', 'VaultSail-conflicts/copy.md']) f.queue.request('local', path);
  assert.equal(Object.keys(f.saved.dirty).length, 0); f.enabled(false); f.time(500_000); await f.queue.pump(); assert.equal(f.batches.length, 1);
  f.queue.request('manual'); await f.queue.pump(); assert.equal(f.batches.length, 2);
  const state = f.saved; state.dirty = { '../escape': 1 }; f.enabled(true); f.restart(); await f.queue.pump(); assert.equal(f.batches[2].full, true);
});
test('foreground resume before a paused request drains does not turn suspension into a permanent user pause', async () => {
  let release!: () => void, suspend = false;
  const f = fixture(async () => { if (suspend) { await new Promise<void>(resolve => { release = resolve; }); throw new VaultSailError('paused', 'safe'); } });
  await f.queue.pump(); suspend = true; f.queue.request('manual'); const running = f.queue.pump();
  f.queue.suspend(true); f.queue.suspend(false); release(); await running;
  assert.equal(f.saved.paused, false); suspend = false; f.time(3000); await f.queue.pump(); assert.equal(f.saved.full, 0);
});

test('100 interleaved edit/click bursts preserve the next revision through reload without overlapping workers', async () => {
  let active = 0, peak = 0, release!: () => void, block = false;
  const f = fixture(async () => { active++; peak = Math.max(peak, active); try { if (block) await new Promise<void>(r => { release = r; }); } finally { active--; } });
  await f.queue.pump();
  for (let i = 0; i < 100; i++) {
    block = true; f.queue.request('manual'); const running = f.queue.pump();
    f.queue.request('local', 'same.md'); f.queue.request('manual'); f.queue.request('local', 'same.md');
    await f.queue.pump(); assert.equal(active, 1); block = false; release(); await running;
    assert.ok(f.saved.dirty['same.md']); f.restart(); await f.queue.pump();
    assert.ok(f.batches.at(-1)!.paths.includes('same.md')); assert.equal(Object.keys(f.saved.dirty).length, 0);
    f.queue.pause(); f.queue.suspend(true); f.queue.suspend(false); f.restart(); await f.queue.pump(); assert.equal(f.saved.paused, true);
  }
  assert.equal(peak, 1);
});
