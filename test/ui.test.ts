import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';

test('plugin UI renders usable Chinese authorization controls; settings contain references, never credentials', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
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
  assert.ok(document.body.textContent!.includes('尚未验证绑定')); assert.equal(document.querySelector('[data-secret-reference]')?.getAttribute('value'), 'own-secret');
  assert.equal(document.body.innerHTML.includes('never-render-private-secret'), false); await plugin.saveSettings(); assert.equal(JSON.stringify(plugin.saved).includes('must-be-stripped'), false);
  const authReplies = async (request: { url: string }) => ({ status: 200, headers: {}, bytes: new ArrayBuffer(0), json: request.url.includes('/device/code') ? { device_code: 'device', user_code: 'ABC123', verification_url: 'https://openapi.baidu.com/device', expires_in: 300, interval: 5 } : { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'netdisk' } });
  plugin.auth = new module.AuthManager(authReplies, { get: (key: string) => secretMap.get(key) ?? null, set: (key: string, value: string) => { secretMap.set(key, value); }, remove: (key: string) => { secretMap.delete(key); } }, () => ({ appKey: plugin.settings.appKey, secretRef: plugin.settings.secretRef, sessionRef: 'vaultsail-session-' + plugin.deviceId }), async () => {});
  Object.assign(globalThis, { mockRequest: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { errno: 0, uk: 1234 } }) });
  await plugin.run('connect', () => plugin.connect()); assert.equal(plugin.auth.status(), 'connected'); assert.equal(plugin.busy, false);
  assert.equal(document.body.innerHTML.includes('private-access'), false); assert.equal(JSON.stringify(plugin.saved).includes('private-refresh'), false);
  await plugin.changeConfiguration({ appKey: 'different-app' }); assert.equal(plugin.auth.status(), 'disconnected'); assert.equal(plugin.settings.binding, undefined);
  const local = new module.ObsidianLocalFiles(app, plugin.deviceId); const original = new TextEncoder().encode('before').buffer; const replacement = new TextEncoder().encode('after').buffer;
  files.set('note.md', original); const { hash, uuid } = await import('../src/core/safety.ts');
  const recoveryId = uuid(); await local.apply('note.md', replacement, hash(original), recoveryId); assert.equal(hash(await local.read('note.md')), hash(replacement));
  const points = await local.recoveryPoints(); assert.equal(points.length, 1); await local.restore(points[0]); assert.equal(hash(await local.read('note.md')), hash(original));
  const vaultId = uuid(); const stateStore = new module.ObsidianStateStore(app, plugin.deviceId, vaultId, 'test-context'); const state = await stateStore.load(); await stateStore.save(state);
  const opId = uuid(); state.knownOps.push(opId); failStateRename = true; await assert.rejects(stateStore.save(state)); const recovered = await stateStore.load(); assert.equal(recovered.knownOps.length, 0);
  await stateStore.save(state); assert.equal((await stateStore.load()).knownOps[0], opId);
  plugin.onunload();
});
