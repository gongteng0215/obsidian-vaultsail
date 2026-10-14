import type { FileVersion, SyncDecision, ThreeWayFileState } from './types';

const same = (a: FileVersion | null, b: FileVersion | null): boolean =>
  a === null || b === null ? a === b : a.hash === b.hash && a.size === b.size;

/**
 * Pure plan, never executes I/O. Base must come from a verified prior sync.
 * If remote enumeration fails, NEVER call this planner with an empty remote inventory.
 * Conflict is intentionally preferred to silent overwrite.
 */
export function reconcileFile(state: ThreeWayFileState): SyncDecision {
  const { path, base, local, remote } = state;
  const changedLocal = !same(local, base);
  const changedRemote = !same(remote, base);

  if (same(local, remote)) {
    return { path, operation: 'noop', reason: 'Local and remote match' };
  }
  if (changedLocal && changedRemote) {
    return { path, operation: 'conflict', reason: 'Both sides changed since baseline' };
  }
  if (changedLocal) {
    return local === null
      ? { path, operation: 'delete-remote', reason: 'Local deletion, remote unchanged' }
      : { path, operation: 'upload', reason: 'Local changed, remote unchanged' };
  }
  if (changedRemote) {
    return remote === null
      ? { path, operation: 'delete-local', reason: 'Remote deletion, local unchanged' }
      : { path, operation: 'download', reason: 'Remote changed, local unchanged' };
  }
  return { path, operation: 'conflict', reason: 'Unexpected divergence, preserve both versions' };
}
