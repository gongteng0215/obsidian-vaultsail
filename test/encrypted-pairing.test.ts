import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { decryptPairing, encryptPairing, isEncryptedPairing, PAIRING_LIFETIME_MS, PAIRING_PREFIX, validateAuthorizedPairing, validatePairingCode, type AuthorizedPairing } from '../src/encrypted-pairing.ts';
import { hash, bytes, uuid } from '../src/core/safety.ts';
function payload(): AuthorizedPairing {
  const now = Date.now();
  return { format: 'vaultsail-authorized', version: 1, createdAt: now, expiresAt: now + PAIRING_LIFETIME_MS,
    config: { format: 'vaultsail-pairing', version: 1, provider: 'baidu', appKey: 'test-app', appDirectory: '/apps/中文应用', remoteVault: { id: uuid(), displayName: 'iPad 测试库' } },
    accountHash: hash(bytes('test-account')), secretKey: 'test-private-secret', session: { accessToken: 'test-private-access', refreshToken: 'test-private-refresh', expiresAt: now + 3600000 } };
}
const password = '正确的密码-123456';
test('authorized pairing encrypts secrets with random salt/IV and interoperates with an independent AES-GCM implementation', async () => {
  const data = payload(); const first = await encryptPairing(data, password); const second = await encryptPairing(data, password);
  assert.notEqual(first, second); assert.ok(first.startsWith(PAIRING_PREFIX)); assert.deepEqual(await decryptPairing(' \n' + first + '\n ', password), data);
  for (const value of [data.secretKey, data.session.accessToken, data.session.refreshToken, password, data.config.remoteVault!.displayName]) assert.equal(first.includes(value), false);
  const packed = Buffer.from(first.slice(PAIRING_PREFIX.length), 'base64url');
  const key = pbkdf2Sync(password, packed.subarray(1, 17), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(17, 29));
  decipher.setAAD(Buffer.concat([Buffer.from(PAIRING_PREFIX), packed.subarray(0, 29)])); decipher.setAuthTag(packed.subarray(-16));
  const decoded = Buffer.concat([decipher.update(packed.subarray(29, -16)), decipher.final()]); assert.deepEqual(JSON.parse(decoded.toString()), data);
});
test('wrong passwords and modifications to salt, IV and ciphertext fail authentication without exposing secrets', async () => {
  const code = await encryptPairing(payload(), password);
  await assert.rejects(decryptPairing(code, 'wrong-password'), { code: 'decrypt' });
  for (const offset of [1, 17, 30]) {
    const bytes = Buffer.from(code.slice(PAIRING_PREFIX.length), 'base64url'); bytes[offset] ^= 1;
    await assert.rejects(decryptPairing(PAIRING_PREFIX + bytes.toString('base64url'), password), { code: 'decrypt' });
  }
});

test('mobile paste accepts a case-insensitive prefix and wrapped text without changing encrypted data', async () => {
  const data = payload(); const code = await encryptPairing(data, password);
  const encoded = code.slice(PAIRING_PREFIX.length);
  const wrapped = ' \r\nvsail:1:' + encoded.match(/.{1,64}/g)!.join(' \t\r\n') + '\n ';
  assert.equal(isEncryptedPairing(wrapped), true);
  validatePairingCode(wrapped);
  assert.deepEqual(await decryptPairing(wrapped, password), data);
  assert.deepEqual(await decryptPairing('VsAiL:1:' + encoded, password), data);
  const index = [...encoded].findIndex(char => /[A-Za-z]/.test(char));
  const original = encoded[index]; const changed = original === original.toLowerCase() ? original.toUpperCase() : original.toLowerCase();
  const tampered = encoded.slice(0, index) + changed + encoded.slice(index + 1);
  await assert.rejects(decryptPairing('vsail:1:' + tampered, password));
});

test('encrypted format detection keeps unsupported versions out of the legacy JSON parser', () => {
  assert.equal(isEncryptedPairing('vsail:2:AAAA'), true);
  assert.equal(isEncryptedPairing('{"format":"vaultsail-pairing"}'), false);
  for (const code of ['vsail:2:AAAA', 'vsail:1:AAAA\u200b', 'vsail:1:AAAA!', ' '.repeat(65536) + 'vsail:1:AAAA'])
    assert.throws(() => validatePairingCode(code), { code: 'configuration' });
});
test('password whitespace is preserved; weak passwords, plaintext downgrade and oversized/unknown envelopes are rejected', async () => {
  const pass = '  secret-123456  '; const code = await encryptPairing(payload(), pass);
  await assert.rejects(decryptPairing(code, pass.trim()), { code: 'decrypt' }); assert.ok(await decryptPairing(code, pass));
  for (const pass of ['', '1234', ' '.repeat(12), 'x'.repeat(257)]) await assert.rejects(encryptPairing(payload(), pass), { code: 'configuration' });
  for (const text of ['{"accessToken":"private"}', 'VSAIL:2:AAAA', PAIRING_PREFIX + 'A', PAIRING_PREFIX + '*', PAIRING_PREFIX + 'A'.repeat(65536)]) assert.throws(() => validatePairingCode(text), { code: 'configuration' });
});
test('payload schema rejects unknown/private device state and expired migration codes, while expired access tokens can refresh', () => {
  const original = payload();
  const invalid = [{ ...original, deviceId: uuid() }, { ...original, version: 2 }, { ...original, accountHash: 'wrong' }, { ...original, secretKey: '' },
    { ...original, config: { ...original.config, remoteVault: undefined } }, { ...original, session: { ...original.session, secretRef: 'source-reference' } },
    { ...original, expiresAt: original.createdAt + 1000 }, { ...original, createdAt: Date.now() + 1000000, expiresAt: Date.now() + 1000000 + PAIRING_LIFETIME_MS }];
  for (const value of invalid) assert.throws(() => validateAuthorizedPairing(value));
  assert.throws(() => validateAuthorizedPairing(original, original.expiresAt), { code: 'expired-pairing' });
  assert.equal(validateAuthorizedPairing({ ...original, session: { ...original.session, expiresAt: 1 } }).session.expiresAt, 1);
});
