import esbuild from 'esbuild';
import process from 'node:process';
import { readFileSync } from 'node:fs';

const production = process.argv.includes('production');
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: 'main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
  banner: { js: '/*!\n' + readFileSync('LICENSE', 'utf8') + '\n\nThird-party runtime dependency: @noble/hashes\n' + readFileSync('node_modules/@noble/hashes/LICENSE', 'utf8') + '\n*/' },
  logLevel: 'info',
});
if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log('VaultSail: watching for source changes');
}
