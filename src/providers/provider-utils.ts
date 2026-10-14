import { VaultSailError } from '../core/safety.ts';
import type { CloudStorageProvider, RemoteObject } from './cloud-storage-provider';

export async function listAll(provider: CloudStorageProvider, directory: string): Promise<RemoteObject[]> {
  const objects: RemoteObject[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
  for (let pageCount = 0; pageCount < 1000; pageCount++) {
    const page = await provider.list(directory, cursor);
    for (const object of page.objects) {
      if (seen.has(object.path)) throw new VaultSailError('response', '分页出现重复对象，远端清单不可信。');
      seen.add(object.path); objects.push(object);
    }
    if (page.complete) { if (page.nextCursor) throw new VaultSailError('response', '分页完成状态矛盾。'); return objects; }
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new VaultSailError('response', '分页缺少推进信息。');
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new VaultSailError('response', '目录超过扫描上限，未完成扫描。');
}
