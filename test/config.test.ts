import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFileLimit, migrateSettings } from '../src/config.ts';
test('chunk parallelism defaults to two and only accepts the device-local range one through four', () => {
  assert.equal(migrateSettings({}).uploadChunkConcurrency, 2);
  for (const value of [1, 2, 3, 4]) assert.equal(migrateSettings({ uploadChunkConcurrency: value }).uploadChunkConcurrency, value);
  for (const value of [0, 5, -1, 2.5, '4', null]) assert.equal(migrateSettings({ uploadChunkConcurrency: value }).uploadChunkConcurrency, 2);
});

test('desktop defaults to 512 MiB; device preference is validated and mobile stays at 20 MiB', () => {
  assert.equal(effectiveFileLimit(migrateSettings({}), false), 512 * 1024 * 1024);
  for (const value of [20, 25, 32, 50, 384, 512]) {
    const settings = migrateSettings({ maxFileMiB: value }); assert.equal(settings.maxFileMiB, value);
    assert.equal(effectiveFileLimit(settings, true), 20 * 1024 * 1024);
  }
  for (const value of [0, 19, 513, 25.5, '50', null]) assert.equal(migrateSettings({ maxFileMiB: value }).maxFileMiB, 512);
});
test('automatic sync requires opt-in and validates the device-local remote check interval', () => {
  assert.equal(migrateSettings({}).autoSyncEnabled, false); assert.equal(migrateSettings({}).remotePollSeconds, 60);
  assert.equal(migrateSettings({ autoSyncEnabled: 'true' }).autoSyncEnabled, false);
  for (const value of [30, 60, 300]) assert.equal(migrateSettings({ remotePollSeconds: value }).remotePollSeconds, value);
  for (const value of [0, 29, 301, 60.5, '60']) assert.equal(migrateSettings({ remotePollSeconds: value }).remotePollSeconds, 60);
});
test('legacy intent is preserved without inventing a verified binding or retaining credentials', () => {
  const settings = migrateSettings({ providerId: 'baidu', remoteVaultId: 'ai-research', access_token: 'private', refresh_token: 'private', secret: 'private', unknown: true });
  assert.equal(settings.remoteVaultId, 'ai-research'); assert.equal(settings.binding, undefined); assert.equal(settings.deletionEnabled, false); assert.equal(JSON.stringify(settings).includes('private'), false);
  assert.equal(settings.appDirectory, '/apps/VaultSail');
  assert.equal(migrateSettings({ appDirectory: '  ' }).appDirectory, '/apps/VaultSail');
  assert.equal(migrateSettings({ appDirectory: '/apps/我的应用' }).appDirectory, '/apps/我的应用');
});
test('deletion is independently opt-in and defaults off; malformed values cannot enable it', () => {
  assert.equal(migrateSettings(null).providerId, 'none'); assert.equal(migrateSettings({}).deletionEnabled, false);
  assert.equal(migrateSettings({ deletionEnabled: true }).deletionEnabled, true);
  for (const value of [false, 'true', 1, null]) assert.equal(migrateSettings({ deletionEnabled: value }).deletionEnabled, false);
});

test('legacy deletion settings preserve their effective value and shed the obsolete experiment gate', () => {
  for (const experimentalSync of [true, false]) for (const deletionEnabled of [true, false]) {
    const settings = migrateSettings({ experimentalSync, deletionEnabled });
    assert.equal(settings.deletionEnabled, experimentalSync && deletionEnabled);
    assert.equal(Object.hasOwn(settings, 'experimentalSync'), false);
    assert.equal(migrateSettings(settings).deletionEnabled, settings.deletionEnabled, 'a second load must preserve the migrated choice');
  }
});
test('transfer concurrency defaults to eight and preserves valid device-local custom values', () => {
  assert.equal(migrateSettings({}).transferConcurrency, 8);
  for (const value of [1, 2, 3, 4, 8, 12, 16, 32]) assert.equal(migrateSettings({ transferConcurrency: value }).transferConcurrency, value);
  for (const value of [0, 33, -1, 2.5, '4', null]) assert.equal(migrateSettings({ transferConcurrency: value }).transferConcurrency, 8);
});
