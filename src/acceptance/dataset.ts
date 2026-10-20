import { bytes, hash } from '../core/safety.ts';

// Stable synthetic data only. These paths never derive from a user's vault.
export const DATASET_ID = 'vaultsail-dual-device-v1';
export const DATASET_ROOT = 'VaultSail-双端验收';
export const DESKTOP_ATTACHMENT = DATASET_ROOT + '/desktop-25MiB.bin';
export const DESKTOP_BYTES = 25 * 1024 * 1024;
export interface AcceptanceFile { path: string; kind: 'markdown' | 'image' | 'pdf' | 'zero' | 'unicode'; data: ArrayBuffer; }
export const EMPTY_DIRECTORIES = ['空目录一', '空目录二', 'empty-03', 'empty-04', 'empty-05', 'empty-06', 'empty-07', '多层空目录', '多层空目录/第二层', '多层空目录/第二层/第三层'].map(p => DATASET_ROOT + '/' + p);
export const MARKER = DATASET_ROOT + '/markdown/00-marker.md';
const png = '89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082';
function pdf(index: number): ArrayBuffer {
  const stream = `BT /F1 12 Tf 50 750 Td (VaultSail synthetic PDF ${index}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return bytes(text);
}
export function acceptanceFiles(): AcceptanceFile[] {
  const files: AcceptanceFile[] = [];
  for (let i = 0; i < 60; i++) files.push({ path: i === 0 ? MARKER : `${DATASET_ROOT}/markdown/${String(i).padStart(2, '0')}.md`, kind: 'markdown', data: bytes(i === 0 ? `# ${DATASET_ID}\nSynthetic acceptance fixture. No personal data.\n` : `# 合成测试笔记 ${i}\n\nVaultSail fixture ${DATASET_ID}\n\n- 固定内容 ${i}\n- 跨端 SHA-256 校验\n`) });
  for (let i = 0; i < 20; i++) files.push({ path: `${DATASET_ROOT}/images/image-${i}.png`, kind: 'image', data: Uint8Array.from(png.match(/../g)!.map(n => parseInt(n, 16))).buffer });
  for (let i = 0; i < 10; i++) files.push({ path: `${DATASET_ROOT}/pdf/document-${i}.pdf`, kind: 'pdf', data: pdf(i) });
  for (let i = 0; i < 5; i++) files.push({ path: `${DATASET_ROOT}/zero/empty-${i}.txt`, kind: 'zero', data: new ArrayBuffer(0) });
  for (let i = 0; i < 5; i++) files.push({ path: `${DATASET_ROOT}/中文路径/第二层/第${i}份资料.txt`, kind: 'unicode', data: bytes(`中文与多层路径 ${i}\n${DATASET_ID}\n`) });
  return files;
}
export interface AcceptanceReader {
  stat(path: string): Promise<{ type: 'file' | 'folder'; size: number } | null>;
  read(path: string): Promise<ArrayBuffer>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
export interface AcceptanceResult {
  format: 'vaultsail-acceptance'; version: 1; dataset: typeof DATASET_ID; pluginVersion: string; platform: 'desktop' | 'mobile';
  markerValid: boolean; expectedFiles: number; passedFiles: number; expectedDirectories: number; passedDirectories: number;
  failures: { missing: number; size: number; hash: number; type: number; unreadable: number; directoryMissing: number; directoryNotEmpty: number };
  desktopAttachment: 'absent' | 'present-over-mobile-limit' | 'unexpected-size' | 'unreadable';
  elapsedMs: number;
}
/** Read-only and bounded. Refuse unrelated vaults before reading any other file. */
export async function verifyAcceptance(reader: AcceptanceReader, pluginVersion: string, mobile: boolean, onProgress?: (done: number, total: number) => void): Promise<AcceptanceResult> {
  const start = Date.now(), files = acceptanceFiles();
  const result: AcceptanceResult = { format: 'vaultsail-acceptance', version: 1, dataset: DATASET_ID, pluginVersion, platform: mobile ? 'mobile' : 'desktop', markerValid: false,
    expectedFiles: files.length, passedFiles: 0, expectedDirectories: EMPTY_DIRECTORIES.length, passedDirectories: 0,
    failures: { missing: 0, size: 0, hash: 0, type: 0, unreadable: 0, directoryMissing: 0, directoryNotEmpty: 0 }, desktopAttachment: 'absent', elapsedMs: 0 };
  const marker = files[0];
  try { const stat = await reader.stat(MARKER); if (!stat || stat.type !== 'file' || stat.size !== marker.data.byteLength || hash(await reader.read(MARKER)) !== hash(marker.data)) return { ...result, elapsedMs: Date.now() - start }; }
  catch { return { ...result, elapsedMs: Date.now() - start }; }
  result.markerValid = true;
  for (const [index, file] of files.entries()) {
    try {
      const stat = await reader.stat(file.path);
      if (!stat) result.failures.missing++;
      else if (stat.type !== 'file') result.failures.type++;
      else if (stat.size !== file.data.byteLength) result.failures.size++;
      else if (hash(await reader.read(file.path)) !== hash(file.data)) result.failures.hash++;
      else result.passedFiles++;
    } catch { result.failures.unreadable++; }
    try { onProgress?.(index + 1, files.length); } catch { /* Observational. */ }
  }
  // Intermediate empty-folder parents may contain only the expected empty folders.
  for (const directory of EMPTY_DIRECTORIES) {
    try {
      const stat = await reader.stat(directory);
      if (!stat || stat.type !== 'folder') { result.failures.directoryMissing++; continue; }
      const children = await reader.list(directory);
      if (children.files.length || children.folders.some(path => !EMPTY_DIRECTORIES.includes(path))) result.failures.directoryNotEmpty++;
      else result.passedDirectories++;
    } catch { result.failures.directoryMissing++; }
  }
  try { const stat = await reader.stat(DESKTOP_ATTACHMENT); if (stat) result.desktopAttachment = stat.type === 'file' && stat.size === DESKTOP_BYTES ? 'present-over-mobile-limit' : 'unexpected-size'; }
  catch { result.desktopAttachment = 'unreadable'; }
  result.elapsedMs = Date.now() - start; return result;
}
