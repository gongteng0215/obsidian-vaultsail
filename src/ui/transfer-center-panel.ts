import type { TransferCenterSnapshot } from '../sync/transfer-center';
import { HISTORY_ACTIONS, HISTORY_CODES, HISTORY_REASONS, type FileHistoryRow } from '../sync/history';
import { formatBytes, PROGRESS_LABELS, type FileUploadProgress } from '../sync/progress';

export interface TransferCenterSource {
  snapshot(): TransferCenterSnapshot; subscribe(listener: () => void): () => void;
  sync(): void; pause(): void; resume(): void; history(): void; refresh(): Promise<void>;
}
const STAGES = { preparing: '准备附件与分片', uploading: '正在上传', committing: '提交云端文件', verifying: '回读校验中', verified: '内容已校验', publishing: '发布版本记录' };
const STATES = { queued: '等待处理', running: '处理中', succeeded: '已完成', skipped: '已跳过', unchanged: '无变化', conflict: '待处理冲突', failed: '失败', paused: '已暂停', unconfirmed: '结果待核验', 'not-run': '尚未执行' };
const TASKS = { running: '正在同步', completed: '本轮已完成', partial: '部分完成，请查看需处理项', failed: '任务未完成', paused: '任务已暂停', interrupted: '上次任务中断，需核验恢复' };
const FILTERS = { all: '全部', active: '进行中', queued: '等待', done: '已完成', attention: '需处理' };
type Filter = keyof typeof FILTERS;
const category = (row: FileHistoryRow): Filter => row.state === 'running' ? 'active' : row.state === 'queued' ? 'queued' : ['succeeded', 'unchanged'].includes(row.state) ? 'done' : 'attention';
const seconds = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)} 秒`;
const text = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.setText(value); };
const eta = (value: number) => value < 60 ? `${Math.ceil(value)} 秒` : `${Math.ceil(value / 60)} 分钟`;
interface RowElements { el: HTMLElement; name: HTMLElement; directory: HTMLElement; action: HTMLElement; state: HTMLElement; detail: HTMLElement; meter: HTMLProgressElement; note: HTMLElement; timings: HTMLElement; }

/** One persistent DOM row per file. Progress never replaces search inputs, focus, or details. */
export class TransferCenterPanel {
  private unsubscribe: () => void; private timer: ReturnType<typeof setInterval>; private closed = false;
  private rows = new Map<string, RowElements>(); private uploads = new Map<string, FileUploadProgress>();
  private filter: Filter = 'all'; private page = 0; private key = ''; private context?: string;
  private title: HTMLElement; private status: HTMLElement; private counts: HTMLElement; private meter: HTMLProgressElement;
  private speed: HTMLElement; private queue: HTMLElement; private warning: HTMLElement; private search: HTMLInputElement;
  private list: HTMLElement; private empty: HTMLElement; private paging: HTMLElement; private performance: HTMLElement;
  private buttons = new Map<Filter, HTMLButtonElement>();
  private sync: HTMLButtonElement; private pause: HTMLButtonElement; private resume: HTMLButtonElement;
  private previous: HTMLButtonElement; private next: HTMLButtonElement;
  private needsRender = true; private running = false;
  constructor(private host: HTMLElement, private source: TransferCenterSource) {
    host.empty(); host.classList.add('vaultsail-transfer-center');
    const heading = host.createDiv({ cls: 'vs-transfer-heading' });
    const brand = heading.createDiv(); brand.createEl('span', { cls: 'vs-transfer-eyebrow', text: 'VAULTSAIL / TRANSFERS' });
    brand.createEl('h2', { text: '传输中心' });
    const actions = heading.createDiv({ cls: 'vs-transfer-actions' });
    this.sync = actions.createEl('button', { text: '开始同步', cls: 'mod-cta' }); this.sync.addEventListener('click', () => source.sync());
    this.pause = actions.createEl('button', { text: '暂停任务' }); this.pause.addEventListener('click', () => source.pause());
    this.resume = actions.createEl('button', { text: '继续 / 恢复' }); this.resume.addEventListener('click', () => source.resume());
    const summary = host.createDiv({ cls: 'vs-transfer-summary' });
    this.title = summary.createEl('strong', { cls: 'vs-transfer-target' });
    this.status = summary.createEl('p', { cls: 'vs-transfer-status' }); this.status.setAttribute('role', 'status');
    const metrics = summary.createDiv({ cls: 'vs-transfer-metrics' }); this.counts = metrics.createEl('span'); this.speed = metrics.createEl('span');
    this.meter = summary.createEl('progress', { cls: 'vs-transfer-total' }); this.meter.setAttribute('aria-label', '本轮已完成文件');
    this.queue = summary.createEl('p', { cls: 'vs-transfer-muted' });
    const filters = host.createDiv({ cls: 'vs-transfer-filters' }); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '按传输状态筛选');
    for (const [id, label] of Object.entries(FILTERS)) { const button = filters.createEl('button', { text: label }); this.buttons.set(id as Filter, button); button.addEventListener('click', () => { this.filter = id as Filter; this.page = 0; this.render(); }); }
    this.search = host.createEl('input', { cls: 'vs-transfer-search' }); this.search.type = 'search'; this.search.placeholder = '搜索文件名或目录'; this.search.setAttribute('aria-label', '搜索传输文件');
    this.search.addEventListener('input', () => { this.page = 0; this.render(); });
    this.warning = host.createEl('p', { cls: 'vs-transfer-warning' });
    this.list = host.createDiv({ cls: 'vs-transfer-list' }); this.list.setAttribute('role', 'list'); this.list.setAttribute('aria-label', '本轮传输文件');
    this.empty = host.createEl('p', { cls: 'vs-transfer-empty' });
    const footer = host.createDiv({ cls: 'vs-transfer-footer' });
    this.previous = footer.createEl('button', { text: '上一页' }); this.previous.addEventListener('click', () => { this.page--; this.render(); });
    this.paging = footer.createEl('span');
    this.next = footer.createEl('button', { text: '下一页' }); this.next.addEventListener('click', () => { this.page++; this.render(); });
    footer.createEl('button', { text: '历史记录' }).addEventListener('click', () => source.history());
    const details = host.createEl('details', { cls: 'vs-transfer-diagnostics' }); details.createEl('summary', { text: '本轮耗时与请求统计' });
    this.performance = details.createEl('p');
    host.createEl('p', { cls: 'vs-transfer-footnote', text: '内容校验并保存版本后才算完成。关闭面板不会停止同步。' });
    this.unsubscribe = source.subscribe(() => { this.needsRender = true; });
    this.timer = setInterval(() => { if (this.needsRender || this.running) this.render(); }, 500); this.render();
    void source.refresh().then(() => { if (!this.closed) this.render(); }).catch(() => { if (!this.closed) text(this.warning, '读取上次任务失败；当前任务仍会正常显示。'); });
  }
  destroy(): void { this.closed = true; this.unsubscribe(); clearInterval(this.timer); this.rows.clear(); this.uploads.clear(); }
  private createRow(id: string): RowElements {
    const el = this.list.createDiv({ cls: 'vs-transfer-file' }); el.setAttribute('role', 'listitem'); el.setAttribute('data-file-id', id);
    const header = el.createDiv({ cls: 'vs-transfer-file-header' }); header.createEl('span', { cls: 'vs-transfer-file-icon' }).setAttribute('aria-hidden', 'true');
    const info = header.createDiv({ cls: 'vs-transfer-file-info' });
    const name = info.createEl('strong'); const directory = info.createEl('span', { cls: 'vs-transfer-directory' });
    const state = header.createEl('span', { cls: 'vs-transfer-state' });
    const action = el.createEl('span', { cls: 'vs-transfer-action' });
    const meter = el.createEl('progress', { cls: 'vs-transfer-file-meter' });
    const note = el.createEl('p', { cls: 'vs-transfer-file-note' });
    const details = el.createEl('details', { cls: 'vs-transfer-file-details' }); details.createEl('summary', { text: '详情' });
    const detail = details.createEl('p'); const timings = details.createEl('p');
    return { el, name, directory, action, state, detail, meter, note, timings };
  }
  render(): void {
    if (this.closed) return;
    const snapshot = this.source.snapshot(), task = snapshot.task, progress = snapshot.progress;
    this.needsRender = false; this.running = snapshot.busy;
    const key = `${snapshot.context ?? ''}:${task?.id ?? ''}`;
    if (this.key !== key) {
      this.key = key; this.rows.clear(); this.uploads.clear(); this.list.empty(); this.page = 0;
      if (this.context !== snapshot.context) { this.search.value = ''; this.filter = 'all'; }
      this.context = snapshot.context;
    }
    for (const upload of progress?.uploads ?? []) this.uploads.set(upload.path, upload);
    text(this.title, snapshot.target);
    const label = snapshot.pauseRequested ? '正在暂停，等待当前请求结束' : snapshot.busy && progress ? PROGRESS_LABELS[progress.phase]
      : task ? TASKS[task.status] : snapshot.context ? '准备就绪' : '请先连接百度网盘并绑定云端库';
    text(this.status, label); this.host.setAttribute('data-running', String(snapshot.busy));
    this.sync.disabled = !snapshot.context || snapshot.busy; this.pause.hidden = !snapshot.busy; this.pause.disabled = snapshot.pauseRequested;
    this.resume.hidden = snapshot.busy || !(task && ['failed', 'paused', 'interrupted'].includes(task.status) || progress && ['paused', 'failed'].includes(progress.phase) || snapshot.queue.includes('暂停'));
    this.resume.disabled = !snapshot.context;
    const files = task?.files ?? [], done = files.filter(row => category(row) === 'done').length;
    text(this.counts, files.length ? `已完成 ${done} / ${files.length} 个文件` : snapshot.busy && progress ? `已扫描 ${progress.doneFiles} 项` : '等待下一次同步');
    this.meter.max = Math.max(1, files.length); if (snapshot.busy && !files.length) this.meter.removeAttribute('value'); else this.meter.value = done;
    text(this.speed, snapshot.bytesPerSecond > 0 && snapshot.busy ? `上传 ${formatBytes(snapshot.bytesPerSecond)}/s` : snapshot.busy && progress?.uploads?.some(row => row.stage === 'uploading') ? '上传速度估算中' : '');
    text(this.queue, snapshot.queue);
    text(this.warning, [task?.truncated ? '本轮记录已达到保存上限，列表与文件计数仅代表已记录部分；完整结果以任务结果为准。' : '', snapshot.historyWarning ? '部分本机记录读取或保存失败，不影响同步内容。' : '', !snapshot.busy && progress?.message ? progress.message : ''].filter(Boolean).join('\n'));
    this.warning.hidden = !this.warning.textContent;
    for (const [id, button] of this.buttons) { text(button, `${FILTERS[id]} ${id === 'all' ? files.length : files.filter(row => category(row) === id).length}`); button.setAttribute('aria-pressed', String(id === this.filter)); }
    const query = this.search.value.toLocaleLowerCase();
    const filtered = files.filter(row => (this.filter === 'all' || category(row) === this.filter) && (!query || row.path.toLocaleLowerCase().includes(query)));
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(filtered.length / 50) - 1)));
    const visible = filtered.slice(this.page * 50, (this.page + 1) * 50), ids = new Set(visible.map(row => row.id));
    for (const [id, elements] of this.rows) if (!ids.has(id)) { elements.el.remove(); this.rows.delete(id); }
    for (let index = 0; index < visible.length; index++) {
      const row = visible[index]; let elements = this.rows.get(row.id);
      if (!elements) { elements = this.createRow(row.id); this.rows.set(row.id, elements); }
      if (this.list.children[index] !== elements.el) this.list.insertBefore(elements.el, this.list.children[index] ?? null);
      this.updateRow(elements, row, snapshot);
    }
    text(this.empty, files.length ? '没有符合当前筛选条件的文件。' : snapshot.busy ? '正在检查变更，文件清单将在扫描完成后显示。' : '尚无文件记录。点击开始同步，或通过历史记录查看以前的任务。');
    this.empty.hidden = visible.length > 0;
    text(this.paging, `${filtered.length} 项 · ${this.page + 1} / ${Math.max(1, Math.ceil(filtered.length / 50))}`);
    this.previous.disabled = this.page === 0; this.next.disabled = (this.page + 1) * 50 >= filtered.length;
    const perf = snapshot.performance;
    text(this.performance, perf ? `本轮经过 ${seconds(perf.elapsedMs)}\n连接 ${seconds(perf.stages.connecting)} · 云端扫描 ${seconds(perf.stages.remote)} · 本地扫描 ${seconds(perf.stages.local)} · 传输处理 ${seconds(perf.stages.transfer)}\n网络请求 ${perf.requestCount} 次 · 令牌刷新 ${perf.refreshCount} 次 · 重试 ${perf.retryCount} 次\n并发请求耗时不能相加当作本轮经过时间。` : '下一次任务开始后显示。');
  }
  private updateRow(elements: RowElements, row: FileHistoryRow, snapshot: TransferCenterSnapshot): void {
    const parts = row.path.split('/'), upload = this.uploads.get(row.path), active = row.state === 'running' && snapshot.busy;
    const timing = snapshot.timings[row.path]; const stage = upload?.stage;
    text(elements.name, parts.pop()!); text(elements.directory, parts.join('/') || '笔记库根目录'); elements.name.title = row.path;
    const label = active && upload?.requestPending ? '等待请求结束' : active && (upload?.retryAt || upload?.waitingParts?.length && !upload.activeParts?.length) ? '等待重试' : active && upload?.waitingForSlot && !upload.activeParts?.length ? '等待请求空位'
      : active && stage ? STAGES[stage] : active && snapshot.progress?.path === row.path ? PROGRESS_LABELS[snapshot.progress.phase] : STATES[row.state];
    text(elements.state, label); elements.el.setAttribute('data-state', row.state); elements.el.setAttribute('data-action', row.action);
    const percent = upload ? upload.totalBytes ? Math.floor(Math.min(1, upload.uploadedBytes / upload.totalBytes) * 100) : upload.completedParts === upload.totalParts && upload.totalParts > 0 ? 100 : 0 : undefined;
    text(elements.action, `${HISTORY_ACTIONS[row.action]} · ${formatBytes(row.size)}${active && percent !== undefined ? ` · 上传 ${percent}%` : ''}${active && upload && upload.attempt > 1 ? ` · 第 ${upload.attempt} 次尝试` : ''}`);
    elements.meter.hidden = !upload || row.state === 'unchanged' || row.state === 'skipped'; elements.meter.max = Math.max(1, upload?.totalBytes ?? 1);
    elements.meter.value = upload?.totalBytes ? upload.uploadedBytes : percent === 100 ? 1 : 0;
    elements.meter.setAttribute('aria-label', `${row.path}：服务端已确认上传内容`);
    const rate = active && stage === 'uploading' ? timing?.bytesPerSecond : undefined;
    const retryUntil = Math.max(upload?.retryAt ?? 0, ...(upload?.waitingParts?.map(part => part.until) ?? []));
    const retryNote = retryUntil > 0 ? ` · ${Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000))} 秒后重试${upload?.waitingParts?.length ? `（${upload.waitingParts.length} 片等待）` : ''}` : '';
    const note = active && upload?.requestPending ? '原生请求仍未结束，保留并发与缓冲额度；结果核验前不会提交文件。'
      : active && upload ? (stage === 'uploading'
      ? `${formatBytes(upload.uploadedBytes)} / ${formatBytes(upload.totalBytes)}${rate ? ` · ${formatBytes(rate)}/s · 上传约剩 ${eta(timing!.uploadRemainingSeconds!)}` : ' · 速度估算中'}${timing && timing.waitingMs >= 2000 ? ` · 等待分片确认 ${seconds(timing.waitingMs)}` : ''}；校验另计`
      : stage === 'verifying' ? `正在回读云端内容并校验${timing ? ` · 本阶段 ${seconds(timing.elapsedMs)}` : ''}`
      : `${STAGES[stage!]}${timing ? ` · 本阶段 ${seconds(timing.elapsedMs)}` : ''}`) + retryNote
      : row.state === 'succeeded' ? ['upload', 'download'].includes(row.action) ? '已校验并保存版本' : '已完成并保存结果' : row.state === 'queued' ? '等待本轮任务调度' : row.code ? HISTORY_CODES[row.code] : HISTORY_REASONS[row.reason];
    text(elements.note, note);
    text(elements.detail, `${row.path}\n${HISTORY_REASONS[row.reason]}${row.code ? '\n' + HISTORY_CODES[row.code] : ''}${upload ? `\n已确认分片 ${upload.completedParts} / ${upload.totalParts}${upload.activeParts?.length ? ` · 正在传第 ${upload.activeParts.join('、')} 片` : upload.currentPart ? ` · 正在传第 ${upload.currentPart} 片` : ''} · 第 ${upload.attempt} 次尝试 · 重试 ${upload.retryCount ?? 0} 次\n进度按服务端确认更新，正在传输的分片尚未计入。` : ''}`);
    text(elements.timings, timing ? [timing.sourcePreparationMs !== undefined ? `本地核验与恢复准备 ${seconds(timing.sourcePreparationMs)}` : '', ...Object.entries(timing.stages).map(([name, ms]) => `${STAGES[name as keyof typeof STAGES]} ${seconds(ms!)}`)].filter(Boolean).join(' · ') : '');
  }
}
