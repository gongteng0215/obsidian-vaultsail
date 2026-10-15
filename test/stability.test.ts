import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { encryptPairing, PAIRING_LIFETIME_MS } from '../src/encrypted-pairing.ts';
import { hash, bytes, uuid } from '../src/core/safety.ts';

const bundle = await build({ stdin: { contents: "export { default as Plugin } from './src/main.ts'; export { ConfigImportModal } from './src/ui/config-modals.ts'; export { VaultSailError } from './src/core/safety.ts';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, plugins: [{ name: 'obsidian-harness', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve('test/fixtures/obsidian.ts') }));
  } }] });
mkdirSync('dist/test', { recursive: true }); const target = path.resolve('dist/test/stability-harness.mjs');
writeFileSync(target, bundle.outputFiles[0].text);
const runtime = await import(pathToFileURL(target).href);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function until(predicate: () => boolean): Promise<void> { for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); } assert.fail('operation did not settle'); }
function fixture() {
  const { document, window } = parseHTML('<html><body></body></html>'); Object.assign(globalThis, { document, window });
  const proto = window.HTMLElement.prototype;
  proto.empty = function() { this.replaceChildren(); }; proto.setText = function(value: string) { this.textContent = value; };
  proto.createEl = function(tag: string, options: { text?: string; cls?: string } = {}) { const el = this.appendChild(document.createElement(tag)); el.textContent = options.text ?? ''; if (options.cls) el.className = options.cls; return el; };
  proto.createDiv = function(options = {}) { return this.createEl('div', options); };
  const secrets = new Map<string, string>([['original-secret', 'synthetic-secret']]); const storage = new Map<string, unknown>();
  const app = { secretStorage: { getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => { secrets.set(key, value); } },
    loadLocalStorage: (key: string) => storage.get(key) ?? null, saveLocalStorage: (key: string, value: unknown) => { storage.set(key, value); } };
  const disk: { settings?: any } = {}; const deviceId = uuid(); const objects = new Map<string, ArrayBuffer>();
  const provider = { root: '/apps/test', profile: async () => ({ accountId: '1234' }), listAll: async () => [],
    writeImmutable: async (key: string, data: ArrayBuffer) => { objects.set(key, data.slice(0)); }, read: async (key: string) => objects.get(key)!.slice(0) };
  const makePlugin = () => {
    const plugin = new runtime.Plugin(app); plugin.deviceId = deviceId;
    plugin.settings = { ...plugin.settings, providerId: 'baidu', appKey: 'original-app', secretRef: 'original-secret', appDirectory: '/apps/test' };
    plugin.auth = plugin.makeAuth(); plugin.pairingProvider = () => provider;
    plugin.saveData = async (value: unknown) => { disk.settings = structuredClone(value); };
    plugin.loadData = async () => structuredClone(disk.settings); return plugin;
  };
  const plugin = makePlugin(); plugin.auth.restoreSession({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000 });
  disk.settings = structuredClone(plugin.settings);
  const code = async () => { const now = Date.now(); return encryptPairing({ format: 'vaultsail-authorized', version: 1, createdAt: now, expiresAt: now + PAIRING_LIFETIME_MS,
    config: { format: 'vaultsail-pairing', version: 1, provider: 'baidu', appKey: 'imported-app', appDirectory: '/apps/test' },
    accountHash: hash(bytes('1234')), secretKey: 'synthetic-import-secret', session: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 3600000 } }, 'synthetic-password'); };
  return { plugin, makePlugin, app, disk, secrets, provider, code, document, window };
}

test('reload waits for old import rollback before reading settings or using staged credentials', async () => {
  const f = fixture(); const started = deferred(), finish = deferred();
  const original = f.plugin.saveData;
  f.plugin.saveData = async (value: any) => { await original(value); if (value.appKey === 'imported-app') { started.resolve(); await finish.promise; } };
  const importing = f.plugin.importConfiguration(await f.code(), 'synthetic-password');
  const rejected = assert.rejects(importing, { code: 'cancelled' }); await started.promise; f.plugin.onunload();
  const reloaded = f.makePlugin(); let loaded = false; const loading = reloaded.loadSettings().then(() => { loaded = true; });
  await tick(); assert.equal(loaded, false); finish.resolve(); await rejected; await loading;
  assert.equal(reloaded.settings.appKey, 'original-app'); reloaded.auth = reloaded.makeAuth(); assert.equal(reloaded.auth.status(), 'connected');
  assert.equal(f.disk.settings.appKey, 'original-app'); assert.equal([...f.secrets.values()].includes('synthetic-import-secret'), false);
});

test('failed rollback preserves both credential sets so a reloaded saved connection remains usable', async () => {
  const f = fixture(); const started = deferred(), finish = deferred(); const original = f.plugin.saveData;
  f.plugin.saveData = async (value: any) => {
    if (value.appKey === 'original-app') throw new Error('synthetic disk error');
    await original(value); started.resolve(); await finish.promise;
  };
  const rejected = assert.rejects(f.plugin.importConfiguration(await f.code(), 'synthetic-password'), { code: 'state' });
  await started.promise; f.plugin.onunload(); const reloaded = f.makePlugin(); const loading = reloaded.loadSettings(); finish.resolve(); await rejected; await loading;
  reloaded.auth = reloaded.makeAuth(); assert.equal(reloaded.settings.appKey, 'imported-app'); assert.equal(reloaded.auth.status(), 'connected');
  assert.equal(f.secrets.get('original-secret'), 'synthetic-secret'); assert.equal(f.secrets.get(reloaded.settings.secretRef), 'synthetic-import-secret');
});

test('an invalidated import cannot roll back over a newer user configuration', async () => {
  const f = fixture(); const started = deferred(), finish = deferred(); const original = f.plugin.saveData;
  f.plugin.saveData = async (value: any) => { await original(value); if (value.appKey === 'imported-app') { started.resolve(); await finish.promise; } };
  const rejected = assert.rejects(f.plugin.importConfiguration(await f.code(), 'synthetic-password'), { code: 'cancelled' });
  await started.promise; const changing = f.plugin.changeConfiguration({ appKey: 'new-user-app' }); finish.resolve();
  await rejected; await changing;
  assert.equal(f.disk.settings.appKey, 'new-user-app'); assert.equal(f.plugin.settings.appKey, 'new-user-app');
  assert.equal([...f.secrets.values()].includes('synthetic-import-secret'), false);
});

async function openImport(f: ReturnType<typeof fixture>) {
  const modal = new runtime.ConfigImportModal(f.app, (text: string, password: string, options: any) => f.plugin.importConfiguration(text, password, options)); modal.open();
  const input = modal.contentEl.querySelector('textarea'); input.value = await f.code(); input.dispatchEvent(new f.window.Event('input'));
  const password = modal.contentEl.querySelector('input[type=password]'); password.value = 'synthetic-password'; password.dispatchEvent(new f.window.Event('input'));
  [...modal.contentEl.querySelectorAll('button')].find((button: any) => button.textContent === '检查并导入').click();
  await until(() => [...f.document.querySelectorAll('h2')].some(el => el.textContent === '确认导入连接'));
  const confirmation = [...f.document.querySelectorAll('h2')].find(el => el.textContent === '确认导入连接')!.parentElement!;
  const button = (text: string) => [...confirmation.querySelectorAll('button')].find(el => el.textContent === text)!;
  button('确认').click(); return { modal, confirmation, button };
}

test('Cancel during account verification aborts the real import and preserves the old connection', async () => {
  const f = fixture(); const started = deferred(), finish = deferred(); const previous = JSON.stringify(f.disk.settings);
  f.plugin.pairingProvider = () => ({ ...f.provider, profile: async () => { started.resolve(); await finish.promise; return { accountId: '1234' }; } });
  const ui = await openImport(f); await started.promise; ui.button('取消').click(); finish.resolve();
  await until(() => !f.plugin.busy); assert.equal(ui.confirmation.isConnected, false);
  assert.equal(JSON.stringify(f.disk.settings), previous); assert.equal(f.plugin.auth.status(), 'connected'); assert.equal(f.plugin.lastErrorCode, 'cancelled');
  assert.equal([...f.secrets.values()].includes('synthetic-import-secret'), false);
});

test('Cancel releases a hanging native account verification without waiting for its response', async () => {
  const f = fixture(); const started = deferred(); const previous = JSON.stringify(f.disk.settings);
  delete f.plugin.pairingProvider;
  const globals = globalThis as unknown as { mockRequest?: () => Promise<never> };
  globals.mockRequest = () => { started.resolve(); return new Promise(() => {}); };
  try {
    const ui = await openImport(f); await started.promise; ui.button('取消').click(); await until(() => !f.plugin.busy);
    assert.equal(JSON.stringify(f.disk.settings), previous); assert.equal(f.plugin.auth.status(), 'connected'); assert.equal(f.plugin.lastErrorCode, 'cancelled');
  } finally { delete globals.mockRequest; }
});

test('saving phase disables Cancel and blocks closing either import dialog until the commit finishes', async () => {
  const f = fixture(); const started = deferred(), finish = deferred(); const original = f.plugin.saveData;
  f.plugin.saveData = async (value: unknown) => { started.resolve(); await finish.promise; await original(value); };
  const ui = await openImport(f); await started.promise;
  assert.equal(ui.button('正在保存，请稍候').disabled, true); ui.modal.close();
  assert.equal(ui.modal.containerEl.isConnected, true); assert.equal(ui.confirmation.isConnected, true);
  ui.button('正在保存，请稍候').click(); assert.equal(ui.confirmation.isConnected, true);
  finish.resolve(); await until(() => !f.plugin.busy); await until(() => !ui.modal.containerEl.isConnected);
  assert.equal(ui.confirmation.isConnected, false); assert.equal(f.plugin.settings.appKey, 'imported-app'); assert.equal(f.plugin.auth.status(), 'connected');
});

test('successful operations retain actionable results, while failures remain classified', async () => {
  const { plugin } = fixture();
  await plugin.run('同步中', async () => { plugin.statusText = '同步完成；2 项冲突已保留双方。'; });
  assert.equal(plugin.statusText, '同步完成；2 项冲突已保留双方。');
  await plugin.run('同步中', async () => {}); assert.equal(plugin.statusText, '操作完成。');
  await plugin.run('同步中', async () => { throw new Error('synthetic'); });
  assert.notEqual(plugin.statusText, '操作完成。'); assert.equal(plugin.lastErrorCode, 'unknown');
});
test('importing an account preserves the destination custom transfer concurrency', async () => {
  const f = fixture(); await f.plugin.setTransferConcurrency(12);
  await f.plugin.importConfiguration(await f.code(), 'synthetic-password');
  assert.equal(f.plugin.settings.transferConcurrency, 12); assert.equal(f.disk.settings.transferConcurrency, 12);
  assert.equal(f.plugin.auth.status(), 'connected');
});

test('connection checks replace stale failures immediately, heartbeat while waiting, and expose failure reasons', async () => {
  const { plugin } = fixture(); const started = deferred(), finish = deferred(); const events: any[] = [];
  plugin.subscribeProgress((event: any) => events.push(event));
  plugin.boundProvider = async () => { started.resolve(); await finish.promise; throw new runtime.VaultSailError('network', '网络请求失败；远端状态未知，请重试。'); };
  const rejected = assert.rejects(plugin.startSync(), { code: 'network' }); await started.promise;
  assert.equal(plugin.progress.phase, 'connecting'); assert.equal(plugin.progress.message, undefined);
  await until(() => events.length >= 2); assert.equal(events.at(-1).phase, 'connecting');
  finish.resolve(); await rejected;
  assert.equal(plugin.progress.phase, 'failed'); assert.match(plugin.progress.message, /网络请求失败/);
  assert.equal(plugin.progressTimer, undefined); plugin.onunload();
});

test('a detached or failing view cannot stop progress heartbeats or other observers', async () => {
  const { plugin } = fixture(); let updates = 0;
  plugin.settingTab = { updateProgress: () => { throw new Error('detached view'); } };
  plugin.subscribeProgress(() => { updates++; }); plugin.beginTransfer();
  await until(() => updates >= 2); assert.equal(plugin.progress.phase, 'connecting');
  plugin.onunload();
  assert.equal(plugin.progressTimer, undefined);
});

test('pausing the connection check stops before scanning and does not poison subsequent operations', async () => {
  const { plugin } = fixture(); const started = deferred(), finish = deferred(); plugin.busy = true;
  plugin.boundProvider = async () => { started.resolve(); await finish.promise; return {}; };
  const rejected = assert.rejects(plugin.startSync(), { code: 'paused' }); await started.promise;
  plugin.pause(); assert.equal(plugin.progress.phase, 'connecting'); assert.match(plugin.statusText, /等待当前请求结束/);
  finish.resolve(); await rejected; plugin.busy = false;
  assert.equal(plugin.progress.phase, 'paused'); assert.equal(plugin.pauseRequested, false); assert.equal(plugin.progressTimer, undefined);
  plugin.onunload();
});
