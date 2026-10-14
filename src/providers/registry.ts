import { BaiduProvider, type TokenSource } from './baidu-provider';
import type { HttpTransport } from './http';

// A provider instance belongs to one app root and credential session.
export function createProvider(id: string, root: string, transport: HttpTransport, auth: TokenSource, active?: () => boolean): BaiduProvider {
  if (id !== 'baidu') throw new Error('Unsupported provider');
  return new BaiduProvider(root, transport, auth, active);
}
