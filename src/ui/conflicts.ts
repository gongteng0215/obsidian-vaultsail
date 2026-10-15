import { App, Modal, Notice, Setting } from 'obsidian';
import { bytes, hash, safeMessage, VaultSailError } from '../core/safety';
import type { ConflictDetails, PlanRow } from '../sync/engine';
import type { ConflictDrafts, ConflictDraft } from '../platform/conflict-drafts';
import { ConfirmModal } from './modals';
interface ConflictActions {
  list(): Promise<PlanRow[]>; details(row: PlanRow): Promise<ConflictDetails>;
  resolve(row: PlanRow, choice: string, data?: ArrayBuffer): Promise<void>;
  both(row: PlanRow, other: string, path: string, primary: string): Promise<void>; drafts: ConflictDrafts;
  deletionEnabled: boolean; remove(row: PlanRow): Promise<void>;
}
export class ConflictInbox extends Modal {
  private actions: ConflictActions;
  constructor(app: App, actions: ConflictActions) { super(app); this.actions = actions; }
  onOpen(): void { this.titleEl.setText('待解决冲突'); void this.reload(); }
  private async reload(): Promise<void> {
    this.contentEl.empty(); const status = this.contentEl.createEl('p', { text: '正在核验冲突…' });
    try {
      const rows = await this.actions.list(); if (!this.containerEl.isConnected) return;
      status.setText(rows.length ? `${rows.length} 个文件待处理，其他独立文件可继续同步。` : '没有待解决冲突。');
      for (const row of rows) new Setting(this.contentEl).setName(row.path).setDesc(`${row.heads.length} 个云端分支 · ${row.reason}`)
        .addButton(button => button.setButtonText('对比与解决').onClick(async () => {
          button.setDisabled(true);
          try { const details = await this.actions.details(row); if (this.containerEl.isConnected) new ConflictEditor(this.app, details, this.actions, () => { void this.reload(); }).open(); }
          catch (error) { new Notice(safeMessage(error)); } finally { button.setDisabled(false); }
        }));
      new Setting(this.contentEl).addButton(button => button.setButtonText('刷新').onClick(() => { void this.reload(); }));
    } catch (error) { status.setText(safeMessage(error)); }
  }
}
class ConflictEditor extends Modal {
  private details: ConflictDetails; private actions: ConflictActions; private done: () => void;
  private draft!: ConflictDraft; private saveTask: Promise<void> = Promise.resolve(); private saving?: ReturnType<typeof setTimeout>; private closed = false;
  private committing = false;
  constructor(app: App, details: ConflictDetails, actions: ConflictActions, done: () => void) { super(app); this.details = details; this.actions = actions; this.done = done; }
  onOpen(): void { this.titleEl.setText('解决冲突 · ' + this.details.row.path); void this.render().catch(error => this.contentEl.createEl('p', { text: safeMessage(error) })); }
  close(): void { if (!this.committing) super.close(); }
  onClose(): void { this.closed = true; if (this.saving) clearTimeout(this.saving); if (this.draft) void this.save().catch(error => new Notice(safeMessage(error))); }
  private fingerprint(): string { return hash(bytes(JSON.stringify([this.details.row.localHash, this.details.row.heads.map(head => head.opId).sort()]))); }
  private async save(): Promise<void> { if (this.draft) this.saveTask = this.actions.drafts.save(this.details.row.path, structuredClone(this.draft)); await this.saveTask; }
  private changed(): void { if (this.saving) clearTimeout(this.saving); this.saving = setTimeout(() => { void this.save().catch(error => new Notice(safeMessage(error))); }, 300); }
  private async render(): Promise<void> {
    const d = this.details, old = await this.actions.drafts.load(d.row.path); if (this.closed) return;
    this.draft = old?.fingerprint === this.fingerprint() ? old : { version: 1, fingerprint: this.fingerprint(), text: d.merge?.text ?? d.local ?? d.versions.find(version => version.text !== undefined)?.text ?? '', blocks: {} };
    this.contentEl.createEl('p', { text: '确认后生成引用全部已知分支的解决版本，原内容保留在历史中。窗口关闭时保存本机草稿。' });
    if (d.row.renameConflict) this.contentEl.createEl('p', { text: '这是并发重命名。确认后最终路径为：' + d.row.path + '。其他路径记录将退役，本地旧文件的移除仍受删除传播开关控制。需要另一文件名时，请关闭并打开对应路径的冲突项。' });
    if (old && old.fingerprint !== this.fingerprint()) {
      this.contentEl.createEl('p', { text: '发现基于旧版本的草稿，当前文件已有变化。旧草稿在下方保留供复制，请按最新内容重新核对。' });
      const previous = this.contentEl.createEl('textarea', { cls: 'vaultsail-merge-editor' }); previous.value = old.text; previous.readOnly = true; previous.setAttribute('aria-label', '旧版本合并草稿');
    }
    let view = 'local'; const tabs = this.contentEl.createDiv({ cls: 'vaultsail-merge-tabs' }); const source = this.contentEl.createEl('pre', { cls: 'vaultsail-merge-source' });
    const values = new Map<string, string>([['local', d.local ?? '本地没有可预览的小型 UTF-8 文本。'], ['base', d.base ?? '没有可用的唯一共同祖先。']]);
    d.versions.forEach(version => values.set(version.id, version.text ?? '此版本为删除记录、二进制或超出文本预览上限，可选择完整内容版本。'));
    for (const [id, label] of [['local', '本机'], ['base', '共同祖先'], ...d.versions.map(version => [version.id, version.label])]) {
      const tab = tabs.createEl('button', { text: label }); tab.addEventListener('click', () => { view = id; source.setText(values.get(view)!); });
    }
    source.setText(values.get(view)!);
    const choices: Record<string, string> = {};
    if (d.row.localHash !== null) choices.local = '本机当前内容';
    for (const version of d.versions) if (d.row.heads.find(head => head.opId === version.id)?.kind === 'update') choices[version.id] = version.label;
    let selected = Object.keys(choices)[0], other = Object.keys(choices).find(choice => choice !== selected) ?? selected;
    const error = this.contentEl.createEl('p'); error.setAttribute('role', 'status');
    const run = async (operation: () => Promise<void>) => {
      this.committing = true;
      const controls = Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button,input,textarea,select')); controls.forEach(control => { control.disabled = true; });
      try { await this.save(); await operation(); this.committing = false; this.close(); this.done(); }
      catch (failure) { error.setText(safeMessage(failure)); }
      finally { this.committing = false; controls.forEach(control => { control.disabled = false; }); }
    };
    if (selected) new Setting(this.contentEl).setName('采用一个完整版本').setDesc('其他版本保留在历史中。')
      .addDropdown(dropdown => dropdown.addOptions(choices).setValue(selected).onChange(value => { selected = value; }))
      .addButton(button => button.setButtonText('采用所选版本').onClick(() => new ConfirmModal(this.app, '确认解决冲突', '核验最新内容并采用所选版本。', () => run(() => this.actions.resolve(d.row, selected))).open()));
    const editable = d.local !== undefined || d.versions.some(version => version.text !== undefined);
    if (editable) {
      this.contentEl.createEl('h3', { text: '逐块处理与合并草稿' });
      const editor = this.contentEl.createEl('textarea', { cls: 'vaultsail-merge-editor' }); editor.setAttribute('aria-label', '合并结果'); editor.value = this.draft.text;
      const chunks = d.merge?.chunks; const unresolved = () => chunks?.some((chunk, index) => chunk.kind === 'conflict' && !Object.hasOwn(this.draft.blocks, String(index))) ?? false;
      let confirmButton: { setDisabled(value: boolean): unknown } | undefined;
      const compose = () => { if (chunks) { this.draft.text = chunks.map((chunk, index) => chunk.kind === 'text' ? chunk.text : this.draft.blocks[String(index)] ?? chunk.local).join(''); editor.value = this.draft.text; } confirmButton?.setDisabled(unresolved()); this.changed(); };
      chunks?.forEach((chunk, index) => {
        if (chunk.kind !== 'conflict') return;
        const block = this.contentEl.createDiv({ cls: 'vaultsail-merge-block' }); block.createEl('strong', { text: `冲突块 ${index + 1}` });
        block.createEl('pre', { text: `原始：\n${chunk.base}\n${d.mergeLabels?.[0] ?? '分支一'}：\n${chunk.local}\n${d.mergeLabels?.[1] ?? '分支二'}：\n${chunk.remote}` });
        for (const [label, text] of [['采用第一段', chunk.local], ['采用第二段', chunk.remote], ['两段都保留', chunk.local + chunk.remote]]) {
          const button = block.createEl('button', { text: label }); button.addEventListener('click', () => {
            if (this.draft.manual) { error.setText('全文已有手动修改，请继续编辑全文并确认，逐块重建已暂停以保护草稿。'); return; }
            this.draft.blocks[String(index)] = text; compose();
          });
        }
      });
      editor.addEventListener('input', () => { this.draft.text = editor.value; this.draft.manual = true; this.changed(); });
      if (unresolved()) new Setting(this.contentEl).setDesc('手动编辑全文后，可明确确认已处理所有冲突块。')
        .addButton(button => button.setButtonText('全文已手动合并').onClick(() => { chunks?.forEach((chunk, index) => { if (chunk.kind === 'conflict') this.draft.blocks[String(index)] ??= ''; }); confirmButton?.setDisabled(false); this.changed(); }));
      new Setting(this.contentEl).addButton(button => { confirmButton = button; button.setButtonText('确认解决并同步').setCta().setDisabled(unresolved()).onClick(() => new ConfirmModal(this.app, '确认合并结果', '重新核验所有版本，保存恢复点后发布合并结果。', () => run(async () => {
        if (unresolved()) throw new VaultSailError('conflict', '请先处理全部冲突块。');
        await this.actions.resolve(d.row, 'merged', bytes(this.draft.text));
      })).open()); });
    }
    if (!d.row.renameConflict && Object.keys(choices).length >= 2) {
      let path = d.row.path.replace(/(\.[^/.]+)?$/, '（另一版）$1');
      new Setting(this.contentEl).setName('保留为两篇').setDesc('当前所选完整版本留在原路径，另一版本作为普通文件同步。')
        .addDropdown(dropdown => dropdown.addOptions(choices).setValue(other).onChange(value => { other = value; }))
        .addText(text => text.setValue(path).onChange(value => { path = value; }))
        .addButton(button => button.setButtonText('保留两篇并解决').onClick(() => new ConfirmModal(this.app, '确认保留两篇', '新文件：' + path, () => run(() => this.actions.both(d.row, other, path, selected))).open()));
    }
    if (this.actions.deletionEnabled && !d.row.renameConflict && (d.row.localHash === null || d.row.heads.some(head => head.kind === 'delete')))
      new Setting(this.contentEl).setName('采用删除结果').setDesc('保存竞争内容的恢复点和历史，明确发布解决后的删除记录。')
        .addButton(button => button.setButtonText('确认删除这篇笔记').onClick(() => new ConfirmModal(this.app, '确认删除', d.row.path + '：将保留全部版本后删除，并传播到开启删除同步的设备。', () => run(() => this.actions.remove(d.row))).open()));
  }
}
