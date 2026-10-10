#!/usr/bin/env node
/**
 * Education only. Not for navigation.
 *
 * Download the current FAA CIFP zip and extract FAACIFP18 under
 * ~/.cache/isobar-cifp/. The zip is not written into the repo.
 *
 *   node scripts/cifp/fetch-cifp.mjs
 */
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const NOT_FOR_NAVIGATION = 'Education only. Not for navigation.';
const PAGE = 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/';
const CACHE = path.join(homedir(), '.cache', 'isobar-cifp');
const execFileAsync = promisify(execFile);

function decodeHref(href) {
  return href.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
}

function absoluteUrl(href) {
  return new URL(decodeHref(href), PAGE).href;
}

function cycleDigits(href) {
  const name = href.split('/').pop() ?? '';
  return name.match(/(\d{6,8})/)?.[1] ?? '';
}

function cycleSortKey(digits) {
  if (digits.length === 8) return digits;
  if (digits.length === 6) return `20${digits}`;
  return digits;
}

export function latestCifpZip(html) {
  const hrefs = [...html.matchAll(/href="([^"]+\.zip)"/gi)]
    .map((match) => absoluteUrl(match[1] ?? ''))
    .filter((href) => /cifp/i.test(href) && /^https:\/\/([a-z0-9-]+\.)?faa\.gov\//i.test(href));
  const ranked = [...new Set(hrefs)].sort((a, b) => cycleSortKey(cycleDigits(b)).localeCompare(cycleSortKey(cycleDigits(a))));
  const latest = ranked[0];
  if (!latest) throw new Error('No CIFP zip link on the FAA download page');
  return latest;
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'isobar-cifp-education/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw new Error(`CIFP download failed (${response.status})`);
  const partial = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  await rename(partial, destination);
}

async function extract(zipPath, directory) {
  await mkdir(directory, { recursive: true });
  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', directory]);
  return findFile(directory, 'FAACIFP18');
}

async function findFile(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const nested = await findFile(full, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function main() {
  const page = await fetch(PAGE, {
    headers: { 'user-agent': 'isobar-cifp-education/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!page.ok) throw new Error(`FAA CIFP page failed (${page.status})`);
  const html = await page.text();
  const url = latestCifpZip(html);
  const cycle = cycleDigits(url);
  const zipPath = path.join(CACHE, 'zips', path.basename(new URL(url).pathname));
  const extracted = path.join(CACHE, 'extracted', cycle || 'current');
  await mkdir(path.dirname(zipPath), { recursive: true });

  let zipStat = null;
  try {
    zipStat = await stat(zipPath);
  } catch {
    zipStat = null;
  }
  if (!zipStat || zipStat.size < 1000) await download(url, zipPath);

  let cifp = await findFile(extracted, 'FAACIFP18');
  if (!cifp) cifp = await extract(zipPath, extracted);
  if (!cifp) throw new Error('FAACIFP18 was not in the CIFP zip');

  const manifest = {
    notForNavigation: NOT_FOR_NAVIGATION,
    source: 'FAA CIFP',
    page: PAGE,
    url,
    cycle,
    zip: zipPath,
    cifp,
    fetchedAt: new Date().toISOString(),
  };
  await writeFile(path.join(CACHE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const size = (await stat(cifp)).size;
  console.log(`${NOT_FOR_NAVIGATION} cycle ${cycle} ${cifp} (${size} bytes)`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
