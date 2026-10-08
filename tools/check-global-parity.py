#!/usr/bin/env python3
"""Compare the global native archive with an exported web frame directory.

This is a read-only contract check. It compares decoded shared archive values;
it does not inspect or claim GPU shader or rendered-pixel parity.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import struct
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

SCHEMA2 = list(range(0, 145, 3)) + [150, 156, 162, 168]
NX, NY = 720, 361
CELLS = NX * NY
KNOTS = 1.943844
FILL_NATIVE = -32768.0


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def stamp(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def record_snapshot(path: Path, raw: bytes, snapshot: dict[Path, str] | None) -> None:
    if snapshot is None:
        return
    digest = hashlib.sha256(raw).hexdigest()
    previous = snapshot.get(path)
    if previous is not None and previous != digest:
        raise ValueError(f"input changed during parity read: {path}")
    snapshot[path] = digest


def run_id(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%HZ")


def load_json(path: Path, snapshot: dict[Path, str] | None = None) -> dict:
    raw = path.read_bytes()
    record_snapshot(path, raw, snapshot)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not an object")
    return value


def native_frame(path: Path, shape: tuple[int, int], snapshot: dict[Path, str] | None = None) -> tuple[np.ndarray, np.ndarray]:
    raw = path.read_bytes()
    record_snapshot(path, raw, snapshot)
    expected = shape[0] * shape[1] * 2
    if len(raw) != expected:
        raise ValueError(f"{path} has {len(raw)} bytes, expected {expected}")
    values = np.frombuffer(raw, dtype="<f2").astype(np.float32)
    missing = ~np.isfinite(values) | (values == FILL_NATIVE)
    return values.reshape(shape), missing.reshape(shape)


def inverse_shuffle_u16(raw: bytes) -> bytes:
    if len(raw) % 2:
        raise ValueError("shuffle-gzip payload has odd byte length")
    n = len(raw) // 2
    # The web codec stores the high-byte plane first; native values are little-endian.
    planes = np.frombuffer(raw, dtype=np.uint8).reshape(2, n)
    return np.ascontiguousarray(planes[::-1].T).tobytes()


def web_frame(path: Path, entry: dict, shape: tuple[int, int], snapshot: dict[Path, str] | None = None) -> tuple[np.ndarray, np.ndarray]:
    raw = path.read_bytes()
    record_snapshot(path, raw, snapshot)
    if entry.get("encoding", "raw") == "shuffle-gzip":
        raw = inverse_shuffle_u16(gzip.decompress(raw))
    elif entry.get("encoding", "raw") != "raw":
        raise ValueError(f"unsupported web encoding {entry.get('encoding')!r}")
    expected = shape[0] * shape[1] * 2
    if len(raw) != expected:
        raise ValueError(f"{path} has {len(raw)} bytes, expected {expected}")
    packed = np.frombuffer(raw, dtype="<u2").astype(np.float32)
    fill = entry.get("fill")
    if type(fill) is not int or not 0 <= fill <= 65535:
        raise ValueError("web fill must be an unsigned integer")
    missing = packed == fill
    values = packed * float(entry.get("scale", 1)) + float(entry.get("offset", 0))
    return values.reshape(shape), missing.reshape(shape)


def check_ladder(value: object) -> None:
    if value != SCHEMA2:
        raise ValueError("global parity requires the exact schema 2 53-lead ladder")


def sidecar(run_dir: Path, variable: str, valid: datetime, snapshot: dict[Path, str] | None = None) -> dict:
    return load_json(run_dir / variable / f"{run_id(valid)}.json", snapshot)


def native_run(root: Path, run: str, snapshot: dict[Path, str] | None = None) -> tuple[Path, dict]:
    directory = root / "products/grids/ecmwf_ifs_global/runs" / run
    manifest = load_json(directory / "manifest.json", snapshot)
    if manifest.get("schema") != 2 or manifest.get("family") != "grids/ecmwf_ifs_global":
        raise ValueError(f"native run {run} is not global schema 2")
    check_ladder(manifest.get("forecast_hours"))
    grid = manifest.get("grid")
    expected = ("west", "east", "north", "south", "step", "nx", "ny", "dtype", "wraps_longitude")
    wanted = (-180, 179.5, 90, -90, 0.5, NX, NY, "float16", True)
    if not isinstance(grid, dict) or any(grid.get(key) != value for key, value in zip(expected, wanted)):
        raise ValueError("native global grid geometry or wrap flag is invalid")
    return directory, manifest


def web_run(root: Path, snapshot: dict[Path, str] | None = None) -> tuple[dict, Path, dict]:
    manifest = load_json(root / "manifest.json", snapshot)
    if manifest.get("schema") != 2 or manifest.get("contract") != "isobar-web":
        raise ValueError("web export must be isobar-web schema 2")
    check_ladder(manifest.get("forecast_hours"))
    grid = manifest.get("grid", {})
    if (grid.get("west"), grid.get("east"), grid.get("north"), grid.get("south"), grid.get("step"), grid.get("nx"), grid.get("ny"), grid.get("wraps_longitude")) != (-180, 179.5, 90, -90, 0.5, NX, NY, True):
        raise ValueError("web export does not declare the exact global grid")
    if not isinstance(manifest.get("run"), str):
        raise ValueError("web export has no run timestamp")
    expected_units = {"mslp": "hPa", "t2m": "C", "wind": "kt", "rain24": "mm"}
    for name in ("mslp", "t2m", "wind", "rain24"):
        entry = manifest.get("variables", {}).get(name)
        if not isinstance(entry, dict) or not isinstance(entry.get("frames"), list):
            raise ValueError(f"web export is missing {name} frames")
        scale, offset, fill = entry.get("scale"), entry.get("offset"), entry.get("fill")
        if not isinstance(scale, (int, float)) or not math.isfinite(float(scale)) or float(scale) <= 0 or not isinstance(offset, (int, float)) or not math.isfinite(float(offset)) or type(fill) is not int or not 0 <= fill <= 65535:
            raise ValueError(f"web {name} scale/offset/fill metadata is invalid")
        if entry.get("units") != expected_units[name]:
            raise ValueError(f"web {name} units are invalid")
    return manifest, root, manifest.get("variables", {})


def path_from(data_root: Path, value: object) -> Path:
    if not isinstance(value, str) or not value or value.startswith(("/", "~")) or ".." in Path(value).parts:
        raise ValueError("unsafe web frame path")
    path = (data_root / value).resolve()
    if data_root.resolve() not in path.parents:
        raise ValueError("web frame escapes data directory")
    return path


def accumulation_window(end: np.ndarray, start: np.ndarray, end_missing: np.ndarray, start_missing: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Match the collector: tiny negative packing noise becomes zero; resets are missing."""
    values = end.astype(np.float64) - start.astype(np.float64)
    reset = values < -0.05
    noise = (values < 0) & ~reset
    values = values.copy()
    values[noise] = 0
    return values, end_missing | start_missing | reset


def compare_field(web_root: Path, entry: dict, native_dir: Path, variable: str, valid: datetime, native_values: np.ndarray, native_missing: np.ndarray, totals: dict, snapshot: dict[Path, str] | None = None) -> None:
    frames = entry.get("frames")
    if not isinstance(frames, list):
        raise ValueError(f"web {variable} has no frame list")
    index = entry.get("_index")
    path = path_from(web_root, frames[index])
    web_values, web_missing = web_frame(path, entry, (NY, NX), snapshot)
    if not np.array_equal(web_missing, native_missing):
        raise ValueError(f"{variable} missing mask differs at {run_id(valid)}")
    present = ~native_missing
    # Native archive frames are float16; include one float16 ULP in addition to
    # the web quantizer half-step so an exact shared value is not rejected by
    # binary rounding at a half-step boundary.
    float_error = 4 * np.finfo(np.float32).eps * np.maximum(1, np.maximum(abs(native_values), abs(web_values))) + 4e-6
    tolerance = abs(float(entry.get("scale", 1))) / 2 + float_error
    bad = present & (abs(web_values - native_values) > tolerance)
    totals["cells"] += CELLS
    totals["missing"] += int(native_missing.sum())
    totals["mismatches"] += int(bad.sum())
    if bad.any():
        raise ValueError(f"{variable} differs at {run_id(valid)} ({int(bad.sum())} cells)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, required=True, help="explicit native archive root")
    parser.add_argument("--web-data", type=Path, required=True, help="explicit web data directory containing manifest.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report = {"checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "scope": {"store": str(args.store), "web_data": str(args.web_data)}, "checks": [], "totals": {"frames": 0, "cells": 0, "missing": 0, "mismatches": 0}, "ok": False}
    try:
        pointer_path = args.store / "products/grids/ecmwf_ifs_global/current.json"
        snapshot: dict[Path, str] = {}
        pointer_before = pointer_path.read_bytes()
        snapshot[pointer_path] = hashlib.sha256(pointer_before).hexdigest()
        pointer = json.loads(pointer_before)
        if pointer.get("schema_version") != 2 or pointer.get("family") != "grids/ecmwf_ifs_global":
            raise ValueError("native pointer is not global schema 2")
        check_ladder(pointer.get("forecast_hours"))
        latest = pointer.get("latest")
        runs = pointer.get("runs")
        if not isinstance(latest, str) or not isinstance(runs, list) or latest not in runs:
            raise ValueError("native pointer latest/runs are invalid")
        native_dir, native_manifest = native_run(args.store, latest, snapshot)
        web_manifest, web_root, variables = web_run(args.web_data, snapshot)
        if web_manifest.get("run") != native_manifest.get("run"):
            raise ValueError("native and web run timestamps differ")
        if native_manifest.get("forecast_hours") != web_manifest.get("forecast_hours"):
            raise ValueError("native and web ladders differ")
        report["identities"] = {"native_pointer_sha256": sha256(pointer_path), "native_manifest_sha256": sha256(native_dir / "manifest.json"), "web_manifest_sha256": sha256(args.web_data / "manifest.json"), "native_run": latest}
        run_dt = datetime.strptime(latest, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
        required = {"mslp": "mslp", "t2m": "t2m", "wind": "wind", "rain24": "rain24"}
        if not all(isinstance(variables.get(name), dict) for name in required):
            raise ValueError("web export is missing one or more parity fields")
        # Load the two vector components only once per frame; comparisons remain frame-at-a-time.
        for index, lead in enumerate(SCHEMA2):
            valid = run_dt + timedelta(hours=lead)
            native: dict[str, tuple[np.ndarray, np.ndarray]] = {}
            for name in ("mslp", "t2m", "u10", "v10", "tp"):
                meta = sidecar(native_dir, name, valid, snapshot)
                if meta.get("run") != native_manifest.get("run") or meta.get("valid_time") != valid.strftime("%Y-%m-%dT%H:%M:%SZ") or meta.get("nx") != NX or meta.get("ny") != NY or meta.get("dtype") != "float16" or meta.get("endian") != "little":
                    raise ValueError(f"native {name} sidecar metadata does not match run/grid")
                native[name] = native_frame(native_dir / name / f"{run_id(valid)}.f16", (NY, NX), snapshot)
            for name, source in (("mslp", "mslp"), ("t2m", "t2m")):
                variables[name]["_index"] = index
                compare_field(web_root, variables[name], native_dir, name, valid, *native[source], report["totals"], snapshot)
            wind_values = np.sqrt(native["u10"][0] ** 2 + native["v10"][0] ** 2) * KNOTS
            wind_missing = native["u10"][1] | native["v10"][1]
            variables["wind"]["_index"] = index
            compare_field(web_root, variables["wind"], native_dir, "wind", valid, wind_values, wind_missing, report["totals"], snapshot)
            # Rain is the 24-hour difference from the newest retained run covering both endpoints.
            rain_end = native["tp"]
            rain_start = None
            for candidate in sorted((str(item) for item in runs if isinstance(item, str)), reverse=True):
                cdir, _ = native_run(args.store, candidate, snapshot)
                candidate_dt = datetime.strptime(candidate, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
                start_valid = valid - timedelta(hours=24)
                if start_valid < candidate_dt:
                    continue
                try:
                    rain_start = native_frame(cdir / "tp" / f"{run_id(start_valid)}.f16", (NY, NX), snapshot)
                    rain_end = native_frame(cdir / "tp" / f"{run_id(valid)}.f16", (NY, NX), snapshot)
                    break
                except (OSError, ValueError):
                    continue
            if rain_start is None:
                raise ValueError(f"no retained run covers rain endpoints for {run_id(valid)}")
            rain_values, rain_missing = accumulation_window(rain_end[0], rain_start[0], rain_end[1], rain_start[1])
            variables["rain24"]["_index"] = index
            compare_field(web_root, variables["rain24"], native_dir, "rain24", valid, rain_values, rain_missing, report["totals"], snapshot)
            report["totals"]["frames"] += 1
        for path, expected in snapshot.items():
            if not path.is_file() or sha256(path) != expected:
                raise ValueError(f"input changed during parity read: {path}")
        report["snapshot"] = {"file_count": len(snapshot), "digest": hashlib.sha256("".join(f"{path}\0{digest}\n" for path, digest in sorted(snapshot.items(), key=lambda item: str(item[0]))).encode()).hexdigest()}
        report["checks"].append({"id": "global.shared_archive_values", "status": "pass", "detail": "all 53 frames and 720x361 cells match within packed-value tolerance"})
        report["ok"] = True
    except Exception as exc:
        report["checks"].append({"id": "global.shared_archive_values", "status": "fail", "detail": str(exc)})
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        for check in report["checks"]:
            print(f"{check['status'].upper():7} {check['id']}: {check['detail']}")
        print("OVERALL ", "PASS" if report["ok"] else "FAIL")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
