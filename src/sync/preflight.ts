/** Read-only checks may overlap, but every started check must settle before a
 * failure releases the task lock or any caller starts applying a plan. */
export async function scanInventories<A, B>(files: () => Promise<A>, directories: () => Promise<B>): Promise<[A, B]> {
  const [fileResult, directoryResult] = await Promise.allSettled([
    Promise.resolve().then(files), Promise.resolve().then(directories),
  ]);
  if (fileResult.status === 'rejected') throw fileResult.reason;
  if (directoryResult.status === 'rejected') throw directoryResult.reason;
  return [fileResult.value, directoryResult.value];
}
