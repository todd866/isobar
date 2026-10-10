#!/usr/bin/env python3
"""Pack Natural Earth 10m lakes and river centerlines for the web map.

Lakes: ne_10m_lakes plus the europe and north_america supplements (public
domain). Rivers: ne_10m_rivers_lake_centerlines, scale-ranked, lake
centerlines omitted. Coordinates are int32 / 10000 degrees.

  python3 tools/pack-water.py LAKES_DIR RIVERS_SHP LAKES_OUT RIVERS_OUT
"""

import json
import struct
import sys
from pathlib import Path

SCALE = 10000
RIVER_EPSILON = 0.008


def read_dbf(path):
    data = Path(path).read_bytes()
    count, header_len, record_len = struct.unpack_from("<IHH", data, 4)
    fields = []
    offset = 32
    while data[offset] != 0x0D:
        name = data[offset:offset + 11].split(b"\x00", 1)[0].decode("latin1")
        kind = chr(data[offset + 11])
        length = data[offset + 16]
        fields.append((name, kind, length))
        offset += 32
    rows = []
    cursor = header_len
    for _ in range(count):
        body = data[cursor + 1:cursor + record_len]
        cursor += record_len
        row = {}
        start = 0
        for name, kind, length in fields:
            raw = body[start:start + length]
            start += length
            row[name] = raw.decode("latin1").strip() if kind in "CN" else raw
        rows.append(row)
    return rows


def read_shp(path):
    data = Path(path).read_bytes()
    offset = 100
    shapes = []
    while offset + 8 <= len(data):
        _rec, words = struct.unpack_from(">II", data, offset)
        offset += 8
        end = offset + words * 2
        if offset + 4 > len(data):
            break
        kind = struct.unpack_from("<i", data, offset)[0]
        parts = []
        if kind in (3, 5, 13, 15) and offset + 44 <= end:
            nparts, npoints = struct.unpack_from("<ii", data, offset + 36)
            part_at = offset + 44
            xy_at = part_at + 4 * nparts
            indexes = [struct.unpack_from("<i", data, part_at + 4 * i)[0] for i in range(nparts)]
            indexes.append(npoints)
            for i in range(nparts):
                ring = []
                for k in range(indexes[i], indexes[i + 1]):
                    x, y = struct.unpack_from("<dd", data, xy_at + 16 * k)
                    ring.append((x, y))
                parts.append(ring)
        shapes.append(parts)
        offset = end
    return shapes


def number(text, default=0.0):
    try:
        return float(text)
    except (TypeError, ValueError):
        return default


def quantize(ring):
    out = []
    for lon, lat in ring:
        pair = (int(round(lon * SCALE)), int(round(lat * SCALE)))
        if not out or out[-1] != pair:
            out.append(pair)
    if len(out) >= 2 and out[0] == out[-1]:
        out.pop()
    return out


def continuous(ring):
    if not ring:
        return ring
    out = [ring[0]]
    for lon, lat in ring[1:]:
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append((lon, lat))
    return out


def perp(point, start, end):
    px, py = point
    ax, ay = start
    bx, by = end
    dx, dy = bx - ax, by - ay
    length = (dx * dx + dy * dy) ** 0.5
    if length == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    return abs(dy * px - dx * py + bx * ay - by * ax) / length


def simplify(ring, epsilon):
    if len(ring) < 4 or epsilon <= 0:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        start, end = stack.pop()
        farthest = start
        distance = 0
        for i in range(start + 1, end):
            candidate = perp(ring[i], ring[start], ring[end])
            if candidate > distance:
                distance = candidate
                farthest = i
        if distance > epsilon:
            keep[farthest] = True
            stack.append((start, farthest))
            stack.append((farthest, end))
    return [point for point, kept in zip(ring, keep) if kept]


def inside(lon, lat, ring):
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        yi, xi = ring[i][1], ring[i][0]
        yj, xj = ring[j][1], ring[j][0]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def feature_inside(lon, lat, rings):
    hit = False
    for ring in rings:
        if inside(lon, lat, ring):
            hit = not hit
    return hit


def bbox(rings):
    lons = [p[0] for ring in rings for p in ring]
    lats = [p[1] for ring in rings for p in ring]
    return min(lons), min(lats), max(lons), max(lats)


def centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def pack_lakes(directory, dest):
    order = [
        "ne_10m_lakes.shp",
        "ne_10m_lakes_europe.shp",
        "ne_10m_lakes_north_america.shp",
    ]
    accepted = []
    names = set()
    skipped = 0
    for filename in order:
        path = Path(directory) / filename
        rows = read_dbf(path.with_suffix(".dbf"))
        shapes = read_shp(path)
        if len(rows) != len(shapes):
            raise SystemExit(f"{filename}: {len(rows)} attributes, {len(shapes)} shapes")
        supplement = filename != order[0]
        for row, parts in zip(rows, shapes):
            name = (row.get("name") or "").casefold()
            zoom = number(row.get("min_zoom"), number(row.get("scalerank"), 7))
            rings = []
            for part in parts:
                points = quantize(continuous(part))
                if len(points) >= 3:
                    rings.append([(lon / SCALE, lat / SCALE) for lon, lat in points])
            if not rings:
                continue
            if name and name in names:
                skipped += 1
                continue
            if supplement:
                west, south, east, north = bbox(rings)
                cx, cy = centroid(rings[0])
                duplicate = False
                for prior in accepted:
                    pw, ps, pe, pn = prior["box"]
                    if cx < pw or cx > pe or cy < ps or cy > pn:
                        continue
                    if feature_inside(cx, cy, prior["rings"]):
                        duplicate = True
                        break
                if duplicate:
                    skipped += 1
                    continue
            if name:
                names.add(name)
            accepted.append({
                "zoom": zoom,
                "name": row.get("name") or "",
                "rings": rings,
                "box": bbox(rings),
            })
    blob = bytearray()
    blob += b"LAKE"
    ring_count = sum(len(item["rings"]) for item in accepted)
    blob += struct.pack("<HHI", 1, SCALE, ring_count)
    points = 0
    for item in accepted:
        zoom = max(0, min(65535, int(round(item["zoom"] * 100))))
        for ring in item["rings"]:
            packed = quantize(ring)
            blob += struct.pack("<HHI", zoom, 0, len(packed))
            for lon, lat in packed:
                blob += struct.pack("<ii", lon, lat)
            points += len(packed)
    Path(dest).write_bytes(blob)
    return {
        "bytes": len(blob),
        "features": len(accepted),
        "rings": ring_count,
        "points": points,
        "skippedDuplicates": skipped,
        "named": {item["name"]: item["zoom"] for item in accepted if item["name"]},
    }


def pack_rivers(shp, dest):
    path = Path(shp)
    rows = read_dbf(path.with_suffix(".dbf"))
    shapes = read_shp(path)
    if len(rows) != len(shapes):
        raise SystemExit(f"rivers: {len(rows)} attributes, {len(shapes)} shapes")
    lines = []
    for row, parts in zip(rows, shapes):
        kind = row.get("featurecla") or ""
        if kind == "Lake Centerline":
            continue
        rank = int(round(number(row.get("scalerank"), 9)))
        for part in parts:
            simplified = simplify(continuous(part), RIVER_EPSILON)
            packed = quantize(simplified)
            if len(packed) >= 2:
                lines.append((rank, packed))
    blob = bytearray()
    blob += b"RIVR"
    blob += struct.pack("<HHI", 1, SCALE, len(lines))
    points = 0
    for rank, line in lines:
        blob += struct.pack("<HHI", max(0, min(65535, rank)), 0, len(line))
        for lon, lat in line:
            blob += struct.pack("<ii", lon, lat)
        points += len(line)
    Path(dest).write_bytes(blob)
    return {"bytes": len(blob), "lines": len(lines), "points": points}


def main():
    lakes_dir, rivers_shp, lakes_out, rivers_out = sys.argv[1:5]
    lakes = pack_lakes(lakes_dir, lakes_out)
    rivers = pack_rivers(rivers_shp, rivers_out)
    want = (
        "Okanagan Lake", "Lake Superior", "Lake Huron", "Lake Michigan",
        "Lake Erie", "Lake Ontario", "Lake Taupo", "Lake Geneva", "Bodensee",
        "Lake Eyre North", "Lake Eyre South",
    )
    print("lakes", {k: lakes[k] for k in ("bytes", "features", "rings", "points", "skippedDuplicates")})
    print("rivers", rivers)
    for name in want:
        print(f"  {name}: min_zoom {lakes['named'].get(name, 'MISSING')}")
    budget = {
        "lakes": {
            "bytes": lakes["bytes"],
            "rings": lakes["rings"],
            "points": lakes["points"],
            "source": "Natural Earth 1:10m lakes, lakes_europe, lakes_north_america (public domain)",
        },
        "rivers": {
            "bytes": rivers["bytes"],
            "lines": rivers["lines"],
            "points": rivers["points"],
            "source": "Natural Earth 1:10m rivers_lake_centerlines (public domain), lake centerlines omitted",
        },
        "closeTiles": {
            "source": "OpenFreeMap OpenMapTiles water polygons (OpenStreetMap, ODbL)",
            "cacheTiles": 32,
            "coordBudgetPerTile": 65536,
            "cacheBytes": 32 * 65536,
            "maxTilesPerView": 24,
        },
    }
    Path(lakes_out).with_name("water-budget.json").write_text(json.dumps(budget, indent=2) + "\n")
    print("budget", budget["lakes"]["bytes"], budget["rivers"]["bytes"], budget["closeTiles"]["cacheBytes"])


if __name__ == "__main__":
    main()
