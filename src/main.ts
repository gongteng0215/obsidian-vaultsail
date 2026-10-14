import { Notice, Plugin, requireApiVersion } from 'obsidian';
import { VaultSailSettingTab } from './ui/settings-tab';
import { DEFAULT_SETTINGS, migrateSettings, type VaultSailSettings } from './config';
import { AuthManager, type DeviceSession } from './auth/auth-manager';
import { appRoot, bytes, hash, MAX_FILE_SIZE, safeMessage, uuid, VaultSailError } from './core/safety';
import { BaiduProvider } from './providers/baidu-provider';
import { ObsidianCredentials, ObsidianLocalFiles, ObsidianStateStore, deviceIdentity, obsidianTransport } from './platform/obsidian-adapters';
import { RemoteVaultStore } from './sync/remote-vault';
import { SyncEngine, type SyncPlan } from './sync/engine';
import { CloudVaultSetupModal, PlanModal } from './ui/modals';

export default class VaultSailPlugin extends Plugin {
  settings: VaultSailSettings = { ...DEFAULT_SETTINGS };
  auth!: AuthManager;
  deviceId = '';
  local!: ObsidianLocalFiles;
  deviceSession?: DeviceSession;
  authPhase: 'idle' | 'requesting' | 'waiting' = 'idle';
  browserRequested = false;
  statusText = '请配置自己的百度应用。';
  busy = false;
  private generation = 0;
  private engine?: SyncEngine;
  private alive = true;
  private settingTab!: VaultSailSettingTab;
  private lastErrorCode?: string;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!requireApiVersion('1.11.4') || !this.app.secretStorage) { new Notice('VaultSail 需要 Obsidian 1.11.4 或更新版本。'); return; }
    this.deviceId = deviceIdentity(this.app); this.local = new ObsidianLocalFiles(this.app, this.deviceId);
    this.auth = new AuthManager(obsidianTransport, new ObsidianCredentials(this.app), () => ({ appKey: this.settings.appKey,
      secretRef: this.settings.secretRef, sessionRef: 'vaultsail-session-' + this.deviceId }));
    this.settingTab = new VaultSailSettingTab(this.app, this); this.addSettingTab(this.settingTab);

    this.addCommand({
      id: 'local-inventory-preview',
      name: '预览本地文件清单（只读）',
      callback: () => {
        const files = this.app.vault.getFiles();
        const byteCount = files.reduce((sum, f) => sum + f.stat.size, 0);
        const sizeMiB = (byteCount / (1024 * 1024)).toFixed(2);
        new Notice(`VaultSail：${files.length} 个本地文件，${sizeMiB} MiB；未修改文件。`, 8000);
      },
    });

    for (const mode of ['upload', 'download', 'sync'] as const) this.addCommand({ id: 'preview-' + mode,
      name: mode === 'upload' ? '预览上传' : mode === 'download' ? '预览下载' : '预览双向同步（实验）', callback: () => { void this.run('正在扫描…', () => this.preview(mode)); } });
    this.addCommand({ id: 'recover-transfer', name: '恢复未完成传输', callback: () => { void this.run('正在恢复…', async () => { const engine = await this.getEngine(); await engine.recover(); }); } });
    this.addRibbonIcon('cloud', 'VaultSail：预览上传', () => { void this.run('正在扫描…', () => this.preview('upload')); });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.hidden) this.pause();
      else if (!this.busy) void this.auditLocalRecovery();
    });
    await this.auditLocalRecovery();
  }

  onunload(): void { this.alive = false; this.pause(); this.auth?.cancel(); }
  refreshUI(): void { if (this.alive && this.settingTab?.containerEl.isConnected) this.settingTab.display(); }
  async run(label: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) { new Notice('已有操作在运行，请先暂停或等待结束。'); return; }
    this.busy = true; this.statusText = label; this.refreshUI();
    try { await action(); this.lastErrorCode = undefined; this.statusText = '操作完成。'; }
    catch (error) {
      this.lastErrorCode = error instanceof VaultSailError ? error.code : 'unknown'; this.statusText = safeMessage(error); new Notice(this.statusText, 9000);
      if (this.lastErrorCode === 'binding' && this.auth.status() === 'connected') this.openCloudSetup();
    }
    finally { this.busy = false; this.refreshUI(); }
  }
  pause(): void { this.engine?.pause(); if (this.authPhase === 'idle') this.statusText = '已请求暂停，等待当前请求结束。'; }
  async changeConfiguration(update: Partial<VaultSailSettings>): Promise<void> {
    this.pause(); this.generation++; this.engine = undefined; this.auth?.disconnect(); this.deviceSession = undefined;
    this.settings = { ...this.settings, ...update, binding: undefined, deletionEnabled: false };
    await this.saveSettings(); this.statusText = '配置已变更，请重新连接并验证权限。';
  }
  async saveAppSecret(secret: string): Promise<void> {
    const value = secret.trim();
    if (!value || /\s/.test(value)) throw new VaultSailError('configuration', '请输入完整的 SecretKey，不能包含空白字符。');
    const ref = 'vaultsail-app-secret-' + this.deviceId;
    new ObsidianCredentials(this.app).set(ref, value);
    await this.changeConfiguration({ secretRef: ref });
  }
  provider(): BaiduProvider {
    if (this.settings.providerId !== 'baidu') throw new VaultSailError('configuration', '请先选择百度网盘。');
    const root = appRoot(this.settings.appDirectory); const generation = this.generation;
    return new BaiduProvider(root, obsidianTransport, this.auth, () => this.alive && generation === this.generation);
  }
  async connect(): Promise<void> {
    const issue = this.auth.configurationIssue(); if (issue) throw new VaultSailError('configuration', issue);
    this.authPhase = 'requesting'; this.browserRequested = false; this.statusText = '正在申请百度设备授权，请稍候…'; this.refreshUI();
    this.generation++; this.engine?.pause(); this.engine = undefined; this.settings.binding = undefined;
    this.deviceSession = undefined;
    try {
      await this.saveSettings();
      await this.auth.connect(session => {
        this.deviceSession = session; this.authPhase = 'waiting';
        try { window.open(session.verificationUrl, '_blank', 'noopener,noreferrer'); this.browserRequested = true; }
        catch { this.browserRequested = false; }
        this.statusText = this.browserRequested ? '已请求打开百度授权页；请在浏览器完成授权。未弹出时可点击下面的打开按钮。' : '浏览器未能自动打开，请点击打开百度授权页面。';
        new Notice('设备授权码已就绪，请在百度官方页面完成授权。', 8000); this.refreshUI();
      });
      this.statusText = '百度授权已完成。'; new Notice('百度授权成功。应用目录可在传输前配置。', 7000);
    } finally { this.deviceSession = undefined; this.authPhase = 'idle'; }
  }
  cancelAuthorization(): void {
    this.auth.cancel(); this.deviceSession = undefined; this.authPhase = 'idle'; this.statusText = '已取消本次授权，可重新连接。'; this.refreshUI();
  }
  async disconnect(): Promise<void> {
    this.pause(); this.generation++; this.auth.disconnect(); this.deviceSession = undefined; this.authPhase = 'idle'; this.engine = undefined;
    this.settings.binding = undefined; this.settings.deletionEnabled = false; await this.saveSettings();
  }
  async checkAccess(): Promise<void> {
    const provider = this.provider(); const profile = await provider.profile(); await provider.listAll('');
    new Notice(profile.label + '：身份与目录列表通过；上传下载需运行往返测试。', 9000);
  }
  private validationKey(accountHash: string): string { return 'vaultsail-validation-' + hash(bytes(this.settings.appKey + '|' + this.settings.appDirectory + '|' + accountHash)); }
  async roundtrip(): Promise<void> {
    const provider = this.provider(); const profile = await provider.profile(); const accountHash = hash(bytes(profile.accountId));
    const root = 'vaultsail-probes/' + uuid() + '/中文测试/多层目录'; await provider.mkdir(root);
    const results: { size: number; passed: boolean }[] = [];
    for (const size of [0, 1024, 4 * 1024 * 1024, MAX_FILE_SIZE]) {
      const data = new Uint8Array(size); for (let i = 0; i < size; i++) data[i] = (i * 31 + 17) % 251;
      const path = root + '/' + size + '.bin'; await provider.writeImmutable(path, data.buffer);
      const downloaded = await provider.read(path); if (hash(downloaded) !== hash(data.buffer)) throw new VaultSailError('integrity', '文件往返 Hash 不一致。');
      results.push({ size, passed: true }); this.statusText = `文件往返验证 ${results.length}/4`; this.refreshUI();
    }
    await provider.listAll(root);
    let quota = '未验证'; try { await provider.quota(); quota = '已验证'; } catch { /* Quota is reported separately from verified transfer capabilities. */ }
    this.app.saveLocalStorage(this.validationKey(accountHash), { passed: true, checkedAt: Date.now(), results, quota });
    new Notice('往返测试通过。测试文件保留在独立目录，可在网盘中自行清理。', 9000);
  }
  async bind(vaultId: string): Promise<void> {
    const provider = this.provider(); const profile = await provider.profile(); const accountHash = hash(bytes(profile.accountId));
    const vault = await new RemoteVaultStore(provider).get(vaultId);
    this.pause(); this.generation++; this.engine = undefined; this.settings.remoteVaultId = vaultId;
    this.settings.binding = { vaultId, appKey: this.settings.appKey, root: provider.root, accountHash, displayName: vault.displayName };
    await this.saveSettings(); this.lastErrorCode = undefined; this.statusText = '已绑定云端库：' + vault.displayName;
  }
  async createVault(name: string): Promise<void> {
    const store = new RemoteVaultStore(this.provider()); const vault = await store.create(name); await this.bind(vault.vaultId);
  }
  openCloudSetup(): void {
    const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
      if (this.busy) throw new VaultSailError('busy', '已有操作在运行，请稍候再试。');
      this.busy = true; this.refreshUI();
      try { return await action(); } finally { this.busy = false; this.refreshUI(); }
    };
    new CloudVaultSetupModal(this.app, this.app.vault.getName(), {
      create: name => guarded(() => this.createVault(name)),
      list: () => guarded(() => new RemoteVaultStore(this.provider()).listVaults()),
      bind: id => guarded(() => this.bind(id)),
      roundtrip: () => guarded(() => this.roundtrip()),
    }).open();
  }
  private async getEngine(): Promise<SyncEngine> {
    const b = this.settings.binding;
    if (!b) throw new VaultSailError('binding', '尚未绑定云端知识库，请创建新库或选择已有库。');
    const provider = this.provider();
    if (b.appKey !== this.settings.appKey || b.root !== provider.root) throw new VaultSailError('binding', '应用或目录已变更，请重新选择并验证云端库。');
    const profile = await provider.profile(); const accountHash = hash(bytes(profile.accountId));
    if (b.accountHash !== accountHash) throw new VaultSailError('binding', '百度账号与原绑定不一致，请为当前账号重新选择云端库。');
    const validation = this.app.loadLocalStorage(this.validationKey(accountHash));
    if (!validation?.passed) throw new VaultSailError('permission', '请先运行本设备的文件往返测试，确认上传下载权限。');
    if (this.engine) return this.engine;
    const context = hash(bytes(b.appKey + '|' + b.root + '|' + accountHash + '|' + b.vaultId));
    this.engine = new SyncEngine(new RemoteVaultStore(provider), this.local, new ObsidianStateStore(this.app, this.deviceId, b.vaultId, context), b.vaultId, this.app.vault.configDir);
    return this.engine;
  }
  async preview(mode: SyncPlan['mode']): Promise<void> {
    if (mode === 'sync' && !this.settings.experimentalSync) throw new VaultSailError('configuration', '双向同步处于实验阶段，请先开启实验功能。');
    const engine = await this.getEngine(); const plan = await engine.preview(mode, this.settings.deletionEnabled);
    new PlanModal(this.app, plan, async progress => { if (this.busy) throw new VaultSailError('busy', '当前有其他操作。'); this.busy = true;
      try {
        if (plan.mode === 'sync' && !this.settings.experimentalSync) throw new VaultSailError('configuration', '实验性同步已关闭，请重新预览。');
        if (!this.settings.deletionEnabled && plan.rows.some(row => row.action === 'delete-local' || row.action === 'delete-remote')) throw new VaultSailError('configuration', '删除传播已关闭，请重新预览。');
        await engine.execute(plan, progress);
      } finally { this.busy = false; this.refreshUI(); } },
      async (row, choice) => { if (this.busy) throw new VaultSailError('busy', '当前有其他操作。'); this.busy = true;
        try { await engine.resolve(row.path, choice, row); } finally { this.busy = false; this.refreshUI(); } }, () => engine.pause()).open();
  }
  async recover(): Promise<void> { await (await this.getEngine()).recover(); }
  async abandonPending(): Promise<void> { await (await this.getEngine()).abandonPending(); }
  async auditLocalRecovery(): Promise<void> {
    const b = this.settings.binding; if (!b) return;
    try {
      const context = hash(bytes(b.appKey + '|' + b.root + '|' + b.accountHash + '|' + b.vaultId));
      const state = await new ObsidianStateStore(this.app, this.deviceId, b.vaultId, context).load();
      this.statusText = state.journals.length ? `发现 ${state.journals.length} 个未完成操作，请恢复任务。` : '本地状态已检查，可手动预览。';
    } catch (error) { this.statusText = safeMessage(error); this.lastErrorCode = error instanceof VaultSailError ? error.code : 'unknown'; }
    this.refreshUI();
  }
  diagnostics(): string {
    const b = this.settings.binding;
    const checked = b ? this.app.loadLocalStorage(this.validationKey(b.accountHash)) : null;
    return JSON.stringify({ pluginVersion: this.manifest.version, authorized: this.auth.status() === 'connected', bound: Boolean(this.settings.binding),
      experimentalSync: this.settings.experimentalSync, deletionEnabled: this.settings.deletionEnabled,
      lastErrorCode: this.lastErrorCode ?? null, localRoundtrip: checked ? { passed: checked.passed === true, checkedAt: checked.checkedAt, results: checked.results, quota: checked.quota } : null,
      realDeviceValidation: '用户在本设备完成；开发者未验证真实账号或 iPad', maxFileMiB: 20 }, null, 2);
  }

  async loadSettings(): Promise<void> {
    const stored: unknown = await this.loadData();
    this.settings = migrateSettings(stored);
    const directory = stored && typeof stored === 'object' ? (stored as Record<string, unknown>).appDirectory : undefined;
    if (typeof directory !== 'string' || !directory.trim()) await this.saveSettings();
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
