import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadTelemetry, type TransferCenterSnapshot } from '../src/sync/transfer-center.ts';
import type { FileUploadProgress, SyncProgress } from '../src/sync/progress.ts';
import { parseHTML } from 'linkedom';
import { build } from 'esbuild';

const file: FileUploadProgress = { path: '附件/video.mp4', contentHash: 'shared-content', stage: 'uploading', uploadedBytes: 0, transferredBytes: 0, totalBytes: 10000, completedParts: 0, totalParts: 5, attempt: 1 };
const progress = (upload = file): SyncProgress => ({ phase: 'uploading', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 10000, startedAt: 1000, updatedAt: 1000, uploads: [upload] });
test('upload rate excludes reused bytes, deduplicates shared content, resets attempts and freezes terminal stages', () => {
  const telemetry = new UploadTelemetry();
  for (const now of [1000, 2000, 3000]) telemetry.observe(progress({ ...file, uploadedBytes: 8000 }), now);
  assert.equal(telemetry.timing(file.path, 3000)?.bytesPerSecond, undefined, 'server reuse is not network throughput');
  telemetry.reset();
  for (const [now, sent] of [[1000, 0], [2000, 1000], [3000, 2000]]) {
    const upload = { ...file, uploadedBytes: sent, transferredBytes: sent };
    telemetry.observe({ ...progress(upload), uploads: [upload, { ...upload, path: 'copy.mp4' }] }, now);
  }
  assert.equal(telemetry.timing(file.path, 3000)?.bytesPerSecond, 1000);
  assert.equal(telemetry.timing(file.path, 3000)?.uploadRemainingSeconds, 8);
  assert.equal(telemetry.rate(3000), 1000, 'two observers of one shared write count once');
  telemetry.observe(progress({ ...file, attempt: 2 }), 4000);
  assert.equal(telemetry.timing(file.path, 4000)?.bytesPerSecond, undefined);
  telemetry.observe(progress({ ...file, stage: 'verifying', uploadedBytes: 10000, attempt: 2 }), 5000);
  assert.equal(telemetry.timing(file.path, 6000)?.stages.verifying, 1000);
  telemetry.observe({ ...progress(), phase: 'failed' }, 6000);
  assert.equal(telemetry.timing(file.path, 99000)?.stages.verifying, 1000);
  assert.equal(telemetry.rate(99000), 0);
  telemetry.reset(); telemetry.observe(progress(), 1000); telemetry.observe(progress(), 4000);
  assert.equal(telemetry.timing(file.path, 4000)?.waitingMs, 3000, 'pending native requests show a real wait without invented bytes');
});

test('transfer center keeps file rows, focus drafts and expanded details through updates; completed files remain searchable', async t => {
  const { window, document } = parseHTML('<html><body></body></html>');
  const proto = window.HTMLElement.prototype as any;
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(value: string) { this.textContent = value; };
  proto.createEl = function(tag: string, options: { text?: string; cls?: string } = {}) { const el = this.appendChild(document.createElement(tag)); el.textContent = options.text ?? ''; if (options.cls) el.className = options.cls; return el; };
  proto.createDiv = function(options = {}) { return this.createEl('div', options); };
  const bundle = await build({ entryPoints: ['src/ui/transfer-center-panel.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { TransferCenterPanel } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const snapshot: TransferCenterSnapshot = { context: 'one-account-vault', target: '测试云端库', busy: true, pauseRequested: false, queue: '正在同步', progress: progress(), timings: {}, bytesPerSecond: 0, historyWarning: false,
    task: { version: 1, id: 'task-one', context: 'one-account-vault', deviceId: 'device', sequence: 0, mode: 'manual', startedAt: 1000, updatedAt: 1000, status: 'running', truncated: false,
      files: [{ id: 'video', path: file.path, action: 'upload', size: 10000, state: 'running', reason: 'planned', updatedAt: 1000 }, { id: 'note', path: 'notes/笔记.md', action: 'upload', size: 12, state: 'queued', reason: 'planned', updatedAt: 1000 }] } };
  const host = document.body.appendChild(document.createElement('section'));
  let listener = () => {}, unsubscribed = false, started = 0;
  const panel = new TransferCenterPanel(host, { snapshot: () => snapshot, subscribe: (callback: () => void) => { listener = callback; return () => { unsubscribed = true; }; }, sync: () => started++, pause: () => {}, resume: () => {}, history: () => {}, refresh: async () => {} });
  t.after(() => panel.destroy());
  const row = host.querySelector('[data-file-id=video]')!, details = row.querySelector('details')!;
  details.setAttribute('open', ''); const search = host.querySelector('input')!; search.value = 'video'; search.dispatchEvent(new window.Event('input'));
  snapshot.progress!.uploads![0] = { ...file, uploadedBytes: 4000, transferredBytes: 4000, completedParts: 2 };
  listener(); await new Promise(resolve => setTimeout(resolve, 560));
  assert.equal(host.querySelector('[data-file-id=video]'), row); assert.equal(details.hasAttribute('open'), true); assert.equal(search.value, 'video');
  assert.match(row.textContent!, /上传 40%/); assert.equal((row.querySelector('progress') as any).value, 4000);
  snapshot.progress!.uploads![0].attempt = 2; panel.render(); assert.match(row.textContent!, /第 2 次尝试/);
  snapshot.progress!.uploads![0] = { ...file, stage: 'verifying', uploadedBytes: 10000, completedParts: 5 }; panel.render();
  assert.match(row.textContent!, /回读校验中/); assert.equal(snapshot.task!.files[0].state, 'running'); assert.match(host.querySelector('.vs-transfer-metrics')!.textContent!, /已完成 0 \/ 2/);
  snapshot.task!.files[0].state = 'succeeded'; snapshot.progress!.uploads = []; panel.render();
  assert.equal(host.querySelector('[data-file-id=video]'), row); assert.match(row.textContent!, /已校验并保存版本/);
  snapshot.pauseRequested = true; listener(); panel.render(); assert.match(host.textContent!, /等待当前请求结束/);
  snapshot.busy = false; snapshot.task!.status = 'completed'; panel.render();
  const sync = [...host.querySelectorAll('button')].find(button => button.textContent === '开始同步')!; sync.click(); assert.equal(started, 1);
  search.value = ''; search.dispatchEvent(new window.Event('input'));
  snapshot.task = { ...snapshot.task!, id: 'another-task', truncated: true, files: Array.from({ length: 65 }, (_, index) => ({ ...snapshot.task!.files[1], id: String(index), path: `批量/${index}.md` })) }; panel.render();
  assert.equal(host.querySelectorAll('[role=listitem]').length, 50); assert.match(host.querySelector('.vs-transfer-warning')!.textContent!, /列表与文件计数仅代表已记录部分/);
  [...host.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click();
  assert.equal(host.querySelectorAll('[role=listitem]').length, 15);
  snapshot.context = 'another-account'; snapshot.target = '另一个库'; snapshot.task = undefined; snapshot.progress = undefined; panel.render();
  assert.equal(host.querySelector('[data-file-id=video]'), null); assert.equal(search.value, '');
  panel.destroy(); assert.equal(unsubscribed, true);
});

test('opening the native transfer view reuses the existing leaf and mobile uses a full tab', async () => {
  const bundle = await build({ stdin: { contents: "export { openTransferCenter } from './src/ui/transfer-center.ts'; export { Platform } from 'obsidian';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'obsidian-view-fixture', setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: process.cwd() + '/test/fixtures/obsidian.ts' })); } }] });
  const { openTransferCenter, Platform } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  let existing = false, created = 0, revealed = 0, tabs = 0;
  const leaf = { setViewState: async (state: any) => { assert.equal(state.type, 'vaultsail-transfer-center'); created++; existing = true; } };
  const plugin = { app: { workspace: { getLeavesOfType: () => existing ? [leaf] : [], getRightLeaf: () => leaf, getLeaf: (type: string) => { assert.equal(type, 'tab'); tabs++; return leaf; }, revealLeaf: async (value: any) => { assert.equal(value, leaf); revealed++; } } } };
  await openTransferCenter(plugin); await openTransferCenter(plugin); assert.equal(created, 1); assert.equal(revealed, 2); assert.equal(tabs, 0);
  existing = false; Platform.isMobile = true; await openTransferCenter(plugin); assert.equal(tabs, 1);
});
