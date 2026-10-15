export type ProgressPhase = 'connecting' | 'scanning-remote' | 'scanning-local' | 'checking' | 'uploading' | 'verifying' | 'publishing' | 'downloading' | 'applying' | 'preview-ready' | 'completed' | 'paused' | 'failed';
export interface SyncProgress {
  phase: ProgressPhase; path?: string; doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number; startedAt: number; updatedAt: number;
  message?: string;
  activeFiles?: number; concurrency?: number;
}
export const PROGRESS_LABELS: Record<ProgressPhase, string> = {
  connecting: '检查百度连接与云端库',
  'scanning-remote': '读取云端版本', 'scanning-local': '扫描本地文件', checking: '重新核验变更', uploading: '上传笔记内容', verifying: '回读并校验内容',
  publishing: '发布版本记录', downloading: '下载云端内容', applying: '写入本地文件', 'preview-ready': '预览已就绪，尚未传输', completed: '处理完成', paused: '已暂停，任务可恢复', failed: '操作未完成',
};
export function progressRunning(progress: SyncProgress): boolean { return !['preview-ready', 'completed', 'paused', 'failed'].includes(progress.phase); }
export function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}
export function formatProgress(progress: SyncProgress, now = Date.now()): string {
  const ended = !progressRunning(progress);
  const elapsed = Math.max(0, Math.floor(((ended ? progress.updatedAt : now) - progress.startedAt) / 1000));
  const scanning = ['connecting', 'scanning-remote', 'scanning-local', 'preview-ready'].includes(progress.phase);
  const count = progress.phase === 'scanning-remote' ? `已读取 ${progress.doneFiles}/${progress.totalFiles} 条版本记录` : `${scanning ? '已扫描' : '已处理'} ${progress.doneFiles}/${progress.totalFiles} 个文件`;
  const size = scanning ? '' : ` · 已校验内容 ${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}`;
  const waiting = !ended && now - progress.updatedAt >= 2000 ? `\n本步骤进行中，已等待新进度 ${Math.floor((now - progress.updatedAt) / 1000)} 秒。` : '';
  const result = progress.message ? '\n' + progress.message : '';
  const stopped = progress.phase === 'failed' ? '\n任务已停止，请根据错误恢复任务或重新同步。' : '';
  const parallel = progress.concurrency && !scanning ? `\n同时传输 ${progress.activeFiles ?? 0}/${progress.concurrency} 个文件` : '';
  return `${PROGRESS_LABELS[progress.phase]}${progress.path ? ' · ' + progress.path : ''}\n${count}${size} · 耗时 ${elapsed} 秒${parallel}${waiting}${result}${stopped}`;
}
