#!/usr/bin/env python3
"""Prepare a bounded, reproducible Sentinel-2 true-colour crop of Everest.

The source is the public EarthSearch STAC mirror of Copernicus Sentinel-2 L2A.
Only the COG header and the tiles intersecting the requested crop are fetched;
this never downloads a complete scene.  The output is a display PNG made from
the native 10 m B04/B03/B02 surface-reflectance bands.  It is not sharpened or
otherwise detail-enhanced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image

EARTHSEARCH = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
SCENE_ID = "S2B_45RVM_20261003_0_L2A"
EVEREST_LON, EVEREST_LAT = 86.9250, 27.9881
OUT_SIZE = 1024
TIMEOUT = 45


def get_range(session: requests.Session, url: str, start: int, end: int) -> bytes:
    """Read one bounded COG byte range; reject silent full-object responses."""
    expected = end - start + 1
    if start < 0 or expected < 1 or expected > 16_000_000:
        raise ValueError("invalid or oversized byte range")
    r = session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=TIMEOUT, stream=True)
    try:
        if r.status_code != 206:
            raise RuntimeError(f"range request returned HTTP {r.status_code}, expected 206")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", r.headers.get("Content-Range", ""))
        if not match or (int(match.group(1)), int(match.group(2))) != (start, end):
            raise RuntimeError(f"invalid Content-Range for {url}: {r.headers.get('Content-Range')!r}")
        if match.group(3) != "*" and int(match.group(3)) <= end:
            raise RuntimeError("range exceeds declared object length")
        try:
            body = r.raw.read(expected + 1, decode_content=False)
        except TypeError:  # small offline fakes and file-like test streams
            body = r.raw.read(expected + 1)
        if len(body) != expected:
            raise RuntimeError(f"short range response for {url}: {len(body)} bytes")
        return body
    finally:
        r.close()


def tiff_header(session: requests.Session, url: str) -> tuple[bytes, dict[int, Any]]:
    head = get_range(session, url, 0, 65535)
    if head[:4] != b"II*\x00":
        raise RuntimeError(f"unsupported TIFF byte order/version: {head[:4]!r}")
    endian = "<"
    ifd = struct.unpack_from(endian + "I", head, 4)[0]
    if ifd < 8 or ifd + 2 > len(head):
        raise RuntimeError("TIFF directory outside bounded header")
    count = struct.unpack_from(endian + "H", head, ifd)[0]
    if ifd + 2 + count * 12 > len(head):
        raise RuntimeError("TIFF entries outside bounded header")
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
    tags: dict[int, Any] = {}
    for i in range(count):
        p = ifd + 2 + i * 12
        tag, typ, n = struct.unpack_from(endian + "HHI", head, p)
        if typ not in sizes or n < 1:
            raise RuntimeError("unsupported TIFF tag type/count")
        size = n * sizes[typ]
        loc = p + 8 if size <= 4 else struct.unpack_from(endian + "I", head, p + 8)[0]
        if loc + size > len(head):
            raise RuntimeError("TIFF tag outside bounded header")
        raw = head[loc : loc + size]
        if typ == 3:
            value = struct.unpack(endian + "H" * n, raw)
        elif typ == 4:
            value = struct.unpack(endian + "I" * n, raw)
        elif typ == 5:
            pairs = struct.unpack(endian + "I" * n * 2, raw)
            value = tuple(pairs[i] / pairs[i + 1] for i in range(0, len(pairs), 2))
        elif typ == 12:
            value = struct.unpack(endian + "d" * n, raw)
        elif typ == 2:
            value = raw.rstrip(b"\0").decode("ascii", errors="replace")
        else:
            value = raw
        tags[tag] = value[0] if n == 1 else value
    required = {256, 257, 258, 259, 277, 322, 323, 324, 325, 33550, 33922, 34735}
    missing = required.difference(tags)
    if missing:
        raise RuntimeError(f"TIFF header missing required tags: {sorted(missing)}")
    if tags[258] != 16 or tags[259] != 8 or tags[277] != 1 or tags.get(339, 1) != 1:
        raise RuntimeError("expected one 16-bit unsigned deflate-compressed Sentinel band")
    offsets = (tags[324],) if isinstance(tags[324], int) else tags[324]
    counts = (tags[325],) if isinstance(tags[325], int) else tags[325]
    if len(offsets) != len(counts) or any(v <= 0 for v in counts):
        raise RuntimeError("invalid TIFF tile offset/count arrays")
    return head, tags


def read_band(session: requests.Session, url: str, x0: int, y0: int, size: int) -> tuple[np.ndarray, bytes, dict[int, Any]]:
    header, tags = tiff_header(session, url)
    width, height = int(tags[256]), int(tags[257])
    tile_w, tile_h = int(tags[322]), int(tags[323])
    offsets = [tags[324]] if isinstance(tags[324], int) else list(tags[324])
    counts = [tags[325]] if isinstance(tags[325], int) else list(tags[325])
    if tile_w != 1024 or tile_h != 1024 or tags[259] != 8 or tags.get(317, 1) not in (1, 2):
        raise RuntimeError("expected 1024px deflate-compressed native Sentinel-2 tiles")
    if x0 < 0 or y0 < 0 or x0 + size > width or y0 + size > height:
        raise RuntimeError("crop extends outside source image")
    x1, y1 = x0 + size, y0 + size
    out = np.zeros((y1 - y0, x1 - x0), dtype=np.uint16)
    c0, c1 = x0 // tile_w, (x1 - 1) // tile_w
    r0, r1 = y0 // tile_h, (y1 - 1) // tile_h
    ncols = math.ceil(width / tile_w)
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            idx = row * ncols + col
            raw = get_range(session, url, offsets[idx], offsets[idx] + counts[idx] - 1)
            pixels = np.frombuffer(zlib.decompress(raw), dtype="<u2")
            # COG tiles at the right/bottom edge retain their full declared
            # dimensions and are padded beyond the image extent.
            tw, th = tile_w, tile_h
            tile = pixels.reshape(th, tw)
            if tags.get(317) == 2:  # TIFF horizontal differencing predictor
                tile = np.cumsum(tile, axis=1, dtype=np.uint32).astype(np.uint16)
            ax0, ay0 = col * tile_w, row * tile_h
            sx0, sy0 = max(x0, ax0), max(y0, ay0)
            sx1, sy1 = min(x1, ax0 + tw, width), min(y1, ay0 + th, height)
            out[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = tile[
                sy0 - ay0 : sy1 - ay0, sx0 - ax0 : sx1 - ax0
            ]
    return out, header, tags


def stac_item(session: requests.Session) -> dict[str, Any]:
    url = f"{EARTHSEARCH}/collections/{COLLECTION}/items/{SCENE_ID}"
    r = session.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    if len(r.content) > 2_000_000:
        raise RuntimeError("STAC item exceeded bounded metadata limit")
    item = r.json()
    if item.get("id") != SCENE_ID:
        raise RuntimeError("STAC item ID changed")
    return item


def utm_forward(lon: float, lat: float, zone: int) -> tuple[float, float]:
    """WGS84 UTM forward transform for the STAC-declared EPSG zone."""
    a, ecc2, k0 = 6378137.0, 0.00669437999014, 0.9996
    lat_r, lon_r = math.radians(lat), math.radians(lon)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    n = a / math.sqrt(1 - ecc2 * math.sin(lat_r) ** 2)
    t, c = math.tan(lat_r) ** 2, ecc2 / (1 - ecc2) * math.cos(lat_r) ** 2
    aa = math.cos(lat_r) * (lon_r - lon0)
    m = a * ((1 - ecc2 / 4 - 3 * ecc2**2 / 64 - 5 * ecc2**3 / 256) * lat_r - (3*ecc2/8 + 3*ecc2**2/32 + 45*ecc2**3/1024)*math.sin(2*lat_r) + (15*ecc2**2/256 + 45*ecc2**3/1024)*math.sin(4*lat_r) - (35*ecc2**3/3072)*math.sin(6*lat_r))
    e = 500000 + k0 * n * (aa + (1-t+c)*aa**3/6 + (5-18*t+t*t+72*c-58*ecc2/(1-ecc2))*aa**5/120)
    north = k0 * (m + n*math.tan(lat_r)*(aa**2/2 + (5-t+9*c+4*c*c)*aa**4/24 + (61-58*t+t*t+600*c-330*ecc2/(1-ecc2))*aa**6/720))
    return e, north


def render_rgb(arrays: list[np.ndarray], radiometry: list[dict[str, float]]) -> tuple[np.ndarray, np.ndarray]:
    """Convert B04/B03/B02 DN arrays to RGB and return the nodata mask."""
    stack = np.stack(arrays, axis=-1)
    nodata = np.any(stack == np.array([b["nodata"] for b in radiometry]), axis=-1)
    reflectance = stack.astype(np.float32) * np.array([b["scale"] for b in radiometry]) + np.array([b["offset"] for b in radiometry])
    rgb = np.clip(reflectance, 0.0, 1.0) ** (1 / 2.2)
    rgb[nodata] = 0
    return np.round(rgb * 255).astype(np.uint8), nodata


def band_radiometry(asset: dict[str, Any]) -> dict[str, float]:
    bands = asset.get("raster:bands", [])
    if len(bands) != 1 or not all(k in bands[0] for k in ("scale", "offset", "nodata")):
        raise RuntimeError("source band lacks explicit radiometry")
    result = {k: float(bands[0][k]) for k in ("scale", "offset", "nodata")}
    if not all(math.isfinite(v) for v in result.values()) or result["scale"] <= 0:
        raise RuntimeError("invalid source radiometry")
    return result


def tiff_epsg(tags: dict[int, Any]) -> int:
    keys = tags[34735]
    if len(keys) < 4 or len(keys) != 4 + 4 * keys[3]:
        raise RuntimeError("invalid GeoKey directory")
    for i in range(4, len(keys), 4):
        key, location, count, value = keys[i:i+4]
        if key == 3072 and location == 0 and count == 1:
            return int(value)
    raise RuntimeError("missing projected EPSG GeoKey")


def utm_to_lonlat(easting: float, northing: float) -> tuple[float, float]:
    """WGS84 UTM zone 45N inverse, avoiding a GIS dependency."""
    a, ecc2, k0 = 6378137.0, 0.00669437999014, 0.9996
    e1 = (1 - math.sqrt(1 - ecc2)) / (1 + math.sqrt(1 - ecc2))
    m = northing / k0
    mu = m / (a * (1 - ecc2 / 4 - 3 * ecc2**2 / 64 - 5 * ecc2**3 / 256))
    phi1 = mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
    phi1 += (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
    phi1 += (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu)
    n1 = a / math.sqrt(1 - ecc2 * math.sin(phi1) ** 2)
    t1, c1 = math.tan(phi1) ** 2, ecc2 / (1 - ecc2) * math.cos(phi1) ** 2
    r1 = a * (1 - ecc2) / (1 - ecc2 * math.sin(phi1) ** 2) ** 1.5
    d = (easting - 500000.0) / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (d**2 / 2 - (5 + 3*t1 + 10*c1 - 4*c1**2 - 9*ecc2/(1-ecc2))*d**4/24)
    lon = math.radians(87.0) + (d - (1 + 2*t1 + c1)*d**3/6) / math.cos(phi1)
    return math.degrees(lon), math.degrees(lat)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", type=Path, default=Path("build/history/imagery"))
    args = ap.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session:
        session.headers["User-Agent"] = "Isobar-Everest-imagery/1.0 (bounded COG range reader)"
        item = stac_item(session)
        props = item["properties"]
        epsg = int(props.get("proj:epsg", 0))
        if epsg < 32601 or epsg > 32660:
            raise RuntimeError(f"unexpected projected CRS: EPSG:{epsg}")
        zone = epsg - 32600
        assets = item["assets"]
        asset_names = {2: "blue", 3: "green", 4: "red"}
        urls = {b: assets[asset_names[b]].get("href") for b in (2, 3, 4)}
        if any(not u or not u.startswith("https://") for u in urls.values()):
            raise RuntimeError("STAC band assets must be HTTPS URLs")
        radiometric_factor = float(props.get("s2:reflectance_conversion_factor", 1.0))
        radiometry = [band_radiometry(assets[asset_names[b]]) for b in (4, 3, 2)]
        ex, ey = utm_forward(EVEREST_LON, EVEREST_LAT, zone)
        _, first_tags = tiff_header(session, urls[4])
        if tiff_epsg(first_tags) != epsg or tuple(first_tags[33922][:3]) != (0, 0, 0):
            raise RuntimeError("source CRS/tiepoint mismatch")
        tie_e, tie_n = first_tags[33922][3], first_tags[33922][4]
        pixel = first_tags[33550][0]
        if abs(pixel - 10.0) > 1e-6 or epsg != 32645:
            raise RuntimeError(f"expected native 10m UTM-45N asset, got {pixel}m EPSG:{epsg}")
        cx, cy = round((ex - tie_e) / pixel), round((tie_n - ey) / pixel)
        if not (0 <= cx < first_tags[256] and 0 <= cy < first_tags[257]):
            raise RuntimeError("Everest summit falls outside the source raster")
        x0, y0 = cx - OUT_SIZE // 2, cy - OUT_SIZE // 2
        bands = [read_band(session, urls[b], x0, y0, OUT_SIZE) for b in (4, 3, 2)]
        for _, _, tags in bands:
            if any(tags[k] != first_tags[k] for k in (256, 257, 33550, 33922, 34735)):
                raise RuntimeError("source bands do not share a grid")
        arrays = [v[0] for v in bands]
        rgb, nodata = render_rgb(arrays, radiometry)
        image = Image.fromarray(rgb, "RGB")
        png = args.output_dir / "everest-sentinel2-20261003.png"
        image.save(png, optimize=True)
        west, south = utm_to_lonlat(tie_e + x0 * pixel, tie_n - (y0 + OUT_SIZE) * pixel)
        east, north = utm_to_lonlat(tie_e + (x0 + OUT_SIZE) * pixel, tie_n - y0 * pixel)
        receipt = {
            "asset": png.name,
            "source": "Copernicus Sentinel-2B MSI L2A surface reflectance via EarthSearch Sentinel COGs",
            "scene_id": SCENE_ID,
            "acquisition_datetime": props["datetime"],
            "stac_item": f"{EARTHSEARCH}/collections/{COLLECTION}/items/{SCENE_ID}",
            "band_urls": {f"B0{b}": urls[b] for b in (2, 3, 4)},
            "attribution": "Copernicus Sentinel data 2026, processed by ESA; accessed via Element84 EarthSearch.",
            "license": "Copernicus Sentinel Data Terms and Conditions (free and open access)",
            "native_pixel_size_m": 10,
            "projection": f"EPSG:{epsg}",
            "pixel_window": {"x": x0, "y": y0, "width": OUT_SIZE, "height": OUT_SIZE},
            "utm_bounds_m": {"west": tie_e + x0*pixel, "south": tie_n-(y0+OUT_SIZE)*pixel, "east": tie_e+(x0+OUT_SIZE)*pixel, "north": tie_n-y0*pixel},
            "geographic_bounds_wgs84": {"west": west, "south": south, "east": east, "north": north},
            "radiometry": {"bands_rgb": radiometry, "unused_solar_conversion_factor": radiometric_factor},
            "nodata_pixels": int(nodata.sum()),
            "rendering": "B04/B03/B02; scaled to surface reflectance, clipped to 0..1, then gamma 1/2.2 to 8-bit RGB; no resampling or sharpening",
            "source_metadata_sha256": hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "source_pixels_sha256": {f"B0{b}": hashlib.sha256(arrays[i].astype("<u2").tobytes()).hexdigest() for i, b in enumerate((4, 3, 2))},
            "source_header_sha256": {f"B0{b}": hashlib.sha256(bands[i][1]).hexdigest() for i, b in enumerate((4, 3, 2))},
            "source_quality": {"tile_cloud_cover_percent": props.get("eo:cloud_cover"), "cloud_shadow_percent": props.get("s2:cloud_shadow_percentage"), "snow_ice_percent": props.get("s2:snow_ice_percentage")},
            "sha256": hashlib.sha256(png.read_bytes()).hexdigest(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        (args.output_dir / "everest-sentinel2-20261003.stac.json").write_text(json.dumps(item, sort_keys=True, separators=(",", ":")))
        (args.output_dir / "everest-sentinel2-20261003.receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"png": str(png), "sha256": receipt["sha256"], "bytes": png.stat().st_size}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
