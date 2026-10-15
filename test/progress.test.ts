import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProgress, progressRunning, type SyncProgress } from '../src/sync/progress.ts';

const sample: SyncProgress = { phase: 'uploading', path: 'note.md', doneFiles: 1, totalFiles: 7, doneBytes: 1024, totalBytes: 8192, startedAt: 1000, updatedAt: 2000 };
test('live progress advances elapsed and waiting time without inventing verified files or bytes', () => {
  assert.match(formatProgress(sample, 3000), /耗时 2 秒/);
  const later = formatProgress(sample, 6000);
  assert.match(later, /耗时 5 秒/); assert.match(later, /已等待新进度 4 秒/);
  assert.match(later, /已处理 1\/7/); assert.match(later, /已校验内容 1.0 KiB \/ 8.0 KiB/);
  assert.equal(sample.updatedAt, 2000);
});
test('failed and paused snapshots freeze the clock and retain a safe actionable reason', () => {
  const failed = { ...sample, phase: 'failed' as const, message: '网络请求超时，请检查网络后重试。' };
  assert.equal(formatProgress(failed, 5000), formatProgress(failed, 500000));
  assert.match(formatProgress(failed), /网络请求超时/); assert.match(formatProgress(failed), /任务已停止/);
  assert.equal(formatProgress(failed).includes('已等待新进度'), false);
  const paused = { ...sample, phase: 'paused' as const };
  assert.equal(formatProgress(paused, 5000), formatProgress(paused, 500000));
});
test('connection checks are live work while completed, failed and preview snapshots are terminal', () => {
  assert.equal(progressRunning({ ...sample, phase: 'connecting' }), true);
  for (const phase of ['completed', 'failed', 'paused', 'preview-ready'] as const) assert.equal(progressRunning({ ...sample, phase }), false);
});
