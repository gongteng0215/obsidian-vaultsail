import { record, sleep, VaultSailError } from '../core/safety.ts';
import { request, urlWith, type HttpTransport } from '../providers/http.ts';

export interface CredentialStore { get(id: string): string | null; set(id: string, value: string): void; remove(id: string): void; }
export interface AuthConfig { appKey: string; secretRef: string; sessionRef: string; }
interface TokenSet { appKey: string; secretRef: string; accessToken: string; refreshToken: string; expiresAt: number; }
export interface DeviceSession { userCode: string; verificationUrl: string; expiresAt: number; }
export type AuthStatus = 'unconfigured' | 'disconnected' | 'pending' | 'connected' | 'reauthorize';
const OAUTH = 'https://openapi.baidu.com/oauth/2.0/';
const ERRORS: Record<string, string> = {
  authorization_pending: '等待你在百度页面完成授权。', slow_down: '授权查询过于频繁，正在延长间隔。',
  access_denied: '你已拒绝授权。', expired_token: '设备码已过期，请重新连接。',
  invalid_client: 'AppKey 或 SecretKey 无效，请检查自己的应用配置。', invalid_grant: '授权凭据已失效，请重新连接。',
  unsupported_response_type: '应用不支持设备码授权。', unsupported_grant_type: '应用不支持所选授权方式。',
};
export class AuthManager {
  private transport: HttpTransport;
  private store: CredentialStore;
  private config: () => AuthConfig;
  private generation = 0;
  private refreshTask?: Promise<string>;
  private refreshGeneration = -1;
  private statusValue: AuthStatus = 'disconnected';
  private controller = new AbortController();
  private wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  fallbackAllowed = false;
  constructor(transport: HttpTransport, store: CredentialStore, config: () => AuthConfig, wait = sleep) {
    this.transport = transport; this.store = store; this.config = config; this.wait = wait;
  }
  private token(): TokenSet | null {
    const cfg = this.config(); const raw = this.store.get(cfg.sessionRef);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as TokenSet;
      return value.appKey === cfg.appKey && value.secretRef === cfg.secretRef && typeof value.accessToken === 'string'
        && typeof value.refreshToken === 'string' && Number.isFinite(value.expiresAt) ? value : null;
    } catch { return null; }
  }
  status(): AuthStatus {
    if (this.configurationIssue()) return 'unconfigured';
    if (this.statusValue === 'pending' || this.statusValue === 'reauthorize') return this.statusValue;
    return this.token() ? 'connected' : 'disconnected';
  }
  configurationIssue(): string | null {
    const cfg = this.config();
    if (!cfg.appKey.trim()) return 'AppKey 尚未保存，请填写后点击保存。';
    if (!cfg.secretRef) return 'SecretKey 尚未保存，请在密钥输入框填写后点击保存。';
    if (cfg.secretRef.startsWith('vaultsail-session-')) return '旧版选中了授权会话项，并不是可用的应用密钥。请在 SecretKey 输入框重新保存一次。';
    if (!this.store.get(cfg.secretRef)?.trim()) return 'SecretKey 存储项为空或不可用，请重新保存密钥；AppKey 无需重填。';
    return null;
  }
  private credentials(): { cfg: AuthConfig; secret: string } {
    const issue = this.configurationIssue(); if (issue) throw new VaultSailError('configuration', issue);
    const cfg = { ...this.config() }; const secret = this.store.get(cfg.secretRef);
    return { cfg, secret: secret! };
  }
  private async oauth(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await request(this.transport, { url: urlWith(OAUTH + path, params) }, true, { timeoutMs: 15000, signal: this.controller.signal });
    const result = record(response.json);
    if (typeof result.error === 'string') {
      const code = Object.hasOwn(ERRORS, result.error) ? result.error : 'oauth';
      throw new VaultSailError(code, ERRORS[code] ?? '百度授权失败，请检查应用权限。');
    }
    if (response.status >= 400) throw new VaultSailError('http', `百度授权请求未通过（HTTP ${response.status}）。`);
    return result;
  }
  private active(generation: number, cfg: AuthConfig): void {
    const now = this.config();
    if (generation !== this.generation || cfg.appKey !== now.appKey || cfg.secretRef !== now.secretRef || cfg.sessionRef !== now.sessionRef) throw new VaultSailError('cancelled', '授权会话已取消或配置已更改。');
  }
  private save(value: Record<string, unknown>, cfg: AuthConfig, generation: number): string {
    this.active(generation, cfg);
    if (typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token
      || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new VaultSailError('response', '授权响应不完整，未保存令牌。');
    if (typeof value.scope !== 'string' || !value.scope.split(/[ ,]+/).includes('netdisk')) throw new VaultSailError('permission', '授权未包含 netdisk 权限。');
    const tokens: TokenSet = { appKey: cfg.appKey, secretRef: cfg.secretRef, accessToken: value.access_token,
      refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000 };
    this.store.set(cfg.sessionRef, JSON.stringify(tokens)); this.statusValue = 'connected'; return tokens.accessToken;
  }
  cancel(): void { this.generation++; this.controller.abort(); this.controller = new AbortController(); this.statusValue = 'disconnected'; }
  disconnect(): void {
    this.cancel(); const cfg = this.config();
    if (cfg.secretRef !== cfg.sessionRef) this.store.remove(cfg.sessionRef);
    this.fallbackAllowed = false;
  }
  async connect(onDevice: (session: DeviceSession) => void): Promise<void> {
    const { cfg, secret } = this.credentials();
    this.disconnect(); this.fallbackAllowed = false; const generation = this.generation;
    this.statusValue = 'pending'; const signal = this.controller.signal;
    try {
      const device = await this.oauth('device/code', { response_type: 'device_code', client_id: cfg.appKey, scope: 'basic,netdisk' });
      this.active(generation, cfg);
      if (typeof device.device_code !== 'string' || !device.device_code || typeof device.user_code !== 'string'
        || typeof device.verification_url !== 'string' || typeof device.expires_in !== 'number' || device.expires_in <= 0
        || !Number.isFinite(device.expires_in) || typeof device.interval !== 'number' || !Number.isFinite(device.interval) || device.interval <= 0) throw new VaultSailError('response', '设备授权响应不完整。');
      const link = new URL(device.verification_url);
      if (link.protocol !== 'https:' || !(link.hostname === 'baidu.com' || link.hostname.endsWith('.baidu.com')) || link.username || link.password) throw new VaultSailError('response', '授权页面不是百度官方 HTTPS 地址。');
      const expiresAt = Date.now() + device.expires_in * 1000; let interval = Math.max(5, device.interval) * 1000;
      onDevice({ userCode: device.user_code, verificationUrl: link.toString(), expiresAt });
      while (Date.now() < expiresAt) {
        await this.wait(Math.min(interval, Math.max(0, expiresAt - Date.now())), signal); this.active(generation, cfg);
        if (Date.now() >= expiresAt) break;
        try {
          const result = await this.oauth('token', { grant_type: 'device_token', code: device.device_code, client_id: cfg.appKey, client_secret: secret });
          this.save(result, cfg, generation); return;
        } catch (error) {
          this.active(generation, cfg);
          if (error instanceof VaultSailError && error.code === 'authorization_pending') continue;
          if (error instanceof VaultSailError && error.code === 'slow_down') { interval += 5000; continue; }
          throw error;
        }
      }
      throw new VaultSailError('expired_token', '设备码已过期，请重新连接。');
    } catch (error) {
      if (generation === this.generation) {
        this.statusValue = 'disconnected';
        this.fallbackAllowed = error instanceof VaultSailError && ['unsupported_response_type', 'unsupported_grant_type'].includes(error.code);
      }
      throw error;
    }
  }
  codeUrl(): string {
    if (!this.fallbackAllowed) throw new VaultSailError('configuration', '仅在设备码明确不受支持时启用备用授权。');
    return urlWith(OAUTH + 'authorize', { response_type: 'code', client_id: this.credentials().cfg.appKey, redirect_uri: 'oob', scope: 'basic,netdisk', display: 'page' });
  }
  async exchangeCode(code: string): Promise<void> {
    if (!this.fallbackAllowed || !code.trim()) throw new VaultSailError('configuration', '备用授权不可用或授权码为空。');
    this.cancel(); const { cfg, secret } = this.credentials(); const generation = this.generation;
    this.save(await this.oauth('token', { grant_type: 'authorization_code', code: code.trim(), client_id: cfg.appKey, client_secret: secret, redirect_uri: 'oob' }), cfg, generation);
  }
  async accessToken(forceRefresh = false): Promise<string> {
    const current = this.token();
    if (!current || this.statusValue === 'reauthorize') throw new VaultSailError('authentication', '请先连接百度网盘或重新授权。');
    if (!forceRefresh && current.expiresAt > Date.now() + 120000) return current.accessToken;
    if (this.refreshTask && this.refreshGeneration === this.generation) return this.refreshTask;
    const { cfg, secret } = this.credentials(); const generation = this.generation;
    this.refreshGeneration = generation;
    const task = (async () => {
      try { return this.save(await this.oauth('token', { grant_type: 'refresh_token', refresh_token: current.refreshToken,
        client_id: cfg.appKey, client_secret: secret }), cfg, generation); }
      catch (error) { if (generation === this.generation) { this.statusValue = 'reauthorize'; this.store.remove(cfg.sessionRef); } throw error; }
      finally { if (generation === this.generation) this.refreshTask = undefined; }
    })();
    this.refreshTask = task; return task;
  }
}
