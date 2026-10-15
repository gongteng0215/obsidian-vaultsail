import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';

test('plugin UI renders usable Chinese authorization controls; settings contain references, never credentials', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  const openedUrls: string[] = []; window.open = (url: string) => { openedUrls.push(url); return null; };
  Object.assign(globalThis, { document, window });
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.empty = function(this: HTMLElement) { this.replaceChildren(); };
  proto.setText = function(this: HTMLElement, value: string) { this.textContent = value; };
  proto.createEl = function(this: HTMLElement, tag: string, options?: { text?: string; cls?: string }) { const el = this.appendChild(document.createElement(tag)); el.textContent = options?.text ?? ''; if (options?.cls) el.className = options.cls; return el; };
  proto.createDiv = function(this: HTMLElement, options?: { cls?: string }) { const el = this.appendChild(document.createElement('div')); if (options?.cls) el.className = options.cls; return el; };
  const result = await build({ stdin: { contents: "export { default as Plugin } from './src/main.ts'; export { AuthManager } from './src/auth/auth-manager.ts'; export { ObsidianLocalFiles, ObsidianStateStore } from './src/platform/obsidian-adapters.ts'; export { TFile, Modal } from 'obsidian';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'obsidian-harness', setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve('test/fixtures/obsidian.ts') })); } }] });
  mkdirSync('dist/test', { recursive: true }); const harnessPath = path.resolve('dist/test/ui-harness.mjs');
  writeFileSync(harnessPath, result.outputFiles[0].text); const module = await import(pathToFileURL(harnessPath).href);
  const secretMap = new Map([['own-secret', 'never-render-private-secret']]); const localMap = new Map<string, unknown>(); const files = new Map<string, ArrayBuffer>(); const dirs = new Set<string>();
  let failStateRename = false;
  const adapter = {
    exists: async (p: string) => files.has(p) || dirs.has(p),
    stat: async (p: string) => files.has(p) ? { type: 'file', size: files.get(p)!.byteLength } : dirs.has(p) ? { type: 'folder', size: 0 } : null,
    mkdir: async (p: string) => { dirs.add(p); }, readBinary: async (p: string) => files.get(p)!.slice(0), writeBinary: async (p: string, data: ArrayBuffer) => { files.set(p, data.slice(0)); },
    remove: async (p: string) => { files.delete(p); }, rename: async (from: string, to: string) => { if (failStateRename && from.endsWith('.next')) { failStateRename = false; throw new Error('crash'); } assert.equal(files.has(to), false); files.set(to, files.get(from)!); files.delete(from); },
    list: async (p: string) => ({ files: [...files.keys()].filter(key => key.startsWith(p + '/') && !key.slice(p.length + 1).includes('/')), folders: [...dirs].filter(key => key.startsWith(p + '/') && !key.slice(p.length + 1).includes('/')) }),
  };
  const vaultEvents = new Map<string, ((file: { path: string }, oldPath?: string) => void)[]>();
  const app = {
    secretStorage: { getSecret: (key: string) => secretMap.get(key) ?? null, setSecret: (key: string, value: string) => {
      // Match Obsidian's actual SecretStorage.validateId contract, including its length cap.
      if (!/^[a-z0-9-]+$/.test(key) || key.length > 64) throw new Error('Secret ID is invalid. 64 characters max.');
      secretMap.set(key, value);
    } },
    loadLocalStorage: (key: string) => localMap.get(key) ?? null, saveLocalStorage: (key: string, value: unknown) => { localMap.set(key, value); },
    workspace: { on: () => ({}), onLayoutReady: (callback: () => void) => callback() },
    vault: { configDir: '.obsidian', adapter, getName: () => '测试笔记库', getFiles: () => [...files].filter(([p]) => !p.startsWith('.')).map(([p, data]) => new module.TFile(p, data.byteLength)),
      on: (name: string, callback: (file: { path: string }, oldPath?: string) => void) => { vaultEvents.set(name, [...vaultEvents.get(name) ?? [], callback]); return {}; },
      getAbstractFileByPath: (p: string) => files.has(p) ? new module.TFile(p, files.get(p)!.byteLength) : dirs.has(p) ? { path: p } : null,
      readBinary: async (file: { path: string }) => files.get(file.path)!.slice(0), modifyBinary: async (file: { path: string }, data: ArrayBuffer) => { files.set(file.path, data.slice(0)); },
      process: async (file: { path: string }, update: (text: string) => string) => { const text = update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(file.path)!)); files.set(file.path, new TextEncoder().encode(text).buffer);
        for (const callback of vaultEvents.get('modify') ?? []) callback(new module.TFile(file.path, files.get(file.path)!.byteLength)); },
      createBinary: async (p: string, data: ArrayBuffer) => { assert.equal(files.has(p), false); files.set(p, data.slice(0)); }, createFolder: async (p: string) => { dirs.add(p); }, trash: async (file: { path: string }) => { files.delete(file.path); } },
  };
  const plugin = new module.Plugin(app); plugin.saved = { providerId: 'baidu', appKey: 'my-app', secretRef: 'own-secret', appDirectory: '/apps/test', remoteVaultId: 'legacy-name', access_token: 'must-be-stripped' };
  await plugin.onload(); plugin.tabs[0].display();
  const buttons = () => [...document.querySelectorAll('button')].map(button => button.textContent);
  for (const label of ['连接百度网盘', '验证文件传输', '创建并绑定', '预览上传', '预览下载', '恢复未完成任务']) assert.ok(buttons().includes(label));
  assert.ok(document.body.textContent!.includes('尚未验证绑定'));
  assert.equal(document.querySelector('input[type=password]')?.getAttribute('placeholder'), '已保存 · 输入新值以更换');
  const panels = [...document.querySelectorAll('[role=tabpanel]')]; assert.equal(panels.length, 3); assert.equal(panels.filter(panel => !panel.hasAttribute('hidden')).length, 1);
  (document.querySelector('#vaultsail-tab-transfer') as HTMLElement).click();
  assert.equal(document.querySelector('#vaultsail-panel-transfer')?.hasAttribute('hidden'), false);
  plugin.tabs[0].display(); assert.equal(document.querySelector('#vaultsail-tab-transfer')?.getAttribute('aria-selected'), 'true');
  assert.equal(document.body.innerHTML.includes('never-render-private-secret'), false); await plugin.saveSettings(); assert.equal(JSON.stringify(plugin.saved).includes('must-be-stripped'), false);
  const authReplies = async (request: { url: string }) => ({ status: 200, headers: {}, bytes: new ArrayBuffer(0), json: request.url.includes('/device/code') ? { device_code: 'device', user_code: 'ABC123', verification_url: 'https://openapi.baidu.com/device', expires_in: 300, interval: 5 } : { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'netdisk' } });
  plugin.auth = new module.AuthManager(authReplies, { get: (key: string) => secretMap.get(key) ?? null, set: (key: string, value: string) => { secretMap.set(key, value); }, remove: (key: string) => { secretMap.delete(key); } }, () => ({ appKey: plugin.settings.appKey, secretRef: plugin.settings.secretRef, sessionRef: 'vaultsail-session-' + plugin.deviceId }), async () => {});
  Object.assign(globalThis, { mockRequest: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { errno: 0, uk: 1234 } }) });
  await plugin.run('connect', () => plugin.connect()); assert.equal(plugin.auth.status(), 'connected'); assert.equal(plugin.busy, false);
  assert.deepEqual(openedUrls, ['https://openapi.baidu.com/device']); assert.equal(plugin.authPhase, 'idle');
  assert.equal(document.body.innerHTML.includes('private-access'), false); assert.equal(JSON.stringify(plugin.saved).includes('private-refresh'), false);
  const originalProvider = plugin.provider; const remoteObjects = new Map<string, ArrayBuffer>(); let providerCalls = 0;
  const fakeProvider = { root: '/apps/test', profile: async () => ({ accountId: '1234', label: 'test' }),
    listAll: async () => [],
    mkdir: async () => {}, writeImmutable: async (key: string, data: ArrayBuffer) => { remoteObjects.set(key, data.slice(0)); },
    read: async (key: string) => { assert.ok(remoteObjects.has(key)); return remoteObjects.get(key)!.slice(0); },
    exists: async () => true,
    list: async (dir: string) => {
      const entries = new Map<string, { path: string; isDirectory: boolean; size: number }>();
      for (const [key, data] of remoteObjects) if (key.startsWith(dir + '/')) {
        const suffix = key.slice(dir.length + 1); const isDirectory = suffix.includes('/'); const path = dir + '/' + suffix.split('/')[0];
        entries.set(path, { path, isDirectory, size: isDirectory ? 0 : data.byteLength });
      }
      return { complete: true, objects: [...entries.values()] };
    },
  };
  plugin.provider = () => { providerCalls++; return fakeProvider; };
  const setupButton = (label: string) => [...document.querySelectorAll('button')].filter(button => button.textContent === label).at(-1)!;
  setupButton('前往云端知识库').click(); assert.equal(document.querySelector('#vaultsail-tab-vault')?.getAttribute('aria-selected'), 'true');
  await plugin.run('preview', () => plugin.preview('upload'));
  assert.equal(providerCalls, 0, 'missing binding must guide setup before accessing remote content');
  assert.ok(document.body.textContent!.includes('先选择一个云端知识库'));
  // The setup wizard creates only cloud metadata after explicit confirmation, never transfers notes.
  [...document.querySelectorAll('button')].filter(button => button.textContent === '创建并绑定').at(-1)!.click();
  assert.equal(remoteObjects.size, 0); setupButton('确认').click();
  for (let i = 0; i < 80 && !plugin.settings.binding; i++) await Promise.resolve();
  for (let i = 0; i < 80 && plugin.busy; i++) await Promise.resolve();
  assert.ok(plugin.settings.binding); assert.equal(plugin.settings.binding.displayName, '测试笔记库');
  assert.equal(plugin.settings.binding.root, '/apps/test'); assert.equal(remoteObjects.size, 1); assert.equal(files.size, 0);
  for (let i = 0; i < 80 && !document.body.textContent!.includes('云端库已绑定。请先验证文件传输'); i++) await Promise.resolve();
  assert.ok(document.body.textContent!.includes('云端库已绑定。请先验证文件传输'));
  setupButton('完成').click();
  await plugin.run('preview', () => plugin.preview('upload'));
  assert.match(plugin.statusText, /文件传输权限验证/); assert.equal(document.body.textContent!.includes('先选择一个云端知识库'), false);
  plugin.settings.binding.accountHash = 'different-account';
  await plugin.run('preview', () => plugin.preview('upload')); assert.match(plugin.statusText, /百度账号与原绑定不一致/);
  setupButton('查看已有库').click();
  for (let i = 0; i < 80 && ![...document.querySelectorAll('button')].some(button => button.textContent === '绑定此库'); i++) await Promise.resolve();
  for (let i = 0; i < 80 && plugin.busy; i++) await Promise.resolve();
  for (let i = 0; i < 80 && setupButton('绑定此库')?.disabled; i++) await Promise.resolve();
  const existingId = plugin.settings.binding.vaultId; setupButton('绑定此库').click();
  for (let i = 0; i < 80 && plugin.busy; i++) await Promise.resolve();
  for (let i = 0; i < 80 && !document.body.textContent!.includes('云端库已绑定。请先验证文件传输'); i++) await Promise.resolve();
  assert.equal(plugin.settings.binding.vaultId, existingId); assert.notEqual(plugin.settings.binding.accountHash, 'different-account');
  setupButton('完成').click(); plugin.provider = originalProvider;
  await plugin.changeConfiguration({ appKey: 'different-app' }); assert.equal(plugin.auth.status(), 'disconnected'); assert.equal(plugin.settings.binding, undefined);
  assert.equal(secretMap.has('vaultsail-session-' + plugin.deviceId), false, 'missing session should not create an empty selectable secret');
  await plugin.saveAppSecret('replacement-private-secret');
  assert.equal(plugin.settings.secretRef, 'vaultsail-app-secret-' + plugin.deviceId);
  assert.equal(secretMap.get(plugin.settings.secretRef), 'replacement-private-secret'); assert.equal(plugin.auth.configurationIssue(), null);
  assert.equal(JSON.stringify(plugin.saved).includes('replacement-private-secret'), false);
  const privateStore = { get: (key: string) => secretMap.get(key) ?? null, set: (key: string, value: string) => { secretMap.set(key, value); }, remove: (key: string) => { secretMap.delete(key); } };
  const waiting = (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  plugin.auth = new module.AuthManager(authReplies, privateStore, () => ({ appKey: plugin.settings.appKey, secretRef: plugin.settings.secretRef, sessionRef: 'vaultsail-session-' + plugin.deviceId }), waiting);
  (document.querySelector('#vaultsail-tab-connect') as HTMLElement).click();
  const findButton = (label: string) => [...document.querySelectorAll('button')].find(button => button.textContent === label)!;
  findButton('连接百度网盘').click();
  for (let i = 0; i < 40 && plugin.authPhase !== 'waiting'; i++) await Promise.resolve();
  assert.equal(plugin.authPhase, 'waiting'); assert.equal(openedUrls.length, 2); assert.equal(document.querySelector('.vaultsail-device-code')?.textContent, 'ABC123');
  assert.equal(findButton('等待浏览器授权…').disabled, true); assert.equal(findButton('取消授权').disabled, false);
  plugin.pause(); assert.match(plugin.statusText, /百度授权页/);
  findButton('取消授权').click(); for (let i = 0; i < 40 && plugin.busy; i++) await Promise.resolve();
  assert.equal(plugin.busy, false); assert.equal(plugin.authPhase, 'idle');
  window.open = () => { throw new Error('browser unavailable'); };
  findButton('连接百度网盘').click(); for (let i = 0; i < 40 && plugin.authPhase !== 'waiting'; i++) await Promise.resolve();
  assert.equal(plugin.browserRequested, false); assert.ok(findButton('打开官方授权页面')); assert.match(document.body.textContent!, /浏览器未能自动打开/);
  findButton('取消授权').click(); for (let i = 0; i < 40 && plugin.busy; i++) await Promise.resolve();
  assert.equal(plugin.busy, false);
  const local = new module.ObsidianLocalFiles(app, plugin.deviceId); const original = new TextEncoder().encode('before').buffer; const replacement = new TextEncoder().encode('after').buffer;
  files.set('note.md', original); const { hash, uuid } = await import('../src/core/safety.ts');
  const recoveryId = uuid(); await local.apply('note.md', replacement, hash(original), recoveryId); assert.equal(hash(await local.read('note.md')), hash(replacement));
  const points = await local.recoveryPoints(); assert.equal(points.length, 1); await local.restore(points[0]); assert.equal(hash(await local.read('note.md')), hash(original));
  const vaultId = uuid(); const stateStore = new module.ObsidianStateStore(app, plugin.deviceId, vaultId, 'test-context'); const state = await stateStore.load(); await stateStore.save(state);
  const opId = uuid(); state.knownOps.push(opId); failStateRename = true; await assert.rejects(stateStore.save(state)); const recovered = await stateStore.load(); assert.equal(recovered.knownOps.length, 0);
  await stateStore.save(state); assert.equal((await stateStore.load()).knownOps[0], opId);
  plugin.settings.binding = { vaultId: existingId, appKey: plugin.settings.appKey, root: '/apps/test', accountHash: hash(new TextEncoder().encode('1234').buffer), displayName: '测试笔记库' };
  plugin.settings.remoteVaultId = existingId; plugin.provider = () => fakeProvider; plugin.tabs[0].display();
  assert.ok(document.body.textContent!.includes('我的应用数据/test/vaultsail/vaults/' + existingId));
  const { exportPortableConfig } = await import('../src/portable-config.ts');
  const exported = exportPortableConfig(plugin.settings, true);
  assert.equal(JSON.parse(exported).remoteVault.id, existingId); assert.equal(exported.includes(plugin.settings.secretRef), false);
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh']) assert.equal(exported.includes(secret), false);
  plugin.auth.restoreSession({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 });
  findButton('导出配对配置').click();
  const pairingPassword = 'test-pairing-password';
  const enter = (label: string, text: string) => { const input = document.querySelector('input[aria-label="' + label + '"]') as HTMLInputElement; input.value = text; input.dispatchEvent(new window.Event('input')); };
  const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), 'async operation must complete'); };
  const toggleSetting = (label: string, checked?: boolean) => {
    const row = [...document.querySelectorAll('.setting-item')].filter(row => row.querySelector('label')?.textContent === label).at(-1)!;
    const input = row.querySelector('input[type=checkbox]') as HTMLInputElement;
    if (checked !== undefined) { input.checked = checked; input.dispatchEvent(new window.Event('change')); }
    return input;
  };
  enter('设置配对密码', pairingPassword); enter('确认配对密码', 'different-password'); findButton('生成加密配对码').click();
  assert.ok(document.body.textContent!.includes('两次输入的密码不一致'));
  enter('确认配对密码', pairingPassword); findButton('生成加密配对码').click();
  const codeInput = document.querySelector('textarea[aria-label="加密配对码"]') as HTMLTextAreaElement;
  await until(() => codeInput.value.startsWith('VSAIL:1:')); const accountOnlyCode = codeInput.value;
  const { decryptPairing } = await import('../src/encrypted-pairing.ts');
  assert.equal((await decryptPairing(accountOnlyCode, pairingPassword)).config.remoteVault, undefined);
  assert.equal(toggleSetting('同时导出当前云端库').checked, false);
  toggleSetting('同时导出当前云端库', true); assert.equal(codeInput.value, '', 'changing export scope invalidates the previous code');
  findButton('生成加密配对码').click(); await until(() => codeInput.value.startsWith('VSAIL:1:'));
  const encrypted = codeInput.value; assert.equal((await decryptPairing(encrypted, pairingPassword)).config.remoteVault!.id, existingId);
  for (const field of [codeInput, document.querySelector('input[aria-label="设置配对密码"]')!, document.querySelector('input[aria-label="确认配对密码"]')!]) {
    assert.equal(field.getAttribute('autocapitalize'), 'none'); assert.equal(field.getAttribute('autocorrect'), 'off'); assert.equal(field.getAttribute('spellcheck'), 'false');
  }
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh', pairingPassword]) assert.equal(encrypted.includes(secret), false);
  findButton('保存加密文件到库').click();
  for (let i = 0; i < 100 && ![...files.keys()].some(p => p.startsWith('VaultSail-配置/')); i++) await Promise.resolve();
  const exportPath = [...files.keys()].find(p => p.startsWith('VaultSail-配置/'))!; assert.ok(exportPath);
  assert.ok(exportPath.endsWith('.vaultsail')); assert.equal(new TextDecoder().decode(files.get(exportPath)!), encrypted);
  setupButton('关闭').click();
  const sourceBinding = plugin.settings.binding; const sourceRemoteId = plugin.settings.remoteVaultId;
  plugin.settings.binding = undefined; plugin.settings.remoteVaultId = '';
  const unboundAccountCode = await plugin.exportAuthorizedConfiguration(pairingPassword);
  assert.equal((await decryptPairing(unboundAccountCode, pairingPassword)).config.remoteVault, undefined);
  await assert.rejects(plugin.exportAuthorizedConfiguration(pairingPassword, true), { code: 'binding' });
  plugin.settings.binding = sourceBinding; plugin.settings.remoteVaultId = sourceRemoteId;
  const sourceSnapshot = JSON.stringify(plugin.saved); await assert.rejects(plugin.importConfiguration('{"access_token":"private"}'), { code: 'configuration' });
  assert.equal(JSON.stringify(plugin.saved), sourceSnapshot);
  const ipadStorage = new Map<string, unknown>(); const ipadApp = { ...app, loadLocalStorage: (key: string) => ipadStorage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => { ipadStorage.set(key, value); } };
  const ipad = new module.Plugin(ipadApp); await ipad.onload(); ipad.tabs[0].display(); assert.notEqual(ipad.deviceId, plugin.deviceId);
  // Use the same file-picking event that the mobile webview dispatches; no import runs until confirmation.
  setupButton('导入配对配置').click();
  const fileInput = document.querySelector('input[aria-label="选择配对配置文件"]') as HTMLInputElement;
  Object.defineProperty(fileInput, 'files', { value: [{ size: exported.length, text: async () => exported }], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  for (let i = 0; i < 80 && setupButton('检查并导入').disabled; i++) await Promise.resolve();
  assert.equal(toggleSetting('绑定配对码中的同一个云端库').checked, false);
  toggleSetting('绑定配对码中的同一个云端库', true);
  assert.equal(ipad.settings.appKey, ''); setupButton('检查并导入').click(); assert.equal(ipad.settings.appKey, '');
  setupButton('确认').click(); for (let i = 0; i < 100 && !ipad.settings.remoteVaultId; i++) await Promise.resolve();
  for (let i = 0; i < 100 && ipad.busy; i++) await Promise.resolve();
  assert.equal(ipad.settings.remoteVaultId, existingId); assert.equal(ipad.settings.binding, undefined); assert.equal(ipad.settings.secretRef, '');
  assert.equal(ipad.settings.experimentalSync, false); assert.equal(ipad.settings.deletionEnabled, false); assert.equal(ipad.auth.status(), 'unconfigured');
  assert.equal(ipad.deviceId === JSON.parse(exported).deviceId, false); assert.ok(document.body.textContent!.includes('验证并绑定导入库'));
  await ipad.saveAppSecret('ipad-own-private-secret'); ipad.auth = new module.AuthManager(authReplies, privateStore,
    () => ({ appKey: ipad.settings.appKey, secretRef: ipad.settings.secretRef, sessionRef: 'vaultsail-session-' + ipad.deviceId }), async () => {});
  await ipad.run('connect', () => ipad.connect()); assert.equal(ipad.auth.status(), 'connected'); ipad.provider = () => fakeProvider;
  await ipad.bind(ipad.settings.remoteVaultId); assert.equal(ipad.settings.binding.vaultId, existingId);
  await ipad.run('preview', () => ipad.preview('download')); assert.match(ipad.statusText, /文件传输权限验证/);
  assert.equal(ipad.lastSuccess(), undefined);
  const beforeImport = JSON.stringify(ipad.saved); const beforeSecret = secretMap.get(ipad.settings.secretRef); const oldSessionRef = 'vaultsail-session-' + ipad.deviceId;
  await assert.rejects(ipad.importConfiguration(encrypted, 'incorrect-password'), { code: 'decrypt' }); assert.equal(JSON.stringify(ipad.saved), beforeImport); assert.equal(ipad.auth.status(), 'connected');
  ipad.pairingProvider = () => ({ ...fakeProvider, profile: async () => { throw new TypeError('private-access https://example.invalid?secret=replacement-private-secret'); } });
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), (error: any) => {
    assert.equal(error.code, 'pairing-account'); assert.match(error.message, /验证百度账号失败（TypeError）/);
    for (const secret of ['private-access', 'replacement-private-secret', 'example.invalid']) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(JSON.stringify(ipad.saved), beforeImport); assert.equal(JSON.parse(ipad.diagnostics()).lastPairingStep, 'account');
  ipad.pairingProvider = () => ({ ...fakeProvider, profile: async () => ({ accountId: 'other-account' }) });
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), { code: 'binding' }); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  ipad.pairingProvider = () => ({ ...fakeProvider, read: async (p: string) => p.endsWith('pairing.bin') ? new ArrayBuffer(0) : fakeProvider.read(p) });
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), { code: 'integrity' }); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  ipad.pairingProvider = (_root: string, auth: any) => ({ ...fakeProvider, profile: async () => { assert.equal(await auth.accessToken(), 'private-access'); return fakeProvider.profile(); } });
  const savedSetSecret = ipadApp.secretStorage.setSecret;
  ipadApp.secretStorage.setSecret = (key: string, value: string) => {
    if (key.startsWith('vaultsail-session-') && key !== oldSessionRef && value) throw new Error('native key storage rejected private-refresh');
    savedSetSecret(key, value);
  };
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), (error: any) => {
    assert.equal(error.code, 'pairing-credentials'); assert.match(error.message, /保存本机密钥失败/); assert.equal(error.message.includes('private-refresh'), false); return true;
  });
  assert.equal(JSON.stringify(ipad.saved), beforeImport); assert.equal(secretMap.get(ipad.settings.secretRef), beforeSecret); assert.equal(ipad.auth.status(), 'connected');
  assert.equal(JSON.parse(ipad.diagnostics()).lastPairingStep, 'credentials'); ipadApp.secretStorage.setSecret = savedSetSecret;
  const originalSave = ipad.saveData.bind(ipad); let failSave = true;
  ipad.saveData = async (value: unknown) => { await originalSave(value); if (failSave) { failSave = false; throw new Error('simulated partial disk failure'); } };
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword)); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  assert.equal(secretMap.get(ipad.settings.secretRef), beforeSecret); assert.ok(secretMap.get(oldSessionRef)); assert.equal(ipad.auth.status(), 'connected');
  ipad.saveData = originalSave;
  const browserCalls = openedUrls.length;
  const pairingReports: string[] = []; const originalImport = ipad.importConfiguration.bind(ipad);
  ipad.importConfiguration = (text: string, pass?: string, options: { bindRemoteVault?: boolean; report?: (message: string) => void } = {}) => originalImport(text, pass, { ...options, report: (message: string) => { pairingReports.push(message); options.report?.(message); } });
  setupButton('导入配对配置').click();
  const encryptedFile = [...document.querySelectorAll('input[aria-label="选择配对配置文件"]')].at(-1)! as HTMLInputElement;
  Object.defineProperty(encryptedFile, 'files', { value: [{ size: encrypted.length, text: async () => encrypted }], configurable: true }); encryptedFile.dispatchEvent(new window.Event('change'));
  await until(() => ([...document.querySelectorAll('textarea[aria-label="粘贴配对配置"]')].at(-1) as HTMLTextAreaElement).value === encrypted);
  const mobileInput = [...document.querySelectorAll('textarea[aria-label="粘贴配对配置"]')].at(-1)! as HTMLTextAreaElement;
  for (const field of [mobileInput, document.querySelector('input[aria-label="输入配对密码"]')!]) {
    assert.equal(field.getAttribute('autocapitalize'), 'none'); assert.equal(field.getAttribute('autocorrect'), 'off'); assert.equal(field.getAttribute('spellcheck'), 'false');
  }
  mobileInput.value = 'vsail:2:AAAA'; mobileInput.dispatchEvent(new window.Event('input'));
  assert.equal(setupButton('检查并导入').disabled, true); assert.match(document.body.textContent!, /加密配对码无效/);
  mobileInput.value = 'vsail:1:' + encrypted.slice('VSAIL:1:'.length).match(/.{1,64}/g)!.join('\r\n'); mobileInput.dispatchEvent(new window.Event('input'));
  toggleSetting('绑定配对码中的同一个云端库', true);
  enter('输入配对密码', pairingPassword); assert.equal(setupButton('检查并导入').disabled, false);
  setupButton('检查并导入').click(); await until(() => document.body.textContent!.includes('上传下载 1 KB'));
  setupButton('确认').click(); await until(() => !!ipad.settings.sessionRef && !ipad.busy);
  assert.equal(ipad.auth.status(), 'connected'); assert.equal(ipad.settings.binding.vaultId, existingId); assert.notEqual(ipad.settings.secretRef, plugin.settings.secretRef);
  assert.ok(ipad.settings.secretRef.length <= 64); assert.ok(ipad.settings.sessionRef.length <= 64);
  for (const stage of ['验证百度账号', '读取云端库', '上传校验文件', '下载校验文件', '保存本机密钥', '启用连接']) assert.ok(pairingReports.some(message => message.includes(stage)));
  assert.notEqual(ipad.deviceId, plugin.deviceId); assert.equal(openedUrls.length, browserCalls); assert.equal(ipad.settings.deletionEnabled, false);
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh', pairingPassword]) assert.equal(JSON.stringify(ipad.saved).includes(secret), false);
  assert.equal(ipad.auth.exportCredentials().session.accessToken, 'private-access'); assert.equal(plugin.auth.status(), 'connected');
  await ipad.run('preview', () => ipad.preview('download')); assert.equal(ipad.progress?.phase, 'preview-ready', 'successful pairing automatically verifies this device for transfer');
  const previousPairingRefs = [ipad.settings.secretRef, ipad.settings.sessionRef];
  await ipad.importConfiguration(encrypted, pairingPassword, { bindRemoteVault: true });
  assert.notEqual(ipad.settings.secretRef, previousPairingRefs[0]); assert.notEqual(ipad.settings.sessionRef, previousPairingRefs[1]);
  for (const ref of previousPairingRefs) assert.equal(Boolean(secretMap.get(ref)), false, 're-pairing removes only obsolete device-owned compact references');
  assert.equal(plugin.auth.status(), 'connected', 're-pairing must preserve the source device authorization');
  const restarted = new module.Plugin(ipadApp); restarted.saved = ipad.saved; await restarted.onload(); assert.equal(restarted.auth.status(), 'connected');
  assert.equal(restarted.deviceId, ipad.deviceId); assert.equal(restarted.auth.exportCredentials().session.accessToken, 'private-access'); restarted.onunload(); restarted.tabs[0].containerEl.remove();
  const copiedStorage = new Map<string, unknown>(); const copiedApp = { ...app, loadLocalStorage: (key: string) => copiedStorage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => { copiedStorage.set(key, value); } };
  const copied = new module.Plugin(copiedApp); copied.saved = ipad.saved; await copied.onload();
  assert.notEqual(copied.deviceId, ipad.deviceId); assert.equal(copied.auth.status(), 'disconnected', 'copying settings must not reuse another device session reference');
  assert.equal(ipad.auth.status(), 'connected'); copied.onunload(); copied.tabs[0].containerEl.remove();
  ipad.onunload(); ipad.tabs[0].containerEl.remove();
  // Another vault can reuse the account without adopting the source vault, even with an old full pairing code.
  for (const code of [accountOnlyCode, unboundAccountCode, encrypted]) {
    const targetStorage = new Map<string, unknown>(); const targetApp = { ...app, loadLocalStorage: (key: string) => targetStorage.get(key) ?? null,
      saveLocalStorage: (key: string, value: unknown) => { targetStorage.set(key, value); } };
    const target = new module.Plugin(targetApp); await target.onload(); target.tabs[0].display();
    await target.importConfiguration(exported);
    assert.equal(target.settings.remoteVaultId, ''); assert.equal(target.settings.pendingVaultName, undefined);
    const targetBefore = JSON.stringify(target.saved);
    if (code !== encrypted) await assert.rejects(target.importConfiguration(code, pairingPassword, { bindRemoteVault: true }), { code: 'configuration' });
    assert.equal(JSON.stringify(target.saved), targetBefore);
    const importedReads: string[] = [];
    target.pairingProvider = () => ({ ...fakeProvider, read: async (path: string) => { importedReads.push(path); return fakeProvider.read(path); },
      list: async (path: string) => { importedReads.push(path); return fakeProvider.list(path); } });
    const localBefore = [...files].map(([path, data]) => [path, hash(data)]);
    const browserBefore = openedUrls.length;
    target.openConfigImport(); assert.equal(toggleSetting('绑定配对码中的同一个云端库').checked, false);
    const targetInput = [...document.querySelectorAll('textarea[aria-label="粘贴配对配置"]')].at(-1)! as HTMLTextAreaElement;
    targetInput.value = code; targetInput.dispatchEvent(new window.Event('input')); enter('输入配对密码', pairingPassword);
    setupButton('检查并导入').click(); await until(() => document.body.textContent!.includes('清除当前云端目标设置'));
    setupButton('确认').click(); await until(() => !!target.settings.sessionRef && !target.busy);
    assert.equal(target.auth.status(), 'connected'); assert.equal(target.settings.remoteVaultId, ''); assert.equal(target.settings.binding, undefined);
    assert.equal(target.settings.pendingVaultName, undefined); assert.equal(JSON.stringify(target.saved).includes(existingId), false);
    assert.equal(openedUrls.length, browserBefore); assert.deepEqual([...files].map(([path, data]) => [path, hash(data)]), localBefore);
    assert.ok(importedReads.every(path => !path.startsWith('vaultsail/vaults/')), 'account-only import must not inspect the source vault');
    await assert.rejects(target.preview('upload'), { code: 'binding' });
    target.provider = () => fakeProvider;
    const sourceObjects = [...remoteObjects].filter(([path]) => path.startsWith('vaultsail/vaults/' + existingId + '/')).map(([path, data]) => [path, hash(data)]);
    await target.createVault('另一个 Vault'); const independentId = target.settings.remoteVaultId; assert.notEqual(independentId, existingId);
    await target.run('正在同步…', () => target.startSync()); assert.ok([...remoteObjects.keys()].some(path => path.startsWith('vaultsail/vaults/' + independentId + '/ops/')));
    assert.match(target.statusText, /同步完成：上传 \d+ 个，下载 \d+ 个，失败 0 项/);
    assert.deepEqual([...remoteObjects].filter(([path]) => path.startsWith('vaultsail/vaults/' + existingId + '/')).map(([path, data]) => [path, hash(data)]), sourceObjects);
    const targetRestarted = new module.Plugin(targetApp); targetRestarted.saved = target.saved; await targetRestarted.onload();
    assert.equal(targetRestarted.auth.status(), 'connected'); assert.equal(targetRestarted.settings.remoteVaultId, independentId);
    targetRestarted.onunload(); targetRestarted.tabs[0].containerEl.remove(); target.onunload(); target.tabs[0].containerEl.remove();
  }
  // Execute a real engine plan through its UI and check progress plus local success metadata.
  localMap.set('vaultsail-validation-' + hash(new TextEncoder().encode(plugin.settings.appKey + '|' + plugin.settings.appDirectory + '|' + plugin.settings.binding.accountHash).buffer), { passed: true });
  plugin.tabs[0].display(); await plugin.run('preview', () => plugin.preview('upload'));
  setupButton('执行清单（冲突自动保留双方）').click(); for (let i = 0; i < 1000 && plugin.busy; i++) await Promise.resolve();
  assert.equal(plugin.busy, false); assert.equal(plugin.progress?.phase, 'completed'); assert.ok(plugin.lastSuccess());
  assert.equal(plugin.lastSuccess()!.bytes, files.get('note.md')!.byteLength);
  assert.ok(document.body.textContent!.includes('已校验内容')); assert.equal(plugin.diagnostics().includes('note.md'), false);
  await plugin.run('files', () => plugin.showCloudFiles()); assert.ok(document.body.textContent!.includes('note.md'));
  assert.ok(document.body.textContent!.includes('/blobs/' + hash(files.get('note.md')!)));
  assert.equal([...remoteObjects.keys()].some(p => p.includes('VaultSail-配置')), false, 'exported pairing files must never become remote notes');
  const beforeSync = remoteObjects.size; files.set('note.md', new TextEncoder().encode('edited locally').buffer);
  setupButton('开始同步').click(); await until(() => !plugin.busy && remoteObjects.size > beforeSync);
  assert.equal(plugin.busy, false); assert.equal(plugin.progress?.phase, 'completed'); assert.ok(remoteObjects.size > beforeSync);
  const afterSync = remoteObjects.size; setupButton('开始同步').click(); await until(() => !plugin.busy && !plugin.queue.state.manual);
  assert.equal(remoteObjects.size, afterSync); assert.equal(plugin.settings.experimentalSync, false, 'normal sync must be available without the deletion experiment');
  const originalNote = files.get('note.md')!;
  await local.writeConflictCopy('note.md', 'local-test', originalNote); assert.equal(hash((await local.readConflictCopy('note.md', 'local-test'))!), hash(originalNote));
  assert.equal([...remoteObjects.keys()].some(p => p.includes('VaultSail-conflicts')), false);
  const bindingBeforeConcurrency = structuredClone(plugin.settings.binding);
  const engineBeforeConcurrency = plugin.engine;
  await plugin.setTransferConcurrency(4); assert.equal(plugin.settings.transferConcurrency, 4); assert.equal(plugin.saved.transferConcurrency, 4);
  assert.equal(plugin.engine, engineBeforeConcurrency, 'changing concurrency must retain the current engine and preview context');
  assert.equal(plugin.auth.status(), 'connected'); assert.deepEqual(plugin.settings.binding, bindingBeforeConcurrency);
  plugin.busy = true; await assert.rejects(plugin.setTransferConcurrency(2), { code: 'busy' }); plugin.busy = false;
  assert.equal(plugin.settings.transferConcurrency, 4); await plugin.setTransferConcurrency(3);
  const concurrencyField = () => document.querySelector('input[aria-label="传输并发数"]') as HTMLInputElement;
  assert.equal(concurrencyField().type, 'number'); assert.equal(concurrencyField().getAttribute('inputmode'), 'numeric');
  concurrencyField().value = '12'; concurrencyField().dispatchEvent(new window.Event('input'));
  assert.equal(plugin.settings.transferConcurrency, 3, 'typing must not save an intermediate value');
  setupButton('保存并发数').click(); await until(() => plugin.saved.transferConcurrency === 12);
  assert.equal(plugin.settings.transferConcurrency, 12); assert.deepEqual(plugin.settings.binding, bindingBeforeConcurrency); assert.equal(plugin.auth.status(), 'connected');
  assert.equal(plugin.engine.concurrency, 12, 'custom input must update the retained execution engine');
  await until(() => concurrencyField().value === '12');
  concurrencyField().value = '2.5'; concurrencyField().dispatchEvent(new window.Event('input')); setupButton('保存并发数').click();
  await Promise.resolve(); assert.equal(plugin.settings.transferConcurrency, 12);
  setupButton('恢复默认 8').click(); await until(() => plugin.saved.transferConcurrency === 8); await until(() => concurrencyField().value === '8');
  // Drive the actual conflict inbox/editor, including persisted drafts and
  // a commit whose modal cannot close halfway through publication.
  const conflictOps = await plugin.engine.remote.revisions(plugin.settings.binding.vaultId);
  const parentIds = new Set(conflictOps.flatMap((op: any) => op.parents));
  const head = conflictOps.find((op: any) => op.path === 'note.md' && !parentIds.has(op.opId));
  const remoteConflict = new TextEncoder().encode('remote conflict body').buffer;
  await plugin.engine.remote.publish(plugin.settings.binding.vaultId, { ...head, opId: uuid(), deviceId: uuid(), parents: [head.opId], hash: hash(remoteConflict), size: remoteConflict.byteLength }, remoteConflict);
  files.set('note.md', new TextEncoder().encode('local conflict body').buffer);
  setupButton('查看待解决冲突').click(); await until(() => !!setupButton('对比与解决'));
  setupButton('对比与解决').click(); await until(() => !!document.querySelector('textarea[aria-label="合并结果"]'));
  const mergeInput = document.querySelector('textarea[aria-label="合并结果"]') as HTMLTextAreaElement;
  mergeInput.value = 'merged by user'; mergeInput.dispatchEvent(new window.Event('input'));
  const firstEditor = module.Modal.instances.at(-1); firstEditor.close();
  await until(() => [...files.keys()].some(path => path.includes('/drafts/') && path.endsWith('.json')));
  setupButton('对比与解决').click(); await until(() => (document.querySelector('textarea[aria-label="合并结果"]') as HTMLTextAreaElement)?.value === 'merged by user');
  const activeEditor = module.Modal.instances.at(-1);
  setupButton('全文已手动合并')?.click();
  const publishBeforeResolution = plugin.engine.remote.publish.bind(plugin.engine.remote); let releaseResolution!: () => void; let resolutionStarted = false;
  plugin.engine.remote.publish = async (...args: any[]) => { if (!resolutionStarted) { resolutionStarted = true; await new Promise<void>(resolve => { releaseResolution = resolve; }); } return publishBeforeResolution(...args); };
  setupButton('确认解决并同步').click(); setupButton('确认').click(); await until(() => resolutionStarted);
  activeEditor.close(); assert.equal(activeEditor.containerEl.isConnected, true, 'a committed resolution must not be presented as cancelled');
  releaseResolution(); await until(() => !activeEditor.containerEl.isConnected && !plugin.busy);
  assert.equal(new TextDecoder().decode(files.get('note.md')!), 'merged by user');
  await until(() => document.body.textContent!.includes('没有待解决冲突'));
  plugin.engine.remote.publish = publishBeforeResolution;
  // Local events enqueue work automatically; the UI does not need a Sync click.
  await plugin.setAutomatic(true); await plugin.queue.pump();
  const autoCount = remoteObjects.size; files.set('note.md', new TextEncoder().encode('automatic file edit').buffer);
  for (const callback of vaultEvents.get('modify') ?? []) callback(new module.TFile('note.md', files.get('note.md')!.byteLength));
  const autoNow = Date.now;
  try { const current = autoNow(); Date.now = () => current + 2500; await plugin.queue.pump(); }
  finally { Date.now = autoNow; }
  assert.ok(remoteObjects.size > autoCount); assert.equal(plugin.settings.autoSyncEnabled, true);
  const automaticOps = await plugin.engine.remote.revisions(plugin.settings.binding.vaultId), used = new Set(automaticOps.flatMap((op: any) => op.parents));
  const beforeDownload = automaticOps.find((op: any) => op.path === 'note.md' && !used.has(op.opId));
  const downloadedText = new TextEncoder().encode('received from another device').buffer;
  await plugin.engine.remote.publish(plugin.settings.binding.vaultId, { ...beforeDownload, opId: uuid(), deviceId: uuid(), parents: [beforeDownload.opId], hash: hash(downloadedText), size: downloadedText.byteLength }, downloadedText);
  const afterRemoteWrite = remoteObjects.size; plugin.queue.request('remote'); await plugin.queue.pump();
  assert.equal(new TextDecoder().decode(files.get('note.md')!), 'received from another device');
  assert.ok(plugin.queue.state.dirty['note.md'], 'native download writes also produce a queued modify event');
  try { const current = autoNow(); Date.now = () => current + 2500; await plugin.queue.pump(); } finally { Date.now = autoNow; }
  assert.equal(remoteObjects.size, afterRemoteWrite, 'plugin-created file events must not loop or publish another version');
  await plugin.setAutomatic(false); assert.equal(plugin.saved.autoSyncEnabled, false);
  let ready!: () => void;
  const delayedApp = { ...app, workspace: { on: () => ({}), onLayoutReady: (callback: () => void) => { ready = callback; } } };
  const delayed = new module.Plugin(delayedApp); delayed.saved = { ...structuredClone(plugin.saved), autoSyncEnabled: true }; delayed.provider = () => fakeProvider;
  await delayed.onload(); assert.equal(delayed.queue, undefined, 'automatic sync must wait for the complete initial vault layout');
  ready(); assert.ok(delayed.queue); delayed.onunload();
  // Exercise a real timer against the rendered view, including a pending file
  // request, failure, recovery actions and a new task replacing the old snapshot.
  const realNow = Date.now; const clock = realNow();
  try {
    Date.now = () => clock; plugin.busy = true; plugin.beginTransfer();
    plugin.publishProgress({ phase: 'uploading', path: 'pending.md', doneFiles: 1, totalFiles: 7, doneBytes: 1024, totalBytes: 8192, startedAt: clock, updatedAt: clock });
    const progressNode = document.querySelector('.vaultsail-progress-text')!;
    const draft = document.querySelector('input:not([type=password])') as HTMLInputElement; draft.value = 'unsaved-app-draft';
    Date.now = () => clock + 4000; await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(document.querySelector('.vaultsail-progress-text'), progressNode, 'heartbeats must update in place');
    assert.equal(draft.value, 'unsaved-app-draft', 'heartbeats must not rebuild settings or discard edits');
    assert.match(document.querySelector('.vaultsail-performance-text')!.textContent!, /传输处理 4.0 秒/);
    assert.match(document.querySelector('.vaultsail-performance-text')!.textContent!, /令牌刷新 0 次/);
    const timingReport = JSON.parse(plugin.diagnostics()).performance;
    assert.equal(timingReport.stages.transfer, 4000);
    assert.equal(JSON.stringify(timingReport).includes('pending.md'), false);
    assert.match(progressNode.textContent!, /耗时 4 秒/); assert.match(progressNode.textContent!, /已等待新进度 4 秒/);
    assert.match(progressNode.textContent!, /已处理 1\/7/); assert.match(document.querySelector('.vaultsail-status-text')!.textContent!, /上传笔记内容/);
    plugin.publishProgress({ ...plugin.progress, phase: 'failed', message: '网络请求超时，请检查网络后重试。', updatedAt: clock + 4000 });
    plugin.busy = false; plugin.statusText = '操作完成。'; plugin.refreshUI();
    assert.match(document.querySelector('.vaultsail-status-text')!.textContent!, /网络请求超时/);
    assert.match(document.querySelector('.vaultsail-progress-text')!.textContent!, /任务已停止/);
    assert.equal(document.querySelector('.vaultsail-progress-actions')!.hasAttribute('hidden'), false);
    assert.equal(plugin.progressTimer, undefined);
    Date.now = () => clock + 20000; plugin.tabs[0].updateProgress();
    assert.match(document.querySelector('.vaultsail-progress-text')!.textContent!, /耗时 4 秒/);
    plugin.beginTransfer();
    assert.equal(document.querySelector('.vaultsail-progress-meter')!.hasAttribute('value'), false);
    assert.equal(document.querySelector('.vaultsail-progress-text')!.textContent!.includes('网络请求超时'), false);
    plugin.publishProgress({ ...plugin.progress, phase: 'completed', updatedAt: Date.now() });
  } finally { Date.now = realNow; plugin.busy = false; }
  plugin.onunload();
});
