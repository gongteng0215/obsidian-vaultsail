import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultSailPlugin from '../main';
import { safeMessage } from '../core/safety';
import { RemoteVaultStore } from '../sync/remote-vault';
import { ConfirmModal } from './modals';
import { DEFAULT_APP_DIRECTORY } from '../config';
import { formatBytes, formatProgress, progressRunning } from '../sync/progress';
import { copyText } from './config-modals';
import { DEFAULT_TRANSFER_CONCURRENCY, MAX_TRANSFER_CONCURRENCY } from '../core/concurrency';

const AUTH_LABELS = { unconfigured: '应用未配置', disconnected: '未授权', pending: '等待授权', connected: '已授权', reauthorize: '需要重新授权' };
export class VaultSailSettingTab extends PluginSettingTab {
  private plugin: VaultSailPlugin;
  private activeTab = 'connect';
  constructor(app: App, plugin: VaultSailPlugin) { super(app, plugin); this.plugin = plugin; }
  updateProgress(): void {
    const p = this.plugin; const progress = p.progress;
    const running = Boolean(progress && progressRunning(progress));
    const status = this.containerEl.querySelector<HTMLElement>('.vaultsail-status-text');
    const summary = p.statusText === '操作完成。' && progress?.phase === 'failed'
      ? '上次任务未完成：' + (progress.message ?? '请恢复任务或重新同步。') : p.statusText;
    const notice = p.auth.configurationIssue() ?? summary;
    if (status && status.textContent !== notice) status.setText(notice);
    const card = this.containerEl.querySelector<HTMLElement>('.vaultsail-progress-card');
    card?.setAttribute('data-phase', progress?.phase ?? 'idle'); card?.setAttribute('aria-busy', String(running));
    const state = this.containerEl.querySelector<HTMLElement>('.vaultsail-progress-state');
    const stateLabel = running ? '进行中 · 实时更新' : progress?.phase === 'failed' ? '上次任务 · 已停止' : progress?.phase === 'paused' ? '上次任务 · 已暂停' : progress ? '上次任务' : '等待开始';
    if (state && state.textContent !== stateLabel) state.setText(stateLabel);
    const text = this.containerEl.querySelector<HTMLElement>('.vaultsail-progress-text');
    const meter = this.containerEl.querySelector<HTMLProgressElement>('.vaultsail-progress-meter');
    const detail = progress ? formatProgress(progress) : '点击开始同步，或先预览文件变化。';
    if (text && text.textContent !== detail) text.setText(detail);
    const queue = this.containerEl.querySelector<HTMLElement>('.vaultsail-queue-status');
    if (queue) queue.setText(p.queueSummary());
    const timing = this.containerEl.querySelector<HTMLElement>('.vaultsail-performance-text');
    const timingText = p.performanceText();
    if (timing) { timing.hidden = !timingText; if (timing.textContent !== timingText) timing.setText(timingText); }
    if (meter) {
      meter.max = Math.max(1, progress?.totalFiles ?? 1);
      if (running && !progress!.totalFiles) meter.removeAttribute('value');
      else meter.value = progress?.doneFiles ?? 0;
    }
    const actions = this.containerEl.querySelector<HTMLElement>('.vaultsail-progress-actions');
    if (actions) { actions.hidden = !progress || !['failed', 'paused'].includes(progress.phase); actions.querySelectorAll('button').forEach(button => { button.disabled = p.busy; }); }
  }
  display(): void {
    const el = this.containerEl; const p = this.plugin; el.empty();
    el.classList.add('vaultsail-workspace');
    const hero = el.createDiv({ cls: 'vaultsail-hero' });
    const brand = hero.createDiv({ cls: 'vaultsail-brand' });
    const mark = brand.createDiv({ cls: 'vaultsail-mark' }); mark.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 40 40');
    for (const shape of [{ d: 'M19 6v21H5L19 6Z', fill: 'currentColor' }, { d: 'M23 10v17h11L23 10Z', fill: 'currentColor', opacity: '0.55' }, { d: 'M5 30h30l-6 6H11l-6-6Z', fill: 'currentColor' }]) {
      const path = document.createElementNS(svg.namespaceURI, 'path'); for (const [key, value] of Object.entries(shape)) path.setAttribute(key, value); svg.appendChild(path);
    }
    mark.appendChild(svg);
    const title = brand.createDiv({ cls: 'vaultsail-brand-copy' }); title.createEl('span', { text: 'YOUR VAULT, EVERY CLOUD', cls: 'vaultsail-eyebrow' });
    title.createEl('span', { text: 'VaultSail · 云舟', cls: 'vaultsail-brand-name' });
    new Setting(title).setName('连接与同步').setHeading().setClass('vaultsail-brand-heading');
    title.createEl('p', { text: '让笔记，随你远航。' });
    const badge = hero.createEl('span', { cls: 'vaultsail-badge', text: AUTH_LABELS[p.auth.status()] }); badge.setAttribute('data-status', p.auth.status());
    const route = hero.createDiv({ cls: 'vaultsail-route' });
    route.createEl('span', { text: this.app.vault.getName(), cls: 'vaultsail-route-local' }); route.createEl('span', { text: '→', cls: 'vaultsail-route-arrow' });
    route.createEl('span', { text: p.settings.binding?.displayName ?? '等待连接云端', cls: 'vaultsail-route-cloud' });
    const metrics = el.createDiv({ cls: 'vaultsail-metrics' });
    for (const [label, value] of [['本地知识库', this.app.vault.getName()], ['云端目标', p.settings.binding ? '已绑定 · 百度网盘' : '尚未绑定'], ['当前版本', p.manifest.version]]) {
      const metric = metrics.createDiv({ cls: 'vaultsail-metric' }); metric.createEl('span', { text: label }); metric.createEl('strong', { text: value });
    }
    const status = el.createDiv({ cls: 'vaultsail-notice' }); status.setAttribute('role', 'status');
    status.createEl('span', { cls: 'vaultsail-status-text' });
    const progressCard = el.createDiv({ cls: 'vaultsail-progress-card' });
    progressCard.createEl('span', { cls: 'vaultsail-progress-state' });
    progressCard.createEl('p', { cls: 'vaultsail-progress-text' }); progressCard.createEl('progress', { cls: 'vaultsail-progress-meter' }).setAttribute('aria-label', '文件处理进度');
    progressCard.createEl('p', { cls: 'vaultsail-performance-text' }).setAttribute('aria-label', '同步耗时统计');
    const progressActions = progressCard.createDiv({ cls: 'vaultsail-progress-actions' });
    new Setting(progressActions)
      .addButton(button => button.setButtonText('恢复未完成任务').onClick(() => { void p.run('核验并恢复任务…', () => p.recover()); }))
      .addButton(button => button.setButtonText('重新同步').onClick(() => { void p.run('正在同步…', () => p.startSync()); }));
    this.updateProgress();
    const nav = el.createDiv({ cls: 'vaultsail-tabs' }); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '云舟工作台');
    const panels = new Map<string, HTMLElement>(); const tabs = new Map<string, HTMLButtonElement>();
    const views = [['connect', '01', '连接与授权'], ['vault', '02', '云端知识库'], ['transfer', '03', '传输与恢复']];
    const selectTab = (id: string) => {
      this.activeTab = id;
      for (const [key, panel] of panels) panel.hidden = key !== id;
      for (const [key, button] of tabs) { button.setAttribute('aria-selected', String(key === id)); button.tabIndex = key === id ? 0 : -1; }
    };
    for (const [id, number, label] of views) {
      const button = nav.createEl('button', { cls: 'vaultsail-tab' }); button.setAttribute('role', 'tab'); button.id = 'vaultsail-tab-' + id;
      button.setAttribute('aria-controls', 'vaultsail-panel-' + id); button.createEl('span', { text: number }); button.createEl('strong', { text: label }); tabs.set(id, button);
      button.addEventListener('click', () => selectTab(id));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = views.findIndex(view => view[0] === this.activeTab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + views.length) % views.length;
        selectTab(views[next][0]); tabs.get(views[next][0])?.focus();
      });
      const panel = el.createDiv({ cls: 'vaultsail-panel' }); panel.id = 'vaultsail-panel-' + id; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); panels.set(id, panel);
    }
    const card = (parent: HTMLElement, label: string, heading: string, description: string) => {
      const result = parent.createDiv({ cls: 'vaultsail-card' }); result.createEl('span', { text: label, cls: 'vaultsail-eyebrow' });
      new Setting(result).setName(heading).setHeading().setClass('vaultsail-card-heading');
      result.createEl('p', { text: description, cls: 'vaultsail-card-intro' }); return result;
    };
    const columns = panels.get('connect')!.createDiv({ cls: 'vaultsail-connect-grid' });
    const appCard = card(columns, 'APPLICATION', '接入你的网盘', '一次保存应用信息，之后在百度官方页面登录。账号密码不在这里输入。');
    const authCard = card(columns, 'CONNECTION', '启程，连接百度', '首台设备授权，也可以导入电脑的加密连接。笔记直接传到你的网盘。');
    const accessCard = card(panels.get('connect')!, 'CHECKPOINT', '连接之后，验证通路', '先检查访问，再验证校验文件能否完整往返。');
    const configCard = card(panels.get('connect')!, 'PAIRING', '在其他 Vault 使用账号', '默认只迁移应用配置和百度授权，不携带云端库绑定。每个 Vault 单独创建或选择云端库；同步同一库时再明确选择复用。');
    const vaultCard = card(panels.get('vault')!, 'DESTINATION', '为这份知识，选择一个泊位', '云端库 ID 用来配对设备，本地笔记库可以有不同名称。');
    const transferCard = card(panels.get('transfer')!, 'WORKSPACE', '先看清变化，再开始传输', `20 MiB / 文件 · 最多 ${p.settings.transferConcurrency} 个文件同时传输 · 并发改动自动保留双方副本。`);
    const recoveryCard = card(panels.get('transfer')!, 'RECOVERY', '每一次修改，都有回程', '未完成的任务可以恢复，旧内容以恢复副本保留。');
    const advanced = panels.get('transfer')!.createEl('details', { cls: 'vaultsail-advanced' }); advanced.createEl('summary', { text: '实验功能与诊断' });
    const advancedCard = advanced.createDiv({ cls: 'vaultsail-card' });
    selectTab(this.activeTab);
    if (!p.settings.binding) new Setting(transferCard).setName('先选择云端知识库').setDesc('目录已配置不代表库已绑定。首次使用创建新库；已有其他设备时选择同一个云端库。')
      .addButton(button => button.setButtonText('前往云端知识库').onClick(() => selectTab('vault')));
    new Setting(appCard).setName('云端服务').addDropdown(dropdown => dropdown.addOption('none', '未配置').addOption('baidu', '百度网盘').setValue(p.settings.providerId)
      .setDisabled(p.busy).onChange(value => { void p.changeConfiguration({ providerId: value as 'none' | 'baidu' }).catch(error => new Notice(safeMessage(error))); }));
    const guide = new Setting(appCard).setName('应用接入').setDesc('使用自己的百度应用。已有 AppKey 和 SecretKey，可直接填写。');
    guide.addButton(button => button.setButtonText('打开百度开放平台').onClick(() => window.open('https://yun.baidu.com/open/platform', '_blank', 'noopener,noreferrer')));
    const saveField = (name: string, key: 'appKey' | 'appDirectory', placeholder: string, description: string) => {
      let draft = p.settings[key];
      const field = new Setting(appCard).setName(name).setDesc(description);
      field
        .addText(text => text.setValue(draft).setPlaceholder(placeholder).setDisabled(p.busy).onChange(value => { draft = value.trim(); field.setDesc(draft === p.settings[key] ? description : '有修改尚未保存。'); }))
        .addButton(button => button.setButtonText('保存').setDisabled(p.busy).onClick(() => { void p.run('保存配置…', async () => {
          const value = key === 'appDirectory' ? draft || DEFAULT_APP_DIRECTORY : draft;
          if (value !== p.settings[key]) await p.changeConfiguration({ [key]: value });
        }); }));
    };
    saveField('AppKey', 'appKey', '粘贴应用 AppKey', p.settings.appKey ? '已保存。修改后需重新连接。' : '尚未保存。');
    let secret = ''; let secretInput: HTMLInputElement;
    const secretSaved = p.settings.secretRef && !p.settings.secretRef.startsWith('vaultsail-session-') && Boolean(this.app.secretStorage.getSecret(p.settings.secretRef)?.trim());
    const secretField = new Setting(appCard).setName('SecretKey').setDesc(secretSaved ? '已保存至本地密钥存储。输入新值可替换。' : p.settings.secretRef ? '旧密钥关联无效或为空，请重新保存一次。' : '尚未保存；输入后点击保存密钥。');
    secretField.addText(text => { secretInput = text.inputEl; text.inputEl.type = 'password'; text.inputEl.autocomplete = 'new-password';
      text.setPlaceholder(secretSaved ? '已保存 · 输入新值以更换' : '粘贴应用 SecretKey').setDisabled(p.busy).onChange(value => { secret = value; secretField.setDesc('密钥尚未保存，请点击保存密钥。'); }); })
      .addButton(button => button.setButtonText('保存密钥').setDisabled(p.busy).onClick(() => { const value = secret; secret = ''; secretInput.value = ''; void p.run('保存密钥…', () => p.saveAppSecret(value)); }));
    saveField('应用目录', 'appDirectory', DEFAULT_APP_DIRECTORY, '默认 /apps/VaultSail。可修改为应用实际获准的目录；留空保存会恢复默认。');
    new Setting(authCard).setName('百度账号授权').setDesc(p.authPhase === 'idle' ? AUTH_LABELS[p.auth.status()] : p.statusText)
      .addButton(button => button.setButtonText(p.authPhase === 'requesting' ? '正在申请授权…' : p.authPhase === 'waiting' ? '等待浏览器授权…' : '连接百度网盘').setCta().setDisabled(p.busy || p.settings.providerId !== 'baidu').onClick(() => { void p.run('申请设备授权…', () => p.connect()); }))
      .addButton(button => button.setButtonText('取消授权').setDisabled(p.authPhase === 'idle').onClick(() => p.cancelAuthorization()))
      .addButton(button => button.setButtonText('断开本地连接').onClick(() => { void p.disconnect().then(() => p.refreshUI()).catch(error => new Notice(safeMessage(error))); }));
    if (p.deviceSession) {
      const session = p.deviceSession;
      const prompt = authCard.createDiv({ cls: 'vaultsail-device-prompt' }); prompt.setAttribute('role', 'status');
      prompt.createEl('p', { text: p.browserRequested ? '请到浏览器的百度官方页面完成授权。' : '请点击下面的按钮打开百度授权页面。' });
      prompt.createEl('strong', { text: session.userCode, cls: 'vaultsail-device-code' });
      new Setting(prompt).setName('设备验证码').setDesc(`请在 ${new Date(session.expiresAt).toLocaleTimeString()} 前输入上面的验证码。`)
        .addButton(button => button.setButtonText('打开官方授权页面').onClick(() => window.open(session.verificationUrl, '_blank', 'noopener,noreferrer')));
    }
    if (p.auth.fallbackAllowed) {
      let code = '';
      new Setting(authCard).setName('备用授权码方式').setDesc('应用明确不支持设备码时可尝试。授权码仅用于本次交换，不保存。')
        .addButton(button => button.setButtonText('打开百度授权').onClick(() => window.open(p.auth.codeUrl(), '_blank', 'noopener,noreferrer')))
        .addText(text => { text.inputEl.type = 'password'; text.setPlaceholder('粘贴本次授权码').onChange(value => { code = value; }); })
        .addButton(button => button.setButtonText('完成授权').setDisabled(p.busy).onClick(() => { void p.run('交换授权码…', async () => { const input = code; code = ''; await p.auth.exchangeCode(input); }); }));
    }
    new Setting(authCard).setName('管理授权').setDesc('本地断开后，百度端授权可在账号管理页撤销。')
      .addButton(button => button.setButtonText('打开百度账号授权管理').onClick(() => window.open('https://passport.baidu.com/accountbind', '_blank', 'noopener,noreferrer')));
    new Setting(accessCard).setName('接口验证').setDesc('往返校验使用独立校验文件，不扫描笔记。')
      .addButton(button => button.setButtonText('检查只读访问').setDisabled(p.busy).onClick(() => { void p.run('检查身份与目录…', () => p.checkAccess()); }))
      .addButton(button => button.setButtonText('验证文件传输').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '验证文件传输权限', '将在获准应用目录下创建独立校验目录并上传、下载约 24 MiB 校验数据。校验文件会保留，供你自行检查和清理。', () => p.run('验证真实文件接口…', () => p.roundtrip())).open()));
    new Setting(configCard).setName('另一设备快速配置')
      .addButton(button => button.setButtonText('导出配对配置').setDisabled(p.busy).onClick(() => p.openConfigExport()))
      .addButton(button => button.setButtonText('导入配对配置').setDisabled(p.busy).onClick(() => p.openConfigImport()));
    new Setting(vaultCard).setName('百度网盘中的位置').setDesc(p.cloudLocation())
      .addButton(button => button.setButtonText('复制云端路径').onClick(() => copyText(p.cloudLocation())))
      .addButton(button => button.setButtonText('查看云端文件').setDisabled(p.busy).onClick(() => { void p.run('读取云端文件版本…', () => p.showCloudFiles()); }));
    const success = p.lastSuccess();
    new Setting(vaultCard).setName('最近一次传输完成').setDesc(success ? `${new Date(success.completedAt).toLocaleString()} · 处理 ${success.files} 个文件 · 校验内容 ${formatBytes(success.bytes)} · 耗时 ${(success.elapsedMs / 1000).toFixed(1)} 秒` : '本设备尚无当前云端库的已完成传输记录。');
    if (!p.settings.binding && p.settings.remoteVaultId) new Setting(vaultCard).setName('待验证的云端库').setDesc(`${p.settings.pendingVaultName ?? ''} · ${p.settings.remoteVaultId}`)
      .addButton(button => button.setButtonText('验证并绑定导入库').setDisabled(p.busy || p.auth.status() !== 'connected').onClick(() => { void p.run('验证导入的云端库…', () => p.bind(p.settings.remoteVaultId)); }));
    new Setting(vaultCard).setName('当前云端库').setDesc(p.settings.binding ? `已绑定：${p.settings.binding.displayName} · ${p.settings.binding.vaultId}` : `尚未验证绑定${p.settings.remoteVaultId ? '；原设置保留为待验证标识' : ''}`)
      .addButton(button => button.setButtonText('查看已有库').setDisabled(p.busy).onClick(() => { void p.run('读取云端库…', async () => {
        const vaults = await new RemoteVaultStore(p.provider()).listVaults(); const modal = new Modal(this.app); modal.titleEl.setText('选择云端库');
        if (!vaults.length) modal.contentEl.createEl('p', { text: '还没有云端库，可返回设置创建。' });
        for (const vault of vaults) new Setting(modal.contentEl).setName(vault.displayName).setDesc(vault.vaultId)
          .addButton(button => button.setButtonText('绑定').onClick(() => { void p.run('验证并绑定…', async () => { await p.bind(vault.vaultId); modal.close(); }); }));
        modal.open();
      }); }));
    let name = this.app.vault.getName();
    new Setting(vaultCard).setName('创建新云端库').setDesc('创建独立空间，随后由你预览并选择传输内容。')
      .addText(text => text.setValue(name).onChange(value => { name = value; }))
      .addButton(button => button.setButtonText('创建并绑定').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '创建云端库', '将在获准应用目录下创建新库：' + name, () => p.run('创建云端库…', () => p.createVault(name))).open()));
    new Setting(transferCard).setName('双向同步').setDesc('根据上次成功的基线自动判断上传与下载。双方改动自动保留原笔记和冲突副本；删除默认关闭。')
      .addButton(button => button.setButtonText('开始同步').setCta().onClick(() => { p.requestSync(); }))
      .addButton(button => button.setButtonText('先看同步清单').setDisabled(p.busy).onClick(() => { void p.run('扫描双向变更…', () => p.preview('sync')); }));
    new Setting(transferCard).setName('自动同步').setDesc('保存后安静 2 秒同步，连续编辑最多合并 15 秒；前台定期检查其他设备的版本。升级后需主动开启。')
      .addToggle(toggle => toggle.setValue(p.settings.autoSyncEnabled).setDisabled(p.busy).onChange(value => { void p.setAutomatic(value).catch(error => { toggle.setValue(p.settings.autoSyncEnabled); new Notice(safeMessage(error)); }); }));
    let interval = String(p.settings.remotePollSeconds);
    new Setting(transferCard).setName('远端检查间隔（秒）').setDesc('30–300 秒，默认 60。执行任务时不叠加检查，后台挂起时暂停。')
      .addText(text => text.setValue(interval).setDisabled(p.busy).onChange(value => { interval = value; }))
      .addButton(button => button.setButtonText('保存检查间隔').setDisabled(p.busy).onClick(() => { void p.setAutomatic(p.settings.autoSyncEnabled, Number(interval)).catch(error => new Notice(safeMessage(error))); }));
    transferCard.createEl('p', { cls: 'vaultsail-queue-status', text: p.queueSummary() }).setAttribute('role', 'status');
    new Setting(transferCard).setName('待解决冲突').setDesc('查看各版本、逐块合并或保留为两篇；确认后其他设备自动接收解决版本。')
      .addButton(button => button.setButtonText('查看待解决冲突').setDisabled(p.busy).onClick(() => p.openConflicts()));
    let concurrencyDraft = String(p.settings.transferConcurrency);
    const concurrencySetting = new Setting(transferCard).setName('同时传输的文件数')
      .setDesc(`可自行输入 1–${MAX_TRANSFER_CONCURRENCY} 之间的整数，默认 ${DEFAULT_TRANSFER_CONCURRENCY}。大附件自动减少同时传输数量，修改不影响账号或云端库绑定。`);
    concurrencySetting.addText(text => {
      text.inputEl.type = 'number'; text.inputEl.min = '1'; text.inputEl.max = String(MAX_TRANSFER_CONCURRENCY); text.inputEl.step = '1';
      text.inputEl.setAttribute('inputmode', 'numeric'); text.inputEl.setAttribute('aria-label', '传输并发数');
      text.setValue(concurrencyDraft).setPlaceholder(String(DEFAULT_TRANSFER_CONCURRENCY)).setDisabled(p.busy).onChange(value => {
        concurrencyDraft = value; concurrencySetting.setDesc('有修改尚未保存，请点击保存并发数。');
      });
    }).addButton(button => button.setButtonText('保存并发数').setDisabled(p.busy).onClick(() => {
      void p.setTransferConcurrency(Number(concurrencyDraft)).catch(error => new Notice(safeMessage(error)));
    })).addButton(button => button.setButtonText(`恢复默认 ${DEFAULT_TRANSFER_CONCURRENCY}`).setDisabled(p.busy).onClick(() => {
      void p.setTransferConcurrency(DEFAULT_TRANSFER_CONCURRENCY).catch(error => new Notice(safeMessage(error)));
    }));
    new Setting(transferCard).setName('单向传输').setDesc('也可只上传或只下载；冲突会自动保存双方副本。')
      .addButton(button => button.setButtonText('预览上传').setDisabled(p.busy).onClick(() => { void p.run('扫描上传清单…', () => p.preview('upload')); }))
      .addButton(button => button.setButtonText('预览下载').setDisabled(p.busy).onClick(() => { void p.run('扫描下载清单…', () => p.preview('download')); }))
      .addButton(button => button.setButtonText('恢复未完成任务').setDisabled(p.busy).onClick(() => { void p.run('核验并恢复任务…', () => p.recover()); }));
    new Setting(recoveryCard).setName('旧任务遇到新的编辑').setDesc('保留内容与恢复点，结束旧任务，然后重新预览双方差异。')
      .addButton(button => button.setButtonText('结束旧任务并重新预览').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '结束旧任务', '未完成操作停止重试，所有已保存内容保留。下一次预览会重新判断双方差异。', () => p.run('结束旧任务…', () => p.abandonPending())).open()));
    new Setting(advancedCard).setName('实验性删除传播').setDesc('默认关闭。开启后显示删除选项，本地保留恢复副本，云端保留历史对象。')
      .addToggle(toggle => toggle.setValue(p.settings.experimentalSync).setDisabled(p.busy).onChange(async value => {
        p.settings.experimentalSync = value; if (!value) p.settings.deletionEnabled = false; await p.saveSettings(); p.refreshUI();
      }));
    if (p.settings.experimentalSync) {
      new Setting(advancedCard).setName('预览双向同步').addButton(button => button.setButtonText('预览').setDisabled(p.busy).onClick(() => { void p.run('扫描双向变更…', () => p.preview('sync')); }));
      new Setting(advancedCard).setName('传播明确删除').setDesc('默认关闭；本地保留恢复副本，云端不永久清理。')
        .addToggle(toggle => toggle.setValue(p.settings.deletionEnabled).setDisabled(p.busy).onChange(value => {
          if (!value) { p.settings.deletionEnabled = false; void p.saveSettings(); return; }
          toggle.setValue(false); new ConfirmModal(this.app, '开启删除传播', '实验功能：同步预览可以包含本地删除和远端删除记录。执行前仍需确认清单。', async () => { p.settings.deletionEnabled = true; await p.saveSettings(); p.refreshUI(); }).open();
        }));
    }
    new Setting(recoveryCard).setName('恢复历史').setDesc('先备份当前内容，再恢复所选版本。')
      .addButton(button => button.setButtonText('查看恢复点').setDisabled(p.busy).onClick(() => { void p.run('读取恢复点…', async () => {
        const points = await p.local.recoveryPoints(); const modal = new Modal(this.app); modal.titleEl.setText('本设备恢复点');
        if (!points.length) modal.contentEl.createEl('p', { text: '还没有恢复点。' });
        for (const point of points) new Setting(modal.contentEl).setName(point.slice(p.local.internal.length + '/recovery/'.length))
          .addButton(button => button.setButtonText('恢复').onClick(() => new ConfirmModal(this.app, '恢复此版本', '将先备份当前文件，再恢复所选内容。', () => p.run('恢复文件…', async () => { await p.local.restore(point); modal.close(); })).open()));
        modal.open();
      }); }));
    new Setting(advancedCard).setName('诊断信息').setDesc('报告不含账号、文件名、凭据或笔记正文。')
      .addButton(button => button.setButtonText('查看脱敏报告').onClick(() => { const modal = new Modal(this.app); modal.titleEl.setText('脱敏诊断'); modal.contentEl.createEl('pre', { text: p.diagnostics() }); modal.open(); }))
      .addButton(button => button.setButtonText('暂停当前任务').onClick(() => { p.pause(); new Notice('已请求暂停，当前网络请求结束后生效。'); }));
    el.createEl('p', { cls: 'vaultsail-footer', text: '你的笔记直接传到自己的网盘 · 凭据保存在本设备' });
  }
}
