import test from 'node:test';
import assert from 'node:assert/strict';
test('task mutual exclusion survives plugin module reload and releases after failure', async () => {
  const first = await import('../src/platform/task-lock.ts?first');
  const second = await import('../src/platform/task-lock.ts?second');
  const app = {}; let release!: () => void, active = 0, peak = 0, nextStarted = false;
  const a = first.withVaultTaskLock(app, async () => { active++; peak = Math.max(peak, active); await new Promise<void>(resolve => { release = resolve; }); active--; throw new Error('expected'); });
  const rejected = assert.rejects(a);
  const b = second.withVaultTaskLock(app, async () => { nextStarted = true; active++; peak = Math.max(peak, active); active--; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(nextStarted, false); release(); await rejected; await b;
  assert.equal(peak, 1); assert.equal(nextStarted, true);
});
