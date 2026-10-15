import { Modal, Notice, Plugin, requireApiVersion } from 'obsidian';
import { VaultSailSettingTab } from './ui/settings-tab';
import { DEFAULT_SETTINGS, migrateSettings, type VaultSailSettings } from './config';
import { AuthManager, type DeviceSession } from './auth/auth-manager';
import { ownsCredentialReference, pairingCredentialReferences } from './auth/credential-references';
import { appRoot, bytes, hash, included, MAX_FILE_SIZE, safeMessage, uuid, VaultSailError } from './core/safety';
import { BaiduProvider } from './providers/baidu-provider';
import { ObsidianCredentials, ObsidianLocalFiles, ObsidianRevisionCache, ObsidianStateStore, deviceIdentity, obsidianTransport } from './platform/obsidian-adapters';
import { buildHeads, RemoteVaultStore, type RemoteVault } from './sync/remote-vault';
import { SyncEngine, type SyncPlan } from './sync/engine';
import { CloudVaultSetupModal, PlanModal } from './ui/modals';
import { CONFIG_EXPORT_DIRECTORY, exportPortableConfig, parsePortableConfig } from './portable-config';
import { ConfigExportModal, ConfigImportModal } from './ui/config-modals';
import { formatBytes, progressRunning, PROGRESS_LABELS, type SyncProgress } from './sync/progress';
import { withConfigurationLock } from './platform/configuration-lock';
import { MAX_TRANSFER_CONCURRENCY, validConcurrency } from './core/concurrency';
import { TransferPerformance, formatPerformance, REQUEST_LABELS } from './sync/performance';
import type { HttpTransport } from './providers/http';
import { SyncQueue, type QueueBatch } from './sync/queue';
import { withVaultTaskLock } from './platform/task-lock';
import { ConflictDrafts } from './platform/conflict-drafts';
import { ConflictInbox } from './ui/conflicts';
import { decryptPairing, encryptPairing, isEncryptedPairing, PAIRING_LIFETIME_MS, validateAuthorizedPairing, validatePairingCode, type AuthorizedPairing, type PairingImportOptions } from './encrypted-pairing';

const PAIRING_STEPS = {
  session: '准备授权', account: '验证百度账号', vault: '读取云端库', listing: '验证目录权限',
  upload: '上传校验文件', download: '下载校验文件', integrity: '校验文件内容',
  credentials: '保存本机密钥', settings: '保存连接配置', verification: '保存本机验证记录', activation: '启用连接',
} as const;

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
  progress?: SyncProgress;
  private performance = new TransferPerformance();
  private timedTransport: HttpTransport = input => this.performance.transport(obsidianTransport, input);
  private progressListeners = new Set<(progress: SyncProgress) => void>();
  private progressTimer?: ReturnType<typeof setInterval>;
  private transferStartedAt?: number;
  private transferPauseRequested = false;
  private generation = 0;
  private connectionRequests = new AbortController();
  private engine?: SyncEngine;
  private alive = true;
  private settingTab!: VaultSailSettingTab;
  private lastErrorCode?: string;
  private lastPairingStep?: keyof typeof PAIRING_STEPS;
  private queue?: SyncQueue; private queueContext?: string; private automaticRun = false;
  private layoutReady = false; private pendingManualSync = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.alive) return;
    if (!requireApiVersion('1.11.4') || !this.app.secretStorage) { new Notice('VaultSail 需要 Obsidian 1.11.4 或更新版本。'); return; }
    this.deviceId = deviceIdentity(this.app); this.local = new ObsidianLocalFiles(this.app, this.deviceId);
    this.auth = this.makeAuth();
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
      name: mode === 'upload' ? '预览上传' : mode === 'download' ? '预览下载' : '预览双向同步', callback: () => { void this.run('正在扫描…', () => this.preview(mode)); } });
    this.addCommand({ id: 'recover-transfer', name: '恢复未完成传输', callback: () => { void this.run('正在恢复…', async () => { const engine = await this.getEngine(); await engine.recover(); }); } });
    this.addCommand({ id: 'start-sync', name: '开始双向同步', callback: () => { this.requestSync(); } });
    this.addCommand({ id: 'resolve-conflicts', name: '查看待解决冲突', callback: () => { this.openConflicts(); } });
    this.addRibbonIcon('cloud', 'VaultSail：开始同步', () => { this.requestSync(); });
    this.registerDomEvent(document, 'visibilitychange', () => {
      this.queue?.suspend(document.hidden);
      if (document.hidden) this.pause(false);
      else if (!this.busy) void this.auditLocalRecovery();
    });
    this.registerDomEvent(window, 'online', () => { this.queue?.request('remote'); });
    const listen = () => {
      if (!this.alive) return;
      this.layoutReady = true;
      for (const name of ['create', 'modify', 'delete', 'rename'] as const) {
        const on = this.app.vault.on?.bind(this.app.vault);
        if (on) this.registerEvent(on(name as 'rename', (file, oldPath?: string) => {
          if (!this.alive) return;
          const paths = [file.path, ...(oldPath ? [oldPath] : [])];
          for (const path of paths) if (included(path, this.app.vault.configDir)) { this.engine?.markDirty(path); this.queue?.request('local', path); }
          if (!('stat' in file) && paths.some(path => included(path, this.app.vault.configDir))) { this.engine?.markDirty(); this.queue?.request('full'); }
        }));
      }
      this.ensureQueue();
      if (this.pendingManualSync) { this.pendingManualSync = false; this.requestSync(); }
    };
    if (this.app.workspace.onLayoutReady) this.app.workspace.onLayoutReady(listen); else listen();
    await this.auditLocalRecovery();
  }

  onunload(): void { this.alive = false; this.queue?.dispose(); this.performance.finish(); this.connectionRequests.abort(); this.pause(false); this.auth?.cancel(); if (this.progressTimer) clearInterval(this.progressTimer); this.progressTimer = undefined; this.progressListeners.clear(); }
  private invalidateConnection(): void {
    this.queue?.dispose(); this.queue = undefined; this.queueContext = undefined;
    this.generation++; this.connectionRequests.abort(); this.connectionRequests = new AbortController();
  }
  subscribeProgress(listener: (progress: SyncProgress) => void): () => void {
    this.progressListeners.add(listener); if (this.progress) listener(this.progress); return () => this.progressListeners.delete(listener);
  }
  private publishProgress(progress: SyncProgress): void {
    if (!this.alive) return;
    this.performance.phase(progress.phase);
    this.progress = { ...progress, startedAt: this.transferStartedAt ?? progress.startedAt };
    if (this.pauseRequested && progressRunning(progress)) this.statusText = '已请求暂停，等待当前请求结束。';
    else this.statusText = progress.message ?? PROGRESS_LABELS[progress.phase];
    if (!progressRunning(progress)) this.transferPauseRequested = false;
    const notify = () => {
      try { this.settingTab?.updateProgress(); } catch { /* A detached view cannot prevent heartbeats or other observers. */ }
      for (const listener of this.progressListeners) { try { listener(this.progress!); } catch { /* UI observers cannot affect writes. */ } }
    };
    notify();
    if (!progressRunning(progress)) { if (this.progressTimer) clearInterval(this.progressTimer); this.progressTimer = undefined; }
    else if (!this.progressTimer) this.progressTimer = setInterval(notify, 500);
  }
  private beginTransfer(): void {
    this.performance.begin();
    this.transferStartedAt = Date.now(); this.transferPauseRequested = false;
    this.publishProgress({ phase: 'connecting', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0,
      startedAt: this.transferStartedAt, updatedAt: this.transferStartedAt });
  }
  private failTransfer(error: unknown): void {
    if (this.progress) this.publishProgress({ ...this.progress,
      phase: error instanceof VaultSailError && ['paused', 'cancelled'].includes(error.code) ? 'paused' : 'failed', message: safeMessage(error), updatedAt: Date.now() });
  }
  get pauseRequested(): boolean { return this.transferPauseRequested || (this.engine?.pauseRequested ?? false); }
  refreshUI(): void { if (this.alive) { this.ensureQueue(); if (this.settingTab?.containerEl.isConnected) this.settingTab.display(); } }
  private context(): string | undefined { const b = this.settings.binding; return b && hash(bytes(b.appKey + '|' + b.root + '|' + b.accountHash + '|' + b.vaultId)); }
  private ensureQueue(): void {
    if (typeof this.app.workspace?.onLayoutReady === 'function' && !this.layoutReady) return;
    const context = this.context();
    if (!context || !this.deviceId || !this.auth) { this.queue?.dispose(); this.queue = undefined; this.queueContext = undefined; return; }
    const key = 'vaultsail-queue-' + this.deviceId + '-' + context;
    if (this.queueContext === key && this.queue) return;
    this.queue?.dispose(); this.queueContext = key;
    this.queue = new SyncQueue({ load: () => this.app.loadLocalStorage(key), save: state => this.app.saveLocalStorage(key, state),
      enabled: () => this.settings.autoSyncEnabled, pollMs: () => this.settings.remotePollSeconds * 1000,
      canRun: () => this.alive && !this.busy && !document.hidden && globalThis.navigator?.onLine !== false,
      run: async batch => { this.automaticRun = !batch.manual; try { await this.run(batch.manual ? '正在同步…' : '自动检查与同步…', () => this.startSync(batch), true, !batch.manual); } finally { this.automaticRun = false; } },
      change: () => { try { this.settingTab?.updateProgress(); } catch { /* Detached view. */ } } });
    if (document.hidden) this.queue.suspend(true);
  }
  requestSync(): void {
    if (typeof this.app.workspace?.onLayoutReady === 'function' && !this.layoutReady) { this.pendingManualSync = true; new Notice('等待笔记库加载完成后同步。'); return; }
    this.ensureQueue(); if (this.queue) this.queue.request('manual'); else void this.run('正在同步…', () => this.startSync());
  }
  queueSummary(): string { return this.queue?.summary() ?? '绑定云端库后可开启自动同步。'; }
  async setAutomatic(enabled: boolean, pollSeconds = this.settings.remotePollSeconds): Promise<void> {
    if (this.busy) throw new VaultSailError('busy', '请等待当前任务结束。');
    if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 300) throw new VaultSailError('configuration', '远端检查间隔必须为 30–300 秒的整数。');
    if (enabled && (!this.settings.binding || this.auth.status() !== 'connected')) throw new VaultSailError('binding', '请先完成授权、绑定和文件权限验证。');
    if (enabled && !this.app.loadLocalStorage(this.validationKey(this.settings.binding!.accountHash))?.passed) throw new VaultSailError('permission', '请先运行本设备的文件传输权限验证。');
    const previous = { enabled: this.settings.autoSyncEnabled, interval: this.settings.remotePollSeconds }; this.busy = true;
    try { this.settings.autoSyncEnabled = enabled; this.settings.remotePollSeconds = pollSeconds; await this.saveSettings(); }
    catch (error) { this.settings.autoSyncEnabled = previous.enabled; this.settings.remotePollSeconds = previous.interval; throw error; }
    finally { this.busy = false; }
    this.queue?.dispose(); this.queue = undefined; this.queueContext = undefined; this.refreshUI();
    if (enabled && !previous.enabled) this.requestSync();
  }
  private async conflictAction<T>(action: (engine: SyncEngine) => Promise<T>): Promise<T> {
    if (this.busy) throw new VaultSailError('busy', '当前任务进行中，请等待完成。');
    this.busy = true;
    try { return await withVaultTaskLock(this.app, async () => { if (!this.alive) throw new VaultSailError('cancelled', '插件已关闭。'); return action(await this.getEngine()); }); }
    finally { this.performance.finish(); this.busy = false; this.refreshUI(); }
  }
  openConflicts(): void {
    const context = this.context(); if (!context) { new Notice('请先绑定云端库。'); return; }
    const boundAction = <T>(action: (engine: SyncEngine) => Promise<T>) => {
      if (this.context() !== context) return Promise.reject<T>(new VaultSailError('binding', '连接已变更，请重新打开冲突列表。'));
      return this.conflictAction(action);
    };
    new ConflictInbox(this.app, {
      list: () => boundAction(async engine => (await engine.preview('sync', this.settings.deletionEnabled, { allowRenames: true })).rows.filter(row => row.action === 'conflict')),
      details: row => boundAction(engine => engine.describeConflict(row)),
      resolve: (row, choice, data) => boundAction(engine => engine.resolve(row.path, choice, row, data)),
      both: (row, other, path, primary) => boundAction(engine => engine.resolveBoth(row, other, path, primary)),
      deletionEnabled: this.settings.deletionEnabled, remove: row => boundAction(engine => engine.resolveDelete(row, this.settings.deletionEnabled)),
      drafts: new ConflictDrafts(this.app, this.deviceId, context),
    }).open();
  }
  private sessionReference(): string {
    const own = 'vaultsail-session-' + this.deviceId; const ref = this.settings.sessionRef;
    return ownsCredentialReference(ref, 'session', this.deviceId) ? ref! : own;
  }
  private makeAuth(): AuthManager {
    return new AuthManager(this.timedTransport, new ObsidianCredentials(this.app), () => ({ appKey: this.settings.appKey,
      secretRef: this.settings.secretRef, sessionRef: this.sessionReference() }));
  }
  async run(label: string, action: () => Promise<void>, rethrow = false, quiet = false): Promise<void> {
    if (this.busy) { if (rethrow) throw new VaultSailError('busy', '当前有其他操作，任务继续等待。'); new Notice('已有操作在运行，请先暂停或等待结束。'); return; }
    this.busy = true; this.statusText = label; this.refreshUI();
    try { await withVaultTaskLock(this.app, async () => { if (!this.alive) throw new VaultSailError('cancelled', '插件已关闭。'); await action(); }); this.lastErrorCode = undefined; if (this.statusText === label) this.statusText = '操作完成。'; }
    catch (error) {
      this.lastErrorCode = error instanceof VaultSailError ? error.code : 'unknown'; this.statusText = safeMessage(error); if (!quiet) new Notice(this.statusText, 9000);
      if (!quiet && this.lastErrorCode === 'binding' && this.auth.status() === 'connected') this.openCloudSetup();
      if (rethrow) throw error;
    }
    finally { this.performance.finish(); this.busy = false; this.refreshUI(); }
  }
  pause(user = true): void {
    if (user) this.queue?.pause();
    this.engine?.pause();
    if (this.authPhase === 'idle' && this.busy && this.progress && progressRunning(this.progress)) {
      this.transferPauseRequested = true; this.statusText = '已请求暂停，等待当前请求结束。';
      try { this.settingTab?.updateProgress(); } catch { /* Pausing must survive a detached settings view. */ }
    }
  }
  async changeConfiguration(update: Partial<VaultSailSettings>): Promise<void> {
    this.pause(); this.invalidateConnection(); this.engine = undefined; this.auth?.disconnect(); this.deviceSession = undefined;
    this.settings = { ...this.settings, ...update, binding: undefined, deletionEnabled: false, autoSyncEnabled: false };
    await this.saveSettings(); this.statusText = '配置已变更，请重新连接并验证权限。';
  }
  async saveAppSecret(secret: string): Promise<void> {
    const value = secret.trim();
    if (!value || /\s/.test(value)) throw new VaultSailError('configuration', '请输入完整的 SecretKey，不能包含空白字符。');
    const ref = 'vaultsail-app-secret-' + this.deviceId;
    new ObsidianCredentials(this.app).set(ref, value);
    await this.changeConfiguration({ secretRef: ref });
  }
  async setTransferConcurrency(value: number): Promise<void> {
    if (this.busy) throw new VaultSailError('busy', '请等待当前任务完成，再修改并发数。');
    if (!validConcurrency(value)) throw new VaultSailError('configuration', `请输入 1–${MAX_TRANSFER_CONCURRENCY} 之间的整数。`);
    this.engine?.configureConcurrency(value); this.settings.transferConcurrency = value; await this.saveSettings();
    this.statusText = `传输并发已设为 ${value} 路，下次任务生效。`; this.refreshUI();
  }
  provider(): BaiduProvider {
    if (this.settings.providerId !== 'baidu') throw new VaultSailError('configuration', '请先选择百度网盘。');
    const root = appRoot(this.settings.appDirectory); const generation = this.generation;
    return new BaiduProvider(root, this.timedTransport, this.auth, () => this.alive && generation === this.generation && !this.pauseRequested, phase => {
      if (this.progress && this.busy && !['scanning-remote', 'checking-remote', 'scanning-local', 'preview-ready', 'completed', 'paused', 'failed'].includes(this.progress.phase)) this.publishProgress({ ...this.progress, phase, updatedAt: Date.now() });
    }, { signal: this.connectionRequests.signal, onRetry: waited => this.performance.retry(waited) });
  }
  async connect(): Promise<void> {
    const issue = this.auth.configurationIssue(); if (issue) throw new VaultSailError('configuration', issue);
    this.authPhase = 'requesting'; this.browserRequested = false; this.statusText = '正在申请百度设备授权，请稍候…'; this.refreshUI();
    this.invalidateConnection(); this.engine?.pause(); this.engine = undefined; this.settings.binding = undefined;
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
    this.pause(); this.invalidateConnection(); this.auth.disconnect(); this.deviceSession = undefined; this.authPhase = 'idle'; this.engine = undefined;
    this.settings.binding = undefined; this.settings.deletionEnabled = false; await this.saveSettings();
  }
  async checkAccess(): Promise<void> {
    const provider = this.provider(); const profile = await provider.profile(); await provider.listAll('');
    new Notice(profile.label + '：身份与目录列表通过；上传下载需运行往返校验。', 9000);
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
    new Notice('往返校验通过。校验文件保留在独立目录，可在网盘中自行清理。', 9000);
  }
  async bind(vaultId: string): Promise<void> {
    const provider = this.provider(); const profile = await provider.profile(); const accountHash = hash(bytes(profile.accountId));
    const vault = await new RemoteVaultStore(provider).get(vaultId);
    this.pause(); this.invalidateConnection(); this.engine = undefined; this.settings.remoteVaultId = vaultId;
    this.settings.binding = { vaultId, appKey: this.settings.appKey, root: provider.root, accountHash, displayName: vault.displayName };
    this.settings.pendingVaultName = undefined; this.settings.autoSyncEnabled = false;
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
  private async boundProvider(): Promise<{ provider: BaiduProvider; binding: NonNullable<VaultSailSettings['binding']>; accountHash: string }> {
    const b = this.settings.binding;
    if (!b) throw new VaultSailError('binding', '尚未绑定云端知识库，请创建新库或选择已有库。');
    const provider = this.provider();
    if (b.appKey !== this.settings.appKey || b.root !== provider.root) throw new VaultSailError('binding', '应用或目录已变更，请重新选择并验证云端库。');
    const profile = await provider.profile(); const accountHash = hash(bytes(profile.accountId));
    if (b.accountHash !== accountHash) throw new VaultSailError('binding', '百度账号与原绑定不一致，请为当前账号重新选择云端库。');
    return { provider, binding: b, accountHash };
  }
  private async getEngine(): Promise<SyncEngine> {
    this.beginTransfer();
    try {
      const { provider, binding: b, accountHash } = await this.boundProvider();
      if (this.pauseRequested) throw new VaultSailError('paused', '任务已暂停，请重新开始或恢复任务。');
      const validation = this.app.loadLocalStorage(this.validationKey(accountHash));
      if (!validation?.passed) throw new VaultSailError('permission', '请先运行本设备的文件传输权限验证，确认上传下载权限。');
      if (this.engine) return this.engine;
      const context = hash(bytes(b.appKey + '|' + b.root + '|' + accountHash + '|' + b.vaultId));
      this.engine = new SyncEngine(new RemoteVaultStore(provider, new ObsidianRevisionCache(this.app, this.deviceId, context), this.settings.transferConcurrency, stats => this.performance.scan(stats)), this.local,
        new ObsidianStateStore(this.app, this.deviceId, b.vaultId, context), b.vaultId, this.app.vault.configDir, event => this.publishProgress(event), this.settings.transferConcurrency);
      return this.engine;
    } catch (error) { this.failTransfer(error); throw error; }
  }
  async preview(mode: SyncPlan['mode']): Promise<void> {
    const engine = await this.getEngine(); const plan = await engine.preview(mode, this.settings.deletionEnabled, { allowRenames: true });
    new PlanModal(this.app, plan, async progress => { if (this.busy) throw new VaultSailError('busy', '当前有其他操作。'); this.busy = true;
      this.beginTransfer(); this.refreshUI();
      try {
        if (!this.settings.deletionEnabled && plan.rows.some(row => row.action === 'delete-local' || row.action === 'delete-remote')) throw new VaultSailError('configuration', '删除传播已关闭，请重新预览。');
        await withVaultTaskLock(this.app, () => engine.execute(plan, progress, true));
        const key = this.successKey(); if (key && this.progress) this.app.saveLocalStorage(key, { completedAt: Date.now(), mode: plan.mode,
          files: this.progress.doneFiles, bytes: this.progress.doneBytes, elapsedMs: this.progress.updatedAt - this.progress.startedAt });
      } catch (error) { this.failTransfer(error); throw error; } finally { this.performance.finish(); this.busy = false; this.refreshUI(); } },
      async (row, choice) => { if (this.busy) throw new VaultSailError('busy', '当前有其他操作。'); this.busy = true;
        this.beginTransfer(); this.refreshUI();
        try { await withVaultTaskLock(this.app, () => engine.resolve(row.path, choice, row)); } catch (error) { this.failTransfer(error); throw error; }
        finally { this.performance.finish(); this.busy = false; this.refreshUI(); } }, () => this.pause(), listener => this.subscribeProgress(listener)).open();
  }
  async startSync(batch?: QueueBatch): Promise<void> {
    if (batch && !batch.manual && !batch.full && !batch.remote && this.engine) {
      const paths = await this.engine.changedFromBaseline(batch.paths);
      if (!paths.length) { this.statusText = '文件内容已与基线一致，无需同步。'; return; }
      batch = { ...batch, paths };
    }
    const startedAt = Date.now(); const engine = await this.getEngine(); let conflicts = 0; let incoming = 0; let files = 0; let contentBytes = 0;
    if (batch) await engine.recoverPending();
    let uploaded = 0; let downloaded = 0; let deleted = 0; let merged = 0;
    let paths = batch?.paths ?? [];
    if (batch && !batch.manual && !batch.full && !batch.remote) { paths = await engine.changedFromBaseline(paths); if (!paths.length) { this.statusText = '文件内容已与基线一致，无需同步。'; if (this.progress) this.publishProgress({ ...this.progress, phase: 'completed', updatedAt: Date.now() }); return; } }
    // One extra pass catches concurrent publications without an unbounded background loop.
    for (let pass = 0; pass < 2; pass++) {
      const result = batch && !batch.manual ? await engine.syncAutomatic(paths, batch.remote, batch.full || pass > 0, this.settings.deletionEnabled) : await engine.sync(this.settings.deletionEnabled); conflicts += result.preservedConflicts; incoming = result.incomingChanges; merged += result.autoMergedFiles ?? 0;
      uploaded += result.uploadedFiles; downloaded += result.downloadedFiles; deleted += result.deletedFiles;
      files += this.progress?.doneFiles ?? 0; contentBytes += this.progress?.doneBytes ?? 0;
      if (!incoming) break;
    }
    if (this.progress) this.publishProgress({ ...this.progress, startedAt, doneFiles: files, totalFiles: files, doneBytes: contentBytes, totalBytes: contentBytes, updatedAt: Date.now() });
    const key = this.successKey(); if (key) this.app.saveLocalStorage(key, { completedAt: Date.now(), mode: 'sync', files, bytes: contentBytes, elapsedMs: Date.now() - startedAt });
    const message = `同步完成：上传 ${uploaded} 个，下载 ${downloaded} 个${merged ? `，自动合并 ${merged} 个` : ''}${deleted ? `，删除 ${deleted} 项` : ''}，失败 0 项${conflicts ? `；${conflicts} 项冲突已保留双方，可打开待解决冲突` : ''}${incoming ? '；期间又有新版本，下一次同步会继续处理' : ''}。`;
    this.statusText = message; if (!this.automaticRun) new Notice(message, 9000);
  }
  cloudLocation(): string {
    const id = this.settings.binding?.vaultId ?? this.settings.remoteVaultId;
    const root = this.settings.binding?.root ?? this.settings.appDirectory;
    return root.replace(/^\/apps\//, '我的应用数据/') + '/vaultsail/vaults/' + (id || '（尚未选择云端库）');
  }
  private successKey(): string | undefined {
    const b = this.settings.binding;
    return b ? 'vaultsail-success-' + hash(bytes(b.appKey + '|' + b.root + '|' + b.accountHash + '|' + b.vaultId)) : undefined;
  }
  lastSuccess(): { completedAt: number; files: number; bytes: number; elapsedMs: number } | undefined {
    const key = this.successKey(); const value = key ? this.app.loadLocalStorage(key) : null;
    return value && ['completedAt', 'files', 'bytes', 'elapsedMs'].every(field => typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0)
      ? { completedAt: value.completedAt, files: value.files, bytes: value.bytes, elapsedMs: value.elapsedMs } : undefined;
  }
  async showCloudFiles(): Promise<void> {
    const { provider, binding } = await this.boundProvider();
    const context = hash(bytes(binding.appKey + '|' + binding.root + '|' + binding.accountHash + '|' + binding.vaultId));
    const store = new RemoteVaultStore(provider, new ObsidianRevisionCache(this.app, this.deviceId, context));
    const heads = buildHeads(await store.revisions(binding.vaultId)); const modal = new Modal(this.app); modal.titleEl.setText('云端文件与版本');
    modal.contentEl.createEl('p', { text: this.cloudLocation() });
    if (!heads.size) modal.contentEl.createEl('p', { text: '当前云端库还没有笔记版本。创建库不会自动上传笔记，请预览上传后执行。' });
    for (const [path, versions] of [...heads].sort(([a], [b]) => a.localeCompare(b))) {
      const row = modal.contentEl.createEl('details', { cls: 'vaultsail-file-row' }); row.createEl('summary', { text: `${path} · ${versions.length > 1 ? '有冲突 · ' : ''}${versions.filter(op => op.kind === 'update').length} 个内容版本` });
      for (const op of versions) { row.createEl('p', { text: op.kind === 'update' ? `${formatBytes(op.size)} · 设备 ${op.deviceId.slice(0, 8)} · 版本 ${op.opId.slice(0, 8)}` : '删除版本记录（历史内容保留）' });
        if (op.hash) row.createEl('code', { text: this.cloudLocation() + '/blobs/' + op.hash }); }
    }
    modal.open();
  }
  openConfigExport(): void {
    new ConfigExportModal(this.app, (password, includeVault) => this.exportAuthorizedConfiguration(password, includeVault), text => this.saveConfigExport(text), Boolean(this.settings.binding)).open();
  }
  openConfigImport(): void { new ConfigImportModal(this.app, (text, password, options) => this.importConfiguration(text, password, options)).open(); }
  async exportAuthorizedConfiguration(password: string, includeVault = false): Promise<string> {
    if (this.busy) throw new VaultSailError('busy', '请等待当前操作完成，再生成配对码。');
    this.busy = true; const generation = this.generation; this.refreshUI();
    try {
      const accountHash = includeVault ? (await this.boundProvider()).accountHash : hash(bytes((await this.provider().profile()).accountId));
      const credentials = this.auth.exportCredentials(); const now = Date.now();
      const code = await encryptPairing({ format: 'vaultsail-authorized', version: 1, createdAt: now, expiresAt: now + PAIRING_LIFETIME_MS,
        config: parsePortableConfig(exportPortableConfig(this.settings, includeVault)), accountHash, ...credentials }, password);
      if (!this.alive || generation !== this.generation) throw new VaultSailError('cancelled', '连接已变更，请重新生成配对码。');
      return code;
    } finally { this.busy = false; this.refreshUI(); }
  }
  private async saveConfigExport(text: string): Promise<string> {
    validatePairingCode(text); // Only ciphertext may be written to the vault.
    const stat = await this.app.vault.adapter.stat(CONFIG_EXPORT_DIRECTORY);
    if (stat && stat.type !== 'folder') throw new VaultSailError('collision', '配置导出目录被同名文件占用。');
    if (!stat) await this.app.vault.createFolder(CONFIG_EXPORT_DIRECTORY);
    const path = CONFIG_EXPORT_DIRECTORY + '/vaultsail-配对-' + uuid() + '.vaultsail'; await this.app.vault.createBinary(path, bytes(text)); return path;
  }
  // A staged provider never reads or changes the currently connected account.
  pairingProvider(root: string, auth: AuthManager, active: () => boolean, signal?: AbortSignal): BaiduProvider {
    return new BaiduProvider(root, obsidianTransport, auth, active, undefined, { signal });
  }
  async importConfiguration(text: string, password?: string, options: PairingImportOptions = {}): Promise<void> {
    if (isEncryptedPairing(text)) {
      if (this.busy) throw new VaultSailError('busy', '请等待当前操作完成，再导入配对码。');
      this.busy = true; const generation = this.generation; this.refreshUI();
      try { await this.applyAuthorizedPairing(await decryptPairing(text, password ?? ''), generation, options); }
      catch (error) {
        if (this.alive && generation === this.generation) { this.statusText = safeMessage(error); this.lastErrorCode = error instanceof VaultSailError ? error.code : 'unknown'; }
        throw error;
      }
      finally { this.busy = false; this.refreshUI(); }
      return;
    }
    const config = parsePortableConfig(text); // Validate everything before touching authorization or stored settings.
    const target = options.bindRemoteVault ? config.remoteVault : undefined;
    if (options.bindRemoteVault && !target) throw new VaultSailError('configuration', '此配置没有云端库信息，请仅导入账号配置，之后再选择云端库。');
    if (this.busy) throw new VaultSailError('busy', '请先完成或暂停当前操作，再导入配置。');
    this.busy = true;
    try {
      if (options.signal?.aborted) throw new VaultSailError('cancelled', '本次导入已取消。');
      options.onCommit?.();
      await this.changeConfiguration({ providerId: 'baidu', appKey: config.appKey, appDirectory: config.appDirectory,
        secretRef: this.settings.appKey === config.appKey ? this.settings.secretRef : '', remoteVaultId: target?.id ?? '',
        pendingVaultName: target?.displayName, experimentalSync: false, deletionEnabled: false });
      this.progress = undefined; this.lastErrorCode = undefined; this.statusText = '配置已导入。请在本设备保存 SecretKey 并授权，然后' + (target ? '验证并绑定导入的云端库。' : '为当前 Vault 创建或选择云端库。');
    } finally { this.busy = false; this.refreshUI(); }
  }
  private async applyAuthorizedPairing(value: AuthorizedPairing, generation: number, options: PairingImportOptions): Promise<void> {
    const payload = validateAuthorizedPairing(value); const config = payload.config;
    const { report } = options;
    const target = options.bindRemoteVault ? config.remoteVault : undefined;
    if (options.bindRemoteVault && !target) throw new VaultSailError('configuration', '此配对码只包含账号连接，请仅导入账号，再为当前 Vault 创建或选择云端库。');
    const active = () => this.alive && generation === this.generation && !options.signal?.aborted;
    const guard = () => { if (!active()) throw new VaultSailError('cancelled', '配置已变更或插件已关闭，本次导入已停止。'); };
    let step: keyof typeof PAIRING_STEPS = 'session';
    const advance = (next: keyof typeof PAIRING_STEPS) => {
      step = next; this.lastPairingStep = next; this.statusText = '正在' + PAIRING_STEPS[next] + '…';
      this.refreshUI();
      try { report?.(this.statusText); } catch { /* Progress rendering cannot change import results. */ }
    };
    guard(); this.statusText = '正在验证导入的百度连接与云端库…'; this.refreshUI();
    const { secretRef, sessionRef } = pairingCredentialReferences(this.deviceId);
    const staged = new Map<string, string>([[secretRef, payload.secretKey]]);
    const auth = new AuthManager(obsidianTransport, { get: id => staged.get(id) ?? null, set: (id, data) => { staged.set(id, data); }, remove: id => { staged.delete(id); } },
      () => ({ appKey: config.appKey, secretRef, sessionRef }));
    const controller = new AbortController(); const cancel = () => { controller.abort(); auth.cancel(); };
    const signals = [options.signal, this.connectionRequests.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    for (const signal of signals) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
    try {
      advance('session');
      auth.restoreSession(payload.session);
      const provider = this.pairingProvider(config.appDirectory, auth, active, controller.signal);
      advance('account');
      const profile = await provider.profile(); guard(); const accountHash = hash(bytes(profile.accountId));
      if (accountHash !== payload.accountHash) throw new VaultSailError('binding', '配对码的账号与实际百度账号不一致，未替换原连接。');
      let vault: RemoteVault | undefined;
      if (target) { advance('vault'); vault = await new RemoteVaultStore(provider).get(target.id); guard(); }
      advance('listing');
      await provider.listAll(''); guard();
      // This device performs its own small roundtrip, never imports another device's test result.
      this.statusText = '正在自动检查本设备的文件传输权限…'; this.refreshUI();
      const probe = new Uint8Array(1024); crypto.getRandomValues(probe);
      const probePath = 'vaultsail-probes/' + uuid() + '/pairing.bin';
      advance('upload');
      await provider.writeImmutable(probePath, probe.buffer); guard();
      advance('download');
      const received = await provider.read(probePath); guard();
      advance('integrity');
      if (hash(received) !== hash(probe.buffer)) throw new VaultSailError('integrity', '导入连接的文件校验未通过，原连接已保留。');
      const next: VaultSailSettings = { ...DEFAULT_SETTINGS, providerId: 'baidu', appKey: config.appKey, appDirectory: provider.root,
        secretRef, sessionRef, transferConcurrency: this.settings.transferConcurrency, remotePollSeconds: this.settings.remotePollSeconds, ...(vault ? { remoteVaultId: vault.vaultId,
        binding: { vaultId: vault.vaultId, displayName: vault.displayName, appKey: config.appKey, root: provider.root, accountHash } } : {}) };
      await withConfigurationLock(this.app, async () => {
        guard(); options.onCommit?.();
        const credentials = new ObsidianCredentials(this.app);
        const previous = { ...this.settings, binding: this.settings.binding ? { ...this.settings.binding } : undefined };
        const oldAuth = this.auth; const oldSessionRef = this.sessionReference();
        let attemptedSave = false;
        try {
          advance('credentials');
          guard(); credentials.set(secretRef, staged.get(secretRef)!); credentials.set(sessionRef, staged.get(sessionRef)!);
          if (credentials.get(secretRef) !== staged.get(secretRef) || credentials.get(sessionRef) !== staged.get(sessionRef))
            throw new VaultSailError('credentials', '本设备密钥存储未成功，原连接已保留。');
          guard();
          advance('settings');
          validateAuthorizedPairing(payload); attemptedSave = true; await this.saveData(next); guard();
          advance('verification');
          const key = 'vaultsail-validation-' + hash(bytes(next.appKey + '|' + next.appDirectory + '|' + accountHash));
          this.app.saveLocalStorage(key, { passed: true, checkedAt: Date.now(), source: 'pairing-local-probe', results: [{ size: 1024, passed: true }], quota: '未验证' });
          advance('activation');
          guard(); this.engine?.pause(); oldAuth.cancel(); this.invalidateConnection(); this.engine = undefined;
          this.settings = next; this.auth = this.makeAuth(); this.deviceSession = undefined; this.authPhase = 'idle';
          this.progress = undefined; this.lastErrorCode = undefined; this.statusText = vault
            ? '配对成功，已连接并绑定云端库：' + vault.displayName + '。可以直接同步，无需再次网页登录。'
            : '账号连接已导入，无需再次网页登录。请为当前 Vault 创建或选择云端库；尚未绑定云端库，也未传输笔记。';
        } catch (error) {
          // New credential references make rollback possible without overwriting the old session.
          if (attemptedSave) {
            try { await this.saveData(previous); }
            catch { throw new VaultSailError('state', '导入保存失败，旧配置恢复未完成。两份凭据均已保留，请重新加载插件后检查连接。'); }
          }
          try { credentials.remove(secretRef); credentials.remove(sessionRef); } catch { /* Old credential references remain intact. */ }
          throw error;
        }
        // Delete only credentials owned by this device's plugin, never a user-selected shared secret.
        try {
          credentials.remove(oldSessionRef);
          if (ownsCredentialReference(previous.secretRef, 'app-secret', this.deviceId) && previous.secretRef !== secretRef) credentials.remove(previous.secretRef);
        } catch { /* Successful migration must not be undone by obsolete credential cleanup. */ }
      });
      new Notice(this.statusText, 9000);
    } catch (error) {
      if (error instanceof VaultSailError) throw new VaultSailError(error.code, PAIRING_STEPS[step] + '失败：' + error.message, error.retryable, error.retryAfter);
      // Native exceptions can contain URLs, tokens or secret values. Only expose a fixed stage and an allowlisted error class.
      const kind = error instanceof Error && ['TypeError', 'ReferenceError', 'RangeError', 'QuotaExceededError', 'SecurityError', 'NotSupportedError'].includes(error.name) ? '（' + error.name + '）' : '';
      throw new VaultSailError('pairing-' + step, PAIRING_STEPS[step] + '失败' + kind + '。请重试，并提供此步骤名称或脱敏诊断；不要发送配对码和密码。');
    } finally { for (const signal of signals) signal.removeEventListener('abort', cancel); auth.cancel(); staged.clear(); }
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
      lastErrorCode: this.lastErrorCode ?? null, localRoundtrip: checked ? { passed: checked.passed === true, checkedAt: checked.checkedAt,
        source: checked.source === 'pairing-local-probe' ? 'pairing-local-probe' : 'full-roundtrip', results: checked.results, quota: checked.quota } : null,
      lastTransfer: this.lastSuccess() ?? null,
      performance: this.performance.snapshot() ?? null,
      performanceNotes: '阶段为实际经过时间；请求耗时及重试等待为并发累计，不能相加当作总耗时。pending 表示原生请求结束尚未确认；failed 仅统计网络或 HTTP 错误。统计仅保留至插件重载。',
      requestLabels: REQUEST_LABELS,
      autoSyncEnabled: this.settings.autoSyncEnabled, remotePollSeconds: this.settings.remotePollSeconds, queueStatus: this.queueSummary(),
      lastPairingStep: this.lastPairingStep ?? null,
      realDeviceValidation: '用户在本设备完成；开发者未验证真实账号或 iPad', maxFileMiB: 20, transferConcurrency: this.settings.transferConcurrency }, null, 2);
  }
  performanceText(): string { return formatPerformance(this.performance.snapshot()); }

  async loadSettings(): Promise<void> {
    await withConfigurationLock(this.app, async () => {
      const stored: unknown = await this.loadData();
      this.settings = migrateSettings(stored);
      const directory = stored && typeof stored === 'object' ? (stored as Record<string, unknown>).appDirectory : undefined;
      if (typeof directory !== 'string' || !directory.trim()) await this.saveData(this.settings);
    });
  }
  async saveSettings(): Promise<void> { await withConfigurationLock(this.app, () => this.saveData(this.settings)); }
}
