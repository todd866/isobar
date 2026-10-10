#!/usr/bin/env python3
"""Generate a bounded, terrain-following synthetic Everest 1953 route.

The route uses retained Mapterhorn Terrarium z12 tiles and the documented
South Col sequence. It is a geometry aid, not a surveyed 1953 trail record.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

Z = 12
DEG_LAT_M = 111_132.0
STEP_M = 75.0
STAGES = (
    ("Base Camp", 28.002, 86.852),
    ("Khumbu Icefall", 27.991, 86.869),
    ("Western Cwm", 27.980, 86.898),
    ("Lhotse Face", 27.965, 86.922),
    ("South Col", 27.971, 86.929),
    ("Camp IX", 27.982, 86.931),
    ("South Summit", 27.9870, 86.9265),
    ("Southeast Ridge", 27.9880, 86.9258),
    ("Everest", 27.9881, 86.9250),
)


def tile_xy(lon: float, lat: float) -> tuple[float, float]:
    x = (lon + 180) / 360 * 2**Z
    phi = math.radians(max(-85.0511, min(85.0511, lat)))
    y = (1 - math.log(math.tan(phi) + 1 / math.cos(phi)) / math.pi) / 2 * 2**Z
    return x, y


class Terrain:
    def __init__(self, directory: Path):
        self.tiles: dict[tuple[int, int], np.ndarray] = {}
        for path in sorted(directory.glob("*.webp")):
            x, y = (int(v) for v in path.stem.split("-"))
            with Image.open(path) as image:
                rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
            if rgba.shape[:2] != (512, 512):
                raise ValueError(f"unexpected tile size: {path}")
            self.tiles[(x, y)] = rgba[:, :, 0].astype(np.float32) * 256 + rgba[:, :, 1] + rgba[:, :, 2] / 256 - 32768

    def sample(self, lon: float, lat: float) -> float | None:
        fx, fy = tile_xy(lon, lat)
        tx, ty = math.floor(fx), math.floor(fy)
        tile = self.tiles.get((tx, ty))
        if tile is None:
            return None
        px, py = (fx - tx) * 512, (fy - ty) * 512
        x0, y0 = max(0, min(511, math.floor(px))), max(0, min(511, math.floor(py)))
        x1, y1 = min(511, x0 + 1), min(511, y0 + 1)
        ax, ay = px - x0, py - y0
        return float((tile[y0, x0] * (1 - ax) + tile[y0, x1] * ax) * (1 - ay) + (tile[y1, x0] * (1 - ax) + tile[y1, x1] * ax) * ay)


def dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = (a[0] + b[0]) / 2
    return math.hypot((b[1] - a[1]) * DEG_LAT_M * math.cos(math.radians(lat)), (b[0] - a[0]) * DEG_LAT_M)


def heading(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = (a[0] + b[0]) / 2
    return math.atan2((b[1] - a[1]) * math.cos(math.radians(lat)), b[0] - a[0])


def move(p: tuple[float, float], bearing: float, metres: float) -> tuple[float, float]:
    return (p[0] + metres * math.cos(bearing) / DEG_LAT_M, p[1] + metres * math.sin(bearing) / (DEG_LAT_M * math.cos(math.radians(p[0]))))


def reconstruct(terrain: Terrain) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for stage_index, (name, lat, lon) in enumerate(STAGES[:-1]):
        target_name, target_lat, target_lon = STAGES[stage_index + 1]
        current = (lat, lon)
        elevation = terrain.sample(*current[::-1])
        if elevation is None:
            raise ValueError(f"missing DEM at {name}")
        if not points:
            points.append({"lat": lat, "lon": lon, "elevation_m": round(elevation, 2), "stage": name, "synthetic": True})
        target = (target_lat, target_lon)
        for _ in range(int(dist(current, target) / STEP_M * 3) + 20):
            remaining = dist(current, target)
            if remaining <= STEP_M * .75:
                break
            direct = heading(current, target)
            best = None
            for degrees in range(-55, 56, 5):
                candidate = move(current, direct + math.radians(degrees), min(STEP_M, remaining))
                ce = terrain.sample(*candidate[::-1])
                if ce is None:
                    continue
                progress = remaining - dist(candidate, target)
                if progress <= 0:
                    continue
                slope = abs(ce - elevation) / STEP_M
                lateral = abs(math.sin(direct - heading(current, candidate)))
                cost = slope * 7 + dist(candidate, target) / STEP_M + lateral * .55 + (2 if progress < STEP_M * .55 else 0)
                if best is None or cost < best[0]:
                    best = (cost, candidate, ce)
            if best is None:
                raise ValueError(f"route solver stalled before {target_name}")
            _, current, elevation = best
            points.append({"lat": round(current[0], 7), "lon": round(current[1], 7), "elevation_m": round(elevation, 2), "stage": target_name, "synthetic": True})
        if dist(current, target) > STEP_M * .75:
            raise ValueError(f"route solver did not reach {target_name}")
        final_elevation = terrain.sample(target_lon, target_lat)
        if final_elevation is None:
            raise ValueError(f"missing DEM at {target_name}")
        if dist(current, target) > 1.0:
            points.append({"lat": target_lat, "lon": target_lon, "elevation_m": round(final_elevation, 2), "stage": target_name, "synthetic": True})
    return points


def prepare(dem_dir: Path, output: Path) -> dict[str, Any]:
    terrain = Terrain(dem_dir)
    points = reconstruct(terrain)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(dem_dir.glob("*.webp"))}
    steps = [math.hypot((b["lon"] - a["lon"]) * 98_000, (b["lat"] - a["lat"]) * DEG_LAT_M) for a, b in zip(points, points[1:])]
    route_length = sum(steps)
    straight_length = math.hypot((points[-1]["lon"] - points[0]["lon"]) * 98_000, (points[-1]["lat"] - points[0]["lat"]) * DEG_LAT_M)
    receipt = {
        "source": "Mapterhorn Terrarium terrain tiles from Copernicus GLO-30 and national elevation models",
        "source_template": "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp", "zoom": Z, "tile_sha256": hashes,
        "historical_sources": [
            "https://nzhistory.govt.nz/edmund-hillary-and-tensing-norgay-reach-summit-of-everest",
            "https://teara.govt.nz/en/interactive/28428/final-ascent-of-everest",
            "https://www.himalayanclub.org/hj/18/1/everest-1953-1/",
            "https://www.alpinejournal.org.uk/Contents/Contents_1954_files/AJ59%201954%20235-238%20Hillary%20Everest%20%284%29.pdf",
        ],
        "method": "bounded slope-cost route solver; 75 m nominal steps; named feature anchors approximate",
        "caveat": "Synthetic terrain-following geometry. The exact 1953 trail, especially through the Icefall and upper ridge, is not reconstructed or claimed surveyed.",
        "generated_at": datetime.now(timezone.utc).isoformat(), "point_count": len(points),
        "stage_anchors": [{"name": name, "lat": lat, "lon": lon} for name, lat, lon in STAGES],
        "route_length_m": route_length, "straight_length_m": straight_length,
        "max_step_m": max(steps),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"schema_version": 1, "kind": "synthetic-terrain-following", "receipt": receipt, "points": points}, indent=2) + "\n")
    receipt["output_sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem-dir", type=Path, default=Path("build/history/everest-route-dem/z12"))
    parser.add_argument("--output", type=Path, default=Path("build/history/everest-1953-route.json"))
    args = parser.parse_args()
    print(json.dumps(prepare(args.dem_dir, args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
