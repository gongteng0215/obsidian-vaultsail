import { Modal, Setting, type App } from 'obsidian';
import { verifyAcceptance } from '../acceptance/dataset';
import { copyText } from './config-modals';
import { storageAdapter } from '../platform/local-io';
import { safeMessage } from '../core/safety';

export class AcceptanceModal extends Modal {
  private closed = false;
  constructor(app: App, private version: string, private mobile: boolean, private save: (report: string) => Promise<string>) { super(app); }
  onClose(): void { this.closed = true; }
  onOpen(): void {
    this.closed = false; this.titleEl.setText('双端测试数据校验');
    this.contentEl.createEl('p', { text: '仅用于专用测试库。只读取固定验收数据并比较 SHA-256，不生成笔记、不发起同步。缺少测试标记时停止。请在首次互传后校验；编辑、改名及删除场景按验收清单单独记录。' });
    const status = this.contentEl.createEl('p', { text: '尚未开始校验。' }); status.setAttribute('role', 'status');
    const output = this.contentEl.createEl('textarea', { cls: 'vaultsail-report-source' }); output.readOnly = true; output.rows = 8; output.setAttribute('aria-label', '不含文件名的验收报告');
    let report = '', running = false;
    const actions = new Setting(this.contentEl);
    let copy!: { setDisabled(value: boolean): unknown }, save!: { setDisabled(value: boolean): unknown };
    actions.addButton(button => button.setButtonText('开始只读校验').setCta().onClick(async () => {
      if (running) return; running = true; button.setDisabled(true); copy.setDisabled(true); save.setDisabled(true);
      try {
        const adapter = storageAdapter(this.app);
        const value = await verifyAcceptance({ stat: p => adapter.stat(p), read: p => adapter.readBinary(p), list: p => adapter.list(p) }, this.version, this.mobile,
          (done, total) => { if (!this.closed) status.setText(`正在校验 ${done}/${total} 个文件…`); });
        if (this.closed) return;
        report = JSON.stringify(value, null, 2); output.value = report;
        status.setText(value.markerValid ? `文件 ${value.passedFiles}/${value.expectedFiles} · 空目录 ${value.passedDirectories}/${value.expectedDirectories}。报告只包含数量、固定失败分类及耗时。` : '未找到有效的专用测试标记，已停止。没有读取其他笔记。');
        copy.setDisabled(false); save.setDisabled(false);
      } catch (error) { if (!this.closed) status.setText(safeMessage(error)); }
      finally { running = false; if (!this.closed) button.setDisabled(false); }
    }));
    actions.addButton(button => { copy = button; button.setButtonText('复制验收报告').setDisabled(true).onClick(async () => { try { await copyText(report, output); } catch (error) { if (!this.closed) status.setText(safeMessage(error)); } }); });
    actions.addButton(button => { save = button; button.setButtonText('保存专项报告').setDisabled(true).onClick(async () => {
      button.setDisabled(true);
      try { await this.save(report); if (!this.closed) status.setText('专项报告已单独保存至插件导出目录，不受最近 30 次任务轮转影响。'); }
      catch (error) { if (!this.closed) status.setText(safeMessage(error)); }
      finally { if (!this.closed) button.setDisabled(false); }
    }); });
  }
}
