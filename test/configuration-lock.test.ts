import assert from 'node:assert/strict';
import test from 'node:test';
import { withConfigurationLock } from '../src/platform/configuration-lock.ts';

test('configuration queue survives module re-evaluation and drains after a rejected transaction', async () => {
  const app = {}; let release!: () => void; const order: string[] = [];
  const old = withConfigurationLock(app, async () => { order.push('write'); await new Promise<void>(resolve => { release = resolve; }); order.push('rollback'); throw new Error('synthetic'); });
  const rejected = assert.rejects(old); await Promise.resolve();
  const fresh = await import(new URL('../src/platform/configuration-lock.ts?reload', import.meta.url).href);
  const reading = fresh.withConfigurationLock(app, async () => { order.push('read'); });
  assert.deepEqual(order, ['write']); release(); await rejected; await reading;
  assert.deepEqual(order, ['write', 'rollback', 'read']);
});
