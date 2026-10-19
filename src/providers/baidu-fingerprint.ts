/** This is an opaque server change token, not a content-integrity check. */
export function baiduDigest(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 32 || !/^[a-zA-Z0-9]{32}$/.test(value)) return undefined;
  return /^[a-fA-F0-9]{32}$/.test(value) ? value.toLowerCase() : value;
}
