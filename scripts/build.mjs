import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // ssh2 loads these optional native accelerators inside try/catch; they are never shipped.
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  mainFields: ['module', 'main'],
  conditions: ['node', 'import', 'require', 'default'],
};

const webviews = {
  ...common,
  entryPoints: { settings: 'webview/settings/main.ts', sync: 'webview/sync/main.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  loader: { '.css': 'css' },
};

const copyAssets = async () => {
  await mkdir('dist/webview', { recursive: true });
  await cp('node_modules/@vscode/codicons/dist/codicon.css', 'dist/webview/codicon.css');
  await cp('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/webview/codicon.ttf');
};

if (watch) {
  await copyAssets();
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webviews)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  // Production output starts clean so no stale source maps end up in the VSIX.
  if (production) await rm('dist', { recursive: true, force: true });
  await Promise.all([esbuild.build(extension), esbuild.build(webviews)]);
  await copyAssets();
}
