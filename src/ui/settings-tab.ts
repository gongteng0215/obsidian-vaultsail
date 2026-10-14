import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type VaultSailPlugin from '../main';
import { safeMessage, VaultSailError } from '../core/safety';
import { RemoteVaultStore } from '../sync/remote-vault';
import { ConfirmModal } from './modals';

const AUTH_LABELS = { unconfigured: '应用未配置', disconnected: '未授权', pending: '等待授权', connected: '已授权', reauthorize: '需要重新授权' };
export class VaultSailSettingTab extends PluginSettingTab {
  private plugin: VaultSailPlugin;
  constructor(app: App, plugin: VaultSailPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const el = this.containerEl; const p = this.plugin; el.empty();
    el.createEl('h2', { text: 'VaultSail · 云舟' });
    el.createEl('p', { text: '用户自行配置百度应用。密码只在百度官方页面输入；笔记直接传输到你的网盘。当前为预览版，真实账号和 iPad 尚未由开发者验证。' });
    new Setting(el).setName('连接状态').setDesc(`${AUTH_LABELS[p.auth.status()]} · ${p.statusText}`);
    new Setting(el).setName('云端服务').addDropdown(dropdown => dropdown.addOption('none', '未配置').addOption('baidu', '百度网盘').setValue(p.settings.providerId)
      .setDisabled(p.busy).onChange(value => { void p.changeConfiguration({ providerId: value as 'none' | 'baidu' }).catch(error => new Notice(safeMessage(error))); }));
    const guide = new Setting(el).setName('第一步：自己的百度应用').setDesc('百度账号用于登录，开放平台应用用于获得文件接口权限。申请结果以平台当前规则为准。');
    guide.addButton(button => button.setButtonText('打开百度开放平台').onClick(() => window.open('https://yun.baidu.com/open/platform', '_blank', 'noopener,noreferrer')));
    const saveField = (name: string, key: 'appKey' | 'appDirectory', placeholder: string, description: string) => {
      let draft = p.settings[key];
      new Setting(el).setName(name).setDesc(description)
        .addText(text => text.setValue(draft).setPlaceholder(placeholder).setDisabled(p.busy).onChange(value => { draft = value.trim(); }))
        .addButton(button => button.setButtonText('保存').setDisabled(p.busy).onClick(() => { void p.run('保存配置…', async () => { if (draft !== p.settings[key]) await p.changeConfiguration({ [key]: draft }); }); }));
    };
    saveField('AppKey', 'appKey', '自己的应用 AppKey / client_id', '保存变更会清除旧连接并要求重新绑定。');
    new Setting(el).setName('SecretKey 本地存储').setDesc('选择或创建自己的本地密钥；配置文件只保存引用。不会发送给开发者。')
      .addComponent(element => new SecretComponent(this.app, element).setValue(p.settings.secretRef).onChange(value => {
        if (p.busy) { new Notice('请等待当前操作完成再修改密钥引用。'); return; }
        void p.changeConfiguration({ secretRef: value ?? '' }).catch(error => new Notice(safeMessage(error)));
      }));
    saveField('获准应用目录', 'appDirectory', '/apps/你的实际应用名', '按实际获准目录填写，支持中文；插件只操作该目录下的隔离子目录。');
    new Setting(el).setName('第二步：登录并授权').setDesc('打开百度官方页面登录；各设备独立授权。')
      .addButton(button => button.setButtonText('连接百度网盘').setCta().setDisabled(p.busy || p.settings.providerId !== 'baidu').onClick(() => { void p.run('申请设备授权…', () => p.connect()); }))
      .addButton(button => button.setButtonText('取消授权').setDisabled(p.auth.status() !== 'pending').onClick(() => { p.auth.cancel(); p.deviceSession = undefined; p.refreshUI(); }))
      .addButton(button => button.setButtonText('断开本地连接').onClick(() => { void p.disconnect().then(() => p.refreshUI()).catch(error => new Notice(safeMessage(error))); }));
    if (p.deviceSession) {
      const session = p.deviceSession;
      new Setting(el).setName('百度授权验证码').setDesc(`${session.userCode} · 请在 ${new Date(session.expiresAt).toLocaleTimeString()} 前完成`)
        .addButton(button => button.setButtonText('打开官方授权页面').onClick(() => window.open(session.verificationUrl, '_blank', 'noopener,noreferrer')));
    }
    if (p.auth.fallbackAllowed) {
      let code = '';
      new Setting(el).setName('备用授权码方式').setDesc('应用明确不支持设备码时可尝试。授权码仅用于本次交换，不保存。')
        .addButton(button => button.setButtonText('打开百度授权').onClick(() => window.open(p.auth.codeUrl(), '_blank', 'noopener,noreferrer')))
        .addText(text => { text.inputEl.type = 'password'; text.setPlaceholder('粘贴本次授权码').onChange(value => { code = value; }); })
        .addButton(button => button.setButtonText('完成授权').setDisabled(p.busy).onClick(() => { void p.run('交换授权码…', async () => { const input = code; code = ''; await p.auth.exchangeCode(input); }); }));
    }
    new Setting(el).setName('撤销百度端授权').setDesc('断开本地连接不会自动撤销百度端授权，也不会删除网盘文件。')
      .addButton(button => button.setButtonText('打开百度账号授权管理').onClick(() => window.open('https://passport.baidu.com/accountbind', '_blank', 'noopener,noreferrer')));
    new Setting(el).setName('第三步：接口权限验证').setDesc('身份与目录检查只读；文件往返测试会创建 0 B、1 KB、4 MiB、20 MiB 的隔离测试文件，不扫描笔记。')
      .addButton(button => button.setButtonText('检查只读访问').setDisabled(p.busy).onClick(() => { void p.run('检查身份与目录…', () => p.checkAccess()); }))
      .addButton(button => button.setButtonText('运行文件往返测试').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '运行隔离文件测试', '将在获准应用目录下创建独立测试目录并上传、下载约 24 MiB 测试数据。测试文件会保留，供你自行检查和清理。', () => p.run('验证真实文件接口…', () => p.roundtrip())).open()));
    new Setting(el).setName('第四步：选择云端库').setDesc(p.settings.binding ? `已绑定：${p.settings.binding.displayName} · ${p.settings.binding.vaultId}` : `尚未验证绑定${p.settings.remoteVaultId ? '；原设置保留为待验证标识' : ''}`)
      .addButton(button => button.setButtonText('查看已有库').setDisabled(p.busy).onClick(() => { void p.run('读取云端库…', async () => {
        const vaults = await new RemoteVaultStore(p.provider()).listVaults(); const modal = new Modal(this.app); modal.titleEl.setText('选择云端库');
        if (!vaults.length) modal.contentEl.createEl('p', { text: '还没有云端库，可返回设置创建。' });
        for (const vault of vaults) new Setting(modal.contentEl).setName(vault.displayName).setDesc(vault.vaultId)
          .addButton(button => button.setButtonText('绑定').onClick(() => { void p.run('验证并绑定…', async () => { await p.bind(vault.vaultId); modal.close(); }); }));
        modal.open();
      }); }));
    let name = this.app.vault.getName();
    new Setting(el).setName('创建新云端库').setDesc('只创建插件管理的独立库，不上传本地笔记。')
      .addText(text => text.setValue(name).onChange(value => { name = value; }))
      .addButton(button => button.setButtonText('创建并绑定').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '创建云端库', '将在获准应用目录下创建新库：' + name, () => p.run('创建云端库…', () => p.createVault(name))).open()));
    new Setting(el).setName('第五步：手动传输').setDesc('先预览再执行；单文件上限 20 MiB、并发 1；不同内容的同名文件停在冲突。')
      .addButton(button => button.setButtonText('预览上传').setDisabled(p.busy).onClick(() => { void p.run('扫描上传清单…', () => p.preview('upload')); }))
      .addButton(button => button.setButtonText('预览下载').setDisabled(p.busy).onClick(() => { void p.run('扫描下载清单…', () => p.preview('download')); }))
      .addButton(button => button.setButtonText('恢复未完成任务').setDisabled(p.busy).onClick(() => { void p.run('核验并恢复任务…', () => p.recover()); }));
    new Setting(el).setName('恢复因内容变化而停止').setDesc('保留当前内容、暂存对象及恢复点，结束旧任务；已发布的远端版本继续存在，随后重新预览差异。')
      .addButton(button => button.setButtonText('结束旧任务并重新预览').setDisabled(p.busy).onClick(() => new ConfirmModal(this.app, '结束旧任务', '未完成操作停止重试，所有已保存内容保留。下一次预览会重新判断双方差异。', () => p.run('结束旧任务…', () => p.abandonPending())).open()));
    new Setting(el).setName('实验性双向同步').setDesc('版本图、基线和冲突保护已实现；当前尚未通过真实双设备验收。只用于测试库。')
      .addToggle(toggle => toggle.setValue(p.settings.experimentalSync).setDisabled(p.busy).onChange(async value => {
        p.settings.experimentalSync = value; if (!value) p.settings.deletionEnabled = false; await p.saveSettings(); p.refreshUI();
      }));
    if (p.settings.experimentalSync) {
      new Setting(el).setName('预览双向同步').addButton(button => button.setButtonText('预览').setDisabled(p.busy).onClick(() => { void p.run('扫描双向变更…', () => p.preview('sync')); }));
      new Setting(el).setName('传播明确删除').setDesc('默认关闭。开启后仅处理有基线及明确删除记录的文件，本地内容保留恢复副本，云端不永久清理。')
        .addToggle(toggle => toggle.setValue(p.settings.deletionEnabled).setDisabled(p.busy).onChange(value => {
          if (!value) { p.settings.deletionEnabled = false; void p.saveSettings(); return; }
          toggle.setValue(false); new ConfirmModal(this.app, '开启删除传播', '实验功能：同步预览可以包含本地删除和远端删除记录。执行前仍需确认清单。', async () => { p.settings.deletionEnabled = true; await p.saveSettings(); p.refreshUI(); }).open();
        }));
    }
    new Setting(el).setName('恢复历史').setDesc('恢复会先保存当前内容的副本。恢复点保存在本设备的插件内部目录，不上传云端。')
      .addButton(button => button.setButtonText('查看恢复点').setDisabled(p.busy).onClick(() => { void p.run('读取恢复点…', async () => {
        const points = await p.local.recoveryPoints(); const modal = new Modal(this.app); modal.titleEl.setText('本设备恢复点');
        if (!points.length) modal.contentEl.createEl('p', { text: '还没有恢复点。' });
        for (const point of points) new Setting(modal.contentEl).setName(point.slice(p.local.internal.length + '/recovery/'.length))
          .addButton(button => button.setButtonText('恢复').onClick(() => new ConfirmModal(this.app, '恢复此版本', '将先备份当前文件，再恢复所选内容。', () => p.run('恢复文件…', async () => { await p.local.restore(point); modal.close(); })).open()));
        modal.open();
      }); }));
    new Setting(el).setName('诊断信息').setDesc('不包含账号、文件名、密钥、令牌或笔记正文。')
      .addButton(button => button.setButtonText('查看脱敏报告').onClick(() => { const modal = new Modal(this.app); modal.titleEl.setText('脱敏诊断'); modal.contentEl.createEl('pre', { text: p.diagnostics() }); modal.open(); }))
      .addButton(button => button.setButtonText('暂停当前任务').onClick(() => { p.pause(); new Notice('已请求暂停，当前网络请求结束后生效。'); }));
  }
}
