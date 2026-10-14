import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, VaultSailSettingTab, type VaultSailSettings } from './settings';

export default class VaultSailPlugin extends Plugin {
  settings: VaultSailSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultSailSettingTab(this.app, this));

    this.addCommand({
      id: 'local-inventory-preview',
      name: 'Preview local vault file inventory (read-only)',
      callback: () => {
        const files = this.app.vault.getFiles();
        const byteCount = files.reduce((sum, f) => sum + f.stat.size, 0);
        const sizeMiB = (byteCount / (1024 * 1024)).toFixed(2);
        new Notice(`VaultSail: ${files.length} local files (${sizeMiB} MiB). No changes made.`, 8000);
      },
    });

    this.addRibbonIcon('cloud', 'VaultSail: inspect local vault', () => {
      const files = this.app.vault.getFiles();
      new Notice(`VaultSail starter: ${files.length} files found. Cloud sync is not yet enabled.`, 7000);
    });
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<VaultSailSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
