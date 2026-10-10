/** OCST coastline (Resources/ownchart-coast.bin). Natural Earth crop, public domain. */

export interface CoastRing {
  lon: Float32Array;
  lat: Float32Array;
}

export interface Coast {
  rings: CoastRing[];
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI16(bytes: Uint8Array, offset: number): number {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

export function parseCoast(bytes: Uint8Array): Coast {
  if (bytes.length < 8) return { rings: [] };
  if (bytes[0] !== 0x4f || bytes[1] !== 0x43 || bytes[2] !== 0x53 || bytes[3] !== 0x54) return { rings: [] };
  const version = readU16(bytes, 4);
  const ringCount = readU16(bytes, 6);
  if (version !== 1 || ringCount === 0) return { rings: [] };
  let cursor = 8;
  const counts: number[] = [];
  for (let ring = 0; ring < ringCount; ring += 1) {
    if (cursor + 2 > bytes.length) return { rings: [] };
    const count = readU16(bytes, cursor);
    cursor += 2;
    if (count < 3 || cursor + count * 4 > bytes.length) return { rings: [] };
    counts.push(count);
    cursor += count * 4;
  }
  if (cursor !== bytes.length) return { rings: [] };
  cursor = 8;
  const rings: CoastRing[] = [];
  for (const count of counts) {
    cursor += 2;
    const lon = new Float32Array(count);
    const lat = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      lon[i] = readI16(bytes, cursor) / 100;
      lat[i] = readI16(bytes, cursor + 2) / 100;
      cursor += 4;
    }
    rings.push({ lon, lat });
  }
  return { rings };
}

export function ringInPolygon(lon: number, lat: number, ring: CoastRing): boolean {
  let inside = false;
  const n = ring.lon.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const yi = ring.lat[i];
    const yj = ring.lat[j];
    const xi = ring.lon[i];
    const xj = ring.lon[j];
    const crosses = (yi > lat) !== (yj > lat);
    if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd across every ring, so a lake ring inside land punches a hole. */
export function coastContains(coast: Coast, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of coast.rings) {
    if (ringInPolygon(lon, lat, ring)) inside = !inside;
  }
  return inside;
}

function perpendicularDistance(lon: number, lat: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(lon - ax, lat - ay);
  return Math.abs(dy * lon - dx * lat + bx * ay - by * ax) / length;
}

export function simplifyRing(ring: CoastRing, epsilon: number): CoastRing {
  if (epsilon <= 0 || ring.lon.length < 4) return ring;
  const keep = new Uint8Array(ring.lon.length);
  keep[0] = 1;
  keep[ring.lon.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.lon.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop() as [number, number];
    let farthest = start;
    let distance = 0;
    for (let i = start + 1; i < end; i += 1) {
      const candidate = perpendicularDistance(ring.lon[i], ring.lat[i], ring.lon[start], ring.lat[start], ring.lon[end], ring.lat[end]);
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
  let count = 0;
  for (let i = 0; i < keep.length; i += 1) if (keep[i]) count += 1;
  const lon = new Float32Array(count);
  const lat = new Float32Array(count);
  let write = 0;
  for (let i = 0; i < keep.length; i += 1) {
    if (!keep[i]) continue;
    lon[write] = ring.lon[i];
    lat[write] = ring.lat[i];
    write += 1;
  }
  return { lon, lat };
}

export function simplifyCoast(coast: Coast, epsilon: number): Coast {
  return { rings: coast.rings.map((ring) => simplifyRing(ring, epsilon)).filter((ring) => ring.lon.length >= 3) };
}
