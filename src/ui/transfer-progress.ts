import { formatUpload, progressRunning, type SyncProgress } from '../sync/progress';

const rendered = new WeakMap<HTMLElement, string>();
/** Updating this isolated area never rebuilds settings inputs or focus. */
export function renderUploads(container: HTMLElement, progress?: SyncProgress): void {
  const uploads = progress?.uploads ?? [], key = JSON.stringify([uploads, progress && progressRunning(progress)]);
  if (rendered.get(container) === key) return; rendered.set(container, key);
  container.empty(); container.hidden = !uploads.length;
  for (const upload of uploads.slice(0, 8)) {
    const row = container.createDiv({ cls: 'vaultsail-upload-row' }); row.setAttribute('data-path', upload.path);
    row.createEl('strong', { text: upload.path });
    row.createEl('p', { cls: 'vaultsail-upload-text', text: formatUpload(upload) });
    const meter = row.createEl('progress', { cls: 'vaultsail-upload-meter' });
    meter.setAttribute('aria-label', upload.path + '：服务端已确认的上传内容');
    meter.max = upload.totalBytes || Math.max(1, upload.totalParts);
    meter.value = upload.totalBytes ? upload.uploadedBytes : upload.completedParts;
    if (upload.stage === 'uploading') row.createEl('p', { text: '每个分片确认后更新；正在传输的分片尚未计入。', cls: 'vaultsail-upload-note' });
    if (['committing', 'verifying', 'verified', 'publishing'].includes(upload.stage) && progress && progressRunning(progress)) row.createEl('p', { text: '上传字节与文件完成分开计算；校验并发布记录后，才计入任务完成。', cls: 'vaultsail-upload-note' });
  }
  if (uploads.length > 8) container.createEl('p', { text: `另有 ${uploads.length - 8} 个文件正在处理。` });
}
