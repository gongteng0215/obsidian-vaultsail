import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthManager, type CredentialStore } from '../src/auth/auth-manager.ts';
import { bytes, VaultSailError } from '../src/core/safety.ts';
import type { HttpTransport, HttpResponse } from '../src/providers/http.ts';

const response = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json, bytes: bytes(JSON.stringify(json)) });
const device = { device_code: 'private-device', user_code: 'DISPLAY', verification_url: 'https://openapi.baidu.com/device', expires_in: 600, interval: 5 };
const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'basic netdisk' };
function setup(transport: HttpTransport, wait?: (ms: number, signal?: AbortSignal) => Promise<void>) {
  const map = new Map([['own-secret', 'private-secret']]);
  const store: CredentialStore = { get: key => map.get(key) ?? null, set: (key, value) => { map.set(key, value); }, remove: key => { map.delete(key); } };
  const config = { appKey: 'own-app', secretRef: 'own-secret', sessionRef: 'vaultsail-session-test' };
  return { auth: new AuthManager(transport, store, () => config, wait), map, config };
}
test('device authorization honors pending and slow_down and persists one private session', async () => {
  const intervals: number[] = []; let polls = 0;
  const { auth, map } = setup(async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/device/code')) { assert.equal(url.searchParams.get('scope'), 'basic,netdisk'); return response(device); }
    assert.equal(url.searchParams.get('grant_type'), 'device_token'); assert.equal(url.searchParams.get('code'), 'private-device');
    polls++; return response(polls === 1 ? { error: 'authorization_pending' } : polls === 2 ? { error: 'slow_down' } : tokens);
  }, async ms => { intervals.push(ms); });
  await auth.connect(session => { assert.equal(session.userCode, 'DISPLAY'); assert.equal('deviceCode' in session, false); });
  assert.deepEqual(intervals, [5000, 5000, 10000]); assert.equal(auth.status(), 'connected');
  assert.equal(await auth.accessToken(), tokens.access_token); assert.equal(map.size, 2);
});
test('cancelled authorization response cannot save tokens', async () => {
  let finish!: (value: HttpResponse) => void;
  let pollStarted!: () => void;
  const started = new Promise<void>(resolve => { pollStarted = resolve; });
  const { auth, map } = setup(async request => request.url.includes('/device/code') ? response(device) : new Promise(resolve => { finish = resolve; pollStarted(); }), async () => {});
  const pending = auth.connect(() => {});
  await started;
  auth.cancel(); finish(response(tokens)); await assert.rejects(pending, { code: 'cancelled' }); assert.equal(map.size, 1);
});
test('configuration changes invalidate late device response', async () => {
  let finish!: (value: HttpResponse) => void;
  const { auth, config, map } = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = auth.connect(() => {});
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  config.appKey = 'other-app'; finish(response(device));
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(map.size, 1);
});
test('only explicit unsupported authorization enables code fallback', async () => {
  for (const error of ['unsupported_response_type', 'access_denied', 'invalid_client', 'arbitrary private-secret']) {
    const { auth } = setup(async () => response({ error, error_description: 'private-secret' }));
    await assert.rejects(auth.connect(() => {}), e => e instanceof VaultSailError && !e.message.includes('private-secret'));
    assert.equal(auth.fallbackAllowed, error === 'unsupported_response_type');
  }
});
test('network failures neither leak request values nor enable fallback', async () => {
  const { auth } = setup(async () => { throw new Error('private-secret URL'); });
  await assert.rejects(auth.connect(() => {}), e => e instanceof VaultSailError && e.code === 'network' && !e.message.includes('private-secret'));
  assert.equal(auth.fallbackAllowed, false);
});
test('missing scope and non-Baidu verification pages are rejected', async () => {
  const { auth } = setup(async request => response(request.url.includes('/device/code') ? { ...device, verification_url: 'https://evil.example/authorize' } : tokens), async () => {});
  await assert.rejects(auth.connect(() => {}), { code: 'response' });
  const second = setup(async request => response(request.url.includes('/device/code') ? device : { ...tokens, scope: 'basic' }), async () => {});
  await assert.rejects(second.auth.connect(() => {}), { code: 'permission' }); assert.equal(second.map.size, 1);
});
test('concurrent token refresh shares one request and survives restart', async () => {
  let refreshes = 0; const transport: HttpTransport = async request => {
    if (request.url.includes('/device/code')) return response(device);
    if (request.url.includes('grant_type=refresh_token')) { refreshes++; return response({ ...tokens, access_token: 'refreshed', refresh_token: 'rotated' }); }
    return response(tokens);
  };
  const { auth, map, config } = setup(transport, async () => {}); await auth.connect(() => {});
  const stored = JSON.parse(map.get(config.sessionRef)!); stored.expiresAt = 1; map.set(config.sessionRef, JSON.stringify(stored));
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]), ['refreshed', 'refreshed', 'refreshed']); assert.equal(refreshes, 1);
  const store: CredentialStore = { get: key => map.get(key) ?? null, set: (key, value) => { map.set(key, value); }, remove: key => { map.delete(key); } };
  const restarted = new AuthManager(transport, store, () => config); assert.equal(restarted.status(), 'connected'); assert.equal(await restarted.accessToken(), 'refreshed');
  restarted.disconnect(); assert.equal(map.has(config.sessionRef), false); assert.equal(map.get('own-secret'), 'private-secret');
});
test('refresh failure requires reauthorization without infinite retry', async () => {
  const { auth } = setup(async request => response(request.url.includes('/device/code') ? device : request.url.includes('grant_type=refresh_token') ? { error: 'invalid_grant' } : tokens), async () => {});
  await auth.connect(() => {}); await assert.rejects(auth.accessToken(true), { code: 'invalid_grant' });
  assert.equal(auth.status(), 'reauthorize'); await assert.rejects(auth.accessToken(), { code: 'authentication' });
});
test('OAuth errors on HTTP 400 still provide classified fallback and reject successful-looking error responses', async () => {
  const { auth } = setup(async () => ({ ...response({ error: 'unsupported_response_type' }), status: 400 }));
  await assert.rejects(auth.connect(() => {}), { code: 'unsupported_response_type' }); assert.equal(auth.fallbackAllowed, true);
  const second = setup(async () => ({ ...response(tokens), status: 400 })); await assert.rejects(second.auth.connect(() => {}), { code: 'http' });
});
test('reserved session selection is rejected before disconnect can erase the selected secret', async () => {
  const { auth, config, map } = setup(async () => { throw new Error('must not contact OAuth'); });
  config.sessionRef = 'vaultsail-session-test'; config.secretRef = config.sessionRef; map.set(config.secretRef, 'user-entered-secret');
  assert.equal(auth.status(), 'unconfigured'); assert.match(auth.configurationIssue()!, /授权会话/);
  await assert.rejects(auth.connect(() => {}), e => e instanceof VaultSailError && e.code === 'configuration' && e.message.includes('重新保存'));
  assert.equal(map.get(config.secretRef), 'user-entered-secret'); auth.disconnect(); assert.equal(map.get(config.secretRef), 'user-entered-secret');
});
test('missing AppKey, missing reference and empty secret have distinct actionable messages', () => {
  const { auth, config, map } = setup(async () => response(tokens));
  config.appKey = ''; assert.match(auth.configurationIssue()!, /AppKey 尚未保存/);
  config.appKey = 'saved-app'; config.secretRef = ''; assert.match(auth.configurationIssue()!, /SecretKey 尚未保存/);
  config.secretRef = 'own-secret'; map.set(config.secretRef, ''); assert.match(auth.configurationIssue()!, /存储项为空/);
  map.set(config.secretRef, 'saved-secret'); assert.equal(auth.configurationIssue(), null);
});

test('imported authorization remaps local references and refreshes without device/code requests; transient refresh failures retain session', async () => {
  const requests: string[] = []; let fail = true;
  const { auth, map, config } = setup(async request => {
    requests.push(request.url); if (fail) throw new Error('secret network detail');
    return response({ ...tokens, access_token: 'imported-refreshed' });
  });
  auth.restoreSession({ accessToken: 'imported-access', refreshToken: 'imported-refresh', expiresAt: 1 });
  await assert.rejects(auth.accessToken(), { code: 'network' }); assert.ok(map.has(config.sessionRef)); assert.equal(auth.status(), 'connected');
  fail = false; assert.equal(await auth.accessToken(), 'imported-refreshed'); assert.ok(requests.every(url => url.includes('grant_type=refresh_token')));
  const exported = auth.exportCredentials(); assert.equal(exported.secretKey, 'private-secret'); assert.equal(exported.session.accessToken, 'imported-refreshed');
  assert.equal('secretRef' in exported.session, false); assert.equal('sessionRef' in exported.session, false);
  const before = map.get(config.sessionRef); assert.throws(() => auth.restoreSession({ accessToken: '', refreshToken: 'x', expiresAt: 1 })); assert.equal(map.get(config.sessionRef), before);
});
test('late expiry responses for an old token reuse the newer token instead of refreshing it again', async () => {
  let refreshes = 0; const { auth } = setup(async () => { refreshes++; return response({ ...tokens, access_token: 'new-access' }); });
  auth.restoreSession({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000 });
  assert.equal(await auth.accessToken(true, 'old-access'), 'new-access');
  assert.equal(await auth.accessToken(true, 'old-access'), 'new-access'); assert.equal(refreshes, 1);
});
