import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
