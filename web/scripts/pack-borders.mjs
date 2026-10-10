#!/usr/bin/env node
/**
 * Packs Natural Earth political borders (public domain) the way the coast is
 * packed: int16 degrees × 100. 50m for a regional view, 10m when zoomed in.
 *
 *   node scripts/pack-borders.mjs <shp-dir> <out-dir>
 *
 * Expects, in shp-dir:
 *   ne_50m_admin_0_boundary_lines_land
 *   ne_10m_admin_0_boundary_lines_land
 *   ne_50m_admin_1_states_provinces_lines
 *   ne_10m_admin_1_states_provinces_lines
 *   ne_50m_admin_1_states_provinces          (label points only)
 *
 * Country lines are Natural Earth's land boundaries. A line whose FEATURECLA
 * is not an international boundary (disputed, line of control, indefinite,
 * indeterminant, lease, unrecognized) is stored dashed and unlabelled.
 * "Overlay limit" is a dataset clip, not a border, and is dropped.
 * State names are the English/local name and the label point, nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';

const [source, outDir] = process.argv.slice(2);
if (!source || !outDir) {
  console.error('usage: pack-borders.mjs <shp-dir> <out-dir>');
  process.exit(2);
}

function readDbf(file) {
  const data = fs.readFileSync(file);
  const records = data.readUInt32LE(4);
  const header = data.readUInt16LE(8);
  const recordLength = data.readUInt16LE(10);
  const fields = [];
  let cursor = 32;
  while (data[cursor] !== 0x0d && cursor < header) {
    const name = data.subarray(cursor, cursor + 11).toString('latin1').replace(/\0.*/, '');
    fields.push({ name, length: data[cursor + 16] });
    cursor += 32;
  }
  const rows = [];
  for (let i = 0; i < records; i += 1) {
    const start = header + i * recordLength;
    const deleted = data[start] === 0x2a;
    let pos = start + 1;
    const row = { deleted };
    for (const field of fields) {
      const bytes = data.subarray(pos, pos + field.length);
      const utf8 = bytes.toString('utf8').replace(/\0/g, '').trim();
      row[field.name] = utf8.includes('\uFFFD') ? bytes.toString('latin1').replace(/\0/g, '').trim() : utf8;
      pos += field.length;
    }
    rows.push(row);
  }
  return rows;
}

function readShp(file) {
  const data = fs.readFileSync(file);
  const records = [];
  let offset = 100;
  while (offset + 8 <= data.length) {
    const words = data.readInt32BE(offset + 4);
    const type = data.readInt32LE(offset + 8);
    const rings = [];
    if (type === 3 || type === 5 || type === 13 || type === 15) {
      const base = offset + 8;
      const parts = data.readInt32LE(base + 36);
      const points = data.readInt32LE(base + 40);
      const index = [];
      let cursor = base + 44;
      for (let i = 0; i < parts; i += 1) {
        index.push(data.readInt32LE(cursor));
        cursor += 4;
      }
      const xy = [];
      for (let i = 0; i < points; i += 1) {
        xy.push([data.readDoubleLE(cursor), data.readDoubleLE(cursor + 8)]);
        cursor += 16;
      }
      for (let i = 0; i < parts; i += 1) {
        const end = i + 1 < parts ? index[i + 1] : points;
        rings.push(xy.slice(index[i], end));
      }
    }
    records.push(rings);
    offset += 8 + words * 2;
  }
  return records;
}

function perpendicular(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  return Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

function simplify(points, epsilon) {
  if (epsilon <= 0 || points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = start;
    let distance = 0;
    for (let i = start + 1; i < end; i += 1) {
      const candidate = perpendicular(points[i], points[start], points[end]);
      if (candidate > distance) {
        distance = candidate;
        farthest = i;
      }
    }
    if (distance > epsilon) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function splitSeams(points) {
  const parts = [];
  let run = [];
  for (const point of points) {
    const previous = run[run.length - 1];
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      if (run.length >= 2) parts.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length >= 2) parts.push(run);
  return parts;
}

function quantize(points) {
  const out = [];
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const x = Math.round(Math.max(-180, Math.min(180, lon)) * 100);
    const y = Math.round(Math.max(-90, Math.min(90, lat)) * 100);
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  return out.length >= 2 ? out : [];
}

function packLines(stem, epsilon, disputed) {
  const rows = readDbf(path.join(source, `${stem}.dbf`));
  const shapes = readShp(path.join(source, `${stem}.shp`));
  if (rows.length !== shapes.length) throw new Error(`${stem}: ${rows.length} attributes, ${shapes.length} shapes`);
  const country = [];
  const dashed = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].deleted) continue;
    const kind = rows[i].FEATURECLA || '';
    if (kind.startsWith('Overlay limit')) continue;
    const bucket = disputed && kind && !kind.startsWith('International') ? dashed : country;
    for (const ring of shapes[i]) {
      for (const part of splitSeams(ring)) {
        const line = quantize(simplify(part, epsilon));
        for (let cursor = 0; cursor < line.length; cursor += 60000) {
          const slice = line.slice(cursor, cursor + 60000);
          if (slice.length >= 2) bucket.push(slice);
        }
      }
    }
  }
  return { country, dashed };
}

function packStates(stem, epsilon) {
  const shapes = readShp(path.join(source, `${stem}.shp`));
  const lines = [];
  for (const rings of shapes) {
    for (const ring of rings) {
      for (const part of splitSeams(ring)) {
        const line = quantize(simplify(part, epsilon));
        if (line.length >= 2) lines.push(line);
      }
    }
  }
  return lines;
}

function writeRings(rings) {
  if (rings.length > 65535) throw new Error(`${rings.length} rings exceed uint16`);
  const chunks = [Buffer.alloc(2)];
  chunks[0].writeUInt16LE(rings.length, 0);
  for (const ring of rings) {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(ring.length, 0);
    const body = Buffer.alloc(ring.length * 4);
    ring.forEach(([lon, lat], i) => {
      body.writeInt16LE(lon, i * 4);
      body.writeInt16LE(lat, i * 4 + 2);
    });
    chunks.push(head, body);
  }
  return Buffer.concat(chunks);
}

function writeBorders(file, country, state, disputed) {
  const head = Buffer.alloc(8);
  head.write('BORD', 0, 'latin1');
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(3, 6);
  const body = Buffer.concat([head, writeRings(country), writeRings(state), writeRings(disputed)]);
  fs.writeFileSync(file, body);
  return body.length;
}

function packNames() {
  const rows = readDbf(path.join(source, 'ne_50m_admin_1_states_provinces.dbf'));
  const names = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.deleted) continue;
    const name = row.name || row.name_en || row.woe_name || row.gn_name;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    const rank = Number(row.scalerank);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const key = `${name}|${lat.toFixed(1)}|${lon.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({
      name,
      lat: Math.round(lat * 1000) / 1000,
      lon: Math.round(lon * 1000) / 1000,
      rank: Number.isFinite(rank) ? rank : 6,
    });
  }
  names.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return names;
}

const regionalCountries = packLines('ne_50m_admin_0_boundary_lines_land', 0.08, true);
const closeCountries = packLines('ne_10m_admin_0_boundary_lines_land', 0.02, true);
const regionalStates = packStates('ne_50m_admin_1_states_provinces_lines', 0.1);
const closeStates = packStates('ne_10m_admin_1_states_provinces_lines', 0.03);
const names = packNames();
fs.mkdirSync(outDir, { recursive: true });
const regionalBytes = writeBorders(
  path.join(outDir, 'regional.bin'),
  regionalCountries.country,
  regionalStates,
  regionalCountries.dashed,
);
const closeBytes = writeBorders(
  path.join(outDir, 'close.bin'),
  closeCountries.country,
  closeStates,
  closeCountries.dashed,
);
const namesFile = path.join(outDir, 'names.json');
fs.writeFileSync(namesFile, JSON.stringify(names));
const bc = names.find((item) => item.name === 'British Columbia');
console.log(JSON.stringify({
  regionalBytes,
  closeBytes,
  namesBytes: fs.statSync(namesFile).size,
  names: names.length,
  britishColumbia: bc ?? null,
  regional: {
    country: regionalCountries.country.length,
    state: regionalStates.length,
    disputed: regionalCountries.dashed.length,
  },
  close: {
    country: closeCountries.country.length,
    state: closeStates.length,
    disputed: closeCountries.dashed.length,
  },
}, null, 2));
