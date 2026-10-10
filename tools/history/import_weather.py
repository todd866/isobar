#!/usr/bin/env python3
"""Import the bounded D-Day ERA5 weather slice from Open-Meteo.

The importer deliberately keeps acquisition separate from normalization so a
saved API response can be checked offline.  The output is a small, explicit
product for the viewer; it is not a claim of beach-scale observational truth.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
import hashlib
from pathlib import Path
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://archive-api.open-meteo.com/v1/archive"
MODEL = "era5"
START_DATE = "1944-06-03"
END_DATE = "1944-06-07"
LATITUDES = tuple(float(value) for value in range(54, 47, -1))
LONGITUDES = tuple(float(value) for value in range(-8, 5))
POINTS = tuple((lat, lon) for lat in LATITUDES for lon in LONGITUDES)
VARIABLES = ("pressure_msl", "wind_speed_10m", "wind_direction_10m", "temperature_2m")
MAX_BATCH = 20
MAX_TIMEOUT = 60.0
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
KNOTS_TO_KNOTS = 1.0


def _finite(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _grid_points(west: float, east: float, south: float, north: float, step: float):
    columns, rows = round((east - west) / step), round((north - south) / step)
    if abs(west + columns * step - east) > 1e-7 or abs(south + rows * step - north) > 1e-7:
        raise ValueError("bounds must be an exact multiple of step")
    return tuple((round(north - row * step, 10), round(west + col * step, 10))
                 for row in range(rows + 1) for col in range(columns + 1))


def make_config(start_date=START_DATE, end_date=END_DATE, west=-8.0, east=4.0, south=48.0, north=54.0, step=1.0,
                event_id="dday", event_label="D-Day") -> dict:
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
    except (TypeError, ValueError) as exc:
        raise ValueError("dates must be YYYY-MM-DD") from exc
    if end < start or (end - start).days + 1 > 7:
        raise ValueError("date range must contain 1-7 calendar days")
    if not all(_finite(value) for value in (west, east, south, north, step)) or step <= 0 or west > east or south > north:
        raise ValueError("invalid geographic bounds or step")
    points = _grid_points(float(west), float(east), float(south), float(north), float(step))
    if len(points) > 200:
        raise ValueError("grid exceeds 200 points")
    if not isinstance(event_id, str) or not event_id or not isinstance(event_label, str) or not event_label:
        raise ValueError("event id and label are required")
    return {"start_date": start_date, "end_date": end_date, "west": float(west), "east": float(east),
            "south": float(south), "north": float(north), "step": float(step), "event_id": event_id,
            "event_label": event_label, "points": points}


def expected_times(start_date=START_DATE, end_date=END_DATE) -> list[str]:
    start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    hours = (datetime.strptime(end_date, "%Y-%m-%d") - datetime.strptime(start_date, "%Y-%m-%d")).days * 24 + 24
    return [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%MZ") for i in range(hours)]


def _canonical_time(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("hourly time must be a string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid hourly time: {value!r}") from exc
    # Open-Meteo emits offset-free ISO strings when timezone=GMT is requested;
    # that response is UTC by contract.  Offset-bearing responses still have
    # to resolve to UTC.
    if parsed.tzinfo is not None and parsed.utcoffset() != timedelta(0):
        raise ValueError("hourly times must be UTC")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def request_url(points: list[tuple[float, float]] | tuple[tuple[float, float], ...], config: dict | None = None) -> str:
    if not 1 <= len(points) <= MAX_BATCH:
        raise ValueError(f"request must contain 1-{MAX_BATCH} points")
    config = config or make_config()
    query = {
        "latitude": ",".join(_number(lat) for lat, _ in points),
        "longitude": ",".join(_number(lon) for _, lon in points),
        "start_date": config["start_date"],
        "end_date": config["end_date"],
        "hourly": ",".join(VARIABLES),
        "model": MODEL,
        "timezone": "GMT",
        "timeformat": "iso8601",
        "temperature_unit": "celsius",
        "wind_speed_unit": "kn",
        "cell_selection": "nearest",
    }
    return API_URL + "?" + urlencode(query)


def _number(value: float) -> str:
    return str(int(value)) if value == int(value) else str(value)


def _locations(payload: object) -> list[dict]:
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list) and all(isinstance(item, dict) for item in payload):
        return payload
    raise ValueError("Open-Meteo response must be an object or list of objects")


def _flatten_payload(payload: object) -> list[dict]:
    if isinstance(payload, (dict, list)):
        return _locations(payload)
    if isinstance(payload, tuple):
        output: list[dict] = []
        for part in payload:
            output.extend(_flatten_payload(part))
        return output
    raise ValueError("invalid payload collection")


def normalize_payload(payload: object, requested_points: tuple[tuple[float, float], ...] | None = None, config: dict | None = None) -> dict:
    """Validate raw API JSON and convert it into Isobar's frame-oriented schema."""
    config = config or make_config()
    requested_points = tuple(requested_points or config["points"])
    locations = _flatten_payload(payload)
    if len(locations) != len(requested_points):
        raise ValueError(f"response returned {len(locations)} locations, expected {len(requested_points)}")
    times: list[str] | None = None
    rows: list[tuple[float, float, list[float], list[float], list[float], list[float]]] = []
    requested = list(requested_points)
    for index, (body, (want_lat, want_lon)) in enumerate(zip(locations, requested)):
        lat, lon = body.get("latitude"), body.get("longitude")
        if not _finite(lat) or not _finite(lon):
            raise ValueError(f"location {index} has invalid returned coordinates")
        # Open-Meteo returns the selected ERA5 grid-cell centre, not necessarily
        # the requested coordinate.  Keep that coordinate in provenance while
        # rejecting a response that was routed to a different degree cell.
        if abs(float(lat) - want_lat) > config["step"] / 2 or abs(float(lon) - want_lon) > config["step"] / 2:
            raise ValueError(f"location {index} returned coordinates are too far from request")
        units = body.get("hourly_units")
        if not isinstance(units, dict):
            raise ValueError(f"location {index} has no hourly_units")
        expected_units = {"pressure_msl": "hPa", "wind_speed_10m": "kn", "wind_direction_10m": "°", "temperature_2m": "°C"}
        if any(units.get(key) != unit for key, unit in expected_units.items()):
            raise ValueError(f"location {index} has unexpected model units")
        hourly = body.get("hourly")
        if not isinstance(hourly, dict):
            raise ValueError(f"location {index} has no hourly data")
        if body.get("utc_offset_seconds") not in (None, 0) or body.get("timezone") not in (None, "GMT", "UTC"):
            raise ValueError(f"location {index} is not a UTC response")
        raw_times = hourly.get("time")
        if not isinstance(raw_times, list):
            raise ValueError(f"location {index} has no hourly times")
        local_times = [_canonical_time(value) for value in raw_times]
        if local_times != expected_times(config["start_date"], config["end_date"]):
            raise ValueError(f"location {index} does not contain the requested hourly range")
        if times is None:
            times = local_times
        elif local_times != times:
            raise ValueError(f"location {index} has a different time axis")
        values: list[list[float]] = []
        for key in VARIABLES:
            value = hourly.get(key)
            if not isinstance(value, list) or len(value) != len(local_times) or not all(_finite(item) for item in value):
                raise ValueError(f"location {index} has missing, nonfinite, or wrong-length {key}")
            values.append([float(item) for item in value])
        if (any(item <= 0 for item in values[0]) or any(item < 0 or item > 300 for item in values[1])
                or any(item < 0 or item > 360 for item in values[2]) or any(item < -150 or item > 100 for item in values[3])):
            raise ValueError(f"location {index} has physically invalid weather values")
        speed, direction = values[1], values[2]
        u = [-KNOTS_TO_KNOTS * speed[i] * math.sin(math.radians(direction[i])) for i in range(len(speed))]
        v = [-KNOTS_TO_KNOTS * speed[i] * math.cos(math.radians(direction[i])) for i in range(len(speed))]
        rows.append((float(lat), float(lon), values[0], u, v, values[3]))

    assert times is not None
    frames = []
    for hour, time in enumerate(times):
        frames.append({"time": time, "pressure_msl": [row[2][hour] for row in rows], "u": [row[3][hour] for row in rows],
                       "v": [row[4][hour] for row in rows], "temperature": [row[5][hour] for row in rows]})
    return {
        "schema_version": 1,
        "product": "isobar-historical-weather",
        "event": {"id": config["event_id"], "label": config["event_label"], "start_date": config["start_date"], "end_date": config["end_date"]},
        "model": "ERA5",
        "grid": {"latitudes": sorted({point[0] for point in requested_points}, reverse=True), "longitudes": sorted({point[1] for point in requested_points}),
                 "nx": len(sorted({point[1] for point in requested_points})), "ny": len(sorted({point[0] for point in requested_points})),
                 "points": [{"requested": {"latitude": lat, "longitude": lon}, "returned": {"latitude": rows[index][0], "longitude": rows[index][1]}}
                            for index, (lat, lon) in enumerate(requested_points)],
                 "order": "north-to-south, west-to-east", "step_degrees": config["step"]},
        "times": times,
        "units": {"pressure_msl": "hPa", "u": "knots", "v": "knots", "temperature": "°C"},
        "frames": frames,
        "provenance": {"provider": "Open-Meteo", "dataset": "ERA5 reanalysis", "model": MODEL, "source": API_URL,
                       "license": "CC BY 4.0; Open-Meteo attribution required", "requested": {"start_date": config["start_date"], "end_date": config["end_date"],
                       "model": MODEL, "variables": list(VARIABLES), "timezone": "GMT", "wind_speed_unit": "kn", "point_count": len(requested_points)},
                       "returned": {"point_count": len(rows), "hour_count": len(times)},
                       "requested_coordinates": [{"latitude": lat, "longitude": lon} for lat, lon in requested_points],
                       "returned_coordinates": [{"latitude": row[0], "longitude": row[1]} for row in rows],
                       "model_verification": "ERA5 was explicitly requested; the API response does not echo model identity.",
                       "request_urls": [],
                       "sampling_limitations": "ERA5 is an hourly ~25 km reanalysis; 1° display samples are interpolated/requested nearest cells and are not beach-scale observations.",
                       "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
    }


def fetch_json(url: str, timeout: float) -> object:
    request = Request(url, headers={"User-Agent": "Isobar historical importer/1.0", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=min(float(timeout), MAX_TIMEOUT)) as response:
            if response.status != 200:
                raise ValueError(f"Open-Meteo returned HTTP {response.status}")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError("Open-Meteo response exceeds 8 MiB limit")
            return json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"nonfinite JSON constant {value}")))
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Open-Meteo request failed: {exc}") from exc


def _cached_json(url: str, timeout: float, cache_dir: Path | None) -> object:
    target = None if cache_dir is None else cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if target is not None and target.is_file():
        raw = target.read_bytes()
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError(f"cached response exceeds 8 MiB limit: {target}")
        return json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"nonfinite JSON constant {value}")))
    value = fetch_json(url, timeout)
    if target is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
        os.replace(temporary, target)
    return value


def fetch_history(timeout: float = 30.0, config: dict | None = None, cache_dir: Path | None = None) -> dict:
    if not _finite(timeout) or timeout <= 0:
        raise ValueError("timeout must be positive")
    # A one-point probe establishes that this historical model/range is served
    # before spending the remaining bounded requests on the 91-point product.
    config = config or make_config()
    urls = [request_url((config["points"][0],), config)]
    probe = _cached_json(urls[0], timeout, cache_dir)
    payloads: list[object] = [probe]
    remaining = config["points"][1:]
    for start in range(0, len(remaining), MAX_BATCH):
        batch = remaining[start:start + MAX_BATCH]
        urls.append(request_url(batch, config))
        payloads.append(_cached_json(urls[-1], timeout, cache_dir))
    result = normalize_payload(tuple(payloads), config=config)
    result["provenance"]["request_urls"] = urls
    return result


def write_atomic(value: dict, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp", delete=False)
    temporary = Path(handle.name)
    try:
        with handle:
            json.dump(value, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("build/history/weather.json"))
    parser.add_argument("--fixture", type=Path, help="normalize saved raw Open-Meteo JSON instead of making requests")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--start-date", default=START_DATE)
    parser.add_argument("--end-date", default=END_DATE)
    parser.add_argument("--west", type=float, default=-8.0)
    parser.add_argument("--east", type=float, default=4.0)
    parser.add_argument("--south", type=float, default=48.0)
    parser.add_argument("--north", type=float, default=54.0)
    parser.add_argument("--step", type=float, default=1.0)
    parser.add_argument("--event-id", default="dday")
    parser.add_argument("--event-label", default="D-Day")
    parser.add_argument("--cache-dir", type=Path, default=Path("build/history/raw"))
    args = parser.parse_args()
    config = make_config(args.start_date, args.end_date, args.west, args.east, args.south, args.north, args.step, args.event_id, args.event_label)
    if args.fixture:
        with args.fixture.open(encoding="utf-8") as stream:
            value = normalize_payload(json.load(stream, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"nonfinite JSON constant {value}"))), config=config)
    else:
        value = fetch_history(args.timeout, config, args.cache_dir)
    write_atomic(value, args.output)
    print(f"wrote {args.output} ({len(value['grid']['points'])} points, {len(value['times'])} hours)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
