import { Modal, Notice, Setting, type App } from 'obsidian';
import { parsePortableConfig } from '../portable-config';
import { decryptPairing, isEncryptedPairing, PAIRING_MAX_BYTES, validatePairingCode } from '../encrypted-pairing';
import { safeMessage, VaultSailError } from '../core/safety';
import { ConfirmModal } from './modals';

function disableTextCorrections(input: HTMLInputElement | HTMLTextAreaElement): void {
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
}

export async function copyText(text: string, input?: HTMLTextAreaElement): Promise<void> {
  try { await navigator.clipboard.writeText(text); new Notice('已复制。'); }
  catch { input?.focus(); input?.select(); new Notice('无法自动复制，请长按文本选择并复制。'); }
}
export class ConfigExportModal extends Modal {
  private generation = 0;
  constructor(app: App, private generate: (password: string) => Promise<string>, private save: (text: string) => Promise<string>) { super(app); }
  onOpen(): void {
    this.titleEl.setText('把连接带到 iPad');
    this.contentEl.classList.add('vaultsail-pairing');
    this.contentEl.createEl('p', { text: '把应用密钥、百度授权和云端库一起加密。iPad 导入后自动验证连接，授权有效时无需重复登录。配对码 24 小时内可用。' });
    const label = this.contentEl.createEl('label', { text: '设置配对密码（至少 10 个字符）' });
    const password = this.contentEl.createEl('input'); password.type = 'password'; password.autocomplete = 'new-password'; password.setAttribute('aria-label', '设置配对密码'); label.appendChild(password);
    const repeatLabel = this.contentEl.createEl('label', { text: '再次输入密码' });
    const repeat = this.contentEl.createEl('input'); repeat.type = 'password'; repeat.autocomplete = 'new-password'; repeat.setAttribute('aria-label', '确认配对密码'); repeatLabel.appendChild(repeat);
    disableTextCorrections(password); disableTextCorrections(repeat);
    this.contentEl.createEl('p', { text: '密码不写入配置或文件。拿到配对码和密码的人可以使用其中的网盘授权，请只交给你自己的设备。' });
    const input = this.contentEl.createEl('textarea', { cls: 'vaultsail-config-text' }); input.readOnly = true; input.rows = 6; input.placeholder = '生成后在这里显示加密配对码'; input.setAttribute('aria-label', '加密配对码');
    disableTextCorrections(input);
    const result = this.contentEl.createEl('p'); result.setAttribute('role', 'status');
    let code = ''; let pending = false; let copy!: { setDisabled(value: boolean): unknown }; let save!: { setDisabled(value: boolean): unknown };
    const invalidate = () => { this.generation++; code = ''; input.value = ''; copy.setDisabled(true); save.setDisabled(true); result.setText('密码已更改，请重新生成配对码。'); };
    password.addEventListener('input', invalidate); repeat.addEventListener('input', invalidate);
    new Setting(this.contentEl).addButton(button => button.setButtonText('生成加密配对码').setCta().onClick(async () => {
      if (pending) return;
      if (password.value !== repeat.value) { result.setText('两次输入的密码不一致。'); return; }
      const generation = ++this.generation; pending = true; code = ''; input.value = ''; copy.setDisabled(true); save.setDisabled(true);
      button.setDisabled(true); result.setText('正在验证电脑连接并加密…');
      try {
        const generated = await this.generate(password.value); if (generation !== this.generation) return;
        code = generated; input.value = code; copy.setDisabled(false); save.setDisabled(false);
        result.setText('配对码已生成。复制到 iPad，输入刚才的密码即可连接。');
      } catch (error) { if (generation === this.generation) result.setText(safeMessage(error)); }
      finally { pending = false; button.setDisabled(false); }
    }));
    new Setting(this.contentEl)
      .addButton(button => { copy = button; button.setButtonText('复制配对码').setDisabled(true).onClick(() => { if (code) void copyText(code, input); }); })
      .addButton(button => { save = button; button.setButtonText('保存加密文件到库').setDisabled(true).onClick(async () => {
        const generation = this.generation; const text = code; if (!text) return; button.setDisabled(true);
        try { const path = await this.save(text); if (generation === this.generation) result.setText('已保存：' + path + '。可通过文件或 AirDrop 传到 iPad；此目录已排除同步。'); }
        catch (error) { if (generation === this.generation) result.setText(safeMessage(error)); }
        finally { button.setDisabled(!code); }
      }); });
    new Setting(this.contentEl).addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
  }
  onClose(): void { this.generation++; this.contentEl.empty(); }
}
export class ConfigImportModal extends Modal {
  private generation = 0;
  constructor(app: App, private apply: (text: string, password?: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText('导入电脑连接');
    this.contentEl.classList.add('vaultsail-pairing');
    this.contentEl.createEl('p', { text: '选择加密文件或粘贴配对码，输入导出时设置的密码。验证成功后即可同步，无需重新填写应用信息或网页登录。' });
    const file = this.contentEl.createEl('input'); file.type = 'file'; file.accept = '.vaultsail,.txt,.json,text/plain,application/json'; file.setAttribute('aria-label', '选择配对配置文件');
    const input = this.contentEl.createEl('textarea', { cls: 'vaultsail-config-text' }); input.rows = 6; input.placeholder = 'VSAIL:1:…（也支持旧版 JSON 配对配置）'; input.setAttribute('aria-label', '粘贴配对配置');
    const password = this.contentEl.createEl('input'); password.type = 'password'; password.autocomplete = 'off'; password.placeholder = '导出时的配对密码'; password.setAttribute('aria-label', '输入配对密码');
    disableTextCorrections(input); disableTextCorrections(password); input.setAttribute('autocomplete', 'off');
    const summary = this.contentEl.createEl('p'); summary.setAttribute('role', 'status');
    let button!: { setDisabled(value: boolean): unknown }; let pending = false;
    const update = () => {
      this.generation++;
      try {
        if (isEncryptedPairing(input.value)) { validatePairingCode(input.value); password.disabled = false; summary.setText('检测到加密连接，输入密码后检查。'); button.setDisabled(pending || !password.value); }
        else {
          const config = parsePortableConfig(input.value); password.disabled = true;
          summary.setText(`旧版配对配置 · ${config.appDirectory}\n云端库：${config.remoteVault?.displayName || '未指定'}。旧版文件没有授权，导入后仍需登录。`); button.setDisabled(pending);
        }
      } catch (error) { password.disabled = false; summary.setText(input.value ? safeMessage(error) : '请先选择文件或粘贴配对码。'); button.setDisabled(true); }
    };
    file.addEventListener('change', () => {
      const generation = ++this.generation; const selected = file.files?.[0]; if (!selected) return; button.setDisabled(true);
      void (async () => {
        try {
          if (selected.size > PAIRING_MAX_BYTES) throw new VaultSailError('configuration', '配置文件过大，请选择 VaultSail 导出的文件。');
          const text = await selected.text(); if (generation !== this.generation) return; input.value = text; update();
        } catch (error) { if (generation === this.generation) { input.value = ''; summary.setText(safeMessage(error)); button.setDisabled(true); } }
      })();
    });
    input.addEventListener('input', update); password.addEventListener('input', update);
    new Setting(this.contentEl).addButton(control => {
      button = control; control.setButtonText('检查并导入').setCta().setDisabled(true).onClick(async () => {
        if (pending) return;
        const text = input.value; const pass = password.value; const generation = ++this.generation;
        pending = true; control.setDisabled(true); summary.setText('正在检查配置…');
        try {
          const encrypted = isEncryptedPairing(text);
          const config = encrypted ? (await decryptPairing(text, pass)).config : parsePortableConfig(text);
          if (generation !== this.generation) return;
          summary.setText(`云端库：${config.remoteVault?.displayName || config.appDirectory}`);
          new ConfirmModal(this.app, '确认导入连接', encrypted
            ? `连接到「${config.remoteVault!.displayName}」。将自动验证账号、云端库并上传下载 1 KB 隔离校验文件；通过后替换原连接，可直接同步。现有笔记保留，删除同步关闭。`
            : `将替换当前应用配置和云端目标。旧版文件未包含授权，需在本设备重新登录。目标：${config.remoteVault?.displayName || config.appDirectory}。`,
          async () => {
            if (generation !== this.generation) throw new VaultSailError('cancelled', '输入已更改，请重新检查后导入。');
            await this.apply(text, encrypted ? pass : undefined); this.close();
          }).open();
        } catch (error) { if (generation === this.generation) summary.setText(safeMessage(error)); }
        finally { pending = false; if (generation === this.generation) control.setDisabled(false); }
      });
    });
    new Setting(this.contentEl).addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
  }
  onClose(): void { this.generation++; this.contentEl.empty(); }
}
