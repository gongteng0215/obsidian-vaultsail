import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { uuid, hash, bytes } from '../src/core/safety.ts';

test('Obsidian folder adapter excludes plugin state and uses nonrecursive deletion with a final race guard', async () => {
  const bundle = await build({ entryPoints: ['src/platform/directory-adapters.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { ObsidianDirectories, ObsidianDirectoryState } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const dirs = new Set(['论文', '论文/空', '.obsidian', '.vaultsail-state', 'VaultSail-conflicts', 'VaultSail-配置']), files = new Map<string, ArrayBuffer>();
  let race = false, removeCalls = 0, renameFailure = false;
  const adapter = {
    exists: async (p: string) => dirs.has(p) || files.has(p),
    stat: async (p: string) => dirs.has(p) ? { type: 'folder', size: 0 } : files.has(p) ? { type: 'file', size: files.get(p)!.byteLength } : null,
    list: async (p: string) => ({ files: [...files.keys()].filter(key => key.startsWith(p + '/')), folders: [...dirs].filter(key => key.startsWith(p + '/')) }),
    mkdir: async (p: string) => { dirs.add(p); },
    rmdir: async (p: string, recursive: boolean) => { assert.equal(recursive, false); removeCalls++; if (race) { files.set(p + '/新笔记.md', bytes('保留')); throw new Error('ENOTEMPTY'); } dirs.delete(p); },
    writeBinary: async (p: string, data: ArrayBuffer) => { files.set(p, data.slice(0)); }, readBinary: async (p: string) => files.get(p)!.slice(0),
    remove: async (p: string) => { files.delete(p); }, rename: async (from: string, to: string) => { if (renameFailure && from.endsWith('.next')) { renameFailure = false; throw new Error('EBUSY'); } assert.equal(files.has(to), false); files.set(to, files.get(from)!); files.delete(from); },
  };
  const app = { vault: { configDir: '.obsidian', adapter, getAllFolders: () => [...dirs].map(path => ({ path })), getFiles: () => [...files].map(([path]) => ({ path })), createFolder: async (path: string) => { dirs.add(path); } } };
  const local = new ObsidianDirectories(app); assert.deepEqual(await local.paths(), ['论文', '论文/空']);
  assert.equal(await local.removeEmpty('论文'), false); assert.equal(removeCalls, 0);
  race = true; assert.equal(await local.removeEmpty('论文/空'), false); assert.ok(files.has('论文/空/新笔记.md'));
  race = false; files.delete('论文/空/新笔记.md'); assert.equal(await local.removeEmpty('论文/空'), true);
  await local.create('论文/新/空'); assert.ok(dirs.has('论文/新/空'));
  files.set('文件', bytes('正文')); await assert.rejects(local.create('文件'), { code: 'collision' });
  const vaultId = uuid(), device = uuid(), context = hash(bytes('connection'));
  const store = new ObsidianDirectoryState(app, vaultId, device, context), state = await store.load();
  state.bases['论文'] = { present: true, heads: [] }; await store.save(state);
  state.bases['论文'].present = false; renameFailure = true; await assert.rejects(store.save(state));
  assert.equal((await store.load()).bases['论文'].present, true, 'previous valid snapshot survives interrupted replacement');
  await store.save(state); assert.equal((await store.load()).bases['论文'].present, false);
  const other = new ObsidianDirectoryState(app, uuid(), device, hash(bytes('other-connection'))); assert.equal(Object.keys((await other.load()).bases).length, 0);
});
