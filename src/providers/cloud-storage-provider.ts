/**
 * Capability-driven interface for Baidu, OneDrive, WebDAV, S3, etc.
 * No implementation may infer that an empty listing means "delete everything" after an API failure.
 */
export interface RemoteObject {
  path: string;
  size: number;
  etag?: string;
  isDirectory: boolean;
  id?: string;
}
export interface RemotePage {
  objects: RemoteObject[];
  nextCursor?: string;
  complete: boolean;
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
  readonly root: string;
  list(directory: string, cursor?: string): Promise<RemotePage>;
  read(path: string): Promise<ArrayBuffer>;
  writeImmutable(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(directory: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** SHA-256 from a completed readback, only when this freshly listed object has the same server fingerprint. */
  verifiedContentHash?(object: RemoteObject): string | undefined;
}
