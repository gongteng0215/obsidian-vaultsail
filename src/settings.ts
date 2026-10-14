import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { BaiduProbeError, BaiduReadOnlyApi } from './providers/baidu-api';
import type VaultSailPlugin from './main';

export interface VaultSailSettings {
  /** Local Vault binds to an explicit remote Vault ID; never reuse a different Vault's identifier. */
  providerId: 'none' | 'baidu';
  remoteVaultId: string;
}
export const DEFAULT_SETTINGS: VaultSailSettings = {
  providerId: 'none',
  remoteVaultId: '',
};

export class VaultSailSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultSailPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Cloud storage')
      .setDesc('Provider integration has not been implemented yet. Settings only; no files are uploaded or downloaded.')
      .addDropdown(dropdown => dropdown
        .addOption('none', 'Not configured')
        .addOption('baidu', 'Baidu Netdisk (planned)')
        .setValue(this.plugin.settings.providerId)
        .onChange(async value => {
          this.plugin.settings.providerId = value as VaultSailSettings['providerId'];
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Remote vault identifier')
      .setDesc('Use a distinct, stable ID for each remote knowledge base. This is saved locally and not connected to a cloud yet.')
      .addText(text => text
        .setPlaceholder('e.g. ai-research')
        .setValue(this.plugin.settings.remoteVaultId)
        .onChange(async value => {
          this.plugin.settings.remoteVaultId = value.trim();
          await this.plugin.saveSettings();
        }));
    // D0 credential is deliberately transient: never saved by Plugin.loadData()/saveData().
    let temporaryToken = '';
    let temporaryDirectory = '/apps/VaultSail';
    let tokenElement: HTMLInputElement | undefined;
    new Setting(containerEl)
      .setName('D0: temporary Baidu access token')
      .setDesc('Read-only API probe only. Token is kept in memory until the test finishes. Do not enter an App Secret.')
      .addText(text => {
        tokenElement = text.inputEl;
        text.inputEl.type = 'password';
        text.setPlaceholder('Temporary access token (not saved)')
          .onChange(value => { temporaryToken = value.trim(); });
      });
    new Setting(containerEl)
      .setName('D0: app test directory')
      .setDesc('Only an authorized isolated directory under /apps/<app-name> may be scanned.')
      .addText(text => text.setValue(temporaryDirectory)
        .onChange(value => { temporaryDirectory = value.trim(); }));
    new Setting(containerEl)
      .setName('D0: test API access (read-only)')
      .setDesc('Performs user-info and directory listing requests. Never uploads, downloads, overwrites or deletes files.')
      .addButton(button => button.setButtonText('Check access').onClick(async () => {
        if (!temporaryToken) { new Notice('VaultSail: a temporary token is required.'); return; }
        button.setDisabled(true);
        const api = new BaiduReadOnlyApi(async url => {
          const response = await requestUrl({ url, method: 'GET', throw: false });
          if (response.status < 200 || response.status >= 300) throw new Error('HTTP request failed');
          return response.json;
        });
        try {
          await api.testAccess(temporaryToken);
          const result = await api.listUpTo(temporaryToken, temporaryDirectory, 5);
          if (!result.complete) {
            new Notice('VaultSail: partial remote listing; NOT verified complete. No changes made.', 9000);
          } else {
            new Notice(`VaultSail: read-only API success, ${result.files.length} items. No changes made.`, 9000);
          }
        } catch (error) {
          const message = error instanceof BaiduProbeError ? error.message : 'Baidu probe failed (sanitized).';
          new Notice(`VaultSail: ${message}`, 9000);
        } finally {
          temporaryToken = '';
          if (tokenElement) tokenElement.value = '';
          button.setDisabled(false);
        }
      }));
    new Setting(containerEl)
      .setName('Safety status')
      .setDesc('Starter build: read-only inventory only. Sync, OAuth, deletion and background operations are disabled.');
  }
}
