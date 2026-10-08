import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'dist/app.js',
  format: 'iife',
  target: 'safari17',
  minify: false,
  legalComments: 'none',
});
copyFileSync('src/app.css', 'dist/app.css');
copyFileSync('index.html', 'dist/index.html');
