export interface VaultSailSettings {
  providerId: 'none' | 'baidu'; remoteVaultId: string; appKey: string; appDirectory: string; secretRef: string;
  binding?: { vaultId: string; appKey: string; root: string; accountHash: string; displayName: string; };
  experimentalSync: boolean; deletionEnabled: boolean;
  pendingVaultName?: string;
  sessionRef?: string;
}
export const DEFAULT_APP_DIRECTORY = '/apps/VaultSail';
export const DEFAULT_SETTINGS: VaultSailSettings = { providerId: 'none', remoteVaultId: '', appKey: '', appDirectory: DEFAULT_APP_DIRECTORY, secretRef: '', experimentalSync: false, deletionEnabled: false };
export function migrateSettings(value: unknown): VaultSailSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result: VaultSailSettings = { ...DEFAULT_SETTINGS };
  if (source.providerId === 'baidu') result.providerId = 'baidu';
  for (const key of ['remoteVaultId', 'appKey', 'appDirectory', 'secretRef'] as const) if (typeof source[key] === 'string') result[key] = source[key];
  result.appDirectory = result.appDirectory.trim() || DEFAULT_APP_DIRECTORY;
  if (typeof source.pendingVaultName === 'string' && source.pendingVaultName.length <= 120) result.pendingVaultName = source.pendingVaultName;
  if (typeof source.sessionRef === 'string' && /^vaultsail-session-[a-z0-9-]{1,100}$/.test(source.sessionRef)) result.sessionRef = source.sessionRef;
  const b = source.binding as Record<string, unknown> | undefined;
  if (b && typeof b.vaultId === 'string' && typeof b.appKey === 'string' && typeof b.root === 'string' && typeof b.accountHash === 'string' && typeof b.displayName === 'string') result.binding = b as unknown as VaultSailSettings['binding'];
  result.experimentalSync = source.experimentalSync === true; result.deletionEnabled = result.experimentalSync && source.deletionEnabled === true;
  return result;
}
