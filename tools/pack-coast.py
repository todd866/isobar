#!/usr/bin/env python3
"""Crop Natural Earth 1:50m land to the Australian chart window.

Source GeoJSON is public domain (Natural Earth). The output is a little-endian
blob: magic OCST, uint16 version, uint16 ring count, then each ring as uint16
count and int16 longitude/latitude in hundredths of a degree.

Rings whose bounding box is wider or taller than 80° are skipped. That drops
the Eurasia and Antarctica polygons, which only graze this window, while
keeping Australia, Tasmania, New Guinea, New Zealand and the nearby islands.
"""

import json
import struct
import sys

WEST, EAST, SOUTH, NORTH = 96.0, 172.0, -52.0, 8.0
MAX_SPAN = 80.0


def rings_of(geometry):
    kind = geometry["type"]
    coords = geometry["coordinates"]
    if kind == "Polygon":
        return coords
    if kind == "MultiPolygon":
        return [ring for polygon in coords for ring in polygon]
    return []


def quantize(ring):
    out = []
    for lon, lat in ring:
        pair = (int(round(lon * 100.0)), int(round(lat * 100.0)))
        if not out or out[-1] != pair:
            out.append(pair)
    if len(out) >= 2 and out[0] == out[-1]:
        out.pop()
    return out


def main():
    src, dest = sys.argv[1], sys.argv[2]
    with open(src) as handle:
        collection = json.load(handle)
    packed = []
    for feature in collection["features"]:
        for ring in rings_of(feature["geometry"]):
            lons = [point[0] for point in ring]
            lats = [point[1] for point in ring]
            min_lon, max_lon = min(lons), max(lons)
            min_lat, max_lat = min(lats), max(lats)
            if max_lon < WEST or min_lon > EAST or max_lat < SOUTH or min_lat > NORTH:
                continue
            if (max_lon - min_lon) > MAX_SPAN or (max_lat - min_lat) > MAX_SPAN:
                continue
            points = quantize(ring)
            if len(points) >= 3:
                packed.append(points)
    blob = bytearray()
    blob += b"OCST"
    blob += struct.pack("<HH", 1, len(packed))
    for ring in packed:
        blob += struct.pack("<H", len(ring))
        for lon, lat in ring:
            blob += struct.pack("<hh", lon, lat)
    with open(dest, "wb") as handle:
        handle.write(blob)
    print(f"rings {len(packed)} points {sum(len(r) for r in packed)} bytes {len(blob)}")


if __name__ == "__main__":
    main()
