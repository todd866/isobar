#!/usr/bin/env node
// A self-contained local review page; file:// works without server or network.
import { build } from '../../training/node_modules/esbuild/lib/main.js';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url)), output = resolve(root, '../../build/clouds');
mkdirSync(resolve(output, 'preview'), { recursive: true });
const result = await build({ entryPoints: [resolve(root, 'sheet.mjs')], bundle: true, write: false, format: 'esm', target: 'safari17', legalComments: 'none' });
const sprites = Object.fromEntries(['painted-atlas', 'stratus', 'nimbostratus'].map(name => [name, `data:image/webp;base64,${readFileSync(resolve(root, `assets/${name}.webp`)).toString('base64')}`]));
const script = `globalThis.CLOUD_SPRITES=${JSON.stringify(sprites)};\n${result.outputFiles[0].text}`.replaceAll('</script', '<\\/script');
writeFileSync(resolve(output, 'index.html'), readFileSync(resolve(root, 'index.html'), 'utf8').replace('<script type="module" src="./sheet.mjs"></script>', `<script type="module">${script}</script>`));
for (const name of ['index.html', 'sheet.mjs', 'render.mjs', 'rules.mjs', 'fixtures.mjs', 'assets']) cpSync(resolve(root, name), resolve(output, 'preview', name), { recursive: true });
console.log(`Standalone preview: ${output}/index.html`);
