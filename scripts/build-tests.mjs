import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const entries = ['unit', 'integration', 'e2e'].flatMap((dir) => {
  try {
    return readdirSync(join('test', dir))
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => join('test', dir, f));
  } catch {
    return [];
  }
});

await esbuild.build({
  entryPoints: entries,
  outdir: 'out-test',
  outbase: 'test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node', 'mocha'],
  mainFields: ['module', 'main'],
  conditions: ['node', 'import', 'require', 'default'],
  logLevel: 'warning',
});
