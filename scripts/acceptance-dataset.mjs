// Generates only in a NEW dedicated directory; verify mode never writes a vault.
import fs from 'node:fs/promises';
import path from 'node:path';
import { acceptanceFiles, EMPTY_DIRECTORIES, DESKTOP_ATTACHMENT, DESKTOP_BYTES, DATASET_ID, verifyAcceptance } from '../src/acceptance/dataset.ts';
import { hash } from '../src/core/safety.ts';

const [mode, target, ...options] = process.argv.slice(2);
if (!['generate', 'verify'].includes(mode) || !target || options.some(arg => !['--desktop', '--mobile'].includes(arg))) throw Error('Usage: node --experimental-strip-types scripts/acceptance-dataset.mjs generate <NEW directory> [--desktop] | verify <test vault> [--mobile]');
const root = path.resolve(target);
const { version } = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
if (mode === 'generate') {
  // Atomic mkdir is the no-overwrite gate, also rejecting an existing production vault.
  await fs.mkdir(root);
  const vault = path.join(root, 'vault'), files = acceptanceFiles();
  for (const file of files) { const full = path.join(vault, file.path); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, new Uint8Array(file.data), { flag: 'wx' }); }
  for (const directory of EMPTY_DIRECTORIES) await fs.mkdir(path.join(vault, directory), { recursive: true });
  const manifest = files.map(file => ({ path: file.path, kind: file.kind, size: file.data.byteLength, sha256: hash(file.data) }));
  if (options.includes('--desktop')) {
    const data = new Uint8Array(DESKTOP_BYTES); for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await fs.writeFile(path.join(vault, DESKTOP_ATTACHMENT), data, { flag: 'wx' });
    manifest.push({ path: DESKTOP_ATTACHMENT, kind: 'desktop-only', size: data.byteLength, sha256: hash(data.buffer) });
  }
  await fs.writeFile(path.join(root, 'content-hashes.json'), JSON.stringify({ dataset: DATASET_ID, files: manifest, emptyDirectories: EMPTY_DIRECTORIES }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ dataset: DATASET_ID, generatedFiles: files.length, emptyDirectories: EMPTY_DIRECTORIES.length, desktopAttachment: options.includes('--desktop') }));
} else {
  const resolve = relative => { const full = path.resolve(root, relative); if (!full.startsWith(root + path.sep)) throw Error('Outside test vault'); return full; };
  const reader = {
    stat: async relative => { try { const info = await fs.lstat(resolve(relative)); if (info.isSymbolicLink()) throw Error('Symlink'); return { type: info.isDirectory() ? 'folder' : 'file', size: info.size }; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    read: async relative => { const data = await fs.readFile(resolve(relative)); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
    list: async relative => { const entries = await fs.readdir(resolve(relative), { withFileTypes: true }); return { files: entries.filter(e => !e.isDirectory()).map(e => relative + '/' + e.name), folders: entries.filter(e => e.isDirectory()).map(e => relative + '/' + e.name) }; },
  };
  const report = await verifyAcceptance(reader, version, options.includes('--mobile'));
  console.log(JSON.stringify(report, null, 2));
  if (!report.markerValid || report.passedFiles !== 100 || report.passedDirectories !== 10) process.exitCode = 1;
}
