import { uuid } from '../core/safety.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../providers/http.ts';
import { requestKind } from '../sync/performance.ts';
import type { DiagnosticLog, LogFields } from './log.ts';

export async function traceRequest(log: DiagnosticLog | undefined, transport: HttpTransport, input: HttpRequest): Promise<HttpResponse> {
  if (!log) return transport(input);
  const started = Date.now(); let endpoint = 'other'; try { endpoint = requestKind(input); } catch { /* Never retain a malformed URL. */ }
  const context: LogFields = { ...log.context(), requestId: uuid(), endpoint,
    method: ['GET', 'POST', 'HEAD'].includes(input.method ?? 'GET') ? input.method ?? 'GET' : 'other',
    bytes: typeof input.body === 'string' ? new TextEncoder().encode(input.body).byteLength : input.body?.byteLength ?? 0 };
  log.record('network', 'start', context);
  try {
    const response = await transport(input);
    const json = response.json && typeof response.json === 'object' ? response.json as Record<string, unknown> : {};
    const code = [json.errno, json.error_code, json.error_no].find(value => Number.isSafeInteger(value) && value !== 0);
    const serviceRequestId = typeof json.request_id === 'string' ? json.request_id : Number.isSafeInteger(json.request_id) ? String(json.request_id) : undefined;
    const expectedPending = json.error === 'authorization_pending' || json.error === 'slow_down';
    const failed = response.status >= 400 || code !== undefined || (typeof json.error === 'string' && json.error !== '' && !expectedPending);
    log.record('network', failed && !expectedPending ? 'failure' : 'finish', { ...context, status: response.status,
      durationMs: Date.now() - started, bytes: response.bytes.byteLength, ...(code !== undefined ? { apiCode: Number(code) } : {}),
      serviceRequestId, outcome: expectedPending ? 'pending' : failed ? 'failure' : 'success' });
    return response;
  } catch (error) {
    log.record('network', 'failure', { ...context, durationMs: Date.now() - started, outcome: 'failure' }, error); throw error;
  }
}
