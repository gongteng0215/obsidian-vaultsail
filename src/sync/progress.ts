import type { ObjectTransferProgress } from '../providers/cloud-storage-provider';
import type { RevisionScanProgress } from './remote-vault';
import { formatPreflight, type PreflightStatus } from './preflight.ts';
export type FileUploadProgress = Omit<ObjectTransferProgress, 'stage'> & { path: string; contentHash?: string; sourcePreparationMs?: number; stage: ObjectTransferProgress['stage'] | 'publishing' };
export type ProgressPhase = 'connecting' | 'scanning-remote' | 'checking-remote' | 'scanning-local' | 'checking' | 'preparing-upload' | 'uploading' | 'verifying' | 'publishing' | 'downloading' | 'applying' | 'preview-ready' | 'completed' | 'paused' | 'failed';
export interface SyncProgress {
  phase: ProgressPhase; path?: string; doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number; startedAt: number; updatedAt: number;
  message?: string;
  activeFiles?: number; concurrency?: number;
  blockedFiles?: number;
  uploads?: FileUploadProgress[];
  scan?: RevisionScanProgress;
  preflight?: PreflightStatus;
}
export function formatScan(scan?: RevisionScanProgress): string {
  if (!scan) return '';
  const labels = { listing: '读取设备目录', metadata: '批量查询记录信息', reading: '读取版本记录', validating: '校验版本关系', 'saving-cache': '检查并保存缓存', completed: '版本扫描完成' };
  return `${labels[scan.phase]}${scan.phase === 'listing' ? ` ${scan.devicesDone}/${scan.devices || '待确定'} · 已发现 ${scan.listed} 条记录` : ` · ${scan.completed}/${scan.listed} 条 · 缓存命中 ${scan.cacheHits} · 实际读取 ${scan.read}`} · 目录分页 ${scan.pages} 次`;
}
export const PROGRESS_LABELS: Record<ProgressPhase, string> = {
  connecting: '检查百度连接与云端库',
  'checking-remote': '复查云端版本',
  'scanning-remote': '读取云端版本', 'scanning-local': '扫描本地文件', checking: '重新核验变更', uploading: '上传笔记内容', verifying: '回读并校验内容',
  publishing: '发布版本记录', downloading: '下载云端内容', applying: '写入本地文件', 'preview-ready': '预览已就绪，尚未传输', completed: '处理完成', paused: '已暂停，任务可恢复', failed: '操作未完成',
  'preparing-upload': '准备附件与本地恢复副本',
};
export function progressRunning(progress: SyncProgress): boolean { return !['preview-ready', 'completed', 'paused', 'failed'].includes(progress.phase); }
export function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}
export function formatUpload(upload: FileUploadProgress): string {
  const labels = { preparing: '准备附件与分片', uploading: '上传分片', committing: '提交云端文件', verifying: '回读并校验（等待完整响应）', verified: '内容校验通过，等待发布记录', publishing: '发布版本记录' };
  const percent = upload.totalBytes ? Math.floor(Math.min(1, upload.uploadedBytes / upload.totalBytes) * 100) : upload.completedParts === upload.totalParts && upload.totalParts > 0 ? 100 : 0;
  const parts = upload.totalParts ? ` · 分片 ${upload.completedParts}/${upload.totalParts}` : '';
  const current = upload.activeParts?.length ? ` · 正在传第 ${upload.activeParts.join('、')} 片` : upload.currentPart ? ` · 正在传第 ${upload.currentPart} 片` : '';
  const until = Math.max(upload.retryAt ?? 0, ...(upload.waitingParts?.map(part => part.until) ?? []));
  const retry = until ? ` · ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} 秒后重试` : '';
  const preparing = upload.stage === 'preparing' && upload.preparedParts !== undefined ? ` · 已准备 ${upload.preparedParts}/${upload.totalParts} 片` : '';
  return `${upload.requestPending ? '等待原生请求结束，结果待核验' : labels[upload.stage]}${upload.attempt > 1 ? ` · 第 ${upload.attempt} 次尝试` : ''}\n已确认上传 ${formatBytes(upload.uploadedBytes)} / ${formatBytes(upload.totalBytes)} · ${percent}%${parts}${current}${preparing}${retry}`;
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
  const blocked = progress.blockedFiles ? `\n跳过 ${progress.blockedFiles} 项（超限或关联保护，未传输；可查看跳过文件）` : '';
  const label = formatPreflight(progress.preflight) || (progress.phase === 'completed' && progress.blockedFiles ? '部分完成 · 有跳过项' : PROGRESS_LABELS[progress.phase]);
  const scan = ['scanning-remote', 'checking-remote'].includes(progress.phase) && progress.scan ? '\n' + formatScan(progress.scan) : '';
  return `${label}${progress.path ? ' · ' + progress.path : ''}\n${count}${size} · 耗时 ${elapsed} 秒${scan}${parallel}${blocked}${waiting}${result}${stopped}`;
}
