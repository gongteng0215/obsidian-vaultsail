import { Modal, Notice, Setting, type App } from 'obsidian';
import { record, safeMessage } from '../core/safety';
import { copyText } from './config-modals';
import { validateDiagnostic, type DiagnosticRecord } from '../diagnostics/log';

export class DiagnosticModal extends Modal {
  private generation = 0; private closed = false;
  constructor(app: App, private read: () => Promise<string>, private save: (report: string) => Promise<string>) { super(app); }
  onClose(): void { this.closed = true; this.generation++; }
  onOpen(): void {
    this.closed = false; this.titleEl.setText('排错日志 · 本设备');
    this.contentEl.createEl('p', { text: '自动记录任务阶段、错误原因链、调用位置、请求结果和恢复检查点。日志仅在本机滚动保存，最多 7 天、32 段（约 4 MiB）；失败和常规记录各保留 16 段，常规检查不挤掉失败记录。文件名使用匿名标识，不记录正文、账号、密钥、令牌、请求地址或响应正文。' });
    const status = this.contentEl.createEl('p'); status.setAttribute('role', 'status');
    const search = this.contentEl.createEl('input'); search.type = 'search'; search.placeholder = '筛选诊断编号或任务编号'; search.setAttribute('aria-label', '筛选排错记录');
    const list = this.contentEl.createDiv(); const source = this.contentEl.createEl('textarea', { cls: 'vaultsail-report-source' }); source.readOnly = true; source.rows = 6; source.setAttribute('aria-label', '脱敏排错日志');
    let report = '', loading = false;
    let rows: DiagnosticRecord[] = []; let copy!: { setDisabled(value: boolean): unknown }; let save!: { setDisabled(value: boolean): unknown };
    const scopes = { task: '任务', plugin: '插件', network: '百度请求', local: '本机读写', history: '同步记录', cache: '版本缓存', queue: '任务队列', engine: '文件传输', pairing: '设备配对' };
    const render = () => {
      list.empty(); const query = search.value.trim().toLowerCase();
      const failures = rows.filter(item => item.event === 'failure' && (!query || item.id.includes(query) || item.fields.taskId?.includes(query))).slice(-10).reverse();
      if (!failures.length) list.createEl('p', { text: query ? '没有匹配的失败记录。' : '保留范围内没有失败事件。旧版发生的错误无法补录原因。' });
      for (const failure of failures) {
        const details = list.createEl('details'); details.createEl('summary', { text: `${new Date(failure.at).toLocaleString()} · ${scopes[failure.scope]} · ${failure.errors?.[0]?.code ?? failure.fields.status ?? '结果异常'} · ${failure.id.slice(0, 8)}` });
        details.createEl('pre', { text: JSON.stringify(failure, null, 2), cls: 'vaultsail-report-record' });
      }
    };
    search.addEventListener('input', render);
    const update = async () => {
      const generation = ++this.generation; loading = true; copy.setDisabled(true); save.setDisabled(true); status.setText('正在异步读取本机日志…');
      try {
        const text = await this.read(); if (this.closed || generation !== this.generation) return;
        const parsed = record(JSON.parse(text));
        rows = (Array.isArray(parsed.records) ? parsed.records as unknown[] : []).map(validateDiagnostic).filter((row): row is DiagnosticRecord => row !== undefined);
        report = text; source.value = text; render(); copy.setDisabled(false); save.setDisabled(false);
        const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
        const dropped = count(parsed.dropped), unreadable = count(parsed.unreadableSegments), truncated = count(parsed.reportTruncated);
        status.setText(`已读取 ${rows.length} 条事件${parsed.storageFailed === true ? ' · 写盘失败，包含尚未保存的内存记录' : ''}${dropped ? ` · 缓冲区丢弃 ${dropped} 条` : ''}${unreadable ? ` · ${unreadable} 段记录无法读取` : ''}${truncated ? ` · 导出容量限制，省略 ${truncated} 条旧事件` : ''}。`);
      } catch (error) { if (!this.closed && generation === this.generation) status.setText(safeMessage(error)); }
      finally { loading = false; }
    };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('刷新日志').onClick(() => { if (!loading) void update(); }))
      .addButton(button => { copy = button; button.setButtonText('复制脱敏日志').setDisabled(true).onClick(async () => { if (!report) return; try { await copyText(report, source); } catch (error) { new Notice(safeMessage(error)); } }); })
      .addButton(button => { save = button; button.setButtonText('导出日志文件').setDisabled(true).onClick(async () => {
        if (!report) return; const generation = this.generation; button.setDisabled(true);
        try { const path = await this.save(report); if (!this.closed && generation === this.generation) status.setText('已导出：' + path + '。该目录已排除同步，可将此文件用于排查。'); }
        catch (error) { if (!this.closed && generation === this.generation) status.setText(safeMessage(error)); }
        finally { if (!this.closed) button.setDisabled(false); }
      }); })
      .addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
    void update();
  }
}
