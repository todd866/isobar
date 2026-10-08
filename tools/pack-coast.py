#!/usr/bin/env python3
"""Pack Natural Earth 1:50m land for Australian or worldwide charts.

Source GeoJSON is public domain (Natural Earth). The output is a little-endian
blob: magic OCST, uint16 version, uint16 ring count, then each ring as uint16
count and int16 longitude/latitude in hundredths of a degree.

By default, rings whose bounding box is wider or taller than 80° are skipped. That drops
the Eurasia and Antarctica polygons, which only graze this window, while
keeping Australia, Tasmania, New Guinea, New Zealand and the nearby islands.
Use --global to retain every world ring without regional clipping.
"""

import argparse
import json
import math
import struct

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
        if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            raise ValueError("coast coordinate outside world bounds")
        pair = (int(round(lon * 100.0)), int(round(lat * 100.0)))
        if not out or out[-1] != pair:
            out.append(pair)
    if len(out) >= 2 and out[0] == out[-1]:
        out.pop()
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--global", dest="world", action="store_true", help="Keep every land ring, including Eurasia and Antarctica")
    args = parser.parse_args()
    src, dest = args.source, args.destination
    with open(src) as handle:
        collection = json.load(handle)
    packed = []
    for feature in collection["features"]:
        for ring in rings_of(feature["geometry"]):
            lons = [point[0] for point in ring]
            lats = [point[1] for point in ring]
            min_lon, max_lon = min(lons), max(lons)
            min_lat, max_lat = min(lats), max(lats)
            if not args.world and (max_lon < WEST or min_lon > EAST or max_lat < SOUTH or min_lat > NORTH):
                continue
            if not args.world and ((max_lon - min_lon) > MAX_SPAN or (max_lat - min_lat) > MAX_SPAN):
                continue
            points = quantize(ring)
            if len(points) >= 3:
                if len(points) > 65535:
                    raise ValueError("coast ring exceeds OCST v1 point capacity")
                packed.append(points)
    if len(packed) > 65535:
        raise ValueError("coast exceeds OCST v1 ring capacity")
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
