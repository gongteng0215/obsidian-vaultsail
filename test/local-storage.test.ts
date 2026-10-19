import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDirectories, localIO, storageAdapter } from '../src/platform/local-io.ts';
import { safeMessage, VaultSailError } from '../src/core/safety.ts';

function disk() {
  const dirs = new Set<string>(), files = new Set<string>();
  let fail: string | undefined;
  const adapter = {
    stat: async (path: string) => files.has(path) ? { type: 'file' } : dirs.has(path) ? { type: 'folder' } : null,
    mkdir: async (path: string) => {
      // Real filesystems reject duplicate mkdir, unlike the old test fixture.
      await new Promise(resolve => setImmediate(resolve));
      if (fail || dirs.has(path) || files.has(path)) throw Object.assign(new Error('private-path-and-token'), { code: fail ?? 'EEXIST' });
      dirs.add(path);
    },
    rename: async () => { throw Object.assign(new Error('secret-response'), { code: 'EPERM' }); },
  };
  return { dirs, files, adapter, app: { vault: { adapter } } as any, fail: (code: string) => { fail = code; } };
}

test('concurrent state/history parent creation accepts a verified folder after duplicate mkdir', async () => {
  const d = disk();
  await Promise.all(Array.from({ length: 8 }, (_, i) => ensureDirectories(d.app, `.vaultsail-state/device/${i % 2 ? 'history' : 'sessions'}/nested`)));
  assert.equal(d.dirs.size, 6);
  assert.ok(d.dirs.has('.vaultsail-state/device/history/nested'));
  assert.ok(d.dirs.has('.vaultsail-state/device/sessions/nested'));
});

test('directory preparation never treats failed mkdir or a same-name file as success', async () => {
  const denied = disk(); denied.fail('EACCES');
  await assert.rejects(ensureDirectories(denied.app, '.vaultsail-state/device'), error =>
    error instanceof VaultSailError && error.code === 'state' && /创建本机目录.*EACCES/.test(error.message));
  assert.equal(denied.dirs.size, 0);
  const collision = disk(); collision.files.add('.vaultsail-state');
  await assert.rejects(ensureDirectories(collision.app, '.vaultsail-state/device'), error =>
    error instanceof VaultSailError && error.code === 'collision');
});

test('native commit failures expose only a fixed step and whitelisted code, without retrying writes', async () => {
  const d = disk(); let calls = 0;
  d.adapter.rename = async () => { calls++; throw Object.assign(new Error('secret-response'), { code: 'EPERM' }); };
  await assert.rejects(storageAdapter(d.app).rename('private-source', 'private-target'), error => {
    const message = safeMessage(error);
    assert.match(message, /提交本机文件.*EPERM/);
    assert.equal(/secret|private/.test(message), false);
    return error instanceof VaultSailError && error.code === 'state';
  });
  assert.equal(calls, 1, 'an ambiguous filesystem write must not be blindly repeated');
});

test('unknown filesystem errors are sanitized; existing validation errors retain their code', async () => {
  for (const error of [new Error('token=private'), { code: 'private-token', message: 'private-body' }, null]) {
    await assert.rejects(localIO('读取本机文件', async () => { throw error; }), actual => {
      assert.match(safeMessage(actual), /^读取本机文件失败。/);
      assert.equal(safeMessage(actual).includes('private'), false); return true;
    });
  }
  const original = new VaultSailError('integrity', '校验失败。');
  await assert.rejects(localIO('读取本机文件', async () => { throw original; }), error => error === original);
  await assert.rejects(localIO('写入本机文件', async () => { throw new Error('ENOSPC: private-path'); }), error => {
    assert.match(safeMessage(error), /ENOSPC.*剩余空间/); return true;
  });
});
