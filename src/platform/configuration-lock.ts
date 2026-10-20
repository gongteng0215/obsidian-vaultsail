// Hot reloads evaluate the bundle again. Keep the queue outside the module so a
// new plugin instance cannot read settings while the old one is rolling back.
const key = Symbol.for('vaultsail.configuration-queue');
const shared = window as unknown as Record<symbol, WeakMap<object, Promise<void>>>;
const queues = shared[key] ??= new WeakMap<object, Promise<void>>();

export function withConfigurationLock<T>(app: object, action: () => Promise<T>): Promise<T> {
  const operation = (queues.get(app) ?? Promise.resolve()).then(action);
  const settled = operation.then(() => {}, () => {});
  queues.set(app, settled);
  void settled.then(() => { if (queues.get(app) === settled) queues.delete(app); });
  return operation;
}
