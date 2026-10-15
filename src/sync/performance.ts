import type { HttpRequest, HttpResponse, HttpTransport } from '../providers/http.ts';
import type { ProgressPhase } from './progress.ts';

const STAGES = { connecting: '连接检查', remote: '云端扫描', local: '本地扫描', transfer: '传输处理' } as const;
const REQUESTS = {
  account: '账号检查', list: '目录查询', prepare: '预上传', upload: '上传分片', commit: '提交文件或目录',
  metadata: '下载信息', download: '下载与回读', refresh: '令牌刷新', authorize: '授权', other: '其他请求',
} as const;
type Stage = keyof typeof STAGES;
type RequestKind = keyof typeof REQUESTS;
interface RequestStats { count: number; failed: number; elapsedMs: number; maxMs: number; pending: number; }
export interface PerformanceSnapshot {
  elapsedMs: number; stages: Record<Stage, number>; requests: Partial<Record<RequestKind, RequestStats>>;
  requestCount: number; refreshCount: number; retryCount: number; retryWaitMs: number;
}
// Only fixed categories and numbers enter the report. No URL, path, response,
// token, error text or request body is retained, even for failed requests.
function kind(input: HttpRequest): RequestKind {
  const url = new URL(input.url);
  if (url.hostname === 'openapi.baidu.com' && url.pathname.startsWith('/oauth/2.0/'))
    return url.searchParams.get('grant_type') === 'refresh_token' ? 'refresh' : 'authorize';
  if (url.hostname === 'pan.baidu.com' && url.pathname.startsWith('/rest/2.0/xpan/')) {
    const method = url.searchParams.get('method');
    return method === 'uinfo' ? 'account' : method === 'list' ? 'list' : method === 'precreate' ? 'prepare'
      : method === 'create' ? 'commit' : method === 'filemetas' ? 'metadata' : 'other';
  }
  if (url.hostname === 'd.pcs.baidu.com' && url.searchParams.get('method') === 'upload') return 'upload';
  if (url.hostname === 'pan.baidu.com' && url.pathname === '/api/quota') return 'other';
  if (['baidu.com', 'baidupcs.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return 'download';
  return 'other';
}
export class TransferPerformance {
  private state?: { started: number; ended?: number; stage?: Stage; since: number; stages: Record<Stage, number>;
    requests: Partial<Record<RequestKind, RequestStats>>; pending: Map<object, { kind: RequestKind; started: number }>; retryCount: number; retryWaitMs: number };
  private now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }
  begin(): void {
    const now = this.now();
    this.state = { started: now, since: now, stages: { connecting: 0, remote: 0, local: 0, transfer: 0 }, requests: {}, pending: new Map(), retryCount: 0, retryWaitMs: 0 };
  }
  phase(phase: ProgressPhase): void {
    const state = this.state; if (!state || state.ended !== undefined) return;
    const now = this.now();
    if (state.stage) state.stages[state.stage] += Math.max(0, now - state.since);
    state.since = now;
    state.stage = ['completed', 'paused', 'failed', 'preview-ready'].includes(phase) ? undefined
      : phase === 'connecting' ? 'connecting' : ['scanning-remote', 'checking-remote'].includes(phase) ? 'remote' : phase === 'scanning-local' ? 'local' : 'transfer';
  }
  finish(): void {
    const state = this.state; if (!state || state.ended !== undefined) return;
    this.phase('completed'); state.ended = this.now();
  }
  retry(waitedMs: number): void {
    const state = this.state; if (!state || state.ended !== undefined) return;
    state.retryCount++; state.retryWaitMs += Math.max(0, waitedMs);
  }
  async transport(transport: HttpTransport, input: HttpRequest): Promise<HttpResponse> {
    const state = this.state;
    if (!state || state.ended !== undefined) return transport(input);
    const category = kind(input), started = this.now(), id = {};
    const stats = state.requests[category] ??= { count: 0, failed: 0, elapsedMs: 0, maxMs: 0, pending: 0 };
    stats.count++; state.pending.set(id, { kind: category, started });
    let failed = false;
    try { const response = await transport(input); failed = response.status >= 400; return response; }
    catch (error) { failed = true; throw error; }
    finally {
      // Native requests may finish after timeout, unload or a subsequent task.
      // Their late results cannot mutate a frozen report or the next task.
      if (this.state === state && state.ended === undefined) {
        const elapsed = Math.max(0, this.now() - started); stats.elapsedMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed);
        if (failed) stats.failed++; state.pending.delete(id);
      }
    }
  }
  snapshot(): PerformanceSnapshot | undefined {
    const state = this.state; if (!state) return undefined;
    const now = state.ended ?? this.now(), stages = { ...state.stages };
    if (state.stage) stages[state.stage] += Math.max(0, now - state.since);
    const requests: PerformanceSnapshot['requests'] = {};
    for (const key of Object.keys(state.requests) as RequestKind[]) requests[key] = { ...state.requests[key]! };
    for (const pending of state.pending.values()) {
      const stats = requests[pending.kind]!; const elapsed = Math.max(0, now - pending.started);
      stats.pending++; stats.elapsedMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed);
    }
    return { elapsedMs: Math.max(0, now - state.started), stages, requests,
      requestCount: Object.values(requests).reduce((sum, stat) => sum + stat.count, 0), refreshCount: requests.refresh?.count ?? 0,
      retryCount: state.retryCount, retryWaitMs: state.retryWaitMs };
  }
}
export function formatPerformance(value?: PerformanceSnapshot): string {
  if (!value) return '';
  const uploadMs = ['prepare', 'upload', 'commit'].reduce((sum, key) => sum + (value.requests[key as RequestKind]?.elapsedMs ?? 0), 0);
  return Object.entries(STAGES).map(([key, label]) => `${label} ${(value.stages[key as Stage] / 1000).toFixed(1)} 秒`).join(' · ')
    + `\n请求耗时（并发累计）：上传相关 ${(uploadMs / 1000).toFixed(1)} 秒 · 下载/回读 ${((value.requests.download?.elapsedMs ?? 0) / 1000).toFixed(1)} 秒`
    + `\n网络请求 ${value.requestCount} 次 · 令牌刷新 ${value.refreshCount} 次`
    + (value.retryCount ? ` · 失败/限流等待 ${value.retryCount} 次（累计 ${(value.retryWaitMs / 1000).toFixed(1)} 秒）` : '');
}
export const REQUEST_LABELS = REQUESTS;
