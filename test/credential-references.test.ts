import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsCredentialReference, pairingCredentialReferences } from '../src/auth/credential-references.ts';
import { uuid } from '../src/core/safety.ts';

test('pairing references obey the real Obsidian SecretStorage ID contract and remain isolated between attempts and devices', () => {
  const device = uuid(); const other = uuid(); const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const pair = pairingCredentialReferences(device);
    for (const [ref, kind] of [[pair.secretRef, 'app-secret'], [pair.sessionRef, 'session']] as const) {
      assert.match(ref, /^[a-z0-9-]{1,64}$/);
      assert.equal(seen.has(ref), false); seen.add(ref);
      assert.equal(ownsCredentialReference(ref, kind, device), true);
      assert.equal(ownsCredentialReference(ref, kind, other), false);
      assert.equal(ownsCredentialReference(ref + '-extra', kind, device), false);
    }
    assert.equal(ownsCredentialReference(pair.secretRef, 'session', device), false);
  }
});

test('existing references remain device-owned while shared and copied references are never adopted', () => {
  const device = uuid(); const other = uuid();
  for (const kind of ['app-secret', 'session'] as const) {
    const old = 'vaultsail-' + kind + '-' + device;
    assert.equal(ownsCredentialReference(old, kind, device), true);
    assert.equal(ownsCredentialReference(old + '-' + uuid(), kind, device), true);
    assert.equal(ownsCredentialReference(old, kind, other), false);
    assert.equal(ownsCredentialReference('shared-user-secret', kind, device), false);
    assert.equal(ownsCredentialReference(undefined, kind, device), false);
  }
});
