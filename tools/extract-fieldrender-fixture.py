#!/usr/bin/env python3
"""Crop two MSLP frames from a published ECMWF root into Tests/fixtures/fieldrender.

Read-only on the store. ECMWF open data is CC BY 4.0; the fixture README says so.
Usage: tools/extract-fieldrender-fixture.py --store ~/Data/isobar --out Tests/fixtures/fieldrender
"""
import argparse
import json
import math
import struct
from pathlib import Path


def decode_f16(bits):
    sign = (bits >> 15) & 1
    exp = (bits >> 10) & 0x1F
    frac = bits & 0x3FF
    if exp == 0:
        value = 0.0 if frac == 0 else math.ldexp(frac, -24)
    elif exp == 31:
        value = float("nan") if frac else float("inf")
    else:
        value = math.ldexp(1.0 + frac / 1024.0, exp - 15)
    return -value if sign else value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--west", type=float, default=108.0)
    parser.add_argument("--north", type=float, default=-30.25)
    parser.add_argument("--nlon", type=int, default=120)
    parser.add_argument("--nlat", type=int, default=80)
    args = parser.parse_args()
    root = Path(args.store).expanduser()
    pointer = json.loads((root / "products/grids/ecmwf_ifs025/current.json").read_text())
    run = pointer["latest"]
    mslp = root / "products/grids/ecmwf_ifs025/runs" / run / "mslp"
    frames = sorted(p for p in mslp.glob("*.f16"))
    if len(frames) < 2:
        raise SystemExit(f"{mslp} does not have two MSLP frames")
    side = json.loads(frames[0].with_suffix(".json").read_text())
    step = float(side["dlon"])
    grid_west = float(side["lon0"])
    grid_north = float(side["lat0"])
    nx = int(side["nx"])
    ny = int(side["ny"])
    col0 = int(round((args.west - grid_west) / step))
    row0 = int(round((grid_north - args.north) / step))
    if col0 < 0 or row0 < 0 or col0 + args.nlon > nx or row0 + args.nlat > ny:
        raise SystemExit(f"crop {col0},{row0} {args.nlon}x{args.nlat} is outside {nx}x{ny}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    steps = []
    for index, frame in enumerate(frames[:2]):
        blob = frame.read_bytes()
        if len(blob) != nx * ny * 2:
            raise SystemExit(f"{frame.name} is {len(blob)} bytes")
        raw = bytearray()
        finite = []
        for row in range(args.nlat):
            for col in range(args.nlon):
                src = ((row0 + row) * nx + (col0 + col)) * 2
                raw += blob[src:src + 2]
                bits = blob[src] | (blob[src + 1] << 8)
                value = decode_f16(bits)
                if math.isfinite(value):
                    finite.append(value)
        name = f"mslp-{index}.f16"
        (out / name).write_bytes(raw)
        meta = json.loads(frame.with_suffix(".json").read_text())
        steps.append({"file": name, "valid": meta["valid_time"], "run": meta["run"]})
        print(f"{name} {meta['valid_time']} min {min(finite):.1f} max {max(finite):.1f}")
    west = grid_west + col0 * step
    north = grid_north - row0 * step
    header = {
        "attribution": "ECMWF Open Data, CC BY 4.0",
        "model": side.get("model", "ecmwf-ifs-0p25-open-data"),
        "units": "hPa",
        "dtype": "float16",
        "endian": "little",
        "order": "north-to-south, west-to-east",
        "fill": -32768,
        "grid": {
            "west": west,
            "north": north,
            "step": step,
            "nLon": args.nlon,
            "nLat": args.nlat,
            "wrapsLongitude": False,
        },
        "steps": steps,
    }
    (out / "header.json").write_text(json.dumps(header, indent=2) + "\n")
    readme = (
        "Two consecutive ECMWF IFS 0.25° mean-sea-level pressure frames, cropped\n"
        "to southern Australia. ECMWF open data, CC BY 4.0\n"
        "(https://www.ecmwf.int/en/forecasts/datasets/open-data).\n"
        "Little-endian float16, north-to-south, west-to-east. See header.json.\n"
        "Rebuild with tools/extract-fieldrender-fixture.py --store ROOT --out DIR.\n"
        "The store is read only.\n"
    )
    (out / "README.md").write_text(readme)
    total = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    print(f"wrote {out} ({total} bytes)")
    if total > 64 * 1024:
        raise SystemExit("fixture exceeds 64 KB")


if __name__ == "__main__":
    main()
