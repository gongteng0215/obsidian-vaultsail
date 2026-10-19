import { Modal, type App } from 'obsidian';
import { formatBytes } from '../sync/progress';
import { formatScanSummary } from '../sync/scan-summary';
import { HISTORY_ACTIONS, HISTORY_CODES, HISTORY_REASONS, HISTORY_STATES, SyncHistory, type SyncHistoryTask } from '../sync/history';
import { preserveInteraction } from './interaction';

const MODES = { manual: '手动双向同步', automatic: '自动同步', upload: '上传清单', download: '下载清单', recover: '恢复任务', resolve: '解决冲突' };
const TASK_STATES = { running: '进行中', completed: '已完成', partial: '部分完成', failed: '失败', paused: '已暂停', interrupted: '中断，需核验' };
const PAGE_SIZE = 50;
export class SyncHistoryModal extends Modal {
  private tasks = new Map<string, SyncHistoryTask>(); private selected = ''; private page = 0;
  private closed = false; private unsubscribe?: () => void; private timer?: ReturnType<typeof setInterval>;
  private select!: HTMLSelectElement; private search!: HTMLInputElement; private state!: HTMLSelectElement; private action!: HTMLSelectElement;
  private summary!: HTMLElement; private list!: HTMLElement; private paging!: HTMLElement; private warning!: HTMLElement;
  private previous!: HTMLButtonElement; private next!: HTMLButtonElement; private signature = '';
  private optionSignature = ''; private followLatest = true;
  private rows = new Map<string, { el: HTMLElement; path: HTMLElement; status: HTMLElement; reason: HTMLElement }>();
  private empty?: HTMLElement; private loadGeneration = 0;
  constructor(app: App, private history: SyncHistory) { super(app); }
  onClose(): void { this.closed = true; this.loadGeneration++; this.unsubscribe?.(); if (this.timer) clearInterval(this.timer); }
  onOpen(): void {
    this.titleEl.setText('同步记录 · 当前云端库 / 本设备'); this.contentEl.classList.add('vaultsail-history');
    this.contentEl.createEl('p', { text: '保留最近 30 次任务，每次最多 1000 条文件记录或 2 MiB。路径仅保存在本机，不含正文或凭据，不进入同步、配对和脱敏报告。记录是显示依据，实际恢复以同步日志核验为准。' });
    const controls = this.contentEl.createDiv({ cls: 'vaultsail-history-controls' });
    this.select = controls.createEl('select'); this.select.setAttribute('aria-label', '选择同步任务');
    this.select.addEventListener('change', () => { this.followLatest = false; this.selected = this.select.value; this.page = 0; this.render(); });
    const latest = controls.createEl('button', { text: '最新任务' }); latest.addEventListener('click', () => { this.followLatest = true; this.selected = ''; this.page = 0; this.render(); });
    const refresh = controls.createEl('button', { text: '刷新记录' }); refresh.addEventListener('click', () => { void this.load(); });
    const filters = this.contentEl.createDiv({ cls: 'vaultsail-history-controls' });
    this.search = filters.createEl('input'); this.search.type = 'search'; this.search.placeholder = '搜索文件路径'; this.search.setAttribute('aria-label', '搜索同步文件路径');
    this.search.addEventListener('input', () => { this.page = 0; this.render(); });
    this.state = filters.createEl('select'); this.state.setAttribute('aria-label', '按文件结果筛选');
    this.options(this.state, [['', '所有结果'], ...Object.entries(HISTORY_STATES)]);
    this.action = filters.createEl('select'); this.action.setAttribute('aria-label', '按同步动作筛选');
    this.options(this.action, [['', '所有动作'], ...Object.entries(HISTORY_ACTIONS)]);
    for (const filter of [this.state, this.action]) filter.addEventListener('change', () => { this.page = 0; this.render(); });
    this.warning = this.contentEl.createEl('p', { cls: 'vaultsail-history-warning' }); this.warning.setAttribute('role', 'status');
    this.summary = this.contentEl.createEl('p', { cls: 'vaultsail-history-summary' }); this.summary.setAttribute('role', 'status');
    this.list = this.contentEl.createDiv({ cls: 'vaultsail-history-list' });
    const footer = this.contentEl.createDiv({ cls: 'vaultsail-history-controls' });
    this.previous = footer.createEl('button', { text: '上一页' }); this.previous.addEventListener('click', () => { this.page--; this.render(); });
    this.paging = footer.createEl('span');
    this.next = footer.createEl('button', { text: '下一页' }); this.next.addEventListener('click', () => { this.page++; this.render(); });
    footer.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    this.unsubscribe = this.history.subscribe(() => this.signature = '');
    this.timer = setInterval(() => { if (!this.closed) this.render(); }, 500);
    this.render(); void this.load();
  }
  private options(select: HTMLSelectElement, options: string[][]): void { select.empty(); for (const [value, text] of options) { const option = select.createEl('option', { text }); option.value = value; } }
  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    try { const tasks = await this.history.list(); if (this.closed || generation !== this.loadGeneration) return; this.tasks = new Map(tasks.map(task => [task.id, task])); this.signature = ''; this.render(); }
    catch { if (!this.closed && generation === this.loadGeneration) this.warning.setText('读取本机记录失败，当前会话结果仍可查看；不会影响笔记同步。'); }
  }
  private render(): void {
    if (this.closed || !this.select) return;
    preserveInteraction(this.contentEl, () => this.update());
  }
  private update(): void {
    for (const task of this.history.snapshots()) this.tasks.set(task.id, task);
    const tasks = [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).slice(0, 30);
    if (this.followLatest || !tasks.some(task => task.id === this.selected)) this.selected = tasks[0]?.id ?? '';
    if (this.selected) this.followLatest = false;
    const task = tasks.find(task => task.id === this.selected);
    const signature = JSON.stringify([tasks.map(item => [item.id, item.sequence, item.status]), this.selected, this.page, this.search.value, this.state.value, this.action.value, task?.status === 'running' ? Math.floor(Date.now() / 1000) : 0, this.history.warning]);
    if (signature === this.signature) return; this.signature = signature;
    const options = tasks.map(item => [item.id, `${new Date(item.startedAt).toLocaleString()} · ${MODES[item.mode]} · ${TASK_STATES[item.status]}`]);
    const optionSignature = JSON.stringify(options);
    if (optionSignature !== this.optionSignature) {
      const present = new Map(Array.from(this.select.options).map(option => [option.value, option]));
      for (let index = 0; index < options.length; index++) {
        const [value, label] = options[index]; let option = present.get(value);
        if (!option) { option = this.select.createEl('option'); option.value = value; }
        if (option.textContent !== label) option.setText(label);
        if (this.select.children[index] !== option) this.select.insertBefore(option, this.select.children[index] ?? null);
        present.delete(value);
      }
      for (const option of present.values()) option.remove(); this.optionSignature = optionSignature;
    }
    if (this.select.value !== this.selected) this.select.value = this.selected;
    this.warning.setText(this.history.warning ? '部分本机记录读取或保存失败，当前会话仍可查看；重启后记录可能不完整。同步结果不因此改变。' : '');
    if (!this.empty) this.empty = this.list.createEl('p');
    if (!task) { for (const row of this.rows.values()) row.el.remove(); this.rows.clear(); this.empty.hidden = true; this.summary.setText('暂无同步记录，下一次执行同步后会在这里显示。'); this.paging.setText('0 条'); this.previous.disabled = this.next.disabled = true; return; }
    const elapsed = Math.max(0, ((task.status === 'running' ? Date.now() : task.endedAt ?? task.updatedAt) - task.startedAt) / 1000);
    const counts = new Map<string, number>(); for (const row of task.files) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
    const totals = [...counts].map(([state, count]) => `${HISTORY_STATES[state as keyof typeof HISTORY_STATES]} ${count}`).join(' · ');
    this.summary.setText(`${TASK_STATES[task.status]} · ${MODES[task.mode]} · ${task.status === 'interrupted' ? '截至最后记录' : '耗时'} ${elapsed.toFixed(1)} 秒${task.code ? ' · ' + HISTORY_CODES[task.code] : ''}\n${totals || '本轮没有文件动作，或在文件处理前已停止。'}${task.truncated ? '\n列表已截断：仅保留容量范围内的前 1000 条，以下统计不代表完整任务。' : ''}`);
    if (task.performance) this.summary.setText(this.summary.textContent + '\n' + formatScanSummary(task.performance));
    const query = this.search.value.toLocaleLowerCase();
    const files = task.files.filter(row => (!query || row.path.toLocaleLowerCase().includes(query)) && (!this.state.value || row.state === this.state.value) && (!this.action.value || row.action === this.action.value));
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(files.length / PAGE_SIZE) - 1)));
    this.empty.hidden = !!files.length; if (!files.length) this.empty.setText(task.files.length ? '没有符合当前筛选条件的文件。' : '没有文件条目；连接检查、扫描失败或无变化检查可只有任务记录。');
    const visible = files.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE), ids = new Set(visible.map(row => task.id + ':' + row.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.el.remove(); this.rows.delete(id); }
    for (let index = 0; index < visible.length; index++) {
      const row = visible[index], id = task.id + ':' + row.id; let elements = this.rows.get(id);
      if (!elements) { const el = this.list.createDiv({ cls: 'vaultsail-history-row' }); el.setAttribute('data-history-id', id); elements = { el, path: el.createEl('strong'), status: el.createEl('p'), reason: el.createEl('p') }; this.rows.set(id, elements); }
      if (this.list.children[index] !== elements.el) this.list.insertBefore(elements.el, this.list.children[index] ?? null);
      elements.el.setAttribute('data-state', row.state);
      const text = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.setText(value); };
      text(elements.path, row.path);
      text(elements.status, `${HISTORY_ACTIONS[row.action]} · ${HISTORY_STATES[row.state]} · ${formatBytes(row.size)} · ${new Date(row.updatedAt).toLocaleTimeString()}${row.startedAt !== undefined ? ` · ${Math.max(0, ((row.state === 'running' ? Date.now() : row.updatedAt) - row.startedAt) / 1000).toFixed(1)} 秒` : ''}`);
      text(elements.reason, HISTORY_REASONS[row.reason] + (row.code ? ' · ' + HISTORY_CODES[row.code] : '') + (row.diagnosticId ? ' · 诊断编号：' + row.diagnosticId : ''));
    }
    this.paging.setText(`筛选结果 ${files.length} 条 · 第 ${this.page + 1}/${Math.max(1, Math.ceil(files.length / PAGE_SIZE))} 页`);
    this.previous.disabled = this.page === 0; this.next.disabled = (this.page + 1) * PAGE_SIZE >= files.length;
  }
}
