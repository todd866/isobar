#!/usr/bin/env python3
"""Pack Natural Earth 1:10m populated places (public domain) for map labels.

Output: JSON array of [name, latitude, longitude, rank], most important first.
Rank is Natural Earth's min_zoom (smaller shows sooner). The map draws a place
when its rank allows at the current zoom and its label does not collide.
"""

import argparse
import json
import math


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="ne_10m_populated_places_simple.geojson")
    parser.add_argument("output")
    args = parser.parse_args()
    with open(args.source, encoding="utf-8") as handle:
        features = json.load(handle)["features"]
    rows = []
    for feature in features:
        p = feature["properties"]
        name = p.get("name") or p.get("nameascii")
        lat, lon = p.get("latitude"), p.get("longitude")
        rank = p.get("min_zoom")
        if not name or lat is None or lon is None or rank is None:
            continue
        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        rows.append([name, round(lat, 3), round(lon, 3), round(float(rank), 1), -(p.get("pop_max") or 0)])
    rows.sort(key=lambda row: (row[3], row[4]))
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump([row[:4] for row in rows], handle, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} places -> {args.output}")


if __name__ == "__main__":
    main()
