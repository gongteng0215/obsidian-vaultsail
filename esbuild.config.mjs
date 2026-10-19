import esbuild from 'esbuild';
import process from 'node:process';
import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const production = process.argv.includes('production');
let buildId = 'source';
try { buildId = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) buildId += '-dirty-' + Date.now().toString(36);
} catch { /* Source archives need not include Git metadata. */ }
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: 'main.js',
  sourcemap: production ? 'external' : 'inline',
  define: { VAULTSAIL_BUILD_ID: JSON.stringify(buildId) },
  minify: production,
  banner: { js: '/*!\n' + readFileSync('LICENSE', 'utf8') + '\n\nThird-party runtime dependency: @noble/hashes\n' + readFileSync('node_modules/@noble/hashes/LICENSE', 'utf8') + '\n*/' },
  logLevel: 'info',
});
if (production) {
  await context.rebuild();
  await context.dispose();
  const debugDirectory = 'dist/debug/' + buildId; mkdirSync(debugDirectory, { recursive: true });
  for (const file of ['main.js', 'main.js.map', 'manifest.json']) copyFileSync(file, debugDirectory + '/' + file);
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(debugDirectory + '/build.json', JSON.stringify({ format: 'vaultsail-build', version: 1, buildId,
    pluginVersion: JSON.parse(readFileSync('manifest.json', 'utf8')).version, mainSha256: digest('main.js'), mapSha256: digest('main.js.map') }, null, 2));
} else {
  await context.watch();
  console.log('VaultSail: watching for source changes');
}
