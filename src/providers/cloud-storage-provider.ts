/**
 * Capability-driven interface for Baidu, OneDrive, WebDAV, S3, etc.
 * No implementation may infer that an empty listing means "delete everything" after an API failure.
 */
export interface RemoteObject {
  path: string;
  size: number;
  etag?: string;
}
export interface RemotePage {
  objects: RemoteObject[];
  nextCursor?: string;
}
export interface CloudProviderCapabilities {
  canList: boolean;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  supportsConditionalWrites: boolean;
}
export interface CloudStorageProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: CloudProviderCapabilities;
  isConfigured(): boolean;
  list(remoteVaultId: string, cursor?: string): Promise<RemotePage>;
  read(remoteVaultId: string, path: string): Promise<ArrayBuffer>;
  write(remoteVaultId: string, path: string, data: ArrayBuffer): Promise<void>;
  remove(remoteVaultId: string, path: string): Promise<void>;
}
