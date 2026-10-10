// Build provenance for the read-only deployment harness. A dirty checkout is
// labelled explicitly; its HEAD is never presented as the deployed source.
// Dirtiness is tracked source only: gitignored and generated outputs
// (exported data, Vercel metadata, procedures) do not make a deploy dirty.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const GENERATED_PREFIXES = [
  'web/public/data/',
  'web/public/procedures/',
  'web/.vercel/',
  'web/.next/',
  'web/node_modules/',
  'web/test-results/',
  'web/playwright-report/',
  'web/blob-report/',
];
const GENERATED_FILES = new Set([
  'web/public/data',
  'web/public/procedures',
  'web/.vercel',
  'web/public/isobar-release.json',
  'web/tsconfig.tsbuildinfo',
]);

/** True for generated or deploy-scratch paths, relative to the repo root. */
export function isGeneratedPath(file) {
  const path = String(file).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (GENERATED_FILES.has(path)) return true;
  const withSlash = path.endsWith('/') ? path : `${path}/`;
  return GENERATED_PREFIXES.some((prefix) => withSlash.startsWith(prefix) || path.startsWith(prefix));
}

/** Path from one porcelain line, or null when the line is blank. */
export function porcelainPath(line) {
  if (!line || line.length < 4) return null;
  let path = line.slice(3);
  const arrow = path.lastIndexOf(' -> ');
  if (arrow !== -1) path = path.slice(arrow + 4);
  if (path.startsWith('"') && path.endsWith('"')) {
    try { path = JSON.parse(path); } catch { path = path.slice(1, -1); }
  }
  return path;
}

/** True when porcelain reports a change outside generated paths. */
export function dirtySource(porcelain) {
  return String(porcelain).split('\n').some((line) => {
    const path = porcelainPath(line);
    return path != null && !isGeneratedPath(path);
  });
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function main() {
  const web = fileURLToPath(new URL('..', import.meta.url));
  const root = resolve(web, '..');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let commit = null, tree = null, dirty = null;
  try {
    commit = git('rev-parse', '--verify', 'HEAD');
    tree = git('rev-parse', 'HEAD^{tree}');
    dirty = dirtySource(git('status', '--porcelain=v1', '--untracked-files=all'));
  } catch {
    // Source uploads may omit .git. Preserve availability, but never reuse an
    // older stamp or invent a verified commit for that build.
  }
  const manifest = resolve(web, 'public/data/manifest.json');
  const dataSha = existsSync(manifest) ? sha256(readFileSync(manifest)) : null;
  const stamp = {
    schema: 1,
    source_commit: commit,
    source_tree: tree,
    source_dirty: dirty,
    data_sha256: dataSha,
    generated: new Date().toISOString(),
  };
  mkdirSync(resolve(web, 'public'), { recursive: true });
  writeFileSync(resolve(web, 'public/isobar-release.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log(`Isobar source: ${commit || 'unavailable'}${dirty ? ' (working changes; deployment identity unverified)' : ''}${dataSha ? ` data ${dataSha.slice(0, 12)}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
