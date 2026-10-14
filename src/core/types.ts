/** Remote vault IDs are logical identifiers and never guessed from local folder names. */
export interface VaultBinding {
  providerId: string;
  remoteVaultId: string;
}

/** Content fingerprints are provided by the same canonical hashing scheme on every device. */
export interface FileVersion {
  hash: string;
  size: number;
}

export type SyncOperation =
  | 'noop'
  | 'upload'
  | 'download'
  | 'delete-local'
  | 'delete-remote'
  | 'conflict';

export interface SyncDecision {
  path: string;
  operation: SyncOperation;
  reason: string;
}

export interface ThreeWayFileState {
  path: string;
  /** Last successfully committed base state. Null means the path did not exist at that baseline. */
  base: FileVersion | null;
  local: FileVersion | null;
  remote: FileVersion | null;
}
