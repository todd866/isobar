#!/usr/bin/env python3
"""Read-only, source-backed coherence checks across Isobar deployments.

This is deliberately a first slice: it checks metadata, pointers, selected
artifact identity, and links. It never builds, executes, or modifies an app.
"""
from __future__ import annotations

import argparse
import hashlib
import html.parser
import importlib.util
import json
import os
import plistlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_BYTES = 1024 * 1024
WEB_REQUIRED = {"mslp", "rain24", "t2m", "wind"}
SCHEMA1 = list(range(0, 97, 3))
SCHEMA2 = list(range(0, 145, 3)) + [150, 156, 162, 168]
HEX40 = re.compile(r"^[0-9a-fA-F]{40}$")


def now_value(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("--now must include a timezone")
    return parsed.astimezone(timezone.utc)


def validate_url(value: str, *, web_origin: bool = False) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("URLs must use http(s), include a host, and contain no credentials")
    if web_origin and (parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("--web-url must be an origin without a path, query, or fragment")
    return value.rstrip("/")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def row(checks: list[dict[str, str]], ident: str, status: str, detail: str) -> None:
    checks.append({"id": ident, "status": status, "detail": detail})


def fetch(url: str) -> tuple[bytes, str]:
    last: Exception | None = None
    for _ in range(2):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "isobar-coherence/1"})
            with urllib.request.urlopen(request, timeout=10) as response:
                content = response.read(MAX_BYTES + 1)
                if len(content) > MAX_BYTES:
                    raise ValueError("response exceeds 1 MiB bound")
                return content, response.headers.get_content_type()
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last = exc
    raise RuntimeError(str(last or "fetch failed"))


def expected_ladder(schema: int) -> list[int]:
    return SCHEMA1 if schema == 1 else SCHEMA2


def check_ladder(value: Any, schema: int) -> str | None:
    if not isinstance(value, list) or any(type(item) is not int for item in value):
        return "forecast_hours is not an integer list"
    if value != sorted(value) or len(set(value)) != len(value):
        return "forecast_hours is not strictly increasing"
    expected = expected_ladder(schema)
    if value != expected:
        missing = [item for item in expected if item not in value]
        extra = [item for item in value if item not in expected]
        return f"forecast_hours ladder mismatch (missing={missing}, extra={extra})"
    return None


def finite_number(value: Any) -> bool:
    return type(value) in (int, float) and float(value) == float(value) and abs(float(value)) != float("inf")


def safe_relative(value: Any) -> bool:
    if not isinstance(value, str) or not value or value.startswith(("/", "~")) or "\\" in value or any(ord(char) < 32 for char in value):
        return False
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        return False
    decoded = urllib.parse.unquote(value)
    return decoded == value and all(part not in ("", ".", "..") for part in value.split("/"))


def grid_from_web(manifest: dict[str, Any]) -> tuple[float, float, float, float, int, int] | None:
    grid = manifest.get("grid")
    if not isinstance(grid, dict):
        return None
    names = ("west", "east", "north", "south", "nx", "ny")
    if any(not finite_number(grid.get(name)) for name in names[:4]) or any(type(grid.get(name)) is not int for name in names[4:]):
        return None
    return tuple(grid[name] for name in names)  # type: ignore[return-value]


def web_checks(url: str, expected_commit: str | None, now: datetime, max_age: float, checks: list[dict[str, str]], observations: dict[str, Any]) -> None:
    base = url.rstrip("/")
    try:
        raw, _ = fetch(base + "/data/manifest.json")
        manifest = json.loads(raw)
        if not isinstance(manifest, dict):
            raise ValueError("manifest is not an object")
        observations["web_manifest"] = {key: manifest.get(key) for key in ("contract", "schema", "run", "generated")}
        schema = manifest.get("schema")
        if type(schema) is not int or schema not in (1, 2):
            row(checks, "web.manifest.schema", "fail", "schema must be 1 or 2")
            return
        if manifest.get("contract") != "isobar-web":
            row(checks, "web.manifest.contract", "fail", "contract must be isobar-web")
        else:
            row(checks, "web.manifest.contract", "pass", "contract is isobar-web")
        hours = manifest.get("forecast_hours")
        ladder_error = check_ladder(SCHEMA1 if schema == 1 and hours is None else hours, schema)
        row(checks, "web.manifest.forecast_hours", "fail" if ladder_error else "pass", ladder_error or f"{len(expected_ladder(schema))} forecast leads")
        if not ladder_error:
            observations["web_hours"] = SCHEMA1 if schema == 1 and hours is None else hours
        expected_step = 3 if schema == 1 else None
        if manifest.get("uniform_step_hours") not in (None, expected_step):
            row(checks, "web.manifest.step", "fail", "uniform_step_hours conflicts with the forecast ladder")
        run = iso(manifest.get("run"))
        generated = iso(manifest.get("generated"))
        if run is None or generated is None or generated < run:
            row(checks, "web.manifest.timestamps", "fail", "run and generated must be timezone-aware timestamps")
        elif run > now or generated > now:
            row(checks, "web.manifest.timestamps", "fail", "run or generated timestamp is in the future")
        else:
            row(checks, "web.manifest.timestamps", "pass", "run and generated timestamps are UTC and nonfuture")
        if run is not None:
            age = (now - run).total_seconds() / 3600
            row(checks, "web.manifest.age", "pass" if 0 <= age <= max_age else "fail", f"web run age {age:.2f}h; limit {max_age:g}h")
        grid = grid_from_web(manifest)
        raw_grid = manifest.get("grid")
        step = raw_grid.get("step") if isinstance(raw_grid, dict) else None
        dtype = raw_grid.get("dtype") if isinstance(raw_grid, dict) else None
        expected_x = (grid[1] - grid[0]) / (grid[4] - 1) if grid and grid[4] >= 2 else None
        expected_y = (grid[2] - grid[3]) / (grid[5] - 1) if grid and grid[5] >= 2 else None
        if grid is None or not -180 <= grid[0] < grid[1] <= 360 or grid[1] - grid[0] > 360 or not -90 <= grid[3] < grid[2] <= 90 or grid[4] < 2 or grid[5] < 2 or not finite_number(step) or step <= 0 or expected_x is None or expected_y is None or abs(step - expected_x) > 1e-9 or abs(step - expected_y) > 1e-9 or dtype != "uint16":
            row(checks, "web.manifest.grid", "fail", "grid coverage or dimensions are invalid")
        else:
            row(checks, "web.manifest.grid", "pass", f"coverage west/east/north/south={grid[:4]}, {grid[4]}x{grid[5]}")
            observations["web_grid"] = grid
            observations["web_wraps_longitude"] = raw_grid.get("wraps_longitude") is True if isinstance(raw_grid, dict) else False
        variables = manifest.get("variables")
        names = set(variables) if isinstance(variables, dict) else set(variables) if isinstance(variables, list) else set()
        missing = sorted(WEB_REQUIRED - names)
        row(checks, "web.manifest.variables", "fail" if missing else "pass", f"missing core fields: {missing}" if missing else "core fields mslp, rain24, t2m, wind are declared")
        if not missing and isinstance(variables, dict):
            expected_units = {"mslp": "hPa", "rain24": "mm", "t2m": "C", "wind": "kt"}
            bad_units = []
            bad_metadata = []
            null_frames = []
            legacy = []
            for name, allowed in expected_units.items():
                entry = variables.get(name)
                unit = entry.get("units", entry.get("unit")) if isinstance(entry, dict) else None
                if unit != allowed:
                    bad_units.append(f"{name}={unit!r}")
                if not isinstance(entry, dict) or not all(finite_number(entry.get(key)) for key in ("scale", "offset", "fill")):
                    bad_metadata.append(name)
                elif entry["scale"] <= 0 or type(entry["fill"]) is not int or not 0 <= entry["fill"] <= 65535 or entry.get("encoding", "raw") not in ("raw", "shuffle-gzip"):
                    bad_metadata.append(name)
                frames = entry.get("frames") if isinstance(entry, dict) else None
                if frames is None:
                    if isinstance(entry, dict) and safe_relative(entry.get("file")):
                        legacy.append(name)
                    else:
                        bad_metadata.append(name)
                elif not isinstance(frames, list) or len(frames) != len(expected_ladder(schema)) or any(item is None or not safe_relative(item) for item in frames):
                    null_frames.append(name)
                elif len(set(frames)) != len(frames):
                    null_frames.append(name)
            unit_status = "fail" if bad_units or bad_metadata else "pass"
            row(checks, "web.manifest.units", unit_status, f"invalid units={bad_units}, metadata={bad_metadata}" if unit_status == "fail" else "core field units and numeric metadata are valid")
            row(checks, "web.manifest.frames", "fail" if null_frames else ("unverified" if legacy else "pass"), f"invalid frame lists: {null_frames}" if null_frames else (f"legacy packed files accepted without byte validation: {legacy}" if legacy else "core frame paths have expected length and no nulls"))
        elif not missing:
            row(checks, "web.manifest.units", "unverified", "variables are names without field unit metadata")
    except Exception as exc:
        row(checks, "web.manifest.fetch", "fail", f"unable to fetch or parse manifest: {exc}")
    try:
        raw, _ = fetch(base + "/isobar-release.json")
        stamp = json.loads(raw)
        valid = isinstance(stamp, dict) and type(stamp.get("schema")) is int and stamp["schema"] == 1 and isinstance(stamp.get("source_commit"), str) and bool(HEX40.fullmatch(stamp["source_commit"]))
        if not valid:
            row(checks, "web.build_identity", "fail", "isobar-release.json lacks schema 1 and a 40-hex source_commit")
        elif stamp.get("source_dirty") is True:
            row(checks, "web.build_identity", "unverified", "build contains working changes; HEAD does not identify the deployed source")
        elif expected_commit:
            status = "pass" if stamp["source_commit"].lower() == expected_commit.lower() else "fail"
            row(checks, "web.build_identity", status, f"observed source_commit={stamp['source_commit']}; expected={expected_commit}")
        else:
            row(checks, "web.build_identity", "unverified", f"observed source_commit={stamp['source_commit']}; target commit is unpinned")
        observations["web_release_stamp"] = {key: stamp.get(key) for key in ("source_commit", "source_tree", "source_dirty", "product_version", "build_id") if isinstance(stamp, dict) and key in stamp}
    except Exception as exc:
        row(checks, "web.build_identity", "unverified", f"release identity unavailable: {exc}")


def load_check_store() -> Any:
    path = Path(__file__).with_name("check-store.py")
    spec = importlib.util.spec_from_file_location("isobar_check_store", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def coverage_from_sidecar(meta: dict[str, Any]) -> tuple[float, float, float, float, int, int] | None:
    if not all(finite_number(meta.get(key)) for key in ("lat0", "lon0", "dlat", "dlon")) or not all(type(meta.get(key)) is int for key in ("nx", "ny")):
        return None
    lat0, lon0, dlat, dlon, nx, ny = (meta[key] for key in ("lat0", "lon0", "dlat", "dlon", "nx", "ny"))
    if nx < 2 or ny < 2 or dlat >= 0 or dlon <= 0 or abs(dlat + dlon) > 1e-9 or dlon * (nx - 1) > 360 or not (-90 <= lat0 <= 90) or not (-180 <= lon0 <= 360) or not (-90 <= lat0 + dlat * (ny - 1) <= 90) or not (-180 <= lon0 + dlon * (nx - 1) <= 360):
        return None
    return (lon0, lon0 + dlon * (nx - 1), lat0, lat0 + dlat * (ny - 1), nx, ny)


def native_checks(store: Path, now: datetime, max_age: float, max_lag: float, web_grid: Any, web_run: datetime | None, checks: list[dict[str, str]], observations: dict[str, Any], compare_web: bool = True) -> None:
    global_pointer = store / "products/grids/ecmwf_ifs_global/current.json"
    if global_pointer.exists():
        pointer_path = global_pointer
        family = "grids/ecmwf_ifs_global"
        global_family = True
    else:
        pointer_path = store / "products/grids/ecmwf_ifs025/current.json"
        family = "grids/ecmwf_ifs025"
        global_family = False
    try:
        before = pointer_path.read_bytes()
        pointer = json.loads(before)
        if not isinstance(pointer, dict):
            raise ValueError("pointer is not an object")
        latest, runs = pointer.get("latest"), pointer.get("runs")
        checker = load_check_store()
        schema = checker.native_schema(pointer) if checker is not None else pointer.get("schema_version", 1)
        if schema == 2 and (pointer.get("contract") not in (None, "isobar-data") or pointer.get("family") not in (None, family) or pointer.get("uniform_step_hours") is not None or pointer.get("horizon_hours") != 168):
            raise ValueError("schema 2 pointer contract, family, uniform step, or horizon is invalid")
        if global_family and schema != 2:
            raise ValueError("global pointer must use schema 2")
        if not isinstance(latest, str) or not isinstance(runs, list) or latest not in runs or schema not in (1, 2):
            raise ValueError("pointer latest/runs/schema are invalid")
        ladder = pointer.get("forecast_hours")
        if schema == 1 and ladder is None:
            ladder = SCHEMA1
        ladder_error = check_ladder(ladder, schema)
        if ladder_error:
            raise ValueError(ladder_error)
        run = datetime.strptime(latest, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
        run_dir = pointer_path.parent / "runs" / latest
        manifest_path = run_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else None
        if schema == 2:
            if (not isinstance(manifest, dict) or manifest.get("schema_version") != 2 or manifest.get("contract") not in (None, "isobar-data") or manifest.get("family") not in (None, family) or manifest.get("uniform_step_hours") is not None or manifest.get("horizon_hours") != 168 or check_ladder(manifest.get("forecast_hours"), 2)):
                raise ValueError("schema 2 run manifest does not match contract, horizon, or exact ladder")
            if global_family:
                grid = manifest.get("grid")
                if (not isinstance(grid, dict) or grid.get("west") != -180 or grid.get("east") != 179.5 or grid.get("north") != 90 or grid.get("south") != -90 or grid.get("step") != 0.5 or grid.get("nx") != 720 or grid.get("ny") != 361 or grid.get("dtype") != "float16" or grid.get("wraps_longitude") is not True):
                    raise ValueError("global manifest does not declare the exact 0.5-degree seam-free grid")
        elif manifest_path.exists() and (not isinstance(manifest, dict) or manifest.get("schema_version", 1) != 1):
            raise ValueError("schema 1 run manifest is malformed or conflicts with pointer")
        mslp = run_dir / "mslp" / f"{latest}.json"
        meta = json.loads(mslp.read_text(encoding="utf-8"))
        if not isinstance(meta, dict) or coverage_from_sidecar(meta) is None:
            raise ValueError("MSLP first sidecar has no usable normalized coverage")
        if global_family and (meta.get("nx") != 720 or meta.get("ny") != 361 or meta.get("lat0") != 90 or meta.get("lon0") != -180 or meta.get("dlat") != -0.5 or meta.get("dlon") != 0.5 or meta.get("wraps_longitude") is not True or meta.get("dtype") != "float16"):
            raise ValueError("global MSLP sidecar does not declare the exact seam-free grid")
        if meta.get("run") != run.strftime("%Y-%m-%dT%H:%M:%SZ") or meta.get("valid_time") != run.strftime("%Y-%m-%dT%H:%M:%SZ"):
            raise ValueError("MSLP sidecar run or valid_time does not match first lead")
        if meta.get("dtype") != "float16" or meta.get("endian") != "little" or meta.get("units") != "hPa":
            raise ValueError("MSLP sidecar dtype, endian, or units are invalid")
        after = pointer_path.read_bytes()
        if before != after:
            row(checks, "native.snapshot", "unverified", "pointer changed during read; snapshot was not mixed")
            return
        age = (now - run).total_seconds() / 3600
        age_status = "pass" if 0 <= age <= max_age else "fail"
        row(checks, "native.run_age", age_status, f"native run age {age:.2f}h; limit {max_age:g}h")
        observations["native"] = {"schema": schema, "family": family, "run": latest, "age_hours": round(age, 2), "grid": coverage_from_sidecar(meta), "wraps_longitude": meta.get("wraps_longitude") is True}
        if compare_web:
            web_hours = observations.get("web_hours")
            status = "unverified" if web_hours is None else "pass" if list(ladder) == list(web_hours) else "fail"
            row(checks, "native.web_ladder", status, "forecast ladders match" if status == "pass" else "forecast ladders differ or web ladder is unavailable")
        if compare_web and web_run:
            lag = (run - web_run).total_seconds() / 3600
            row(checks, "native.web_lag", "pass" if abs(lag) <= max_lag else "fail", f"web lag relative to native: {lag:.2f}h (positive means native is newer); absolute limit {max_lag:g}h")
        elif compare_web:
            row(checks, "native.web_lag", "unverified", "web run timestamp unavailable")
        if compare_web and web_grid and coverage_from_sidecar(meta) != tuple(web_grid):
            row(checks, "native.web_coverage", "fail", f"native coverage {coverage_from_sidecar(meta)} does not match web {tuple(web_grid)}")
        elif compare_web:
            row(checks, "native.web_coverage", "pass" if web_grid else "unverified", "native coverage matches web" if web_grid else "web coverage unavailable")
        if compare_web and global_family:
            if web_grid and tuple(web_grid) == coverage_from_sidecar(meta) and observations.get("web_wraps_longitude") is True:
                row(checks, "native.web_grid_orientation", "pass", "global native and web grids share seam-free longitude wrapping")
            else:
                row(checks, "native.web_grid_orientation", "fail", "global web grid must match coverage and declare wraps_longitude=true")
        row(checks, "native.pointer_manifest", "pass", f"schema {schema} pointer and run manifest agree")
    except Exception as exc:
        row(checks, "native.pointer_manifest", "fail", f"native archive evidence unavailable: {exc}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_inventory(app: Path) -> dict[str, str]:
    """Return deterministic path-level hashes under Contents without following symlinks."""
    inventory: dict[str, str] = {}
    contents = app / "Contents"
    for path in sorted(contents.rglob("*"), key=lambda item: item.relative_to(contents).as_posix()):
        relative = path.relative_to(contents).as_posix()
        if path.is_symlink():
            inventory[relative] = "symlink:" + os.readlink(path)
        elif path.is_file():
            inventory[relative] = "file:" + sha256(path)
        elif path.is_dir():
            inventory[relative] = "dir"
    return inventory


def bundle_digest(app: Path) -> str:
    """Hash every path and payload under Contents without following symlinks."""
    digest = hashlib.sha256()
    for relative, entry in bundle_inventory(app).items():
        digest.update(relative.encode("utf-8") + b"\0")
        kind, _, payload = entry.partition(":")
        digest.update(kind.encode("ascii") + b"\0")
        if payload:
            digest.update((bytes.fromhex(payload) if kind == "file" else payload.encode("utf-8")) + b"\0")
    return digest.hexdigest()


def app_checks(app: Path, reference: Path | None, checks: list[dict[str, str]], observations: dict[str, Any]) -> None:
    try:
        plist_path = app / "Contents/Info.plist"
        plist = plistlib.loads(plist_path.read_bytes())
        executable_name = plist.get("CFBundleExecutable")
        if not isinstance(executable_name, str) or not executable_name or Path(executable_name).name != executable_name or executable_name in (".", ".."):
            raise ValueError("CFBundleExecutable is not a safe basename")
        if not isinstance(plist.get("CFBundleShortVersionString"), str) or not plist.get("CFBundleShortVersionString") or not isinstance(plist.get("CFBundleVersion"), str) or not plist.get("CFBundleVersion"):
            raise ValueError("bundle version and build are missing")
        executable = app / "Contents/MacOS" / executable_name
        collector = app / "Contents/Resources/collector/isobar-data"
        config = app / "Contents/Resources/collector/_internal/config/isobar.toml"
        if not executable.is_file() or not collector.is_file() or not config.is_file():
            raise ValueError("main executable, bundled collector, or collector config is missing")
        actual = {"version": plist.get("CFBundleShortVersionString"), "build": plist.get("CFBundleVersion"), "executable_sha256": sha256(executable), "collector_sha256": sha256(collector), "contents_sha256": bundle_digest(app)}
        observations["app"] = actual
        row(checks, "app.layout", "pass", "Info.plist, main executable and collector are present")
        if reference:
            ref_plist = plistlib.loads((reference / "Contents/Info.plist").read_bytes())
            ref_name = ref_plist.get("CFBundleExecutable")
            if not isinstance(ref_name, str) or Path(ref_name).name != ref_name:
                raise ValueError("reference CFBundleExecutable is unsafe")
            same_version = (plist.get("CFBundleShortVersionString"), plist.get("CFBundleVersion")) == (ref_plist.get("CFBundleShortVersionString"), ref_plist.get("CFBundleVersion"))
            hashes_match = actual["contents_sha256"] == bundle_digest(reference)
            installed_inventory = bundle_inventory(app)
            reference_inventory = bundle_inventory(reference)
            changed_paths = sorted(path for path in set(installed_inventory) | set(reference_inventory) if installed_inventory.get(path) != reference_inventory.get(path))
            observations["app_reference_changed_paths"] = changed_paths
            row(checks, "app.reference_identity", "pass" if hashes_match and same_version else "fail", "version/build and full Contents payload match" if hashes_match and same_version else f"version/build match={same_version}, full bundle payload matches={hashes_match}")
        else:
            row(checks, "app.source_identity", "unverified", "binary hashes identify this artifact only; no trusted source identity was supplied")
    except Exception as exc:
        row(checks, "app.layout", "fail", f"installed app evidence unavailable: {exc}")


class LinkParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []
        self.blocked = 0
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self.blocked += 1
        if tag == "a" and not self.blocked:
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)
    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.blocked:
            self.blocked -= 1


def release_checks(api_url: str, web_url: str, checks: list[dict[str, str]], observations: dict[str, Any]) -> None:
    try:
        release = json.loads(fetch(api_url)[0])
        if not isinstance(release, dict) or not isinstance(release.get("tag_name"), str) or not release["tag_name"] or release.get("draft") is not False or release.get("prerelease") is True or not isinstance(release.get("assets"), list):
            raise ValueError("release JSON lacks published tag and assets")
        assets = [item.get("browser_download_url") for item in release["assets"] if isinstance(item, dict) and isinstance(item.get("browser_download_url"), str)]
        dmg = next((link for link in assets if urllib.parse.urlparse(link).scheme == "https" and "mac" in link.lower() and "arm64" in link.lower() and link.lower().endswith(".dmg")), None)
        if not dmg:
            row(checks, "release.arm64_dmg", "fail", "published release has no macOS arm64 DMG")
            return
        observations["release"] = {"issuer": api_url, "tag_name": release["tag_name"], "download": dmg}
        raw, _ = fetch(web_url.rstrip("/") + "/download")
        parser = LinkParser(); parser.feed(raw.decode("utf-8", errors="replace"))
        links = [urllib.parse.urljoin(web_url, link) for link in parser.links]
        row(checks, "release.download_link", "pass" if dmg in links else "fail", "published arm64 DMG is linked by /download" if dmg in links else "published arm64 DMG is not linked by server-rendered /download HTML")
    except Exception as exc:
        row(checks, "release.endpoint", "fail", f"release evidence unavailable: {exc}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-url")
    parser.add_argument("--release-api-url")
    parser.add_argument("--app", type=Path)
    parser.add_argument("--store", type=Path)
    parser.add_argument("--reference-app", type=Path)
    parser.add_argument("--expected-web-commit")
    parser.add_argument("--max-model-age-hours", type=float, default=18)
    parser.add_argument("--max-run-lag-hours", type=float, default=12)
    parser.add_argument("--now")
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if not any((args.web_url, args.release_api_url, args.app, args.store)):
            parser.error("select at least one scope: --web-url, --release-api-url, --app or --store")
        if args.reference_app and not args.app:
            parser.error("--reference-app requires --app")
        if args.release_api_url and not args.web_url:
            parser.error("--release-api-url requires --web-url to check the public download link")
        if args.expected_web_commit and not HEX40.fullmatch(args.expected_web_commit):
            parser.error("--expected-web-commit must be 40 hexadecimal characters")
        if args.expected_web_commit and not args.web_url:
            parser.error("--expected-web-commit requires --web-url")
        if args.web_url:
            args.web_url = validate_url(args.web_url, web_origin=True)
        if args.release_api_url:
            args.release_api_url = validate_url(args.release_api_url)
        if not finite_number(args.max_model_age_hours) or not finite_number(args.max_run_lag_hours) or args.max_model_age_hours < 0 or args.max_run_lag_hours < 0:
            parser.error("age and lag limits must be non-negative")
        captured = now_value(args.now)
    except SystemExit:
        raise
    except Exception as exc:
        parser.error(str(exc))
    checks: list[dict[str, str]] = []
    observations: dict[str, Any] = {}
    if args.web_url:
        web_checks(args.web_url, args.expected_web_commit, captured, args.max_model_age_hours, checks, observations)
    web_grid = observations.get("web_grid")
    web_run = iso(observations.get("web_manifest", {}).get("run")) if isinstance(observations.get("web_manifest"), dict) else None
    if args.store:
        native_checks(args.store, captured, args.max_model_age_hours, args.max_run_lag_hours, web_grid, web_run, checks, observations, compare_web=bool(args.web_url))
    if args.app:
        app_checks(args.app, args.reference_app, checks, observations)
    if args.release_api_url:
        if not args.web_url:
            row(checks, "release.download_link", "unverified", "--web-url is required to verify the download page link")
        else:
            release_checks(args.release_api_url, args.web_url, checks, observations)
    report = {"checked_at": captured.isoformat().replace("+00:00", "Z"), "scope": {"web_url": args.web_url, "release_api_url": args.release_api_url, "app": str(args.app) if args.app else None, "store": str(args.store) if args.store else None, "reference_app": str(args.reference_app) if args.reference_app else None}, "policy": {"expected_web_commit": args.expected_web_commit, "max_model_age_hours": args.max_model_age_hours, "max_run_lag_hours": args.max_run_lag_hours}, "observations": observations, "checks": checks, "ok": bool(checks) and all(item["status"] == "pass" for item in checks)}
    if args.as_json:
        print(json.dumps(report, sort_keys=True))
    else:
        for item in checks:
            print(f"{item['status'].upper():10} {item['id']}: {item['detail']}")
        print(f"OVERALL    {'PASS' if report['ok'] else 'FAIL/UNVERIFIED'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
