import { record, VaultSailError } from '../core/safety.ts';
export interface HttpRequest { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; }
export interface HttpResponse { status: number; headers: Record<string, string>; json?: unknown; bytes: ArrayBuffer; }
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
export interface RequestPolicy { timeoutMs?: number; signal?: AbortSignal; }
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export function urlWith(base: string, params: Record<string, string>): string {
  const url = new URL(base); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value); return url.toString();
}
export async function request(transport: HttpTransport, input: HttpRequest, allowOAuthError = false, policy: RequestPolicy = {}): Promise<HttpResponse> {
  if (policy.signal?.aborted) throw new VaultSailError('cancelled', '请求已取消。');
  const pending = Promise.resolve().then(() => transport(input)).catch(() => { throw new VaultSailError('network', '网络请求失败；远端状态未知，请重试。', true); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let result: HttpResponse;
  try {
    result = await Promise.race([pending, new Promise<never>((_, reject) => {
      const write = !['GET', 'HEAD'].includes((input.method ?? 'GET').toUpperCase());
      timer = setTimeout(() => reject(new VaultSailError(write ? 'write-timeout' : 'timeout', write
        ? '写入请求超时，远端结果尚未确认；任务已保留，请先核验后恢复。'
        : '网络请求超时，请检查网络后重试。', !write)), policy.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      if (policy.signal) {
        abort = () => reject(new VaultSailError('cancelled', '请求已取消。'));
        policy.signal.addEventListener('abort', abort, { once: true });
        if (policy.signal.aborted) abort();
      }
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) policy.signal?.removeEventListener('abort', abort);
  }
  if (result.status === 429 || result.status >= 500) {
    const value = Object.entries(result.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    const delay = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now())) : 0;
    throw new VaultSailError('rate', '接口繁忙或限流，任务已保留。', true, Number.isFinite(delay) ? delay : 0);
  }
  if (allowOAuthError && result.status >= 400 && result.status < 500) return result;
  if (result.status < 200 || result.status >= 300) throw new VaultSailError('http', `接口请求未通过（HTTP ${result.status}）。`);
  return result;
}
export function apiSuccess(value: unknown, format: 'xpan' | 'pcs-upload' = 'xpan'): Record<string, unknown> {
  const result = record(value);
  // Baidu uses different error envelopes across XPAN, PCS and gateway responses.
  // Explicit errors always win over success-looking payload fields.
  if (result.error !== undefined && result.error !== '') throw new VaultSailError('authentication', '百度返回授权错误，请检查应用配置并重新授权。');
  const fields = ['errno', 'error_code', 'error_no'].filter(key => Object.hasOwn(result, key));
  if (fields.some(key => !Number.isSafeInteger(result[key]))) throw new VaultSailError('response', '接口状态码格式无效，不能确认远端结果。');
  const code = Number(fields.map(key => result[key]).find(value => value !== 0) ?? 0);
  if (code !== 0) throwApiCode(code);
  if (format === 'pcs-upload') {
    // Only this endpoint may omit errno on success. The caller also compares this
    // digest with the uploaded bytes before it publishes any file metadata.
    if (typeof result.md5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(result.md5)) throw new VaultSailError('response', '分片上传未返回有效 MD5，不能确认上传结果。');
    return result;
  }
  if (!fields.length) throw new VaultSailError('response', '接口缺少有效状态码，不能确认远端结果。');
  return result;
}
function throwApiCode(code: number): never {
  if ([20016, 20017].includes(code)) throw new VaultSailError('token-expired', '授权令牌失效，需要续期。');
  if (code === -9) throw new VaultSailError('not-found', '远端目录或文件不存在。');
  if (code === -8) throw new VaultSailError('exists', '远端对象已存在，不能覆盖。');
  if (code === -6 || code === 31045) throw new VaultSailError('permission', `身份或接口权限未通过（百度错误码 ${code}），请检查应用授权。`);
  if (code === 31034) throw new VaultSailError('rate', '百度接口限流，任务已保留。', true);
  throw new VaultSailError('api', `百度接口返回错误码 ${code}，已停止操作。`);
}
