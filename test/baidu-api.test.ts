import assert from 'node:assert/strict';
import test from 'node:test';
import { BaiduProbeError, BaiduReadOnlyApi } from '../src/providers/baidu-api.ts';

const ok = (list: unknown[] = []) => ({ errno: 0, list });
const api = (result: unknown) => new BaiduReadOnlyApi(async () => result);
const item = (path: string) => ({ path, size: 12, isdir: 0, fs_id: 99 });

test('identity success returns no private user information', async () => {
  const value = await api({errno: 0, baidu_name: 'sensitive'}).testAccess('secret');
  assert.deepEqual(value, { reachable: true });
});
test('missing errno is not an empty remote result', async () => {
  await assert.rejects(api({list: []}).listPage('secret', '/apps/test'), /missing numeric errno/);
});
test('invalid token maps to auth failure without leaking value', async () => {
  await assert.rejects(api({ errno: -6, access_token: 'do-not-print' }).testAccess('secret'), (error: unknown) => {
    assert.ok(error instanceof BaiduProbeError);
    assert.equal(error.kind, 'authentication');
    assert.doesNotMatch(error.message, /secret|do-not-print/);
    return true;
  });
});
test('malformed listing does not produce empty inventory', async () => {
  await assert.rejects(api({ errno: 0 }).listPage('secret', '/apps/test'), /list is missing/);
});
test('nonzero errno does not produce empty inventory', async () => {
  await assert.rejects(api({ errno: 31066, list: [] }).listPage('secret', '/apps/test'), /31066/);
});
test('network error is sanitized and inventory unknown', async () => {
  const broken = new BaiduReadOnlyApi(async () => { throw Error('https://pan.baidu.com/?access_token=SECRET'); });
  await assert.rejects(broken.listPage('secret', '/apps/test'), (error: unknown) => {
    assert.ok(error instanceof BaiduProbeError);
    assert.equal(error.kind, 'transport');
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
});
test('request uses only readonly endpoints and properly escapes app dir', async () => {
  const urls: string[] = [];
  const client = new BaiduReadOnlyApi(async url => { urls.push(url); return ok(); });
  await client.listPage('secret', '/apps/My Notes');
  const u = new URL(urls[0]);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.searchParams.get('method'), 'list');
  assert.equal(u.searchParams.get('dir'), '/apps/My Notes');
  assert.equal(u.searchParams.get('access_token'), 'secret');
});
test('path traversal and arbitrary root rejected', async () => {
  await assert.rejects(api(ok()).listPage('secret', '/'), /inside \/apps/);
  await assert.rejects(api(ok()).listPage('secret', '/apps/test/../other'), /inside \/apps/);
});
test('wrong directory entry rejected', async () => {
  await assert.rejects(api(ok([item('/elsewhere/a.md')])).listPage('secret', '/apps/test'), /outside/);
});
test('normal list correctly parses files', async () => {
  assert.deepEqual(await api(ok([item('/apps/test/one.md')])).listPage('secret', '/apps/test'), {
    files: [{path:'/apps/test/one.md', size:12, isDirectory:false, fileId:'99'}], nextOffset:null,
  });
});
test('listUpTo walks pages and checks for duplicates', async () => {
  let n = 0;
  const client = new BaiduReadOnlyApi(async () => {
    const files = Array.from({length:100}, (_, i) => item(`/apps/test/${n}-${i}.md`));
    n += 1;
    return ok(n === 1 ? files : [item('/apps/test/end.md')]);
  });
  const listing = await client.listUpTo('secret', '/apps/test', 3);
  assert.equal(listing.files.length, 101);
  assert.equal(listing.complete, true);
  assert.equal(n, 2);
});
test('bounded pagination reports incomplete, never complete', async () => {
  let n = 0;
  const client = new BaiduReadOnlyApi(async () => ok(Array.from({length:100}, (_,i) => item(`/apps/test/${n++}-${i}.md`))));
  const listing = await client.listUpTo('secret', '/apps/test', 1);
  assert.equal(listing.files.length, 100);
  assert.equal(listing.complete, false);
});
test('duplicate listing yields error', async () => {
  const client = new BaiduReadOnlyApi(async () => ok(Array.from({length:100}, () => item('/apps/test/repeated.md'))));
  await assert.rejects(client.listUpTo('secret', '/apps/test'), /Duplicate/);
});
