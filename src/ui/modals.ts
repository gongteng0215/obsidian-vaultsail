import { Modal, Setting, type App } from 'obsidian';
import { safeMessage, VaultSailError } from '../core/safety';
import type { SyncPlan, PlanRow } from '../sync/engine';
import type { RemoteVault } from '../sync/remote-vault';
import { formatProgress, type SyncProgress } from '../sync/progress';
import { renderUploads } from './transfer-progress';

export class CloudVaultSetupModal extends Modal {
  constructor(app: App, private localName: string, private actions: {
    create: (name: string) => Promise<void>; list: () => Promise<RemoteVault[]>; bind: (id: string) => Promise<void>; roundtrip: () => Promise<void>;
  }) { super(app); }
  onOpen(): void {
    this.titleEl.setText('先选择一个云端知识库');
    this.contentEl.createEl('p', { text: '百度账号授权与云端库绑定是两步。应用目录只是存放位置；首次使用请创建新库，另一台设备请选择同一个已有库。' });
    let name = this.localName; let busy = false;
    const status = this.contentEl.createEl('p'); status.setAttribute('role', 'status');
    const controls: { setDisabled: (disabled: boolean) => unknown }[] = [];
    const perform = async (label: string, action: () => Promise<void>) => {
      if (busy) return;
      busy = true; controls.forEach(control => control.setDisabled(true)); status.setText(label);
      try { await action(); } catch (error) { status.setText(safeMessage(error)); }
      finally { busy = false; controls.forEach(control => control.setDisabled(false)); }
    };
    const done = () => { this.contentEl.empty(); this.contentEl.createEl('p', { text: '云端库已绑定。请先验证文件传输，再重新点击预览上传或预览下载。绑定不会自动传输笔记。' });
      const result = this.contentEl.createEl('p'); result.setAttribute('role', 'status');
      new Setting(this.contentEl).setName('验证上传下载权限').setDesc('已在本设备通过测试时，可以直接完成并重新预览。')
        .addButton(button => button.setButtonText('验证文件传输').onClick(() => new ConfirmModal(this.app, '验证文件传输权限', '将上传、下载约 24 MiB 独立校验数据，校验文件保留；不上传笔记。', async () => {
          button.setDisabled(true); result.setText('正在验证文件往返…');
          try { await this.actions.roundtrip(); result.setText('文件传输权限验证通过，可以重新预览传输。'); }
          catch (error) { result.setText(safeMessage(error)); throw error; }
          finally { button.setDisabled(false); }
        }).open()));
      new Setting(this.contentEl).addButton(button => button.setButtonText('完成').setCta().onClick(() => this.close())); };
    new Setting(this.contentEl).setName('第一次使用：创建新库')
      .addText(text => { controls.push(text); text.setValue(name).onChange(value => { name = value; }); })
      .addButton(button => { controls.push(button); button.setButtonText('创建并绑定').setCta().onClick(() => {
        if (busy) return;
        const requestedName = name;
        new ConfirmModal(this.app, '创建云端库', '将在当前应用目录下创建新库：' + requestedName, () => perform('正在创建并验证云端库…', async () => { await this.actions.create(requestedName); done(); })).open();
      }); });
    const list = this.contentEl.createDiv();
    new Setting(this.contentEl).setName('已有其他设备：选择已有库')
      .addButton(button => { controls.push(button); button.setButtonText('查看已有库').onClick(() => perform('正在读取云端库…', async () => {
        const vaults = await this.actions.list(); list.empty();
        status.setText(vaults.length ? '请选择要与本地笔记库配对的云端库。' : '当前目录下还没有云端库，请创建新库。');
        for (const vault of vaults) new Setting(list).setName(vault.displayName).setDesc(vault.vaultId)
          .addButton(bindButton => { controls.push(bindButton); bindButton.setDisabled(true).setButtonText('绑定此库').onClick(() => perform('正在验证并绑定…', async () => { await this.actions.bind(vault.vaultId); done(); })); });
      })); });
  }
}

const LABELS: Record<PlanRow['action'], string> = { upload: '上传', download: '下载', conflict: '冲突', skip: '跳过', noop: '无变化', 'delete-local': '移入本地回收区', 'delete-remote': '发布删除记录' };
export class ConfirmModal extends Modal {
  private controller = new AbortController();
  private pending = false;
  private committing = false;
  get saving(): boolean { return this.pending && this.committing; }
  constructor(app: App, private title: string, private description: string,
    private confirm: (report: (message: string) => void, control: { signal: AbortSignal; beginCommit: () => void }) => Promise<void>,
    private cancellable = false) { super(app); }
  close(): void { if (!this.saving) super.close(); }
  onClose(): void { this.controller.abort(); }
  onOpen(): void {
    this.titleEl.setText(this.title); this.contentEl.createEl('p', { text: this.description });
    const error = this.contentEl.createEl('p');
    error.setAttribute('role', 'status');
    let cancel: { setDisabled(value: boolean): unknown; setButtonText(value: string): unknown };
    const beginCommit = () => {
      if (this.controller.signal.aborted) throw new VaultSailError('cancelled', '操作已取消。');
      this.committing = true; cancel.setDisabled(true); cancel.setButtonText(this.cancellable ? '正在保存，请稍候' : '正在处理，请稍候');
    };
    new Setting(this.contentEl).addButton(button => { cancel = button; button.setButtonText('取消').onClick(() => this.close()); })
      .addButton(button => button.setButtonText('确认').setCta().onClick(async () => {
        if (this.pending) return;
        this.pending = true; button.setDisabled(true); error.setText('正在处理…');
        try {
          if (!this.cancellable) beginCommit();
          await this.confirm(message => error.setText(message), { signal: this.controller.signal, beginCommit });
          this.pending = false; this.committing = false; this.close();
        } catch (e) {
          error.setText(safeMessage(e)); this.pending = false; this.committing = false;
          button.setDisabled(false); cancel.setDisabled(false); cancel.setButtonText('取消');
        }
      }));
  }
}
export class PlanModal extends Modal {
  private unsubscribe?: () => void;
  constructor(app: App, private plan: SyncPlan, private execute: (progress: (done: number, total: number) => void) => Promise<void>, private resolve: (row: PlanRow, choice: string) => Promise<void>, private pause: () => void,
    private subscribe?: (listener: (progress: SyncProgress) => void) => () => void) { super(app); }
  onClose(): void { this.unsubscribe?.(); }
  onOpen(): void {
    this.titleEl.setText('VaultSail · 传输预览');
    const changed = this.plan.rows.filter(row => row.action !== 'noop');
    const blocked = this.plan.rows.filter(row => row.blocked).length;
    this.contentEl.createEl('p', { text: `${this.plan.rows.length} 个文件，${changed.length} 项待处理${blocked ? `，其中 ${blocked} 项超限或关联保护将跳过，不会传输` : ''}。冲突会自动保留双方副本；下面的内容选择是可选的统一版本操作。` });
    const status = this.contentEl.createEl('p', { cls: 'vaultsail-progress-text' }); status.setAttribute('role', 'status');
    const meter = this.contentEl.createEl('progress', { cls: 'vaultsail-progress-meter' }); meter.max = Math.max(1, this.plan.rows.length); meter.value = 0;
    meter.setAttribute('aria-label', '文件处理进度');
    const uploads = this.contentEl.createDiv({ cls: 'vaultsail-upload-progress' });
    let executing = false;
    if (this.subscribe) this.unsubscribe = this.subscribe(progress => { if (executing) { status.setText(formatProgress(progress)); meter.max = Math.max(1, progress.totalFiles); meter.value = progress.doneFiles; renderUploads(uploads, progress); } });
    const list = this.contentEl.createDiv({ cls: 'vaultsail-plan' });
    for (const row of changed) {
      const item = list.createDiv({ cls: 'vaultsail-plan-row' });
      item.createEl('strong', { text: `${LABELS[row.action]} · ${row.path}` }); item.createEl('p', { text: row.reason });
      if (row.action === 'conflict') {
        const choices: Record<string, string> = {}; if (row.localHash) choices.local = '保留本地内容';
        for (const head of row.heads) if (head.kind === 'update') choices[head.opId] = '采用远端 · ' + head.deviceId.slice(0, 8) + ' · ' + head.opId.slice(0, 8);
        let choice = Object.keys(choices)[0];
        if (choice) new Setting(item).setDesc('执行前保存所有竞争版本的恢复副本；处理后需要重新预览。')
          .addDropdown(dropdown => dropdown.addOptions(choices).onChange(value => { choice = value; }))
          .addButton(button => button.setButtonText('可选：统一为所选版本').onClick(() => new ConfirmModal(this.app, '确认统一内容版本', row.path + '：保留所有版本副本后应用所选内容。', async () => { await this.resolve(row, choice); this.close(); }).open()));
      }
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText('关闭').onClick(() => this.close()))
      .addButton(button => button.setButtonText('暂停任务').onClick(() => { this.pause(); status.setText('暂停请求已提交，等待当前请求结束。'); }))
      .addButton(button => button.setButtonText('执行清单（冲突自动保留双方）').setCta().onClick(async () => {
        button.setDisabled(true); executing = true;
        try { await this.execute((done, total) => { if (!this.subscribe) status.setText(`已处理 ${done}/${total}`); }); status.setText(status.textContent + (blocked ? `\n部分完成：${blocked} 项未传输，原文件与基线保留。` : '\n执行完成；冲突副本可在 VaultSail-conflicts 查看。')); }
        catch (e) { status.setText(status.textContent + '\n' + safeMessage(e)); }
        finally { executing = false; button.setDisabled(false); }
      }));
  }
}
