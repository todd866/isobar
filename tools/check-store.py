#!/usr/bin/env python3
"""Read-only preflight for the archive layout consumed by the Isobar app.

This deliberately checks the app's legacy files as well as the newer daemon
products.  A complete daemon archive is useful evidence, but it is not app
consumable until the legacy pointers and per-location files exist.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

MAX_AGE_HOURS = 18
DEFAULT_PLACES = (
    ("Perth coast", "94614", "qd63czw", -31.994, 115.75),
    ("Sydney", "94768", "r3gx2sp", -33.86, 151.21),
)
REQUIRED_VARIABLES = ("msl", "t850", "t2m", "rain24", "u10", "v10")
NATIVE_VARIABLES = ("mslp", "t850", "t2m", "u10", "v10", "tp")
NATIVE_LEADS = tuple(range(0, 97, 3))
NATIVE_GRID = {"lat0": 0.0, "lon0": 95.0, "dlat": -0.25, "dlon": 0.25, "fill": -32768, "native_step_hours": 3}
NATIVE_UNITS = {"mslp": "hPa", "t850": "degC", "t2m": "degC", "u10": "m/s", "v10": "m/s", "tp": "mm"}
NATIVE_PARAMS = {"mslp": "msl", "t850": "t", "t2m": "2t", "u10": "10u", "v10": "10v", "tp": "tp"}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def observation_time(value: Any) -> datetime | None:
    parsed = iso(value)
    if parsed is not None:
        return parsed
    if isinstance(value, str):
        try:
            return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def check_file(path: Path, label: str, errors: list[str]) -> bool:
    try:
        if not path.is_file() or not path.stat().st_size:
            raise OSError("missing or empty")
        with path.open("rb") as handle:
            handle.read(1)
    except OSError as exc:
        errors.append(f"{label}: {path} ({exc})")
        return False
    return True


def safe_component(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and not value.startswith(('/', '~')) and \
        ".." not in value and "/" not in value and "\\" not in value


def published_directory(store: Path, family: str, errors: list[str]) -> Path | None:
    """Resolve a published family, with legacy fallback only without a pointer."""
    base = store / "products" / family
    pointer_path = base / "current.json"
    if not pointer_path.is_file():
        return base if base.is_dir() else None
    try:
        pointer = read_json(pointer_path)
        latest = pointer.get("latest") if isinstance(pointer, dict) else None
        if not safe_component(latest):
            raise ValueError("invalid latest run")
        run = base / "runs" / latest
        if not run.is_dir():
            raise ValueError(f"missing run {latest}")
        return run
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"published {family} pointer: {pointer_path} ({exc})")
        return None


def check_chart(store: Path, errors: list[str], warnings: list[str]) -> dict[str, Any]:
    chart_base = store / "products/charts"
    chart_dir = published_directory(store, "charts", errors)
    chart_pointer = chart_base / "current.json"
    chart = chart_dir / "IDG00073.pdf" if chart_dir else chart_base / "IDG00073.pdf"
    if chart_dir is None and chart_pointer.is_file():
        chart = chart_base / "__invalid_published_snapshot__.pdf"
    ok = check_file(chart, "prognosis chart", errors)
    if ok:
        try:
            with chart.open("rb") as handle:
                if handle.read(5) != b"%PDF-":
                    errors.append(f"prognosis chart: {chart} is not a PDF")
                    ok = False
        except OSError as exc:
            errors.append(f"prognosis chart: {chart} ({exc})")
            ok = False
    warning_dir = published_directory(store, "warnings", errors)
    warning_files = sorted(warning_dir.glob("*.xml")) if warning_dir and warning_dir.is_dir() else []
    for path in warning_files:
        try:
            ET.parse(path)
        except (OSError, ET.ParseError) as exc:
            errors.append(f"warning XML: {path} ({exc})")
    if not warning_files:
        warnings.append("no warning XML is archived (the app can show an empty warning set)")
    return {"prognosis_pdf": ok, "warning_xml": len(warning_files)}


def check_manifest(store: Path, errors: list[str], warnings: list[str], now: datetime) -> dict[str, Any]:
    native_pointer = store / "products/grids/ecmwf_ifs025/current.json"
    if native_pointer.is_file():
        return check_native_grid(store, errors, warnings, now)
    latest_path = store / "ecmwf/latest.json"
    result: dict[str, Any] = {"legacy_pointer": None, "daemon_pointer": None, "consumable": False}
    try:
        latest = read_json(latest_path)
        if not isinstance(latest, dict):
            raise ValueError("pointer is not an object")
        old_path = latest.get("path") or latest.get("run")
        if not isinstance(old_path, str) or not old_path or "/" in old_path or "\\" in old_path or ".." in old_path or Path(old_path).is_absolute():
            raise ValueError("invalid path")
        result["legacy_pointer"] = {"run": latest.get("run"), "path": old_path}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"legacy ECMWF pointer: {latest_path} ({exc})")

    if result["legacy_pointer"]:
        run_dir = store / "ecmwf" / str(result["legacy_pointer"]["path"])
        manifest_path = run_dir / "manifest.json"
        try:
            manifest = read_json(manifest_path)
            if not isinstance(manifest, dict):
                raise ValueError("manifest is not an object")
            if manifest.get("schema", 1) != 1:
                raise ValueError("schema is not 1")
            grid, times = manifest.get("grid"), manifest.get("times")
            if not isinstance(grid, dict) or not isinstance(times, list) or not times:
                raise ValueError("missing grid or valid times")
            if grid.get("dtype", "float32") != "float32" or grid.get("endian", "little") != "little":
                raise ValueError("grid is not little-endian float32")
            nx, ny, step = grid.get("nx"), grid.get("ny"), grid.get("step")
            if not isinstance(nx, int) or not isinstance(ny, int) or nx < 2 or ny < 2 or not isinstance(step, (int, float)) or step <= 0:
                raise ValueError("grid dimensions or step are unusable")
            if any(not isinstance(grid.get(name), (int, float)) for name in ("west", "east", "north", "south")):
                raise ValueError("grid is missing numeric west/east/north/south bounds")
            order = grid.get("order", "")
            if order and "north-to-south" not in order:
                raise ValueError("grid order is not north-to-south")
            if any(iso(item) is None for item in times) or iso(manifest.get("run")) is None:
                raise ValueError("manifest contains an invalid run or time")
            run = iso(manifest["run"])
            result["loaded_run"] = run.strftime("%Y%m%dT%HZ")
            age = (now - run).total_seconds() / 3600
            if age > MAX_AGE_HOURS:
                errors.append(f"legacy ECMWF run is stale: {age:.1f}h old (limit {MAX_AGE_HOURS}h)")
            if age < -1:
                warnings.append(f"legacy ECMWF run is {abs(age):.1f}h in the future")
            variables = manifest.get("variables") or {}
            expected_bytes = len(times) * nx * ny * 4
            files: dict[str, str] = {}
            for variable in REQUIRED_VARIABLES:
                present = isinstance(variables, dict) and variable in variables
                entry = variables.get(variable) if present else None
                if present and not isinstance(entry, dict):
                    errors.append(f"legacy ECMWF {variable}: manifest entry is not an object")
                    continue
                name = entry.get("file") if isinstance(entry, dict) else None
                if present and (not isinstance(name, str) or not name or "/" in name or "\\" in name or ".." in name or Path(name).is_absolute()):
                    errors.append(f"legacy ECMWF {variable}: manifest file path is unsafe: {name!r}")
                    continue
                name = name or f"{variable}.f32"
                path = run_dir / name
                if not check_file(path, f"legacy ECMWF {variable}", errors):
                    continue
                if path.stat().st_size != expected_bytes:
                    errors.append(f"legacy ECMWF {variable}: {path} has {path.stat().st_size} bytes, expected {expected_bytes}")
                files[variable] = name
            result["manifest"] = {"run": manifest.get("run"), "times": len(times), "nx": nx, "ny": ny, "age_hours": round(age, 2), "files": files}
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            errors.append(f"legacy ECMWF manifest: {manifest_path} ({exc})")

    daemon_path = store / "products/grids/ecmwf_ifs025/current.json"
    try:
        daemon = read_json(daemon_path)
        if not isinstance(daemon, dict):
            raise ValueError("pointer is not an object")
        daemon_run = daemon.get("latest") or daemon.get("run") or daemon.get("path")
        result["daemon_pointer"] = {"latest": daemon_run, "path": str(daemon_path.relative_to(store))}
        old_run = result.get("loaded_run")
        if daemon_run and old_run and str(daemon_run) != str(old_run):
            errors.append(f"ECMWF pointer mismatch: daemon grid latest {daemon_run!r} != app loaded run {old_run!r}")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        warnings.append(f"daemon grid pointer unavailable: {daemon_path} ({exc})")
    return result


def check_native_grid(store: Path, errors: list[str], warnings: list[str], now: datetime) -> dict[str, Any]:
    pointer_path = store / "products/grids/ecmwf_ifs025/current.json"
    result: dict[str, Any] = {"mode": "native", "native_pointer": None, "consumable": False}
    try:
        pointer = read_json(pointer_path)
        latest = pointer.get("latest") if isinstance(pointer, dict) else None
        runs = pointer.get("runs") if isinstance(pointer, dict) else None
        if not isinstance(latest, str) or not latest or not isinstance(runs, list) or latest not in runs:
            raise ValueError("pointer must name latest and include it in runs")
        if "/" in latest or "\\" in latest or ".." in latest or Path(latest).is_absolute():
            raise ValueError("unsafe latest run")
        result["native_pointer"] = {"latest": latest, "runs": len(runs), "path": str(pointer_path.relative_to(store))}
        run_dir = store / "products/grids/ecmwf_ifs025/runs" / latest
        run = datetime.strptime(latest, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
        result["loaded_run"] = latest
        age = (now - run).total_seconds() / 3600
        if age > MAX_AGE_HOURS:
            errors.append(f"native ECMWF run is stale: {age:.1f}h old (limit {MAX_AGE_HOURS}h)")
        if age < -1:
            warnings.append(f"native ECMWF run is {abs(age):.1f}h in the future")
        fields: dict[str, Any] = {}
        shape: tuple[int, int] | None = None
        for variable in NATIVE_VARIABLES:
            entries = []
            for lead in NATIVE_LEADS:
                valid_id = (run + timedelta(hours=lead)).strftime("%Y%m%dT%HZ")
                sidecar_path = run_dir / variable / f"{valid_id}.json"
                data_path = run_dir / variable / f"{valid_id}.f16"
                try:
                    meta = read_json(sidecar_path)
                    if not isinstance(meta, dict):
                        raise ValueError("sidecar is not an object")
                    if meta.get("dtype") != "float16" or meta.get("endian") != "little":
                        raise ValueError("not little-endian float16")
                    if meta.get("order") != "north-to-south, west-to-east":
                        raise ValueError("grid order is not canonical")
                    for key, expected in NATIVE_GRID.items():
                        if meta.get(key) != expected:
                            raise ValueError(f"{key} is {meta.get(key)!r}, expected {expected!r}")
                    if meta.get("units") != NATIVE_UNITS[variable] or meta.get("param") != NATIVE_PARAMS[variable]:
                        raise ValueError("field units or param do not match the native contract")
                    if not isinstance(meta.get("nx"), int) or not isinstance(meta.get("ny"), int) or meta["nx"] < 2 or meta["ny"] < 2:
                        raise ValueError("invalid dimensions")
                    current_shape = (meta["nx"], meta["ny"])
                    if shape is None:
                        shape = current_shape
                    elif current_shape != shape:
                        raise ValueError(f"dimensions {current_shape} do not match {shape}")
                    if not isinstance(meta.get("units"), str) or not meta["units"]:
                        raise ValueError("missing units")
                    expected_time = (run + timedelta(hours=lead)).strftime("%Y-%m-%dT%H:%M:%SZ")
                    if meta.get("run") != run.strftime("%Y-%m-%dT%H:%M:%SZ") or meta.get("valid_time") != expected_time:
                        raise ValueError("invalid run or valid time")
                    expected = meta["nx"] * meta["ny"] * 2
                    if not data_path.is_file() or data_path.stat().st_size != expected:
                        raise ValueError(f"binary size {data_path.stat().st_size if data_path.exists() else 0}, expected {expected}")
                    entries.append(valid_id)
                except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                    errors.append(f"native ECMWF {variable} {valid_id}: {exc}")
            fields[variable] = len(entries)
            if len(entries) != len(NATIVE_LEADS):
                errors.append(f"native ECMWF {variable}: {len(entries)}/{len(NATIVE_LEADS)} valid steps")
        result["fields"] = fields
        result["run"] = latest
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        errors.append(f"native ECMWF pointer: {pointer_path} ({exc})")
    return result


def check_locations(store: Path, errors: list[str], now: datetime) -> dict[str, Any]:
    native_pointer = store / "products/grids/ecmwf_ifs025/current.json"
    if native_pointer.is_file() or (store / "products/points/ecmwf_ifs/current.json").is_file():
        return check_native_locations(store, errors, now)
    observations: dict[str, bool] = {}
    points: dict[str, bool] = {}
    for place, wmo, geohash, _lat, _lon in DEFAULT_PLACES:
        obs_path = store / "products/obs" / f"{wmo}.json"
        try:
            root = read_json(obs_path)
            observations_root = root.get("observations") if isinstance(root, dict) else None
            rows = observations_root.get("data") if isinstance(observations_root, dict) else None
            first = rows[0] if isinstance(rows, list) and rows else None
            observations[place] = bool(isinstance(first, dict) and isinstance(first.get("local_date_time_full"), str) and len(first["local_date_time_full"]) >= 12)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            observations[place] = False
        if not observations[place]:
            errors.append(f"configured observation {place} ({wmo}) is missing or not app-readable: {obs_path}")
        point_path = store / "products/points" / f"{geohash}.json"
        try:
            root = read_json(point_path)
            rows = root.get("hourly") if isinstance(root, dict) else None
            points[place] = bool(rows and isinstance(rows, list) and all(isinstance(row, dict) and iso(row.get("time")) for row in rows))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            points[place] = False
        if not points[place]:
            errors.append(f"configured point forecast {place} ({geohash}) is missing or not app-readable: {point_path}")
    return {"observations": observations, "point_forecasts": points}


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlambda = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def open_observation_db(path: Path) -> sqlite3.Connection:
    """Read records safely even when macOS needs to recreate idle WAL sidecars."""
    connection = None
    uri = path.resolve().as_uri()
    try:
        connection = sqlite3.connect(uri + "?mode=ro", uri=True, timeout=0.75)
        connection.execute("PRAGMA schema_version").fetchone()
        return connection
    except sqlite3.Error as exc:
        if connection is not None:
            connection.close()
        code = getattr(exc, "sqlite_errorcode", 0) & 0xff
        if code not in {sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_READONLY}:
            raise
    connection = None
    try:
        # mode=rw never creates a missing database. Only auxiliary WAL files
        # may be created; query_only and NO_CKPT_ON_CLOSE protect the data.
        connection = sqlite3.connect(uri + "?mode=rw", uri=True, timeout=0.75)
        setconfig = getattr(connection, "setconfig", None)
        no_checkpoint = getattr(sqlite3, "SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE", None)
        if setconfig is None or no_checkpoint is None:
            raise sqlite3.OperationalError("Idle WAL checks require Python 3.12+ with SQLite no-checkpoint support")
        setconfig(no_checkpoint, True)
        connection.execute("PRAGMA query_only = ON")
        if not connection.getconfig(no_checkpoint) or connection.execute("PRAGMA query_only").fetchone()[0] != 1:
            raise sqlite3.OperationalError("SQLite read-only guards could not be enabled")
        return connection
    except Exception:
        if connection is not None:
            connection.close()
        raise


def check_native_locations(store: Path, errors: list[str], now: datetime) -> dict[str, Any]:
    observations: dict[str, bool] = {}
    points: dict[str, bool] = {}
    db_path = store / "products/obs/obs.sqlite"
    connection = None
    try:
        connection = open_observation_db(db_path)
        connection.execute("BEGIN")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(obs)")}
        required = {"wmo", "aifstime_utc", "product_id", "name", "lat", "lon", "air_temp", "wind_dir", "wind_dir_deg", "wind_spd_kmh", "gust_kmh", "wind_spd_kt", "gust_kt", "press_msl", "press_tend", "rain_trace", "cloud_base_m", "vis_km"}
        if not required.issubset(columns):
            raise ValueError("obs table is missing required columns")
        for place, wmo, _geohash, _lat, _lon in DEFAULT_PLACES:
            row = connection.execute(
                "SELECT aifstime_utc, lat, lon, air_temp FROM obs WHERE wmo = ? ORDER BY aifstime_utc DESC LIMIT 1",
                (int(wmo),),
            ).fetchone()
            observed = observation_time(row[0]) if row else None
            try:
                numeric = row and all(math.isfinite(float(value)) for value in row[1:])
            except (TypeError, ValueError):
                numeric = False
            observations[place] = bool(row and observed and abs((now - observed).total_seconds()) <= 48 * 3600 and numeric)
            if not observations[place]:
                errors.append(f"configured observation {place} ({wmo}) is missing or invalid in {db_path}")
    except (OSError, sqlite3.Error, ValueError) as exc:
        errors.append(f"observation SQLite: {db_path} ({exc})")
        observations = {place: False for place, *_ in DEFAULT_PLACES}
    finally:
        if connection is not None:
            connection.close()
    points_family = store / "products/points/ecmwf_ifs"
    points_pointer = points_family / "current.json"
    candidates: list[Path] = []
    try:
        pointer = read_json(points_pointer)
        latest = pointer.get("latest") if isinstance(pointer, dict) else None
        runs = pointer.get("runs") if isinstance(pointer, dict) else None
        if not isinstance(latest, str) or not isinstance(runs, list) or latest not in runs or "/" in latest or "\\" in latest or ".." in latest:
            raise ValueError("pointer must name a safe latest run")
        run_dir = points_family / "runs" / latest
        candidates = list(run_dir.glob("*.json"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        errors.append(f"ECMWF surface point pointer: {points_pointer} ({exc})")
    for place, _wmo, _geohash, lat, lon in DEFAULT_PLACES:
        nearest = None
        for path in candidates:
            try:
                root = read_json(path)
                distance = _distance_km(lat, lon, float(root["latitude"]), float(root["longitude"]))
                if distance <= 30 and (nearest is None or distance < nearest[0]):
                    times = root.get("time")
                    hourly = root.get("hourly")
                    units = root.get("units")
                    expected_units = {"temperature_2m": "°C", "wind_speed_10m": "kn", "wind_direction_10m": "°"}
                    valid = isinstance(times, list) and times and all(isinstance(value, str) and iso(value) for value in times)
                    valid = valid and isinstance(units, dict) and all(units.get(key) == value for key, value in expected_units.items())
                    if not isinstance(hourly, dict):
                        valid = False
                    else:
                        valid = valid and all(
                            isinstance(hourly.get(key), list)
                            and len(hourly[key]) == len(times)
                            and all(isinstance(value, (int, float)) and math.isfinite(value) for value in hourly[key])
                            for key in expected_units
                        )
                    nearest = (distance, path.name, bool(valid))
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                continue
        points[place] = nearest is not None and nearest[2]
        if not points[place]:
            errors.append(f"no valid ECMWF surface point within 30km of {place}")
    return {"observations": observations, "point_forecasts": points, "source": "obs.sqlite + ecmwf_ifs surface points"}


def check_source_health(store: Path, errors: list[str]) -> dict[str, Any]:
    """Require the status source the app can associate with the ECMWF grid."""
    path = store / "status.json"
    try:
        root = read_json(path)
        sources = root.get("sources") if isinstance(root, dict) else None
        if not isinstance(sources, list):
            raise ValueError("sources is not an array")
        by_id = {item.get("id"): item for item in sources if isinstance(item, dict) and isinstance(item.get("id"), str)}
        source = by_id.get("ecmwf-open-data") or by_id.get("ecmwf-ifs")
        if source is None:
            raise ValueError("no ecmwf-open-data or ecmwf-ifs source")
        if source.get("ok") is not True:
            raise ValueError(f"{source.get('id')} is not healthy")
        return {"id": source["id"], "ok": True}
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        errors.append(f"ECMWF source health: {path} ({exc})")
        return {"id": None, "ok": False}


def check_kite(store: Path, errors: list[str], warnings: list[str]) -> dict[str, Any]:
    native_family = store / "products/kite"
    native_pointer = native_family / "current.json"
    if native_pointer.is_file():
        try:
            pointer = read_json(native_pointer)
            latest = pointer.get("latest") if isinstance(pointer, dict) else None
            runs = pointer.get("runs") if isinstance(pointer, dict) else None
            if not isinstance(latest, str) or not isinstance(runs, list) or latest not in runs or "/" in latest or "\\" in latest or ".." in latest:
                raise ValueError("pointer must name a safe latest run")
            run_dir = native_family / "runs" / latest
            files = sorted(run_dir.glob("*.json"))
            if not files:
                raise ValueError("latest run has no spot files")
            valid = 0
            for path in files:
                root = read_json(path)
                if isinstance(root, dict) and isinstance(root.get("hours"), list) and root.get("id"):
                    valid += 1
            if valid != len(files):
                raise ValueError(f"{len(files) - valid} spot files are malformed")
            return {"present": True, "native": True, "spots": valid, "latest": latest}
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            errors.append(f"native kite product: {native_pointer} ({exc})")
            return {"present": True, "native": True, "spots": 0}
    path = store / "products/kite.json"
    if not path.exists():
        warnings.append("kite product is absent (allowed when kite is not configured)")
        return {"present": False, "spots": 0}
    try:
        root = read_json(path)
        spots = root.get("spots") if isinstance(root, dict) else None
        if not isinstance(spots, list):
            raise ValueError("spots is not an array")
        return {"present": True, "spots": len(spots)}
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        errors.append(f"kite product: {path} ({exc})")
        return {"present": True, "spots": 0}


def preflight(store: Path, now: datetime) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    ecmwf = check_manifest(store, errors, warnings, now)
    source_health = check_source_health(store, errors)
    ecmwf["consumable"] = not errors
    locations = check_locations(store, errors, now)
    charts = check_chart(store, errors, warnings)
    kite = check_kite(store, errors, warnings)
    daemon_archive = (store / "products/grids/ecmwf_ifs025/current.json").is_file()
    if daemon_archive and not ecmwf["consumable"]:
        warnings.append("daemon grid archive is present, but it is not consumed by this app")
    return {
        "ok": not errors,
        "store": str(store),
        "checked_at": now.isoformat().replace("+00:00", "Z"),
        "app_consumable": ecmwf["consumable"] and not errors,
        "archive_present": daemon_archive,
        "ecmwf": ecmwf,
        "source_health": source_health,
        "locations": locations,
        "charts": charts,
        "kite": kite,
        "warnings": warnings,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check whether an Isobar store is consumable by the native app.")
    parser.add_argument("--store", type=Path, default=Path.home() / "Data/isobar")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable JSON")
    parser.add_argument("--now", help="UTC instant (ISO-8601), useful for deterministic checks")
    args = parser.parse_args(argv)
    now = iso(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        parser.error("--now must be an ISO-8601 timestamp")
    report = preflight(args.store.expanduser(), now)
    if args.as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print("READY" if report["ok"] else "NOT READY")
        print(f"store: {report['store']}")
        print(f"app consumable: {'yes' if report['app_consumable'] else 'no'}")
        print(f"daemon archive present: {'yes' if report['archive_present'] else 'no'}")
        for message in report["warnings"]:
            print(f"warning: {message}")
        for message in report["errors"]:
            print(f"error: {message}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
