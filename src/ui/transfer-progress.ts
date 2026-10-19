import { formatUpload, progressRunning, type SyncProgress } from '../sync/progress';

interface UploadRow { el: HTMLElement; title: HTMLElement; text: HTMLElement; meter: HTMLProgressElement; note: HTMLElement; }
const rendered = new WeakMap<HTMLElement, { key: string; rows: Map<string, UploadRow>; more: HTMLElement }>();
/** Updating this isolated area never rebuilds settings inputs or focus. */
export function renderUploads(container: HTMLElement, progress?: SyncProgress): void {
  const uploads = progress?.uploads ?? [], key = JSON.stringify([uploads, progress && progressRunning(progress)]);
  let state = rendered.get(container);
  if (state?.key === key) return;
  if (!state) { state = { key, rows: new Map(), more: container.createEl('p') }; rendered.set(container, state); }
  state.key = key; container.hidden = !uploads.length;
  const visible = uploads.slice(0, 8), paths = new Set(visible.map(upload => upload.path));
  for (const [path, row] of state.rows) if (!paths.has(path)) { row.el.remove(); state.rows.delete(path); }
  for (let index = 0; index < visible.length; index++) {
    const upload = visible[index]; let row = state.rows.get(upload.path);
    if (!row) {
      const el = container.createDiv({ cls: 'vaultsail-upload-row' }); el.setAttribute('data-path', upload.path);
      row = { el, title: el.createEl('strong', { text: upload.path }), text: el.createEl('p', { cls: 'vaultsail-upload-text' }), meter: el.createEl('progress', { cls: 'vaultsail-upload-meter' }), note: el.createEl('p', { cls: 'vaultsail-upload-note' }) };
      state.rows.set(upload.path, row);
    }
    if (container.children[index] !== row.el) container.insertBefore(row.el, container.children[index] ?? null);
    const text = formatUpload(upload); if (row.text.textContent !== text) row.text.setText(text);
    const meter = row.meter;
    meter.setAttribute('aria-label', upload.path + '：服务端已确认的上传内容');
    meter.max = upload.totalBytes || Math.max(1, upload.totalParts);
    meter.value = upload.totalBytes ? upload.uploadedBytes : upload.completedParts;
    const note = upload.stage === 'uploading' ? '每个分片确认后更新；正在传输的分片尚未计入。'
      : ['committing', 'verifying', 'verified', 'publishing'].includes(upload.stage) && progress && progressRunning(progress) ? '上传字节与文件完成分开计算；校验并发布记录后，才计入任务完成。' : '';
    if (row.note.textContent !== note) row.note.setText(note); row.note.hidden = !note;
  }
  state.more.hidden = uploads.length <= 8;
  if (uploads.length > 8) state.more.setText(`另有 ${uploads.length - 8} 个文件正在处理。`);
}
