import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings } from '../src/config.ts';
test('legacy intent is preserved without inventing a verified binding or retaining credentials', () => {
  const settings = migrateSettings({ providerId: 'baidu', remoteVaultId: 'ai-research', access_token: 'private', refresh_token: 'private', secret: 'private', unknown: true });
  assert.equal(settings.remoteVaultId, 'ai-research'); assert.equal(settings.binding, undefined); assert.equal(settings.deletionEnabled, false); assert.equal(JSON.stringify(settings).includes('private'), false);
  assert.equal(settings.appDirectory, '/apps/VaultSail');
  assert.equal(migrateSettings({ appDirectory: '  ' }).appDirectory, '/apps/VaultSail');
  assert.equal(migrateSettings({ appDirectory: '/apps/我的应用' }).appDirectory, '/apps/我的应用');
});
test('malformed settings and deletion without experimental sync cannot enable writes', () => {
  assert.equal(migrateSettings(null).providerId, 'none'); assert.equal(migrateSettings({ deletionEnabled: true }).deletionEnabled, false);
});
