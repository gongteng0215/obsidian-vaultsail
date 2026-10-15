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
  const result = await build({ stdin: { contents: "export { default as Plugin } from './src/main.ts'; export { AuthManager } from './src/auth/auth-manager.ts'; export { ObsidianLocalFiles, ObsidianStateStore } from './src/platform/obsidian-adapters.ts'; export { TFile } from 'obsidian';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false,
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
  const app = {
    secretStorage: { getSecret: (key: string) => secretMap.get(key) ?? null, setSecret: (key: string, value: string) => { secretMap.set(key, value); } },
    loadLocalStorage: (key: string) => localMap.get(key) ?? null, saveLocalStorage: (key: string, value: unknown) => { localMap.set(key, value); },
    workspace: { on: () => ({}) },
    vault: { configDir: '.obsidian', adapter, getName: () => '测试笔记库', getFiles: () => [...files].filter(([p]) => !p.startsWith('.')).map(([p, data]) => new module.TFile(p, data.byteLength)),
      getAbstractFileByPath: (p: string) => files.has(p) ? new module.TFile(p, files.get(p)!.byteLength) : dirs.has(p) ? { path: p } : null,
      readBinary: async (file: { path: string }) => files.get(file.path)!.slice(0), modifyBinary: async (file: { path: string }, data: ArrayBuffer) => { files.set(file.path, data.slice(0)); },
      process: async (file: { path: string }, update: (text: string) => string) => { const text = update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(file.path)!)); files.set(file.path, new TextEncoder().encode(text).buffer); },
      createBinary: async (p: string, data: ArrayBuffer) => { assert.equal(files.has(p), false); files.set(p, data.slice(0)); }, createFolder: async (p: string) => { dirs.add(p); }, trash: async (file: { path: string }) => { files.delete(file.path); } },
  };
  const plugin = new module.Plugin(app); plugin.saved = { providerId: 'baidu', appKey: 'my-app', secretRef: 'own-secret', appDirectory: '/apps/test', remoteVaultId: 'legacy-name', access_token: 'must-be-stripped' };
  await plugin.onload(); plugin.tabs[0].display();
  const buttons = () => [...document.querySelectorAll('button')].map(button => button.textContent);
  for (const label of ['连接百度网盘', '运行文件往返测试', '创建并绑定', '预览上传', '预览下载', '恢复未完成任务']) assert.ok(buttons().includes(label));
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
  for (let i = 0; i < 80 && !document.body.textContent!.includes('云端库已绑定。请先运行文件往返测试'); i++) await Promise.resolve();
  assert.ok(document.body.textContent!.includes('云端库已绑定。请先运行文件往返测试'));
  setupButton('完成').click();
  await plugin.run('preview', () => plugin.preview('upload'));
  assert.match(plugin.statusText, /文件往返测试/); assert.equal(document.body.textContent!.includes('先选择一个云端知识库'), false);
  plugin.settings.binding.accountHash = 'different-account';
  await plugin.run('preview', () => plugin.preview('upload')); assert.match(plugin.statusText, /百度账号与原绑定不一致/);
  setupButton('查看已有库').click();
  for (let i = 0; i < 80 && ![...document.querySelectorAll('button')].some(button => button.textContent === '绑定此库'); i++) await Promise.resolve();
  for (let i = 0; i < 80 && plugin.busy; i++) await Promise.resolve();
  for (let i = 0; i < 80 && setupButton('绑定此库')?.disabled; i++) await Promise.resolve();
  const existingId = plugin.settings.binding.vaultId; setupButton('绑定此库').click();
  for (let i = 0; i < 80 && plugin.busy; i++) await Promise.resolve();
  for (let i = 0; i < 80 && !document.body.textContent!.includes('云端库已绑定。请先运行文件往返测试'); i++) await Promise.resolve();
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
  const exported = exportPortableConfig(plugin.settings);
  assert.equal(JSON.parse(exported).remoteVault.id, existingId); assert.equal(exported.includes(plugin.settings.secretRef), false);
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh']) assert.equal(exported.includes(secret), false);
  plugin.auth.restoreSession({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 });
  findButton('导出配对配置').click();
  const pairingPassword = 'test-pairing-password';
  const enter = (label: string, text: string) => { const input = document.querySelector('input[aria-label="' + label + '"]') as HTMLInputElement; input.value = text; input.dispatchEvent(new window.Event('input')); };
  const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), 'async operation must complete'); };
  enter('设置配对密码', pairingPassword); enter('确认配对密码', 'different-password'); findButton('生成加密配对码').click();
  assert.ok(document.body.textContent!.includes('两次输入的密码不一致'));
  enter('确认配对密码', pairingPassword); findButton('生成加密配对码').click();
  const codeInput = document.querySelector('textarea[aria-label="加密配对码"]') as HTMLTextAreaElement;
  await until(() => codeInput.value.startsWith('VSAIL:1:')); const encrypted = codeInput.value;
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh', pairingPassword]) assert.equal(encrypted.includes(secret), false);
  findButton('保存加密文件到库').click();
  for (let i = 0; i < 100 && ![...files.keys()].some(p => p.startsWith('VaultSail-配置/')); i++) await Promise.resolve();
  const exportPath = [...files.keys()].find(p => p.startsWith('VaultSail-配置/'))!; assert.ok(exportPath);
  assert.ok(exportPath.endsWith('.vaultsail')); assert.equal(new TextDecoder().decode(files.get(exportPath)!), encrypted);
  setupButton('关闭').click();
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
  await ipad.run('preview', () => ipad.preview('download')); assert.match(ipad.statusText, /文件往返测试/);
  assert.equal(ipad.lastSuccess(), undefined);
  const beforeImport = JSON.stringify(ipad.saved); const beforeSecret = secretMap.get(ipad.settings.secretRef); const oldSessionRef = 'vaultsail-session-' + ipad.deviceId;
  await assert.rejects(ipad.importConfiguration(encrypted, 'incorrect-password'), { code: 'decrypt' }); assert.equal(JSON.stringify(ipad.saved), beforeImport); assert.equal(ipad.auth.status(), 'connected');
  ipad.pairingProvider = () => ({ ...fakeProvider, profile: async () => ({ accountId: 'other-account' }) });
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), { code: 'binding' }); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  ipad.pairingProvider = () => ({ ...fakeProvider, read: async (p: string) => p.endsWith('pairing.bin') ? new ArrayBuffer(0) : fakeProvider.read(p) });
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword), { code: 'integrity' }); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  ipad.pairingProvider = (_root: string, auth: any) => ({ ...fakeProvider, profile: async () => { assert.equal(await auth.accessToken(), 'private-access'); return fakeProvider.profile(); } });
  const originalSave = ipad.saveData.bind(ipad); let failSave = true;
  ipad.saveData = async (value: unknown) => { await originalSave(value); if (failSave) { failSave = false; throw new Error('simulated partial disk failure'); } };
  await assert.rejects(ipad.importConfiguration(encrypted, pairingPassword)); assert.equal(JSON.stringify(ipad.saved), beforeImport);
  assert.equal(secretMap.get(ipad.settings.secretRef), beforeSecret); assert.ok(secretMap.get(oldSessionRef)); assert.equal(ipad.auth.status(), 'connected');
  ipad.saveData = originalSave;
  const browserCalls = openedUrls.length;
  setupButton('导入配对配置').click();
  const encryptedFile = [...document.querySelectorAll('input[aria-label="选择配对配置文件"]')].at(-1)! as HTMLInputElement;
  Object.defineProperty(encryptedFile, 'files', { value: [{ size: encrypted.length, text: async () => encrypted }], configurable: true }); encryptedFile.dispatchEvent(new window.Event('change'));
  await until(() => ([...document.querySelectorAll('textarea[aria-label="粘贴配对配置"]')].at(-1) as HTMLTextAreaElement).value === encrypted);
  enter('输入配对密码', pairingPassword); setupButton('检查并导入').click(); await until(() => document.body.textContent!.includes('上传下载 1 KB'));
  setupButton('确认').click(); await until(() => !!ipad.settings.sessionRef && !ipad.busy);
  assert.equal(ipad.auth.status(), 'connected'); assert.equal(ipad.settings.binding.vaultId, existingId); assert.notEqual(ipad.settings.secretRef, plugin.settings.secretRef);
  assert.notEqual(ipad.deviceId, plugin.deviceId); assert.equal(openedUrls.length, browserCalls); assert.equal(ipad.settings.deletionEnabled, false);
  for (const secret of ['replacement-private-secret', 'private-access', 'private-refresh', pairingPassword]) assert.equal(JSON.stringify(ipad.saved).includes(secret), false);
  assert.equal(ipad.auth.exportCredentials().session.accessToken, 'private-access'); assert.equal(plugin.auth.status(), 'connected');
  await ipad.run('preview', () => ipad.preview('download')); assert.equal(ipad.progress?.phase, 'preview-ready', 'successful pairing automatically verifies this device for transfer');
  const restarted = new module.Plugin(ipadApp); restarted.saved = ipad.saved; await restarted.onload(); assert.equal(restarted.auth.status(), 'connected');
  assert.equal(restarted.deviceId, ipad.deviceId); assert.equal(restarted.auth.exportCredentials().session.accessToken, 'private-access'); restarted.onunload(); restarted.tabs[0].containerEl.remove();
  const copiedStorage = new Map<string, unknown>(); const copiedApp = { ...app, loadLocalStorage: (key: string) => copiedStorage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => { copiedStorage.set(key, value); } };
  const copied = new module.Plugin(copiedApp); copied.saved = ipad.saved; await copied.onload();
  assert.notEqual(copied.deviceId, ipad.deviceId); assert.equal(copied.auth.status(), 'disconnected', 'copying settings must not reuse another device session reference');
  assert.equal(ipad.auth.status(), 'connected'); copied.onunload(); copied.tabs[0].containerEl.remove();
  ipad.onunload(); ipad.tabs[0].containerEl.remove();
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
  setupButton('开始同步').click(); for (let i = 0; i < 1000 && plugin.busy; i++) await Promise.resolve();
  assert.equal(plugin.busy, false); assert.equal(plugin.progress?.phase, 'completed'); assert.ok(remoteObjects.size > beforeSync);
  const afterSync = remoteObjects.size; setupButton('开始同步').click(); for (let i = 0; i < 1000 && plugin.busy; i++) await Promise.resolve();
  assert.equal(remoteObjects.size, afterSync); assert.equal(plugin.settings.experimentalSync, false, 'normal sync must be available without the deletion experiment');
  const originalNote = files.get('note.md')!;
  await local.writeConflictCopy('note.md', 'local-test', originalNote); assert.equal(hash((await local.readConflictCopy('note.md', 'local-test'))!), hash(originalNote));
  assert.equal([...remoteObjects.keys()].some(p => p.includes('VaultSail-conflicts')), false);
  plugin.onunload();
});
