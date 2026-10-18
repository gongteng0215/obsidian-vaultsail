import { ItemView, Platform, type WorkspaceLeaf } from 'obsidian';
import type VaultSailPlugin from '../main';
import { TransferCenterPanel } from './transfer-center-panel';

export const TRANSFER_CENTER_VIEW = 'vaultsail-transfer-center';
export class TransferCenterView extends ItemView {
  private panel?: TransferCenterPanel;
  constructor(leaf: WorkspaceLeaf, private plugin: VaultSailPlugin) { super(leaf); }
  getViewType(): string { return TRANSFER_CENTER_VIEW; }
  getDisplayText(): string { return '云舟 · 传输中心'; }
  getIcon(): string { return 'list-start'; }
  async onOpen(): Promise<void> {
    this.panel = new TransferCenterPanel(this.contentEl, {
      snapshot: () => this.plugin.transferSnapshot(), subscribe: listener => this.plugin.subscribeTransfers(listener),
      sync: () => this.plugin.requestSync(), pause: () => this.plugin.pause(), resume: () => this.plugin.resumeTransfers(),
      history: () => this.plugin.showSyncHistory(), refresh: () => this.plugin.loadTransferHistory(),
    });
  }
  async onClose(): Promise<void> { this.panel?.destroy(); this.panel = undefined; }
}
export async function openTransferCenter(plugin: VaultSailPlugin): Promise<void> {
  const workspace = plugin.app.workspace;
  const existing = workspace.getLeavesOfType(TRANSFER_CENTER_VIEW)[0];
  const leaf = existing ?? (Platform.isMobile ? workspace.getLeaf('tab') : workspace.getRightLeaf(false) ?? workspace.getLeaf('tab'));
  if (!existing) await leaf.setViewState({ type: TRANSFER_CENTER_VIEW, active: true });
  await workspace.revealLeaf(leaf);
}
