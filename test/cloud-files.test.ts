import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import type { Revision } from '../src/sync/remote-vault.ts';

const revision = (path: string, kind: 'update' | 'delete' = 'update', id = 'revision-one'): Revision => ({ schemaVersion: 1,
  vaultId: 'vault', opId: id, deviceId: 'device-one', fileId: path, path, kind, parents: [], size: kind === 'delete' ? 0 : 24,
  ...(kind === 'update' ? { hash: 'a'.repeat(64) } : {}), createdAt: 1 });

test('cloud file tree groups paths, preserves conflict/deletion versions and searches without flattening ancestors', async () => {
  const bundle = await build({ entryPoints: ['src/ui/cloud-files.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'obsidian', setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve('test/fixtures/obsidian.ts') })); } }] });
  const { cloudFileTree, CloudFilesPanel } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const heads = new Map<string, Revision[]>([
    ['根笔记.md', [revision('根笔记.md')]],
    ['项目/研究/笔记10.md', [revision('项目/研究/笔记10.md')]],
    ['项目/研究/笔记2.md', [revision('项目/研究/笔记2.md'), revision('项目/研究/笔记2.md', 'delete', 'revision-two')]],
    ['项目/旧稿.md', [revision('项目/旧稿.md', 'delete')]],
    ['项目', [revision('项目', 'delete')]],
    ['__proto__/内容.md', [revision('__proto__/内容.md')]],
    ['附件/<img src=x>.md', [revision('附件/<img src=x>.md')]],
  ]);
  const tree = cloudFileTree(heads);
  assert.equal(tree.files, 7);
  const folder = tree.children.find((node: any) => node.kind === 'folder' && node.path === '项目');
  assert.equal(folder.files, 3); assert.ok(tree.children.find((node: any) => node.kind === 'file' && node.path === '项目'), 'deleted same-name file must survive alongside a directory');
  const research = folder.children.find((node: any) => node.path === '项目/研究');
  assert.deepEqual(research.children.map((node: any) => node.name), ['笔记2.md', '笔记10.md']);
  assert.equal(research.children[0].versions.length, 2, 'all concurrent versions survive grouping');
  const filtered = cloudFileTree(heads, '研究/笔记2');
  assert.equal(filtered.files, 1); assert.equal(filtered.children[0].path, '项目'); assert.equal(filtered.children[0].children[0].path, '项目/研究');
  assert.equal(cloudFileTree(heads, '不存在').files, 0);

  const { window, document } = parseHTML('<html><body></body></html>'); Object.assign(globalThis, { window, document });
  const proto = window.HTMLElement.prototype as any;
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(value: string) { this.textContent = value; };
  proto.createEl = function(tag: string, options: { text?: string; cls?: string } = {}) { const el = this.appendChild(document.createElement(tag)); el.textContent = options.text ?? ''; if (options.cls) el.className = options.cls; return el; };
  proto.createDiv = function(options = {}) { return this.createEl('div', options); };
  const host = document.body.appendChild(document.createElement('section'));
  new CloudFilesPanel(host, heads, '云端测试位置');
  const folderAt = (path: string) => [...host.querySelectorAll('details[data-cloud-folder]')].find(el => el.getAttribute('data-cloud-folder') === path)!;
  const fileAt = (path: string) => [...host.querySelectorAll('details[data-cloud-file]')].find(el => el.getAttribute('data-cloud-file') === path)!;
  const button = (name: string) => [...host.querySelectorAll('button')].find(el => el.textContent === name)!;
  const toggle = (el: Element, open: boolean) => { el.toggleAttribute('open', open); el.dispatchEvent(new window.Event('toggle')); };
  assert.equal(folderAt('项目').hasAttribute('open'), true);
  assert.equal(folderAt('项目/研究').hasAttribute('open'), false);
  assert.equal(fileAt('项目/研究/笔记2.md'), undefined, 'collapsed subdirectories render lazily');
  toggle(folderAt('项目/研究'), true);
  const conflict = fileAt('项目/研究/笔记2.md'); assert.equal(conflict.getAttribute('data-state'), 'conflict');
  assert.equal(conflict.textContent!.includes('删除版本记录'), false, 'versions are not rendered before opening a file');
  toggle(conflict, true); assert.match(conflict.textContent!, /删除版本记录/); assert.match(conflict.textContent!, /blobs\//);
  assert.equal(fileAt('项目/旧稿.md').getAttribute('data-state'), 'deleted');
  assert.equal(host.querySelector('img'), null, 'paths must render as text, never HTML');
  button('全部折叠').click(); assert.equal(folderAt('项目').hasAttribute('open'), false); assert.equal(folderAt('项目/研究'), undefined);
  const search = host.querySelector('input')!; search.value = '研究/笔记2'; search.dispatchEvent(new window.Event('input'));
  assert.equal(host.querySelector('input'), search); assert.equal(folderAt('项目/研究').hasAttribute('open'), true); assert.ok(fileAt('项目/研究/笔记2.md'));
  assert.equal(fileAt('根笔记.md'), undefined); assert.match(host.textContent!, /找到 1 个文件路径/);
  search.value = ''; search.dispatchEvent(new window.Event('input')); assert.equal(folderAt('项目').hasAttribute('open'), false, 'clearing search restores folder expansion preferences');
  button('全部展开').click(); assert.equal(folderAt('项目/研究').hasAttribute('open'), true); assert.ok(fileAt('项目/研究/笔记10.md'));
  search.value = '不存在'; search.dispatchEvent(new window.Event('input')); assert.match(host.textContent!, /没有匹配的文件或目录/);
  const empty = document.body.appendChild(document.createElement('section')); new CloudFilesPanel(empty, new Map(), '位置'); assert.match(empty.textContent!, /当前云端库还没有笔记版本/);
});
