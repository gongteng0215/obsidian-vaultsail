import { VaultSailError } from '../core/safety.ts';

export interface SyncNoticeSummary { uploaded: number; downloaded: number; deleted: number; merged: number; conflicts: number; blocked: number; directories?: number; }
export interface SyncNotice { message: string; duration: number; }

/** Device-local presentation only; never changes queue retry or sync decisions. */
export class AutomaticNotifications {
  attention?: string;
  private failures = new Set<string>();
  private warnings = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  clearFailure(): void { this.attention = undefined; this.failures.clear(); }
  reset(): void { this.clearFailure(); this.warnings.clear(); }
  completed(summary: SyncNoticeSummary, automatic: boolean): SyncNotice | undefined {
    this.clearFailure();
    if (!automatic) return;
    const { uploaded, downloaded, deleted, merged, conflicts, blocked } = summary;
    const changed = uploaded + downloaded + deleted + merged + (summary.directories ?? 0) > 0;
    const warning = conflicts > 0 || blocked > 0;
    if (!changed && !warning) return;
    if (warning) {
      const now = this.now(), key = `${conflicts}:${blocked}`;
      for (const [oldKey, time] of this.warnings) if (now - time >= 300_000) this.warnings.delete(oldKey);
      if (!changed && this.warnings.has(key)) return;
      if (this.warnings.size >= 32) this.warnings.delete(this.warnings.keys().next().value!);
      this.warnings.set(key, now);
    }
    const parts = [uploaded ? `上传 ${uploaded} 个` : '', downloaded ? `下载 ${downloaded} 个` : '',
      merged ? `自动合并 ${merged} 个` : '', deleted ? `删除 ${deleted} 项` : '', summary.directories ? `目录 ${summary.directories} 项` : ''].filter(Boolean);
    if (conflicts) parts.push(`${conflicts} 项冲突已保留双方，请查看待解决冲突`);
    if (blocked) parts.push(`跳过 ${blocked} 项未传输，请在传输中心查看`);
    return { message: `VaultSail 自动同步${warning ? '需要留意' : '完成'}：${parts.join('；')}。`, duration: warning ? 12_000 : 4000 };
  }
  failed(error: unknown): SyncNotice | undefined {
    const code = error instanceof VaultSailError ? error.code : 'unknown';
    if (['paused', 'cancelled', 'busy', 'changed'].includes(code)) return;
    const category = ['network', 'timeout'].includes(code) ? 'network'
      : ['authentication', 'token-expired', 'expired_token', 'invalid_grant'].includes(code) ? 'authentication'
      : ['permission', 'configuration', 'binding', 'rate'].includes(code) ? code : 'other';
    const reason = category === 'network' ? '网络异常，待办已保留，将自动重试。'
      : category === 'rate' ? '接口限流，待办已保留，将等待后重试。'
      : category === 'authentication' ? '授权需要检查，请到连接与授权页面重新连接。'
      : category === 'permission' ? '权限验证未通过，请检查应用权限和连接状态。'
      : category === 'configuration' || category === 'binding' ? '连接配置或云端库需要检查，请打开插件设置。'
      : '任务已停止，待办已保留，请在传输中心查看详情。';
    this.attention = '自动同步未完成：' + reason;
    if (this.failures.has(category)) return;
    this.failures.add(category);
    return { message: 'VaultSail ' + this.attention, duration: 12_000 };
  }
}
