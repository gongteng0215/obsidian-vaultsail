/**
 * Baidu Netdisk D0 read-only probe transport. No writes and no credential persistence.
 * The API may change: this adapter must be validated using the application's own grants.
 */
export type JsonGet = (url: string) => Promise<unknown>;

export interface BaiduProfile {
  /** Deliberately excludes user identity, email, avatar, and token. */
  reachable: true;
}

export interface BaiduListedFile {
  path: string;
  isDirectory: boolean;
  size: number;
  fileId?: string;
}

export interface BaiduListing {
  files: BaiduListedFile[];
  nextOffset: number | null;
}

const BASE = 'https://pan.baidu.com/rest/2.0/xpan/';
const MAX_PAGE_SIZE = 100;

/** Errors are intentionally sanitized; no token, full URL, or raw response in messages. */
export class BaiduProbeError extends Error {
  readonly kind: 'authentication' | 'api' | 'response' | 'transport';
  constructor(kind: 'authentication' | 'api' | 'response' | 'transport', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'BaiduProbeError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSuccess(value: unknown): Record<string, unknown> {
  if (!isObject(value) || typeof value.errno !== 'number' || !Number.isInteger(value.errno)) {
    throw new BaiduProbeError('response', 'Invalid Baidu API response: missing numeric errno.');
  }
  if (value.errno === -6) {
    throw new BaiduProbeError('authentication', 'Baidu authorization failed or expired (errno -6).');
  }
  if (value.errno !== 0) {
    throw new BaiduProbeError('api', `Baidu API returned errno ${value.errno}. No local files were changed.`);
  }
  return value;
}

function buildUrl(path: 'nas' | 'file', params: Record<string, string>): string {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function assertAccessToken(token: string): void {
  if (!token || /\s/.test(token)) {
    throw new BaiduProbeError('authentication', 'A nonempty access token is required.');
  }
}

function assertDir(dir: string): void {
  // Never query arbitrary cloud directories when probing; restrict to the app sandbox.
  if (!/^\/apps\/[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)*\/?$/.test(dir)
      || dir.includes('..')) {
    throw new BaiduProbeError('response', 'Probe directory must be inside /apps/<app-name> without traversal.');
  }
}

export class BaiduReadOnlyApi {
  private readonly jsonGet: JsonGet;
  constructor(jsonGet: JsonGet) { this.jsonGet = jsonGet; }

  private async get(path: 'nas' | 'file', params: Record<string, string>): Promise<Record<string, unknown>> {
    try {
      return validateSuccess(await this.jsonGet(buildUrl(path, params)));
    } catch (error) {
      if (error instanceof BaiduProbeError) throw error;
      // Transport failures must not be treated as empty inventories or leak request URLs.
      throw new BaiduProbeError('transport', 'Baidu request failed; remote inventory is UNKNOWN, not empty.');
    }
  }

  async testAccess(accessToken: string): Promise<BaiduProfile> {
    assertAccessToken(accessToken);
    await this.get('nas', { method: 'uinfo', access_token: accessToken });
    return { reachable: true };
  }

  async listPage(accessToken: string, appDir: string, offset = 0, limit = MAX_PAGE_SIZE): Promise<BaiduListing> {
    assertAccessToken(accessToken);
    assertDir(appDir);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new BaiduProbeError('response', 'Invalid pagination parameters.');
    }
    const response = await this.get('file', {
      method: 'list', access_token: accessToken, dir: appDir,
      start: String(offset), limit: String(limit), order: 'name', desc: '0', web: '0',
    });
    if (!Array.isArray(response.list)) {
      throw new BaiduProbeError('response', 'Incomplete Baidu list response: list is missing; refusing an empty-inventory interpretation.');
    }
    if (response.list.length > limit) {
      throw new BaiduProbeError('response', 'Baidu list response exceeded requested page size.');
    }
    const files = response.list.map((raw): BaiduListedFile => {
      if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.size !== 'number' || !Number.isFinite(raw.size)
          || typeof raw.isdir !== 'number' || ![0, 1].includes(raw.isdir)) {
        throw new BaiduProbeError('response', 'Baidu list contains an invalid file entry.');
      }
      if (!raw.path.startsWith(appDir.replace(/\/$/, '') + '/')) {
        throw new BaiduProbeError('response', 'Baidu returned a file outside the requested app directory.');
      }
      return {
        path: raw.path,
        isDirectory: raw.isdir === 1,
        size: Number(raw.size),
        ...(typeof raw.fs_id === 'number' || typeof raw.fs_id === 'string' ? { fileId: String(raw.fs_id) } : {}),
      };
    });
    // This older list endpoint uses start/limit; a full page is ambiguous.
    // Fetch the next page instead of guessing the inventory is complete.
    return { files, nextOffset: files.length === limit ? offset + files.length : null };
  }

  /** Return incomplete/unknown on API error instead of silently treating it as an empty vault. */
  async listUpTo(accessToken: string, appDir: string, maxPages = 5): Promise<{files: BaiduListedFile[]; complete: boolean}> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new BaiduProbeError('response', 'Invalid maxPages limit.');
    }
    const files: BaiduListedFile[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.listPage(accessToken, appDir, offset);
      for (const item of page.files) {
        if (seen.has(item.path)) throw new BaiduProbeError('response', 'Duplicate list entries detected; inventory may have changed during pagination.');
        seen.add(item.path);
        files.push(item);
      }
      if (page.nextOffset === null) return { files, complete: true };
      offset = page.nextOffset;
    }
    return { files, complete: false };
  }
}
