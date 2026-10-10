import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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
await esbuild.build({
  entryPoints: ['src/instruments/e6b/standalone.ts'],
  bundle: true,
  outfile: 'dist/e6b.js',
  format: 'iife',
  target: 'safari17',
  minify: false,
  legalComments: 'none',
});
copyFileSync('e6b.html', 'dist/e6b.html');
writeFileSync('dist/app.css', readFileSync('src/app.css', 'utf8') + '\n' + readFileSync('src/instruments/instruments.css', 'utf8'));
copyFileSync('index.html', 'dist/index.html');

// Both native sky surfaces use the canonical renderer and the same decoded atlas as the web.
await esbuild.build({ entryPoints: ['src/sky/host.ts'], bundle: true, outfile: 'dist/sky.js',
  format: 'iife', target: 'safari17', minify: false, legalComments: 'none' });
copyFileSync('sky.html', 'dist/sky.html');
copyFileSync('../web/public/sky/painted-clouds.webp', 'dist/painted-clouds.webp');
