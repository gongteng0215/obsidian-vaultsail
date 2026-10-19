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
/** Payload confirmed by the server, never estimated socket bytes or retries. */
export interface ObjectTransferProgress {
  stage: 'preparing' | 'uploading' | 'committing' | 'verifying' | 'verified';
  uploadedBytes: number; totalBytes: number; completedParts: number; totalParts: number;
  /** Newly acknowledged request payload in this attempt, excluding server-reused parts. */
  transferredBytes?: number;
  currentPart?: number; preparedParts?: number; attempt: number;
  activeParts?: number[]; waitingParts?: { part: number; until: number; attempt: number }[];
  retryCount?: number; retryAt?: number; waitingForSlot?: boolean; requestPending?: boolean;
}
export type TransferObserver = (progress: ObjectTransferProgress) => void;
export interface CloudStorageProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: CloudProviderCapabilities;
  isConfigured(): boolean;
  readonly root: string;
  list(directory: string, cursor?: string): Promise<RemotePage>;
  read(path: string): Promise<ArrayBuffer>;
  writeImmutable(path: string, data: ArrayBuffer, onProgress?: TransferObserver): Promise<void>;
  mkdir(directory: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Fresh metadata for listed files whose listing omitted a content fingerprint. */
  inspect?(objects: RemoteObject[]): Promise<RemoteObject[]>;
  /** Prepare a bounded batch for reading; temporary download URLs stay inside the provider. */
  prepareReads?(objects: RemoteObject[]): Promise<RemoteObject[]>;
  /** SHA-256 from a completed readback, only when this freshly listed object has the same server fingerprint. */
  verifiedContentHash?(object: RemoteObject): string | undefined;
}
