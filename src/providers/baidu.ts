import type { CloudStorageProvider, CloudProviderCapabilities, RemotePage } from './cloud-storage-provider';

/** Placeholder only. API access, OAuth and app permissions must pass D0 feasibility first. */
export class BaiduProvider implements CloudStorageProvider {
  readonly id = 'baidu';
  readonly displayName = 'Baidu Netdisk (planned)';
  readonly capabilities: CloudProviderCapabilities = {
    canList: false,
    canRead: false,
    canWrite: false,
    canDelete: false,
    supportsConditionalWrites: false,
  };

  isConfigured(): boolean { return false; }
  private unavailable(): never {
    throw new Error('Baidu Netdisk adapter is not implemented. Run D0 feasibility checks first.');
  }
  async list(_remoteVaultId: string, _cursor?: string): Promise<RemotePage> { return this.unavailable(); }
  async read(_remoteVaultId: string, _path: string): Promise<ArrayBuffer> { return this.unavailable(); }
  async write(_remoteVaultId: string, _path: string, _data: ArrayBuffer): Promise<void> { this.unavailable(); }
  async remove(_remoteVaultId: string, _path: string): Promise<void> { this.unavailable(); }
}
