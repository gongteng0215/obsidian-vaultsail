import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const sourceText = file => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
/** Same input yields the same bundle in a Git checkout or a source archive.
 * Never inspect settings, environment, Git metadata, notes or local artifacts. */
export function buildIdentity(root = process.cwd()) {
  const sources = (directory = 'src') => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = directory + '/' + entry.name;
    return entry.isDirectory() ? sources(relative) : entry.isFile() && entry.name.endsWith('.ts') ? [relative] : [];
  });
  const files = ['package.json', 'package-lock.json', 'manifest.json', 'styles.css', 'LICENSE', 'esbuild.config.mjs', 'scripts/build-identity.mjs',
    ...sources()].sort();
  const digest = createHash('sha256');
  for (const file of files) digest.update(file + '\0' + sourceText(path.join(root, file)) + '\0');
  return digest.digest('hex').slice(0, 40);
}
