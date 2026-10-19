import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticNotifications, type SyncNoticeSummary } from '../src/sync/automatic-notifications.ts';
import { VaultSailError } from '../src/core/safety.ts';

const empty: SyncNoticeSummary = { uploaded: 0, downloaded: 0, deleted: 0, merged: 0, conflicts: 0, blocked: 0 };

test('automatic no-change checks stay quiet; real transfers, merges and deletions are summarized', () => {
  const notices = new AutomaticNotifications();
  assert.equal(notices.completed(empty, true), undefined);
  const result = notices.completed({ ...empty, uploaded: 2, downloaded: 1, merged: 1, deleted: 3 }, true)!;
  assert.match(result.message, /自动同步完成：上传 2 个；下载 1 个；自动合并 1 个；删除 3 项/);
  assert.equal(result.duration, 4000);
  assert.equal(notices.completed({ ...empty, uploaded: 1 }, false), undefined, 'manual sync retains its own completion notice');
});

test('unresolved conflicts and skipped files get actionable warnings with a five-minute duplicate limit', () => {
  let now = 1000; const notices = new AutomaticNotifications(() => now);
  const issues = { ...empty, conflicts: 1, blocked: 2 };
  const warning = notices.completed(issues, true)!;
  assert.match(warning.message, /冲突已保留双方/); assert.match(warning.message, /跳过 2 项未传输/);
  assert.equal(warning.duration, 12_000);
  now += 60_000; assert.equal(notices.completed(issues, true), undefined);
  assert.ok(notices.completed({ ...issues, conflicts: 2 }, true), 'changed issue counts must be announced');
  assert.equal(notices.completed(issues, true), undefined, 'alternating counts must not defeat duplicate limits');
  assert.match(notices.completed({ ...issues, uploaded: 1 }, true)!.message, /上传 1 个/, 'real work must still be reported alongside remaining issues');
  now += 300_000; assert.ok(notices.completed(issues, true));
});

test('automatic failures distinguish retries from stopped tasks and suppress repeats until verified success', () => {
  const notices = new AutomaticNotifications();
  const first = notices.failed(new VaultSailError('network', 'private detail'))!;
  assert.match(first.message, /将自动重试/); assert.equal(first.duration, 12_000);
  assert.equal(notices.failed(new VaultSailError('timeout', 'private detail')), undefined);
  assert.match(notices.attention!, /网络异常/);
  assert.match(notices.failed(new VaultSailError('rate', 'private detail'))!.message, /等待后重试/);
  assert.match(notices.failed(new VaultSailError('authentication', 'private detail'))!.message, /重新连接/);
  assert.equal(notices.failed(new VaultSailError('token-expired', 'private detail')), undefined);
  assert.match(notices.failed(new VaultSailError('write-timeout', 'private detail'))!.message, /任务已停止/);
  notices.completed(empty, true); assert.equal(notices.attention, undefined);
  assert.ok(notices.failed(new VaultSailError('network', 'private detail')), 'a new incident after recovery must be announced again');
});

test('pause, background cancellation, scheduling contention and replan do not generate failure notifications', () => {
  const notices = new AutomaticNotifications();
  for (const code of ['paused', 'cancelled', 'busy', 'changed']) assert.equal(notices.failed(new VaultSailError(code, 'private detail')), undefined);
  assert.equal(notices.attention, undefined);
});

test('notifications never copy raw exceptions, provider responses, filenames or secrets', () => {
  for (const error of [new Error('private-access private-note.md https://private.invalid'),
    new VaultSailError('permission', 'private-access private-note.md https://private.invalid')]) {
    const result = new AutomaticNotifications().failed(error)!;
    assert.equal(/private-access|private-note|https:/.test(result.message), false);
    assert.match(result.message, /权限|传输中心/);
  }
});

test('connection reset clears deduplication and attention without persisting any notification state', () => {
  const notices = new AutomaticNotifications();
  const issue = { ...empty, blocked: 1 };
  notices.completed(issue, true); notices.failed(new VaultSailError('permission', 'private detail'));
  notices.reset(); assert.equal(notices.attention, undefined);
  assert.ok(notices.completed(issue, true)); assert.ok(notices.failed(new VaultSailError('permission', 'private detail')));
});
