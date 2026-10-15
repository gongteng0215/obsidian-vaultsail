import { bytes, hash, uuid, validId, VaultSailError } from '../core/safety.ts';

type CredentialKind = 'app-secret' | 'session';
function prefix(kind: CredentialKind): string { return 'vaultsail-' + kind + '-'; }
function deviceScope(deviceId: string): string {
  if (!validId(deviceId)) throw new VaultSailError('state', '本机设备标识无效，未保存密钥。');
  return hash(bytes(deviceId)).slice(0, 16);
}
export function pairingCredentialReferences(deviceId: string): { secretRef: string; sessionRef: string } {
  // Obsidian validates IDs against /^[a-z0-9-]+$/ and a 64-character maximum.
  // A 16-character device scope plus a random 24-character nonce keeps both IDs below that cap.
  const suffix = deviceScope(deviceId) + '-' + uuid().replace(/-/g, '').slice(0, 24);
  return { secretRef: prefix('app-secret') + suffix, sessionRef: prefix('session') + suffix };
}
export function ownsCredentialReference(ref: string | undefined, kind: CredentialKind, deviceId: string): boolean {
  if (!ref) return false;
  const legacy = prefix(kind) + deviceId;
  if (ref === legacy || ref.startsWith(legacy + '-')) return true;
  const compact = prefix(kind) + deviceScope(deviceId) + '-';
  return ref.startsWith(compact) && /^[a-f0-9]{24}$/.test(ref.slice(compact.length));
}
