import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { preserveInteraction, rememberFields } from '../src/ui/interaction.ts';

function dom() {
  const { window, document } = parseHTML('<html><body><main></main></body></html>'); Object.assign(globalThis, { window, document });
  const proto = window.HTMLElement.prototype as any;
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(value: string) { this.textContent = value; };
  proto.createEl = function(tag: string, options: { text?: string; cls?: string } = {}) { const el = this.appendChild(document.createElement(tag)); el.textContent = options.text ?? ''; if (options.cls) el.className = options.cls; return el; };
  proto.createDiv = function(options = {}) { return this.createEl('div', options); };
  return { window, document, host: document.querySelector('main')! };
}

test('DOM commits retain the latest scroll, drafts and disclosures across repeated structural changes', async () => {
  const { document, host } = dom();
  const render = () => { host.innerHTML = '<details><summary>诊断</summary>说明</details><input aria-label="草稿" value="saved">'; rememberFields(host); };
  render(); host.querySelector('details')!.setAttribute('open', ''); host.querySelector('input')!.value = 'unsaved';
  host.scrollTop = 100; document.body.scrollTop = 200;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const updating = (async () => { await gate; preserveInteraction(host, () => { render(); host.scrollTop = 0; document.body.scrollTop = 0; }, true); })();
  host.scrollTop = 444; document.body.scrollTop = 777; release(); await updating;
  assert.equal(host.scrollTop, 444); assert.equal(document.body.scrollTop, 777, 'capture must happen after the await, not before the user scrolls');
  assert.equal(host.querySelector('input')!.value, 'unsaved'); assert.equal(host.querySelector('details')!.hasAttribute('open'), true);
  preserveInteraction(host, render, true); assert.equal(host.querySelector('input')!.value, 'unsaved', 'one restoration cannot make the draft look saved');
  preserveInteraction(host, render, false); assert.equal(host.querySelector('input')!.value, 'saved', 'different connection contexts must not inherit old drafts');
});

test('async modal results ignore older requests and closed views; history keeps the task being read', async () => {
  const { window, document } = dom();
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) option.removeAttribute('selected'); this.querySelectorAll('option').forEach((option: any) => { if (option.value === value) option.setAttribute('selected', ''); }); },
  });
  const bundle = await build({ stdin: { contents: "export { SyncHistoryModal } from './src/ui/sync-history.ts'; export { ConflictInbox } from './src/ui/conflicts.ts'; export { CloudVaultSetupModal } from './src/ui/modals.ts';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'obsidian', setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve('test/fixtures/obsidian.ts') })); } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find(el => el.textContent === label)!;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const pending: ((rows: any[]) => void)[] = [];
  let snapshots: any[] = []; let listener!: () => void;
  const history = { list: () => new Promise<any[]>(resolve => pending.push(resolve)), snapshots: () => snapshots, subscribe: (callback: () => void) => { listener = callback; return () => {}; }, warning: false };
  const task = (id: string, time: number) => ({ version: 1, id, startedAt: time, updatedAt: time + 1, endedAt: time + 1, status: 'completed', mode: 'automatic', sequence: 1, files: [], truncated: false });
  const modal = new module.SyncHistoryModal({}, history); modal.open();
  try {
    button(modal.contentEl, '刷新记录').click(); pending[1]([task('newer', 200)]); await tick();
    const select = modal.contentEl.querySelector('select[aria-label="选择同步任务"]')!;
    assert.equal(select.value, 'newer'); pending[0]([task('stale', 100)]); await tick(); assert.equal(select.value, 'newer');
    snapshots = [task('background', 300), task('newer', 200)]; listener(); await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(select.value, 'newer', 'new background tasks cannot replace the selected history task');
    button(modal.contentEl, '最新任务').click(); assert.equal(select.value, 'background');
    button(modal.contentEl, '刷新记录').click(); const beforeClose = modal.contentEl.textContent; modal.close(); pending[2]([task('late', 500)]); await tick(); assert.equal(modal.contentEl.textContent, beforeClose);
  } finally { modal.close(); }
  const conflicts: ((rows: any[]) => void)[] = [];
  const inbox = new module.ConflictInbox({}, { list: () => new Promise<any[]>(resolve => conflicts.push(resolve)) }); inbox.open();
  button(inbox.contentEl, '刷新').click(); conflicts[1]([{ path: 'latest.md', heads: [], reason: 'test' }]); await tick();
  conflicts[0]([{ path: 'stale.md', heads: [], reason: 'test' }]); await tick(); assert.match(inbox.contentEl.textContent, /latest.md/); assert.equal(inbox.contentEl.textContent.includes('stale.md'), false);
  button(inbox.contentEl, '刷新').click(); inbox.close(); const closedText = inbox.contentEl.textContent;
  conflicts[2]([]); await tick(); assert.equal(inbox.contentEl.textContent, closedText);
  let finishList!: (rows: any[]) => void;
  const setup = new module.CloudVaultSetupModal({}, '测试库', { list: () => new Promise<any[]>(resolve => { finishList = resolve; }) }); setup.open();
  button(setup.contentEl, '查看已有库').click(); const loadingText = setup.contentEl.textContent; setup.close(); finishList([{ vaultId: 'id', displayName: 'late vault' }]); await tick();
  assert.equal(setup.contentEl.textContent, loadingText); assert.equal(document.body.textContent!.includes('late vault'), false);
});
