import { RequestPool } from '../core/request-pool.ts';
const key = Symbol.for('vaultsail.request-pools');
interface Pools { requests: RequestPool; bodies: RequestPool; }
const shared = globalThis as typeof globalThis & { [key]?: WeakMap<object, Pools> };
const pools = shared[key] ??= new WeakMap<object, Pools>();
/** Survives plugin reload while old native requests or multipart bodies remain alive. */
export function requestPools(owner: object): Pools {
  let value = pools.get(owner);
  if (!value) { value = { requests: new RequestPool(8), bodies: new RequestPool(8) }; pools.set(owner, value); }
  return value;
}
