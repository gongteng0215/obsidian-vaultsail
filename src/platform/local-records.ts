/** Local storage is untrusted: expose only fixed, validated report fields. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function readLastSuccess(value: unknown): { completedAt: number; files: number; bytes: number; elapsedMs: number; blockedFiles: number } | undefined {
  const v = object(value);
  if (!v || !count(v.completedAt) || !count(v.files) || !count(v.bytes) || !count(v.elapsedMs)) return undefined;
  return { completedAt: v.completedAt, files: v.files, bytes: v.bytes, elapsedMs: v.elapsedMs,
    blockedFiles: count(v.blockedFiles) && Number.isSafeInteger(v.blockedFiles) ? v.blockedFiles : 0 };
}
export function readLocalValidation(value: unknown) {
  const v = object(value); if (!v || typeof v.passed !== 'boolean') return undefined;
  const results = (Array.isArray(v.results) ? v.results as unknown[] : []).flatMap(item => {
    const row = object(item); return row && count(row.size) && typeof row.passed === 'boolean' ? [{ size: row.size, passed: row.passed }] : [];
  }).slice(0, 100);
  return { passed: v.passed, checkedAt: count(v.checkedAt) ? v.checkedAt : undefined,
    source: v.source === 'pairing-local-probe' ? 'pairing-local-probe' : 'full-roundtrip', results,
    quota: v.quota === '已验证' ? '已验证' : '未验证' };
}
