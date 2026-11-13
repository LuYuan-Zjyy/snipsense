import * as esbuild from 'esbuild';
import fs from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

const extension = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
});

const webview = await esbuild.context({
  ...shared,
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
});

const repoMap = await esbuild.context({
  ...shared,
  entryPoints: ['webview/repoMap.ts'],
  outfile: 'dist/repoMap.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch(), repoMap.watch()]);
  console.log('SnipSense: watching extension + webview + repo map');
} else {
  await Promise.all([extension.rebuild(), webview.rebuild(), repoMap.rebuild()]);
  await Promise.all([extension.dispose(), webview.dispose(), repoMap.dispose()]);
  console.log('SnipSense: build complete');
}
