import { Modal, Setting, type App } from 'obsidian';
import { safeMessage } from '../core/safety';
import type { SyncPlan, PlanRow } from '../sync/engine';

const LABELS: Record<PlanRow['action'], string> = { upload: '上传', download: '下载', conflict: '冲突', skip: '跳过', noop: '无变化', 'delete-local': '移入本地回收区', 'delete-remote': '发布删除记录' };
export class ConfirmModal extends Modal {
  constructor(app: App, private title: string, private description: string, private confirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.title); this.contentEl.createEl('p', { text: this.description });
    const error = this.contentEl.createEl('p');
    new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('确认').setCta().onClick(async () => {
        button.setDisabled(true); try { await this.confirm(); this.close(); } catch (e) { error.setText(safeMessage(e)); button.setDisabled(false); }
      }));
  }
}
export class PlanModal extends Modal {
  constructor(app: App, private plan: SyncPlan, private execute: (progress: (done: number, total: number) => void) => Promise<void>, private resolve: (row: PlanRow, choice: string) => Promise<void>, private pause: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('VaultSail · 传输预览');
    const changed = this.plan.rows.filter(row => row.action !== 'noop');
    this.contentEl.createEl('p', { text: `${this.plan.rows.length} 个文件，${changed.length} 项变化。冲突项不会自动执行。` });
    const status = this.contentEl.createEl('p'); const list = this.contentEl.createDiv({ cls: 'vaultsail-plan' });
    for (const row of changed) {
      const item = list.createDiv({ cls: 'vaultsail-plan-row' });
      item.createEl('strong', { text: `${LABELS[row.action]} · ${row.path}` }); item.createEl('p', { text: row.reason });
      if (row.action === 'conflict') {
        const choices: Record<string, string> = {}; if (row.localHash) choices.local = '保留本地内容';
        for (const head of row.heads) if (head.kind === 'update') choices[head.opId] = '采用远端 · ' + head.deviceId.slice(0, 8) + ' · ' + head.opId.slice(0, 8);
        let choice = Object.keys(choices)[0];
        if (choice) new Setting(item).setDesc('执行前保存所有竞争版本的恢复副本；处理后需要重新预览。')
          .addDropdown(dropdown => dropdown.addOptions(choices).onChange(value => { choice = value; }))
          .addButton(button => button.setButtonText('处理冲突').onClick(() => new ConfirmModal(this.app, '确认处理冲突', row.path + '：保留所有版本副本后应用所选内容。', async () => { await this.resolve(row, choice); this.close(); }).open()));
      }
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText('关闭').onClick(() => this.close()))
      .addButton(button => button.setButtonText('暂停任务').onClick(() => { this.pause(); status.setText('暂停请求已提交，等待当前请求结束。'); }))
      .addButton(button => button.setButtonText('执行预览中的非冲突操作').setCta().onClick(async () => {
        button.setDisabled(true); try { await this.execute((done, total) => status.setText(`已处理 ${done}/${total}`)); status.setText('执行完成；冲突和跳过项保留。请重新预览。'); }
        catch (e) { status.setText(safeMessage(e)); }
      }));
  }
}
