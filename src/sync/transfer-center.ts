import type { SyncHistoryTask } from './history';
import type { PerformanceSnapshot } from './performance';
import { progressRunning, type FileUploadProgress, type SyncProgress } from './progress.ts';

export interface UploadTiming {
  stage: FileUploadProgress['stage']; since: number; elapsedMs: number;
  stages: Partial<Record<FileUploadProgress['stage'], number>>;
  bytesPerSecond?: number; uploadRemainingSeconds?: number;
  sourcePreparationMs?: number;
  waitingMs: number;
}
export interface TransferCenterSnapshot {
  networkWait?: string;
  context?: string; target: string; busy: boolean; pauseRequested: boolean; queue: string;
  task?: SyncHistoryTask; progress?: SyncProgress; performance?: PerformanceSnapshot;
  timings: Record<string, UploadTiming>; bytesPerSecond: number; historyWarning: boolean;
}
type Measurement = { stage: FileUploadProgress['stage']; since: number; ended?: number; stages: UploadTiming['stages'];
  attempt: number; blocked?: boolean; hash?: string; sourcePreparationMs?: number; lastAcknowledgedAt: number; bytes: number; total: number; uploaded: number; samples: { at: number; bytes: number }[] };

/** Session-only observations. Never used for baselines, recovery, or persisted credentials. */
export class UploadTelemetry {
  private files = new Map<string, Measurement>();
  reset(): void { this.files.clear(); }
  observe(progress: SyncProgress, now = Date.now()): void {
    if (!progressRunning(progress)) { for (const path of this.files.keys()) this.finish(path, now); return; }
    for (const upload of progress.uploads ?? []) {
      let entry = this.files.get(upload.path);
      if (entry && upload.contentHash && entry.hash && entry.hash !== upload.contentHash) { this.files.delete(upload.path); entry = undefined; }
      if (!entry) {
        if (this.files.size >= 1000) { const old = [...this.files].find(([, value]) => value.ended !== undefined); if (old) this.files.delete(old[0]); else continue; }
        entry = { stage: upload.stage, since: now, stages: {}, attempt: upload.attempt, hash: upload.contentHash, sourcePreparationMs: upload.sourcePreparationMs,
          lastAcknowledgedAt: now, bytes: upload.transferredBytes ?? 0, total: upload.totalBytes, uploaded: upload.uploadedBytes, samples: [] };
        this.files.set(upload.path, entry);
      }
      if (entry.ended !== undefined) continue;
      entry.hash ??= upload.contentHash;
      entry.blocked = Boolean(upload.requestPending || upload.retryAt && upload.retryAt > now || !upload.activeParts?.length && (upload.waitingParts?.length || upload.waitingForSlot));
      if (entry.stage !== upload.stage) {
        entry.stages[entry.stage] = (entry.stages[entry.stage] ?? 0) + Math.max(0, now - entry.since);
        entry.stage = upload.stage; entry.since = now; entry.lastAcknowledgedAt = now; entry.samples = [];
      }
      const sent = upload.transferredBytes ?? 0;
      if (entry.attempt !== upload.attempt || sent < entry.bytes) { entry.samples = []; entry.lastAcknowledgedAt = now; }
      if (sent > entry.bytes) entry.lastAcknowledgedAt = now;
      entry.attempt = upload.attempt; entry.bytes = sent; entry.uploaded = upload.uploadedBytes;
      if (upload.stage === 'uploading' && upload.transferredBytes !== undefined) {
        const last = entry.samples.at(-1);
        if (!last || now > last.at) entry.samples.push({ at: now, bytes: sent });
        else last.bytes = sent;
        while (entry.samples.length > 1 && entry.samples[1].at < now - 5000) entry.samples.shift();
        if (entry.samples.length > 64) entry.samples.splice(0, entry.samples.length - 64);
      }
    }
  }
  finish(path: string, now = Date.now()): void {
    const entry = this.files.get(path); if (entry && entry.ended === undefined) entry.ended = now;
  }
  timing(path: string, now = Date.now()): UploadTiming | undefined {
    const entry = this.files.get(path); if (!entry) return;
    const elapsedMs = Math.max(0, (entry.ended ?? now) - entry.since);
    const stages = { ...entry.stages, [entry.stage]: (entry.stages[entry.stage] ?? 0) + elapsedMs };
    const result: UploadTiming = { stage: entry.stage, since: entry.since, elapsedMs, stages, sourcePreparationMs: entry.sourcePreparationMs, waitingMs: Math.max(0, (entry.ended ?? now) - entry.lastAcknowledgedAt) };
    const samples = entry.samples.filter(sample => sample.at >= now - 6000);
    const first = samples[0], last = samples.at(-1);
    if (entry.ended === undefined && !entry.blocked && entry.stage === 'uploading' && samples.length >= 3 && first && last && now - first.at >= 1500 && now - last.at <= 5000 && last.bytes > first.bytes) {
      result.bytesPerSecond = (last.bytes - first.bytes) / ((now - first.at) / 1000);
      result.uploadRemainingSeconds = Math.ceil(Math.max(0, entry.total - entry.uploaded) / result.bytesPerSecond);
    }
    return result;
  }
  rate(now = Date.now()): number {
    const objects = new Set<string>(); let rate = 0;
    for (const [path, entry] of this.files) {
      const key = entry.hash ?? path; if (objects.has(key)) continue;
      const speed = this.timing(path, now)?.bytesPerSecond;
      if (speed) { objects.add(key); rate += speed; }
    }
    return rate;
  }
}
