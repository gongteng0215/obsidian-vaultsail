import { Modal, Notice, Setting, type App } from 'obsidian';
import { parsePortableConfig } from '../portable-config';
import { safeMessage, VaultSailError } from '../core/safety';
import { ConfirmModal } from './modals';

export async function copyText(text: string, input?: HTMLTextAreaElement): Promise<void> {
  try { await navigator.clipboard.writeText(text); new Notice('已复制。'); }
  catch { input?.focus(); input?.select(); new Notice('无法自动复制，请长按文本选择并复制。'); }
}
export class ConfigExportModal extends Modal {
  constructor(app: App, private text: string, private save: () => Promise<string>) { super(app); }
  onOpen(): void {
    this.titleEl.setText('导出到另一台设备');
    this.contentEl.createEl('p', { text: '包含 AppKey、应用目录和云端库配对信息。密钥、令牌、设备身份与任务记录不在文件中；iPad 需保存自己的 SecretKey 并独立授权。' });
    const input = this.contentEl.createEl('textarea', { cls: 'vaultsail-config-text' }); input.value = this.text; input.readOnly = true; input.rows = 12; input.setAttribute('aria-label', '可复制的配对配置');
    const result = this.contentEl.createEl('p'); result.setAttribute('role', 'status');
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('复制配置').onClick(() => copyText(this.text, input)))
      .addButton(button => button.setButtonText('保存配置文件到库').setCta().onClick(async () => {
        button.setDisabled(true);
        try { const path = await this.save(); result.setText('已保存：' + path + '。可通过文件或 AirDrop 传到 iPad。此目录已排除同步。'); }
        catch (error) { result.setText(safeMessage(error)); }
        finally { button.setDisabled(false); }
      }));
  }
}
export class ConfigImportModal extends Modal {
  constructor(app: App, private apply: (text: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText('导入配对配置');
    this.contentEl.createEl('p', { text: '选择另一设备导出的 JSON 文件，或粘贴配置。导入后需在本设备授权、验证云端库及文件权限，随后预览下载。' });
    const file = this.contentEl.createEl('input'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', '选择配对配置文件');
    const input = this.contentEl.createEl('textarea', { cls: 'vaultsail-config-text' }); input.rows = 10; input.placeholder = '也可以在这里粘贴配对配置'; input.setAttribute('aria-label', '粘贴配对配置');
    const summary = this.contentEl.createEl('p'); summary.setAttribute('role', 'status');
    const update = () => {
      try { const config = parsePortableConfig(input.value); summary.setText(`百度网盘 · ${config.appDirectory}\n云端库：${config.remoteVault?.displayName || '未指定'}${config.remoteVault ? ' · ' + config.remoteVault.id : ''}`); button.setDisabled(false); }
      catch (error) { summary.setText(input.value ? safeMessage(error) : '请先选择文件或粘贴配置。'); button.setDisabled(true); }
    };
    let reading = 0;
    file.addEventListener('change', () => { const generation = ++reading; const selected = file.files?.[0]; if (!selected) return;
      button.setDisabled(true);
      void (async () => {
        try {
          if (selected.size > 64 * 1024) throw new VaultSailError('configuration', '配置文件过大，请选择 VaultSail 导出的配对配置。');
          const text = await selected.text(); if (generation !== reading) return; input.value = text; update();
        } catch (error) { if (generation === reading) { input.value = ''; summary.setText(safeMessage(error)); button.setDisabled(true); } }
      })();
    });
    input.addEventListener('input', () => { reading++; update(); });
    let button: { setDisabled: (value: boolean) => unknown };
    new Setting(this.contentEl).addButton(control => { button = control; control.setButtonText('检查并导入').setCta().setDisabled(true).onClick(() => {
      const text = input.value;
      try {
        const config = parsePortableConfig(text);
        new ConfirmModal(this.app, '确认导入配置', `将替换当前应用配置和云端目标，停止旧任务并断开本地授权。目标：${config.remoteVault?.displayName || config.appDirectory}。笔记内容保留，需重新授权。`, async () => { await this.apply(text); this.close(); }).open();
      } catch (error) { summary.setText(safeMessage(error)); }
    }); });
  }
}
