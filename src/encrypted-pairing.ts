import { validateAuthSession, type AuthSession } from './auth/auth-manager.ts';
import { record, VaultSailError } from './core/safety.ts';
import { parsePortableConfig, type PortableConfig } from './portable-config.ts';

export const PAIRING_PREFIX = 'VSAIL:1:';
export const PAIRING_MAX_BYTES = 64 * 1024;
export const PAIRING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ITERATIONS = 600000;
const HEADER_SIZE = 29; // version + random 16-byte salt + random 12-byte IV
export interface AuthorizedPairing {
  format: 'vaultsail-authorized'; version: 1; createdAt: number; expiresAt: number;
  config: PortableConfig; accountHash: string; secretKey: string; session: AuthSession;
}
export interface PairingImportOptions {
  bindRemoteVault?: boolean; report?: (message: string) => void;
  signal?: AbortSignal; onCommit?: () => void;
}
const invalid = () => new VaultSailError('configuration', '加密配对码无效、已损坏或版本不支持，请重新导出。');
function passwordBytes(password: string): Uint8Array {
  if (typeof password !== 'string' || [...password].length < 10 || password.length > 256 || !password.trim())
    throw new VaultSailError('configuration', '配对密码至少需要 10 个字符，最长 256 个字符。');
  return new TextEncoder().encode(password); // Spaces are part of the password; never silently trim.
}
function cryptoApi(): Crypto {
  const api = typeof window !== 'undefined' && window.crypto?.subtle ? window.crypto : typeof crypto !== 'undefined' ? crypto : undefined;
  if (!api?.subtle) throw new VaultSailError('configuration', '当前环境不支持安全加解密，请更新 Obsidian；不会降级为明文导出。');
  return api;
}
function base64url(data: Uint8Array): string {
  let s = ''; for (const byte of data) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pairingText(text: string): string {
  if (text.length > PAIRING_MAX_BYTES) throw invalid();
  // Only transport whitespace is removable. Preserve case in the authenticated payload.
  return text.trim().replace(/[ \t\r\n]/g, '');
}
function decode(text: string): Uint8Array {
  const clean = pairingText(text);
  if (clean.slice(0, PAIRING_PREFIX.length).toUpperCase() !== PAIRING_PREFIX) throw invalid();
  const encoded = clean.slice(PAIRING_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw invalid();
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
    const data = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (data.length < HEADER_SIZE + 16 || data[0] !== 1 || base64url(data) !== encoded) throw invalid();
    return data;
  } catch { throw invalid(); }
}
export function isEncryptedPairing(text: string): boolean { return /^VSAIL:/i.test(pairingText(text)); }
export function validatePairingCode(text: string): void { decode(text); }
export function validateAuthorizedPairing(value: unknown, now = Date.now()): AuthorizedPairing {
  const v = record(value);
  if (Object.keys(v).some(key => !['format', 'version', 'createdAt', 'expiresAt', 'config', 'accountHash', 'secretKey', 'session'].includes(key))
    || v.format !== 'vaultsail-authorized' || v.version !== 1 || !Number.isSafeInteger(v.createdAt) || !Number.isSafeInteger(v.expiresAt)
    || (v.createdAt as number) <= 0 || (v.createdAt as number) > now + 5 * 60 * 1000
    || (v.expiresAt as number) - (v.createdAt as number) !== PAIRING_LIFETIME_MS
    || typeof v.accountHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.accountHash)
    || typeof v.secretKey !== 'string' || !v.secretKey || v.secretKey.length > 4096 || /\s/.test(v.secretKey)) throw invalid();
  if ((v.expiresAt as number) <= now) throw new VaultSailError('expired-pairing', '配对码已超过 24 小时有效期，请在电脑重新导出。');
  const config = parsePortableConfig(JSON.stringify(v.config));
  return { format: 'vaultsail-authorized', version: 1, createdAt: v.createdAt as number, expiresAt: v.expiresAt as number,
    config, accountHash: v.accountHash, secretKey: v.secretKey, session: validateAuthSession(v.session) };
}
async function derive(password: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const api = cryptoApi();
  const material = await api.subtle.importKey('raw', password as Uint8Array<ArrayBuffer>, 'PBKDF2', false, ['deriveKey']);
  return api.subtle.deriveKey({ name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(header: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(PAIRING_PREFIX); const result = new Uint8Array(prefix.length + header.length);
  result.set(prefix); result.set(header, prefix.length); return result;
}
export async function encryptPairing(payload: AuthorizedPairing, password: string): Promise<string> {
  const pass = passwordBytes(password); const value = validateAuthorizedPairing(payload);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  if (plain.length > 32 * 1024) throw invalid();
  const header = new Uint8Array(HEADER_SIZE); header[0] = 1; cryptoApi().getRandomValues(header.subarray(1));
  try {
    const key = await derive(pass, header.slice(1, 17));
    const encrypted = await cryptoApi().subtle.encrypt({ name: 'AES-GCM', iv: header.slice(17), additionalData: aad(header), tagLength: 128 }, key, plain);
    const result = new Uint8Array(HEADER_SIZE + encrypted.byteLength); result.set(header); result.set(new Uint8Array(encrypted), HEADER_SIZE);
    return PAIRING_PREFIX + base64url(result);
  } finally { pass.fill(0); plain.fill(0); }
}
export async function decryptPairing(code: string, password: string): Promise<AuthorizedPairing> {
  const data = decode(code); const pass = passwordBytes(password); const header = data.slice(0, HEADER_SIZE);
  let plain: Uint8Array | undefined;
  try {
    const key = await derive(pass, header.slice(1, 17));
    try { plain = new Uint8Array(await cryptoApi().subtle.decrypt({ name: 'AES-GCM', iv: header.slice(17), additionalData: aad(header), tagLength: 128 }, key, data.slice(HEADER_SIZE))); }
    catch { throw new VaultSailError('decrypt', '无法解密：密码不正确或配对码被修改，请检查后重试。'); }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } catch { throw invalid(); }
    return validateAuthorizedPairing(parsed);
  } finally { pass.fill(0); plain?.fill(0); }
}
