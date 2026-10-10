/** Explicit local ingestion: one upstream request per two hours, never per browser. */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrbitSource } from '../src/lib/earth-orbit';

const directory = path.join(homedir(), '.local/state/isobar-orbits');
const target = fileURLToPath(new URL('../public/data/earth/iss.json', import.meta.url));
const cache = path.join(directory, 'iss.json'), lock = path.join(directory, 'fetch.lock');
const attempt = path.join(directory, 'last-attempt.json'), interval = 2 * 3600_000;
await mkdir(directory, { recursive: true });
await mkdir(lock); // Concurrent invocations fail before making a request.
try {
  const old = await readFile(cache, 'utf8').then(JSON.parse).catch(() => null);
  let source = old ? parseOrbitSource(old) : null;
  if (!source?.retrievedAt || Date.now() - Date.parse(source.retrievedAt) >= interval) {
    const previous = await readFile(attempt, 'utf8').then(JSON.parse).catch(() => ({ at: 0 }));
    if (Date.now() - previous.at < interval) throw new Error('Upstream cooldown: use the existing cache or wait two hours from the last attempt.');
    await writeFile(attempt, JSON.stringify({ at: Date.now() }));
    const response = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=JSON',
      { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) throw new Error('CelesTrak returned ' + response.status + '; no automatic retry.');
    const text = await response.text();
    if (text.length > 512_000) throw new Error('Oversized station catalogue');
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('Invalid station catalogue');
    source = parseOrbitSource({ kind: 'elements', retrievedAt: new Date().toISOString(), omm: rows.find(row => Number(row.NORAD_CAT_ID) === 25544) });
    await writeFile(cache + '.tmp', JSON.stringify(source)); await rename(cache + '.tmp', cache);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target + '.tmp', JSON.stringify(source)); await rename(target + '.tmp', target);
  console.log('ISS elements prepared. Epoch: ' + source.epoch);
} finally { await rm(lock, { recursive: true }); }
