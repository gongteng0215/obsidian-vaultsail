const key = Symbol.for('vaultsail.task-queue');
const shared = window as typeof window & { [key]?: WeakMap<object, Promise<void>> };
const queues = shared[key] ??= new WeakMap<object, Promise<void>>();
export async function withVaultTaskLock<T>(app: object, run: () => Promise<T>): Promise<T> {
  const operation = (queues.get(app) ?? Promise.resolve()).then(run), settled = operation.then(() => {}, () => {});
  queues.set(app, settled);
  try { return await operation; } finally { if (queues.get(app) === settled) queues.delete(app); }
}
