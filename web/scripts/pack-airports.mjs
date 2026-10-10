#!/usr/bin/env node
/**
 * Packs OurAirports (public domain) large and medium airports that have an
 * ICAO code for the place search: [icao, iata, name, lat, lon, city, rank].
 * rank is 0 for large and 1 for medium. Names drop a trailing "Airport".
 *
 *   node scripts/pack-airports.mjs airports.csv public/places/airports.json
 *
 * Source: https://davidmegginson.github.io/ourairports-data/airports.csv
 */
import fs from 'node:fs';
import path from 'node:path';

const [source, output] = process.argv.slice(2);
if (!source || !output) {
  console.error('usage: pack-airports.mjs <airports.csv> <output.json>');
  process.exit(2);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quote = false;
      } else cell += c;
    } else if (c === '"') quote = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function shortName(name) {
  return name
    .replace(/\s+International Airport$/i, '')
    .replace(/\s+Regional Airport$/i, '')
    .replace(/\s+Airport$/i, '')
    .replace(/\s+Airfield$/i, '')
    .replace(/\s+Aerodrome$/i, '')
    .replace(/\s+Air Base$/i, '')
    .trim();
}

const table = parseCsv(fs.readFileSync(source, 'utf8'));
const header = table.shift() ?? [];
const col = (name) => {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`missing column ${name}`);
  return index;
};
const typeCol = col('type');
const nameCol = col('name');
const latCol = col('latitude_deg');
const lonCol = col('longitude_deg');
const cityCol = col('municipality');
const icaoCol = col('icao_code');
const identCol = col('ident');
const iataCol = col('iata_code');

const byIcao = new Map();
for (const cells of table) {
  const type = cells[typeCol];
  if (type !== 'large_airport' && type !== 'medium_airport') continue;
  const icao = (cells[icaoCol] || cells[identCol] || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) continue;
  const lat = Math.round(Number(cells[latCol]) * 1000) / 1000;
  const lon = Math.round(Number(cells[lonCol]) * 1000) / 1000;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
  const rank = type === 'large_airport' ? 0 : 1;
  const prior = byIcao.get(icao);
  if (prior && prior[6] <= rank) continue;
  const iata = (cells[iataCol] || '').trim().toUpperCase();
  const name = shortName(cells[nameCol] || icao) || icao;
  const city = (cells[cityCol] || '').trim();
  byIcao.set(icao, [icao, /^[A-Z0-9]{3}$/.test(iata) ? iata : '', name, lat, lon, city, rank]);
}

const rows = [...byIcao.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(rows)}\n`);
console.log(`${rows.length} airports -> ${output}`);
