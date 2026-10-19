import type { PerformanceSnapshot } from './performance';
import { SCAN_DETAIL_KEYS } from './performance.ts';
const KEYS = ['elapsedMs', 'requestCount', 'refreshCount', 'retryCount', 'retryWaitMs', 'scans', 'listed', 'cacheHits', 'read', 'missingFingerprints', 'connectingMs', 'remoteMs', 'localMs', 'transferMs', ...SCAN_DETAIL_KEYS] as const;
export type ScanSummary = { version: 1; pluginVersion: string; platform: 'desktop' | 'mobile' } & Record<typeof KEYS[number], number>;
/** Strict local/export whitelist: never retain arbitrary exception, URL, path, or response fields. */
export function validateScanSummary(value: unknown): ScanSummary | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.pluginVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(v.pluginVersion) || v.pluginVersion.length > 40 || !['desktop', 'mobile'].includes(String(v.platform))) return;
  if (KEYS.some(key => typeof v[key] !== 'number' || !Number.isFinite(v[key]) || Number(v[key]) < 0 || Number(v[key]) > 1e15)) return;
  return { version: 1, pluginVersion: v.pluginVersion, platform: v.platform as ScanSummary['platform'], ...Object.fromEntries(KEYS.map(key => [key, v[key]])) } as ScanSummary;
}
export function scanSummary(snapshot: PerformanceSnapshot | undefined, pluginVersion: string, mobile: boolean): ScanSummary | undefined {
  if (!snapshot) return;
  const values = Object.fromEntries(KEYS.map(key => [key, 0]));
  for (const key of ['elapsedMs', 'requestCount', 'refreshCount', 'retryCount', 'retryWaitMs', 'scans'] as const) values[key] = snapshot[key];
  for (const key of ['listed', 'cacheHits', 'read', 'missingFingerprints'] as const) values[key] = snapshot.versions[key];
  for (const key of SCAN_DETAIL_KEYS) values[key] = snapshot.versions.details?.[key] ?? 0;
  for (const key of ['connecting', 'remote', 'local', 'transfer'] as const) values[key + 'Ms'] = snapshot.stages[key];
  return validateScanSummary({ ...values, version: 1, pluginVersion, platform: mobile ? 'mobile' : 'desktop' });
}
export function formatScanSummary(value?: ScanSummary): string {
  return value ? `请求 ${value.requestCount} 次 · 令牌刷新 ${value.refreshCount} 次 · 扫描 ${value.scans} 轮 · 缓存命中 ${value.cacheHits}/${value.listed} 条\n版本正文 ${(value.readBytes/1024).toFixed(1)} KiB · 缓存写入 ${value.cacheWrites} 次 · 云端 ${(value.remoteMs/1000).toFixed(2)} 秒 · 本地 ${(value.localMs/1000).toFixed(2)} 秒` : '';
}
