import type { PerformanceSnapshot } from './performance';
import { SCAN_DETAIL_KEYS, REQUEST_LABELS, formatRequestStats, type RequestKind, type RequestStats } from './performance.ts';
import type { RevisionScanStats } from './remote-vault';
export type SummaryTaskType = 'manual' | 'automatic' | 'upload' | 'download' | 'recover' | 'resolve';
const KEYS = ['elapsedMs', 'requestCount', 'refreshCount', 'retryCount', 'retryWaitMs', 'scans', 'listed', 'cacheHits', 'read', 'missingFingerprints', 'connectingMs', 'remoteMs', 'localMs', 'transferMs', ...SCAN_DETAIL_KEYS] as const;
export type ScanSummary = { version: 1; pluginVersion: string; platform: 'desktop' | 'mobile'; taskType?: SummaryTaskType;
  requests?: Partial<Record<RequestKind, RequestStats>>; directories?: RevisionScanStats & { scans: number } } & Record<typeof KEYS[number], number>;
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15;
/** Strict local/export whitelist: never retain arbitrary exception, URL, path, or response fields. */
export function validateScanSummary(value: unknown): ScanSummary | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.pluginVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(v.pluginVersion) || v.pluginVersion.length > 40 || !['desktop', 'mobile'].includes(String(v.platform))) return;
  if (KEYS.some(key => typeof v[key] !== 'number' || !Number.isFinite(v[key]) || Number(v[key]) < 0 || Number(v[key]) > 1e15)) return;
  const result = { version: 1, pluginVersion: v.pluginVersion, platform: v.platform as ScanSummary['platform'], ...Object.fromEntries(KEYS.map(key => [key, v[key]])) } as ScanSummary;
  if (['manual', 'automatic', 'upload', 'download', 'recover', 'resolve'].includes(String(v.taskType))) result.taskType = v.taskType as SummaryTaskType;
  if (v.requests && typeof v.requests === 'object' && !Array.isArray(v.requests)) {
    result.requests = {};
    for (const key of Object.keys(REQUEST_LABELS) as RequestKind[]) {
      const raw = (v.requests as Record<string, unknown>)[key];
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>, keys = ['count', 'failed', 'elapsedMs', 'maxMs', 'pending'] as const;
      if (keys.every(k => numeric(row[k])) && Number(row.failed) <= Number(row.count) && Number(row.pending) <= Number(row.count))
        result.requests[key] = Object.fromEntries(keys.map(k => [k, row[k]])) as unknown as RequestStats;
    }
  }
  if (result.requests && !Object.keys(result.requests).length && Object.keys(v.requests as object).length) delete result.requests;
  if (v.directories && typeof v.directories === 'object') {
    const row = v.directories as Record<string, unknown>, keys = ['scans', 'listed', 'cacheHits', 'read', 'missingFingerprints'] as const;
    if (keys.every(k => numeric(row[k]))) {
      result.directories = Object.fromEntries(keys.map(k => [k, row[k]])) as unknown as NonNullable<ScanSummary['directories']>;
      const detail = row.details as Record<string, unknown> | undefined;
      if (detail && SCAN_DETAIL_KEYS.every(k => numeric(detail[k]))) result.directories.details = Object.fromEntries(SCAN_DETAIL_KEYS.map(k => [k, detail[k]])) as unknown as NonNullable<RevisionScanStats['details']>;
    }
  }
  return result;
}
export function scanSummary(snapshot: PerformanceSnapshot | undefined, pluginVersion: string, mobile: boolean, taskType?: SummaryTaskType): ScanSummary | undefined {
  if (!snapshot) return;
  const values = Object.fromEntries(KEYS.map(key => [key, 0]));
  for (const key of ['elapsedMs', 'requestCount', 'refreshCount', 'retryCount', 'retryWaitMs', 'scans'] as const) values[key] = snapshot[key];
  for (const key of ['listed', 'cacheHits', 'read', 'missingFingerprints'] as const) values[key] = snapshot.versions[key];
  for (const key of SCAN_DETAIL_KEYS) values[key] = snapshot.versions.details?.[key] ?? 0;
  for (const key of ['connecting', 'remote', 'local', 'transfer'] as const) values[key + 'Ms'] = snapshot.stages[key];
  return validateScanSummary({ ...values, version: 1, pluginVersion, platform: mobile ? 'mobile' : 'desktop', taskType,
    requests: snapshot.requests, ...(snapshot.directories ? { directories: { ...snapshot.directories, scans: snapshot.directoryScans ?? 0 } } : {}) });
}
export function formatScanSummary(value?: ScanSummary): string {
  return value ? `任务类型 ${value.taskType ?? '未记录'} · 请求 ${value.requestCount} 次 · 令牌刷新 ${value.refreshCount} 次 · 文件扫描 ${value.scans} 轮 · 缓存命中 ${value.cacheHits}/${value.listed} 条\n版本正文 ${(value.readBytes/1024).toFixed(1)} KiB · 缓存写入 ${value.cacheWrites} 次 · 云端 ${(value.remoteMs/1000).toFixed(2)} 秒 · 本地 ${(value.localMs/1000).toFixed(2)} 秒`
    + `\n目录记录：${value.directories ? `扫描 ${value.directories.scans} 轮 · 缓存命中 ${value.directories.cacheHits}/${value.directories.listed} 条 · 正文读取 ${value.directories.read} 条 · 缓存写入 ${value.directories.details?.cacheWrites ?? '未记录'} 次` : '未记录'}`
    + `\n请求分类：${value.requests ? formatRequestStats(value.requests) : '未记录'}` : '';
}
