import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildIdentity } from '../scripts/build-identity.mjs';

test('build identity is identical across paths, newline styles and Git/archive environments', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsail-build-'));
  try {
    const make = (name: string, newline: string) => {
      const root = path.join(temp, name); fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true }); fs.mkdirSync(path.join(root, 'scripts'));
      for (const file of ['package.json', 'package-lock.json', 'manifest.json', 'styles.css', 'LICENSE', 'esbuild.config.mjs', 'scripts/build-identity.mjs', 'src/nested/z.ts', 'src/main.ts']) fs.writeFileSync(path.join(root, file), 'same' + newline + 'source' + newline);
      return root;
    };
    const git = make('checkout', '\r\n'), archive = make('archive', '\n'); fs.mkdirSync(path.join(git, '.git')); fs.writeFileSync(path.join(git, '.git/HEAD'), 'arbitrary');
    const expected = buildIdentity(git); assert.match(expected, /^[a-f0-9]{40}$/); assert.equal(buildIdentity(archive), expected);
    fs.writeFileSync(path.join(git, 'data.json'), 'sensitive-never-read'); fs.writeFileSync(path.join(git, 'unrelated.txt'), 'different'); assert.equal(buildIdentity(git), expected);
    for (const file of ['src/main.ts', 'styles.css', 'package-lock.json', 'scripts/build-identity.mjs']) {
      const source = fs.readFileSync(path.join(archive, file)); fs.appendFileSync(path.join(archive, file), 'changed'); assert.notEqual(buildIdentity(archive), expected); fs.writeFileSync(path.join(archive, file), source);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('production build emits byte-identical JS, manifest and CSS from CRLF and LF checkouts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsail-assets-'));
  try {
    const make = (name: string, newline: string) => {
      const root = path.join(temp, name); fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, 'scripts'));
      for (const file of ['esbuild.config.mjs', 'scripts/build-identity.mjs']) fs.copyFileSync(file, path.join(root, file));
      fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction');
      for (const [file, text] of Object.entries({ 'package.json': '{"type":"module","version":"0.2.23"}\n', 'package-lock.json': '{}\n',
        'manifest.json': '{\n  "version": "0.2.23"\n}\n', 'styles.css': '.sample {\n  display: block;\n}\n', LICENSE: 'MIT\n',
        'src/main.ts': 'export default class Example {}\n' })) fs.writeFileSync(path.join(root, file), text.replaceAll('\n', newline));
      const before = buildIdentity(root);
      execFileSync(process.execPath, [path.join(root, 'esbuild.config.mjs'), 'production'], { cwd: root, stdio: 'pipe' });
      assert.equal(buildIdentity(root), before, 'normalizing release assets must not change the build identity');
      return root;
    };
    const windows = make('windows', '\r\n'), linux = make('linux', '\n');
    for (const file of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(fs.readFileSync(path.join(windows, file)), fs.readFileSync(path.join(linux, file)), file);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
