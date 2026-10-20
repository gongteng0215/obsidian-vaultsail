import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'test/**', 'scripts/**', '*.mjs'] },
  ...obsidianmd.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { parserOptions: { projectService: true } },
    rules: { 'obsidianmd/ui/sentence-case': ['warn', { brands: ['VaultSail', 'VAULTSAIL', 'SecretKey', 'VSAIL', 'MiB'], acronyms: ['SHA-256', 'JSON', 'YOUR VAULT, EVERY CLOUD'] }] } },
]);
