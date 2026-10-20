import assert from 'node:assert/strict';
import test from 'node:test';
import { included, relativePath } from '../src/core/safety.ts';
import { readLastSuccess, readLocalValidation } from '../src/platform/local-records.ts';
import { storageAdapter } from '../src/platform/local-io.ts';

test('local status and capability reports whitelist fields from damaged or untrusted storage', () => {
  for (const value of [null, [], 'private', { completedAt: 'private' }, { completedAt: Infinity, files: 1, bytes: 2, elapsedMs: 3 }]) assert.equal(readLastSuccess(value), undefined);
  assert.deepEqual(readLastSuccess({ completedAt: 1, files: 2, bytes: 3, elapsedMs: 4, blockedFiles: -1, secret: 'private' }),
    { completedAt: 1, files: 2, bytes: 3, elapsedMs: 4, blockedFiles: 0 });
  assert.equal(readLocalValidation({ passed: 'true' }), undefined);
  assert.deepEqual(readLocalValidation({ passed: true, checkedAt: 'private', quota: 'private', results: [{ size: 1024, passed: true, path: 'private' }, { size: 'private', passed: true }], secret: 'private' }),
    { passed: true, checkedAt: undefined, source: 'full-roundtrip', results: [{ size: 1024, passed: true }], quota: '未验证' });
  assert.equal(readLocalValidation({ passed: true, source: 'pairing-local-probe' })?.source, 'pairing-local-probe');
});

test('control character rejection and custom configuration exclusions remain intact', () => {
  for (let code = 0; code < 32; code++) assert.throws(() => relativePath('note' + String.fromCharCode(code) + '.md'));
  assert.equal(relativePath('研究/笔记.md'), '研究/笔记.md');
  assert.equal(included('custom-config/plugins/settings.json', 'custom-config'), false);
  assert.equal(included('.obsidian/plugins/settings.json'), false);
  assert.equal(included('.vaultsail-state/recovery/note.md'), false);
  assert.equal(included('notes/研究.md', 'custom-config'), true);
});

test('typed adapter preserves receiver, optional arguments and reads current native methods', async () => {
  const source = { marker: 'receiver', stat: async function(path: string) { assert.equal(this.marker, 'receiver'); return { type: 'file', size: path.length }; },
    exists: async function(path: string, sensitive?: boolean) { assert.equal(this.marker, 'receiver'); return path === 'Note' && sensitive === true; } };
  const app = { vault: { adapter: source } } as any;
  const adapter = storageAdapter(app);
  assert.equal((await adapter.stat('Note'))?.size, 4); assert.equal(await adapter.exists('Note', true), true);
  source.stat = async () => ({ type: 'file', size: 8 }); assert.equal((await adapter.stat('Note'))?.size, 8);
  assert.equal(storageAdapter(app), adapter);
});
