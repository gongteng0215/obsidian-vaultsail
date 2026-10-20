import './node-host.mjs';
/** Run only against a deliberately isolated test app directory. Does not write remotely. */
import { BaiduReadOnlyApi, BaiduProbeError } from '../src/providers/baidu-api.ts';

const token = process.env.VAULTSAIL_BAIDU_TOKEN || '';
const dir = process.env.VAULTSAIL_BAIDU_APP_DIR || '';

if (!token || !dir) {
  console.error('Missing VAULTSAIL_BAIDU_TOKEN or VAULTSAIL_BAIDU_APP_DIR. See docs/D0_BAIDU_PROBE.md.');
  process.exitCode = 2;
} else {
  const api = new BaiduReadOnlyApi(async (url) => {
    // No URL or auth values are logged, including in failure cases.
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('HTTP error');
    return response.json();
  });
  try {
    await api.testAccess(token);
    console.log('PASS: access token permitted read-only user info endpoint.');
    const inventory = await api.listUpTo(token, dir, 5);
    console.log(`PASS: list returned ${inventory.files.length} entries. Pagination complete: ${inventory.complete}.`);
    console.log('D0 READ ONLY: no uploads, downloads, deletes, or local file mutations performed.');
    if (!inventory.complete) process.exitCode = 3;
  } catch (error) {
    const kind = error instanceof BaiduProbeError ? error.kind : 'transport';
    // Never print the unknown error object: it may contain the request URL/token.
    console.error(`FAIL: read-only API check (${kind}). No remote deletion or upload attempted.`);
    process.exitCode = 1;
  }
}
