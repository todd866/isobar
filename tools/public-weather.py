#!/usr/bin/env python3
"""Build and validate a minimal, sanitized public weather snapshot."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
from datetime import datetime, timezone


SCHEMA = 1
GRID_FAMILY = "products/grids/ecmwf_ifs025"
GRID_FIELDS = ("cloud_cover", "gust10", "mslp", "mucape", "t2m", "t850", "tp", "u10", "v10")
CORE_FIELDS = ("mslp", "t850", "t2m", "u10", "v10", "tp")
POINT_FAMILIES = ("products/points/ecmwf_ifs", "products/points/marine")
# Configured surface points (isobar-data config/isobar.toml). Coordinates are the
# requested locations; published files may be snapped within 30 km.
SURFACE_POINTS = {
    "cottesloe": {"place": "Perth", "public_name": "Cottesloe", "latitude": -31.9953964, "longitude": 115.7511955, "timezone": "Australia/Perth", "marine": True},
    "yssy": {"place": "Sydney", "public_name": "Sydney", "latitude": -33.946, "longitude": 151.177, "timezone": "Australia/Sydney", "marine": False},
    "safety-bay": {"place": "Safety Bay", "public_name": "Safety Bay", "latitude": -32.3040595, "longitude": 115.7286309, "timezone": "Australia/Perth", "marine": True},
    "rottnest": {"place": "Rottnest", "public_name": "Rottnest", "latitude": -32.0, "longitude": 115.5, "timezone": "Australia/Perth", "marine": False},
    "perth-airport": {"place": "Perth Airport", "public_name": "Perth Airport", "latitude": -31.9403, "longitude": 115.967003, "timezone": "Australia/Perth", "marine": False},
    "garden-island": {"place": "Garden Island", "public_name": "Garden Island", "latitude": -32.2, "longitude": 115.7, "timezone": "Australia/Perth", "marine": False},
}
REQUIRED_SURFACE = ("cottesloe", "yssy")
DAILY_NUMBERS = ("temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_hours", "weather_code",
                 "wind_speed_10m_max", "wind_gusts_10m_max", "wind_direction_10m_dominant")
DATE_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}")
CLOCK_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?")
ZONE_TEXT = re.compile(r"[A-Za-z]+(?:/[A-Za-z0-9_+-]+)+")
POINT_HOURLY = {
    "ecmwf_ifs": ("temperature_2m", "dew_point_2m", "pressure_msl", "wind_speed_10m", "wind_direction_10m",
                   "wind_gusts_10m", "precipitation", "cape", "visibility", "cloud_cover", "cloud_cover_low", "weather_code"),
    "marine": ("wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction",
                "swell_wave_period", "wind_wave_height", "wind_wave_direction", "wind_wave_period",
                "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period",
                "sea_surface_temperature", "sea_level_height_msl"),
}
LICENSE_IDS = {"ecmwf-cc-by-4.0", "open-meteo-cc-by-4.0"}
ATTRIBUTION = {"sources": [
    {"licence_id": "ecmwf-cc-by-4.0", "policy_url": "https://www.ecmwf.int/en/forecasts/datasets/open-data",
     "attribution": "ECMWF Open Data, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)", "redistribute": True},
    {"licence_id": "open-meteo-cc-by-4.0", "policy_url": "https://open-meteo.com/en/terms",
     "attribution": "Weather data by Open-Meteo.com (https://open-meteo.com/)", "redistribute": True},
]}
GRID_UNITS = dict(zip(GRID_FIELDS, ("%", "m/s", "hPa", "J/kg", "degC", "degC", "mm", "m/s", "m/s")))
GRID_PARAMS = dict(zip(GRID_FIELDS, ("tcc", "10fg", "msl", "mucape", "2t", "t", "tp", "10u", "10v")))
MAX_MEMBERS = 20_000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), parse_constant=lambda _: fail("non-finite JSON number"))
    except (OSError, ValueError) as exc:
        fail(f"invalid JSON: {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"expected JSON object: {path}")
    return value


def safe_component(value: str) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9TZ-]{11,32}(?:-[a-f0-9]{8,64})?", value))


def safe_rel(value: str) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    p = PurePosixPath(value)
    return not p.is_absolute() and p.as_posix() == value and all(part not in {"", ".", ".."} for part in p.parts)


def timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?", value):
        fail("invalid forecast timestamp")
    return datetime.fromisoformat(value.rstrip("Z")).replace(tzinfo=timezone.utc)


def run_datetime(token: str) -> datetime:
    if not isinstance(token, str):
        fail("invalid model run timestamp")
    try:
        return datetime.strptime(token, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return timestamp(token)
        except ValueError:
            fail(f"invalid model run timestamp: {token}")


def check_fresh(run: str, max_age_hours: float | None, now: datetime | None = None) -> None:
    if max_age_hours is None:
        return
    if not math.isfinite(max_age_hours) or max_age_hours <= 0:
        fail("max-age-hours must be positive")
    age = (now or datetime.now(timezone.utc)) - run_datetime(run)
    if age.total_seconds() > max_age_hours * 3600:
        fail(f"model run is {age.total_seconds() / 3600:.1f} hours old")
    if age.total_seconds() < -3600:
        fail("model run is in the future")


def copy_file(source: Path, staging: Path, relative: str) -> None:
    if not safe_rel(relative):
        fail(f"unsafe output path: {relative}")
    if source.is_symlink() or not source.is_file():
        fail(f"source is not a regular file: {source}")
    size = source.stat().st_size
    if size > MAX_FILE_BYTES:
        fail(f"file exceeds limit: {source}")
    target = staging / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def write_json(staging: Path, relative: str, value: dict) -> None:
    if not safe_rel(relative):
        fail(f"unsafe output path: {relative}")
    target = staging / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def public_attribution(source: Path) -> dict:
    body = read_json(source)
    rows = body.get("sources")
    if not isinstance(rows, list):
        fail("attribution.json has no sources array")
    if not LICENSE_IDS <= {row.get("licence_id") for row in rows if isinstance(row, dict) and row.get("redistribute") is True}:
        fail("attribution is missing ECMWF or Open-Meteo credit")
    return ATTRIBUTION


def select_runs(root: Path) -> list[str]:
    pointer = read_json(root / GRID_FAMILY / "current.json")
    latest = pointer.get("latest")
    runs = pointer.get("runs")
    if not isinstance(latest, str) or not safe_component(latest):
        fail("grid pointer has no safe latest run")
    if not isinstance(runs, list) or not all(isinstance(run, str) and safe_component(run) for run in runs):
        fail("grid pointer has invalid runs")
    ordered = [latest] + [run for run in reversed(runs) if run != latest]
    if not (root / GRID_FAMILY / "runs" / latest).is_dir():
        fail("grid pointer latest run is missing")
    selected = [run for run in ordered if (root / GRID_FAMILY / "runs" / run).is_dir()][:2]
    if len(selected) < 2:
        fail("grid pointer does not name two existing runs")
    return list(reversed(selected))


def public_grid_sidecar(source: Path, field: str, run: str) -> dict:
    body = read_json(source)
    valid = timestamp(body.get("valid_time"))
    issued = run_datetime(run)
    step = (valid - issued).total_seconds() / 3600
    if step < 0 or step > 96 or step % 3 != 0 or source.stem != valid.strftime("%Y%m%dT%HZ"):
        fail("grid valid time is outside the model run or has the wrong filename")
    expected = {"lat0": 0.0, "lon0": 95.0, "dlat": -.25, "dlon": .25, "ny": 201, "nx": 301,
                "units": GRID_UNITS[field], "run": issued.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "valid_time": valid.strftime("%Y-%m-%dT%H:%M:%SZ"), "model": "ecmwf-ifs-0p25-open-data",
                "fill": -32768, "native_step_hours": 3, "order": "north-to-south, west-to-east",
                "dtype": "float16", "endian": "little", "param": GRID_PARAMS[field]}
    if any(body.get(key) != value for key, value in expected.items()):
        fail(f"unexpected grid metadata: {source}")
    return expected


def finite_coord(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def distance_km(lat: float, lon: float, want_lat: float, want_lon: float) -> float:
    radius = 6371.0
    phi1, phi2 = math.radians(lat), math.radians(want_lat)
    dphi = math.radians(want_lat - lat)
    dlambda = math.radians(want_lon - lon)
    arc = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(arc))


def public_timezone(value, fallback: str) -> str:
    # Older products omit the IANA zone. An unknown or private string falls back
    # to the configured place zone rather than being copied through.
    if isinstance(value, str) and ZONE_TEXT.fullmatch(value) and value not in {"Etc/UTC", "Etc/GMT"}:
        return value
    return fallback


def public_daily(daily) -> dict | None:
    if not isinstance(daily, dict):
        return None
    times = daily.get("time")
    if not isinstance(times, list) or not 1 <= len(times) <= 8 or any(not isinstance(item, str) or not DATE_TEXT.fullmatch(item) for item in times):
        return None
    out = {"time": list(times)}
    for key in DAILY_NUMBERS:
        values = daily.get(key)
        if not isinstance(values, list) or len(values) != len(times):
            continue
        if any(value is not None and (type(value) not in (int, float) or not math.isfinite(value)) for value in values):
            continue
        out[key] = values
    for key in ("sunrise", "sunset"):
        values = daily.get(key)
        if not isinstance(values, list) or len(values) != len(times):
            continue
        if any(value is not None and (not isinstance(value, str) or not CLOCK_TEXT.fullmatch(value)) for value in values):
            continue
        out[key] = values
    return out


def public_point(source: Path, family: str) -> dict:
    body = read_json(source)
    point_id = body.get("id")
    spec = SURFACE_POINTS.get(point_id) if isinstance(point_id, str) else None
    if spec is None or body.get("licence_id") != "open-meteo-cc-by-4.0":
        fail(f"point contains non-public identity metadata: {source}")
    lat, lon = body.get("latitude"), body.get("longitude")
    if not finite_coord(lat) or not finite_coord(lon):
        fail(f"non-finite coordinate: {source}")
    if distance_km(lat, lon, spec["latitude"], spec["longitude"]) > 30:
        fail(f"point coordinates are not the public {spec['public_name']} point: {source}")
    if not isinstance(body.get("units"), dict) or not isinstance(body.get("time"), list) or not isinstance(body.get("hourly"), dict):
        fail(f"point schema is incomplete: {source}")
    times = body["time"]
    parsed = [timestamp(value) for value in times]
    # Seven local days are 168 hourly steps. Allow a short margin, not an open-ended series.
    if not 24 <= len(times) <= 192 or any((b - a).total_seconds() != 3600 for a, b in zip(parsed, parsed[1:])):
        fail("point must contain consecutive hourly times")
    issued = timestamp(body.get("run"))
    model = "ecmwf_ifs" if family == "ecmwf_ifs" else "best-match"
    if body.get("model") != model or body.get("native_step_hours") != 1:
        fail("unexpected public point model")
    out = {"id": point_id, "licence_id": "open-meteo-cc-by-4.0", "model": model,
           "run": issued.strftime("%Y-%m-%dT%H:%M:%SZ"), "native_step_hours": 1,
           "latitude": lat, "longitude": lon, "timezone": public_timezone(body.get("timezone"), spec["timezone"]),
           "time": times}
    daily = public_daily(body.get("daily"))
    if daily:
        out["daily"] = daily
    out["hourly"] = {key: body["hourly"][key] for key in POINT_HOURLY[family] if key in body["hourly"]}
    out["units"] = {key: body["units"][key] for key in out["hourly"] if key in body["units"]}
    for key, values in out["hourly"].items():
        if not isinstance(values, list) or len(values) != len(times) or any(v is not None and (type(v) not in (int, float) or not math.isfinite(v)) for v in values):
            fail(f"point has invalid numeric hourly values: {key}")
        if out["units"].get(key) not in ("°C", "hPa", "kn", "°", "mm", "J/kg", "m", "%", "wmo code", "s"):
            fail(f"point has invalid units: {key}")
    return out


def build_manifest(staging: Path, runs: list[str], generated_at: str) -> dict:
    fields = []
    for run in runs:
        run_dir = staging / GRID_FAMILY / "runs" / run
        for field in GRID_FIELDS:
            field_dir = run_dir / field
            if not field_dir.is_dir():
                continue
            for binary in sorted(field_dir.glob("*.f16")):
                sidecar = binary.with_suffix(".json")
                if not sidecar.is_file():
                    fail(f"grid field has no sidecar: {binary}")
                meta = public_grid_sidecar(sidecar, field, run)
                expected_bytes = meta["nx"] * meta["ny"] * 2
                if binary.stat().st_size != expected_bytes:
                    fail(f"grid has wrong byte length: {binary}")
                fields.append({
                    "field": field,
                    "run": run,
                    "valid_time": meta.get("valid_time"),
                    "path": str(binary.relative_to(staging)),
                    "sidecar": str(sidecar.relative_to(staging)),
                    "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "bytes": expected_bytes,
                    "units": meta.get("units"),
                    "grid": {key: meta.get(key) for key in ("lat0", "lon0", "dlat", "dlon", "ny", "nx")},
                })
        if {entry["field"] for entry in fields if entry["run"] == run} < set(CORE_FIELDS):
            fail(f"selected run is missing a required core grid field: {run}")
    if not fields:
        fail("selected runs contain no public grid fields")
    places, marine = [], []
    for family, bucket in (("ecmwf_ifs", places), ("marine", marine)):
        pointer = read_json(staging / "products/points" / family / "current.json")
        run = pointer["latest"]
        directory = staging / "products/points" / family / "runs" / run
        if not directory.is_dir():
            fail(f"missing point run: {family}")
        for path in sorted(directory.glob("*.json")):
            point = public_point(path, family)
            bucket.append({"id": point["id"], "name": SURFACE_POINTS[point["id"]]["place"], "timezone": point["timezone"],
                           "family": family, "run": run, "path": str(path.relative_to(staging)),
                           "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    if {item["id"] for item in places} < set(REQUIRED_SURFACE) or not any(item["id"] == "cottesloe" for item in marine):
        fail("snapshot is missing Perth or Sydney")
    return {
        "schemaVersion": SCHEMA,
        "generatedAt": generated_at,
        "latestRun": runs[-1],
        "runTime": run_datetime(runs[-1]).isoformat().replace("+00:00", "Z"),
        "runs": runs,
        "grid": {"family": "ecmwf_ifs025", "fields": fields},
        "points": {"places": places, "marine": marine},
        "attribution": ["ecmwf-cc-by-4.0", "open-meteo-cc-by-4.0"],
    }


def publish_archive(staging: Path, output: Path) -> None:
    """Write the snapshot beside output, fsync it, then publish with os.replace."""
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as raw:
            with tarfile.open(fileobj=raw, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(staging.rglob("*")):
                    if not path.is_file():
                        continue
                    data = path.read_bytes()
                    info = tarfile.TarInfo(path.relative_to(staging).as_posix())
                    info.size = len(data)
                    info.mode = 0o644
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    archive.addfile(info, io.BytesIO(data))
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(temporary, output)
    except BaseException:
        if temporary.exists():
            temporary.unlink()
        raise


def export_snapshot(source: Path, output: Path, max_age_hours: float | None = None) -> None:
    source = source.expanduser().resolve()
    if not source.is_dir():
        fail(f"source archive is not a directory: {source}")
    if output.exists():
        fail(f"output already exists: {output}")
    runs = select_runs(source)
    check_fresh(runs[-1], max_age_hours)
    with tempfile.TemporaryDirectory(prefix="isobar-public-") as temp:
        staging = Path(temp)
        grid_root = staging / GRID_FAMILY
        grid_root.mkdir(parents=True)
        (grid_root / "current.json").write_text(json.dumps({"latest": runs[-1], "runs": runs}, indent=2) + "\n")
        for run in runs:
            source_run = source / GRID_FAMILY / "runs" / run
            for field in GRID_FIELDS:
                source_field = source_run / field
                if not source_field.is_dir():
                    continue
                for binary in source_field.glob("*.f16"):
                    relative = str((Path(GRID_FAMILY) / "runs" / run / field / binary.name))
                    copy_file(binary, staging, relative)
                    sidecar_rel = str(Path(relative).with_suffix(".json"))
                    write_json(staging, sidecar_rel, public_grid_sidecar(binary.with_suffix(".json"), field, run))
        for family in POINT_FAMILIES:
            kind = family.removeprefix("products/points/")
            source_family = source / family
            pointer = read_json(source_family / "current.json")
            run = pointer.get("latest")
            if not isinstance(run, str) or not safe_component(run):
                fail(f"invalid point pointer: {family}")
            for point_id, spec in SURFACE_POINTS.items():
                if kind == "marine" and not spec["marine"]:
                    continue
                point = source_family / "runs" / run / f"{point_id}.json"
                required = point_id in REQUIRED_SURFACE if kind == "ecmwf_ifs" else point_id == "cottesloe"
                if not point.is_file():
                    if required:
                        fail(f"missing public point: {point}")
                    continue
                write_json(staging, f"{family}/runs/{run}/{point_id}.json", public_point(point, kind))
            write_json(staging, f"{family}/current.json", {"latest": run, "runs": [run]})
        write_json(staging, "attribution.json", public_attribution(source / "attribution.json"))
        manifest = build_manifest(staging, runs, datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"))
        write_json(staging, "manifest.json", manifest)
        validate_tree(staging, max_age_hours=max_age_hours)
        publish_archive(staging, output)


def validate_tree(root: Path, max_age_hours: float | None = None) -> dict:
    manifest = read_json(root / "manifest.json")
    if manifest.get("schemaVersion") != SCHEMA or not isinstance(manifest.get("grid"), dict):
        fail("unsupported public snapshot manifest")
    if not isinstance(manifest.get("runs"), list) or len(manifest["runs"]) != 2 or not all(isinstance(run, str) and re.fullmatch(r"\d{8}T(?:00|12)Z", run) for run in manifest["runs"]):
        fail("snapshot must contain two valid grid runs")
    if manifest["runs"][0] >= manifest["runs"][1]:
        fail("grid runs must be ordered and distinct")
    timestamp(manifest.get("generatedAt"))
    if manifest.get("latestRun") != manifest["runs"][-1] or manifest.get("runTime") != run_datetime(manifest["latestRun"]).isoformat().replace("+00:00", "Z"):
        fail("snapshot model run timestamp is inconsistent")
    check_fresh(manifest["latestRun"], max_age_hours)
    allowed_exact = {"manifest.json", "attribution.json", "products/grids/ecmwf_ifs025/current.json",
                     "products/points/ecmwf_ifs/current.json", "products/points/marine/current.json"}
    members = list(root.rglob("*"))
    total = 0
    for path in members:
        if path.is_dir():
            continue
        rel = path.relative_to(root).as_posix()
        if path.is_symlink() or not path.is_file():
            fail(f"non-regular public file: {rel}")
        size = path.stat().st_size
        total += size
        if size > MAX_FILE_BYTES:
            fail(f"public file exceeds limit: {rel}")
    if len([path for path in members if path.is_file()]) > MAX_MEMBERS or total > MAX_TOTAL_BYTES:
        fail("public snapshot exceeds size limits")
    attribution = read_json(root / "attribution.json")
    if attribution != ATTRIBUTION:
        fail("public attribution is incomplete")
    grid_pointer = read_json(root / "products/grids/ecmwf_ifs025/current.json")
    if grid_pointer != {"latest": manifest["latestRun"], "runs": manifest["runs"]}:
        fail("grid pointer mismatch")
    entries = manifest["grid"].get("fields")
    if not isinstance(entries, list) or not entries:
        fail("grid manifest has no fields")
    expected = set(allowed_exact)
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or not safe_rel(entry.get("path", "")) or not safe_rel(entry.get("sidecar", "")):
            fail("invalid grid manifest path")
        if entry["path"] in seen or entry["sidecar"] in seen:
            fail("duplicate grid manifest path")
        seen.update((entry["path"], entry["sidecar"]))
        binary = root / entry["path"]
        sidecar = root / entry["sidecar"]
        if not binary.is_file() or not sidecar.is_file():
            fail("grid manifest references a missing file")
        expected.update((entry["path"], entry["sidecar"]))
        if entry.get("bytes") != 301 * 201 * 2 or binary.stat().st_size != entry["bytes"]:
            fail("grid manifest has invalid byte length")
        if hashlib.sha256(binary.read_bytes()).hexdigest() != entry.get("sha256"):
            fail("grid binary hash mismatch")
        run = entry.get("run")
        field = entry.get("field")
        if not isinstance(run, str) or not isinstance(field, str) or run not in manifest["runs"] or field not in GRID_FIELDS:
            fail("grid manifest has invalid field")
        meta = public_grid_sidecar(sidecar, field, run)
        canonical = f"{GRID_FAMILY}/runs/{run}/{field}/{timestamp(meta['valid_time']).strftime('%Y%m%dT%HZ')}"
        if entry["path"] != canonical + ".f16" or entry["sidecar"] != canonical + ".json" or read_json(sidecar) != meta:
            fail("grid manifest path or metadata is not canonical")
        if entry.get("grid") != {key: meta[key] for key in ("lat0", "lon0", "dlat", "dlon", "ny", "nx")}:
            fail("grid manifest geometry mismatch")
    for run in manifest["runs"]:
        for field in CORE_FIELDS:
            steps = {(timestamp(entry["valid_time"]) - run_datetime(run)).total_seconds() / 3600 for entry in entries if entry["run"] == run and entry["field"] == field}
            if steps != set(range(0, 97, 3)):
                fail(f"snapshot is missing required core forecast hours for {run}/{field}")
    points_section = manifest.get("points")
    places = points_section.get("places") if isinstance(points_section, dict) else None
    marine = points_section.get("marine") if isinstance(points_section, dict) else None
    if not isinstance(places, list) or not isinstance(marine, list) or not places or not marine:
        fail("point manifest is incomplete")
    if {item.get("id") for item in places if isinstance(item, dict)} < set(REQUIRED_SURFACE) or not any(isinstance(item, dict) and item.get("id") == "cottesloe" for item in marine):
        fail("snapshot is missing Perth or Sydney")
    seen_ids = set()
    for item in places + marine:
        if not isinstance(item, dict) or item.get("family") not in {"ecmwf_ifs", "marine"} or item.get("id") not in SURFACE_POINTS:
            fail("point manifest is incomplete")
        if item["family"] == "marine" and not SURFACE_POINTS[item["id"]]["marine"]:
            fail("invalid point manifest path")
        if (item["family"], item["id"]) in seen_ids:
            fail("invalid point manifest path")
        seen_ids.add((item["family"], item["id"]))
        path = item.get("path", "")
        if not safe_component(item.get("run")) or path != f"products/points/{item['family']}/runs/{item['run']}/{item['id']}.json" or not safe_rel(path) or path in expected or not (root / path).is_file():
            fail("invalid point manifest path")
        expected.add(path)
        point = public_point(root / path, item["family"])
        if read_json(root / path) != point or item.get("name") != SURFACE_POINTS[item["id"]]["place"] or item.get("timezone") != point.get("timezone"):
            fail("point contains non-canonical metadata")
        if hashlib.sha256((root / path).read_bytes()).hexdigest() != item.get("sha256"):
            fail("point hash mismatch")
        pointer = read_json(root / "products/points" / item["family"] / "current.json")
        if pointer != {"latest": item["run"], "runs": [item["run"]]}:
            fail("point pointer mismatch")
        required = ("temperature_2m", "precipitation", "wind_speed_10m") if item["family"] == "ecmwf_ifs" else ("wave_height", "wave_direction", "wave_period")
        times = point.get("time", [])
        hourly = point.get("hourly", {})
        if len(times) < 24 or any(not isinstance(hourly.get(key), list) or len(hourly[key]) < 24 for key in required):
            fail(f"{item['family']} point has fewer than 24 forecast hours")
        if max_age_hours is not None:
            now = datetime.now(timezone.utc)
            for key in required:
                if sum(0 <= (timestamp(time) - now).total_seconds() <= 48 * 3600 and values is not None for time, values in zip(times, hourly[key])) < 24:
                    fail(f"{item['family']} lacks 24 future hours of {key}")
    for exact in allowed_exact:
        if not (root / exact).is_file():
            fail(f"missing required public file: {exact}")
    actual = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    if actual != expected:
        fail(f"public snapshot file set mismatch: {sorted(actual ^ expected)[:3]}")
    if manifest != build_manifest(root, manifest["runs"], manifest["generatedAt"]):
        fail("manifest contains inconsistent or non-canonical metadata")
    return manifest


def import_snapshot(bundle: Path, destination: Path, max_age_hours: float | None = None) -> None:
    bundle = bundle.expanduser().resolve()
    if not bundle.is_file():
        fail(f"bundle does not exist: {bundle}")
    if destination.exists() and any(destination.iterdir()):
        fail(f"destination must be absent or empty: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="isobar-import-", dir=str(destination.parent)) as temp:
        staging = Path(temp)
        with tarfile.open(bundle, "r|gz") as archive:
            total, names = 0, set()
            for member in archive:
                if len(names) >= MAX_MEMBERS or member.name in names:
                    fail("bundle contains too many or duplicate members")
                names.add(member.name)
                if not safe_rel(member.name) or member.name.startswith("./"):
                    fail(f"unsafe bundle path: {member.name}")
                if not member.isfile():
                    fail(f"bundle contains non-regular entry: {member.name}")
                if member.size < 0 or member.size > MAX_FILE_BYTES:
                    fail(f"bundle member exceeds limit: {member.name}")
                total += member.size
                if total > MAX_TOTAL_BYTES:
                    fail("bundle exceeds total size limit")
                target = staging / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
        validate_tree(staging, max_age_hours=max_age_hours)
        # Replace an empty destination in one step. Removing it first would drop
        # the only copy of the staged tree if the rename then failed.
        os.replace(staging, destination)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export or import a sanitized Isobar public weather snapshot")
    sub = parser.add_subparsers(dest="command", required=True)
    exp = sub.add_parser("export")
    exp.add_argument("source")
    exp.add_argument("output")
    exp.add_argument("--max-age-hours", type=float, default=None)
    imp = sub.add_parser("import")
    imp.add_argument("bundle")
    imp.add_argument("destination")
    imp.add_argument("--max-age-hours", type=float, default=None)
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            export_snapshot(Path(args.source), Path(args.output), args.max_age_hours)
        else:
            import_snapshot(Path(args.bundle), Path(args.destination), args.max_age_hours)
    except (OSError, tarfile.TarError, ValueError) as exc:
        print(f"public-weather: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
