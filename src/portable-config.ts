import { appRoot, record, validId, VaultSailError } from './core/safety.ts';
import type { VaultSailSettings } from './config.ts';

export const CONFIG_EXPORT_DIRECTORY = 'VaultSail-配置';
export interface PortableConfig {
  format: 'vaultsail-pairing'; version: 1; provider: 'baidu'; appKey: string; appDirectory: string;
  remoteVault?: { id: string; displayName: string };
}
const invalid = () => new VaultSailError('configuration', '配置文件无效或版本不支持，请使用 VaultSail 导出的配对配置。');
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
export function parsePortableConfig(text: string): PortableConfig {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw invalid();
  let source: Record<string, unknown>;
  try { source = record(JSON.parse(text)); } catch { throw invalid(); }
  exactKeys(source, ['format', 'version', 'provider', 'appKey', 'appDirectory', 'remoteVault']);
  if (source.format !== 'vaultsail-pairing' || source.version !== 1 || source.provider !== 'baidu'
    || typeof source.appKey !== 'string' || !source.appKey || source.appKey.length > 256 || /\s/.test(source.appKey)
    || typeof source.appDirectory !== 'string') throw invalid();
  let root: string; try { root = appRoot(source.appDirectory); } catch { throw invalid(); }
  const result: PortableConfig = { format: 'vaultsail-pairing', version: 1, provider: 'baidu', appKey: source.appKey, appDirectory: root };
  if (source.remoteVault !== undefined) {
    let vault: Record<string, unknown>; try { vault = record(source.remoteVault); } catch { throw invalid(); }
    exactKeys(vault, ['id', 'displayName']);
    if (!validId(vault.id) || typeof vault.displayName !== 'string' || vault.displayName.length > 120 || /[\x00-\x1f]/.test(vault.displayName)) throw invalid();
    result.remoteVault = { id: vault.id, displayName: vault.displayName };
  }
  return result;
}
export function exportPortableConfig(settings: VaultSailSettings, includeVault = false): string {
  if (settings.providerId !== 'baidu') throw new VaultSailError('configuration', '请先配置百度应用，再导出配对配置。');
  const b = settings.binding;
  const remoteVault = b && b.appKey === settings.appKey && b.root === appRoot(settings.appDirectory)
    ? { id: b.vaultId, displayName: b.displayName }
    : validId(settings.remoteVaultId) ? { id: settings.remoteVaultId, displayName: settings.pendingVaultName ?? '' } : undefined;
  return JSON.stringify(parsePortableConfig(JSON.stringify({ format: 'vaultsail-pairing', version: 1, provider: 'baidu', appKey: settings.appKey,
    appDirectory: settings.appDirectory, ...(includeVault && remoteVault ? { remoteVault } : {}) })), null, 2);
}
