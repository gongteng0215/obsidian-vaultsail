/** Read-only checks may overlap, but every started check must settle before a
 * failure releases the task lock or any caller starts applying a plan. */
export type CheckStatus = 'running' | 'completed' | 'failed';
export interface PreflightStatus { files: CheckStatus; directories: CheckStatus; }
export function formatPreflight(status?: PreflightStatus): string {
  if (!status) return '';
  if (status.files === 'failed' || status.directories === 'failed') return status.files === 'running' || status.directories === 'running' ? '检查失败，正在等待另一项检查结束' : '检查失败，未开始传输';
  if (status.files === 'completed' && status.directories === 'completed') return '检查完成，准备处理变更';
  if (status.files === 'completed') return '文件检查完成，等待目录检查';
  if (status.directories === 'completed') return '目录检查完成，等待文件检查';
  return '正在检查文件与目录';
}
export async function scanInventories<A, B>(files: () => Promise<A>, directories: () => Promise<B>, onStatus?: (status: PreflightStatus) => void): Promise<[A, B]> {
  const status: PreflightStatus = { files: 'running', directories: 'running' };
  const notify = () => { try { onStatus?.({ ...status }); } catch { /* Observers cannot change task admission. */ } };
  const check = async <T>(kind: keyof PreflightStatus, run: () => Promise<T>) => {
    try { const result = await run(); status[kind] = 'completed'; notify(); return result; }
    catch (error) { status[kind] = 'failed'; notify(); throw error; }
  };
  notify();
  const [fileResult, directoryResult] = await Promise.allSettled([
    Promise.resolve().then(() => check('files', files)), Promise.resolve().then(() => check('directories', directories)),
  ]);
  if (fileResult.status === 'rejected') throw fileResult.reason;
  if (directoryResult.status === 'rejected') throw directoryResult.reason;
  return [fileResult.value, directoryResult.value];
}
