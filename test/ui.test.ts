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
  plugin.onunload();
});
