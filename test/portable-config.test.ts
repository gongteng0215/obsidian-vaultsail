import assert from 'node:assert/strict';
import test from 'node:test';
import { exportPortableConfig, parsePortableConfig } from '../src/portable-config.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { included, uuid } from '../src/core/safety.ts';

test('portable configuration exports only application and pending vault pairing, excluding all credentials and device state', () => {
  const vaultId = uuid();
  const text = exportPortableConfig({ ...DEFAULT_SETTINGS, providerId: 'baidu', appKey: 'public-app', secretRef: 'private-secret-reference',
    experimentalSync: true, deletionEnabled: true, binding: { vaultId, appKey: 'public-app', root: DEFAULT_SETTINGS.appDirectory, accountHash: 'private-account', displayName: '配对库' },
    ...{ access_token: 'private-token', deviceId: uuid(), journals: ['private-state'] } });
  const config = parsePortableConfig(text); assert.equal(config.remoteVault?.id, vaultId); assert.equal(config.remoteVault?.displayName, '配对库');
  assert.deepEqual(Object.keys(config).sort(), ['appDirectory', 'appKey', 'format', 'provider', 'remoteVault', 'version']);
  for (const privateValue of ['private-secret-reference', 'private-account', 'private-token', 'private-state', 'experimentalSync', 'deletionEnabled']) assert.equal(text.includes(privateValue), false);
  assert.equal(included('VaultSail-配置/export.json'), false);
});
test('portable import rejects credentials, unknown versions, malformed IDs and unsafe roots before mutation', () => {
  const valid = { format: 'vaultsail-pairing', version: 1, provider: 'baidu', appKey: 'public-app', appDirectory: '/apps/中文应用', remoteVault: { id: uuid(), displayName: 'iPad 库' } };
  for (const value of [{ ...valid, version: 2 }, { ...valid, secretRef: 'private' }, { ...valid, access_token: 'private' },
    { ...valid, binding: {} }, { ...valid, appDirectory: '/apps/../other' }, { ...valid, appKey: '' }, { ...valid, remoteVault: { ...valid.remoteVault, accountHash: 'private' } },
    { ...valid, remoteVault: { id: 'legacy-name', displayName: '库' } }, { ...valid, remoteVault: { id: uuid(), displayName: '\n' } }]) {
    assert.throws(() => parsePortableConfig(JSON.stringify(value)), { code: 'configuration' });
  }
  assert.throws(() => parsePortableConfig('x'.repeat(64 * 1024 + 1)), { code: 'configuration' });
  assert.equal(parsePortableConfig(JSON.stringify(valid)).appDirectory, '/apps/中文应用');
});
