import type { CloudStorageProvider } from './cloud-storage-provider';
import { BaiduProvider } from './baidu';

export const providers: ReadonlyMap<string, CloudStorageProvider> = new Map([
  ['baidu', new BaiduProvider()],
]);

export function getProvider(id: string): CloudStorageProvider | undefined {
  return providers.get(id);
}
