import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const common = { bundle: true, format: 'iife', target: 'safari17', minify: false, legalComments: 'none' };
await esbuild.build({ ...common, entryPoints: ['src/app.ts'], outfile: 'dist/app.js' });
// The sky section (Fly card, Atmosphere window): the same renderer as isobar.md.
await esbuild.build({ ...common, entryPoints: ['src/sky/host.ts'], outfile: 'dist/sky.js' });
copyFileSync('src/app.css', 'dist/app.css');
copyFileSync('index.html', 'dist/index.html');
copyFileSync('sky.html', 'dist/sky.html');
