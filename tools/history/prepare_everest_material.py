#!/usr/bin/env python3
"""Prepare one bounded, wide Sentinel-2 material crop for the Everest scene.

This deliberately reuses the existing range-based COG reader.  The output is
modern (2026) satellite material for orientation only; it is not a 1953 image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from prepare_everest_imagery import (  # noqa: E402
    COLLECTION,
    EARTHSEARCH,
    SCENE_ID,
    TIMEOUT,
    band_radiometry,
    render_rgb,
    read_band,
    stac_item,
    tiff_header,
    tiff_epsg,
    utm_forward,
    utm_to_lonlat,
)

OUT_SIZE = 2048
SCENE_DATE = "2026-10-03"
PIXEL_M = 10.0
TIE_E, TIE_N = 399960.0, 3200040.0
EPSG = "EPSG:32645"
ROUTE_ANCHORS = (
    (28.002, 86.852),
    (27.991, 86.869),
    (27.980, 86.898),
    (27.971, 86.929),
    (27.982, 86.931),
    (27.9881, 86.9250),
)


def route_pixel_bounds(size: int = OUT_SIZE, width: int = 10980, height: int = 10980,
                       tie_e: float = TIE_E, tie_n: float = TIE_N, pixel: float = PIXEL_M) -> dict[str, Any]:
    if size != OUT_SIZE or size > width or size > height:
        raise ValueError("the wide crop must be 2048px and fit inside the source")
    pixels = [((utm_forward(lon, lat, 45)[0] - tie_e) / pixel,
               (tie_n - utm_forward(lon, lat, 45)[1]) / pixel) for lat, lon in ROUTE_ANCHORS]
    min_x, max_x = min(p[0] for p in pixels), max(p[0] for p in pixels)
    min_y, max_y = min(p[1] for p in pixels), max(p[1] for p in pixels)
    center_x, center_y = (min_x + max_x) / 2, (min_y + max_y) / 2
    x0 = min(max(0, math.floor(center_x - size / 2)), width - size)
    y0 = min(max(0, math.floor(center_y - size / 2)), height - size)
    return {"x": int(x0), "y": int(y0), "width": size, "height": size,
            "route_pixel_bounds": {"west": min_x, "east": max_x, "north": min_y, "south": max_y},
            "clamped": x0 in (0, width - size) or y0 in (0, height - size)}


def prepare(output_dir: Path, *, session: requests.Session | None = None) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    own_session = session is None
    session = session or requests.Session()
    session.headers["User-Agent"] = "Isobar-Everest-material/1.0 (bounded COG range reader)"
    try:
        item = stac_item(session)
        props = item["properties"]
        epsg = int(props.get("proj:epsg", 0))
        if epsg != 32645:
            raise RuntimeError(f"expected UTM zone 45N source, got EPSG:{epsg}")
        assets = item["assets"]
        names = {2: "blue", 3: "green", 4: "red"}
        urls = {b: assets[names[b]]["href"] for b in (2, 3, 4)}
        if any(not u.startswith("https://") for u in urls.values()):
            raise RuntimeError("STAC band assets must be HTTPS URLs")
        radiometry = [band_radiometry(assets[names[b]]) for b in (4, 3, 2)]
        first_header, first_tags = tiff_header(session, urls[4])
        if tiff_epsg(first_tags) != epsg:
            raise RuntimeError("source CRS does not match STAC metadata")
        tiepoint = first_tags[33922]
        pixel_sizes = first_tags[33550]
        if tuple(tiepoint[:3]) != (0, 0, 0) or abs(pixel_sizes[0] - PIXEL_M) > 1e-6 or abs(pixel_sizes[1] - PIXEL_M) > 1e-6:
            raise RuntimeError("source raster tiepoint/pixel grid is not zero-origin 10m")
        tie_e, tie_n = tiepoint[3], tiepoint[4]
        pixel = pixel_sizes[0]
        if abs(pixel - PIXEL_M) > 1e-6:
            raise RuntimeError("source is not native 10m material")
        exts = (int(first_tags[256]), int(first_tags[257]))
        window = route_pixel_bounds(width=exts[0], height=exts[1], tie_e=tie_e, tie_n=tie_n, pixel=pixel)
        for lat, lon in ROUTE_ANCHORS:
            east, northing = utm_forward(lon, lat, 45)
            px, py = (east - tie_e) / pixel, (tie_n - northing) / pixel
            if not (window["x"] <= px <= window["x"] + OUT_SIZE and window["y"] <= py <= window["y"] + OUT_SIZE):
                raise RuntimeError("selected crop does not contain every route anchor")
        bands = [read_band(session, urls[b], window["x"], window["y"], OUT_SIZE) for b in (4, 3, 2)]
        for _, _, tags in bands:
            if any(tags[k] != first_tags[k] for k in (256, 257, 33550, 33922, 34735)):
                raise RuntimeError("source bands do not share a grid")
        arrays = [v[0] for v in bands]
        rgb, nodata = render_rgb(arrays, radiometry)
        rgba = np.concatenate([rgb, ((~nodata) * 255).astype(np.uint8)[..., None]], axis=-1)
        png = output_dir / "everest-sentinel2-wide-20261003.png"
        Image.fromarray(rgba, "RGBA").save(png, optimize=True)
        corners = [
            utm_to_lonlat(tie_e + window["x"] * pixel, tie_n - window["y"] * pixel),
            utm_to_lonlat(tie_e + (window["x"] + OUT_SIZE) * pixel, tie_n - window["y"] * pixel),
            utm_to_lonlat(tie_e + window["x"] * pixel, tie_n - (window["y"] + OUT_SIZE) * pixel),
            utm_to_lonlat(tie_e + (window["x"] + OUT_SIZE) * pixel, tie_n - (window["y"] + OUT_SIZE) * pixel),
        ]
        west, east = min(p[0] for p in corners), max(p[0] for p in corners)
        south, north = min(p[1] for p in corners), max(p[1] for p in corners)
        receipt = {
            "asset": png.name, "source": "Copernicus Sentinel-2B MSI L2A surface reflectance via EarthSearch Sentinel COGs",
            "scene_id": SCENE_ID, "scene_date": SCENE_DATE, "acquisition_datetime": props["datetime"], "stac_item": f"{EARTHSEARCH}/collections/{COLLECTION}/items/{SCENE_ID}",
            "band_urls": {f"B0{b}": urls[b] for b in (2, 3, 4)},
            "source_metadata_sha256": hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "source_pixels_sha256": {f"B0{b}": hashlib.sha256(arrays[i].astype("<u2").tobytes()).hexdigest() for i, b in enumerate((4, 3, 2))},
            "source_header_sha256": {f"B0{b}": hashlib.sha256(bands[i][1]).hexdigest() for i, b in enumerate((4, 3, 2))},
            "attribution": "Copernicus Sentinel data 2026, processed by ESA; accessed via Element84 EarthSearch.",
            "license": "Copernicus Sentinel Data Terms and Conditions (free and open access)", "native_pixel_size_m": 10,
            "projection": EPSG, "pixel_window": window,
            "utm_bounds_m": {"west": tie_e + window["x"] * pixel, "south": tie_n - (window["y"] + OUT_SIZE) * pixel, "east": tie_e + (window["x"] + OUT_SIZE) * pixel, "north": tie_n - window["y"] * pixel},
            "geographic_bounds_wgs84": {"west": west, "south": south, "east": east, "north": north},
            "radiometry": {"bands_rgb": radiometry}, "nodata_pixels": int(nodata.sum()),
            "rendering": "B04/B03/B02; scaled to surface reflectance, gamma 1/2.2, RGBA nodata alpha; no sharpening",
            "historical_relevance": "Modern 2026 orientation material; not a 1953 observation or reconstruction.",
            "sha256": hashlib.sha256(png.read_bytes()).hexdigest(), "bytes": png.stat().st_size,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        (output_dir / "everest-sentinel2-wide-20261003.stac.json").write_text(json.dumps(item, sort_keys=True, separators=(",", ":")))
        receipt_path = output_dir / "everest-sentinel2-wide-20261003.receipt.json"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        return {"png": str(png), "receipt": str(receipt_path), "sha256": receipt["sha256"], "bytes": receipt["bytes"], "receipt_data": receipt}
    finally:
        if own_session:
            session.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", type=Path, default=Path("build/history/imagery-wide"))
    args = ap.parse_args()
    print(json.dumps(prepare(args.output_dir), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
