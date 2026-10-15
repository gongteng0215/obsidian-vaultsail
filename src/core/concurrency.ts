export const DEFAULT_TRANSFER_CONCURRENCY = 3;
export const MAX_TRANSFER_CONCURRENCY = 4;
export const TRANSFER_BATCH_BYTES = 24 * 1024 * 1024;
export function validConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TRANSFER_CONCURRENCY;
}
// Drain started operations on failure. Never release the caller while another
// worker can still publish an object or mutate a cache in the background.
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!validConcurrency(limit)) throw new RangeError('Invalid transfer concurrency');
  const results: R[] = new Array(items.length); let next = 0; let failed = false; let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await action(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
