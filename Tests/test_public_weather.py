#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import tarfile
from pathlib import Path
from datetime import datetime, timedelta, timezone

import pytest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("public_weather", HERE.parent / "tools" / "public-weather.py")
public_weather = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(public_weather)


def make_archive(root: Path, *, private: bool = True) -> None:
    grid = root / "products/grids/ecmwf_ifs025"
    (grid / "current.json").parent.mkdir(parents=True)
    (grid / "current.json").write_text(json.dumps({"latest": "20260927T00Z", "runs": ["20260926T00Z", "20260927T00Z"]}))
    for run in ("20260926T00Z", "20260927T00Z"):
        issued = datetime.strptime(run, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)
        for field_name in public_weather.CORE_FIELDS:
            field = grid / "runs" / run / field_name
            field.mkdir(parents=True)
            for step in range(0, 97, 3):
                valid = issued + timedelta(hours=step)
                name = valid.strftime("%Y%m%dT%HZ")
                (field / f"{name}.f16").write_bytes(b"\x00\x01" * (301 * 201))
                (field / f"{name}.json").write_text(json.dumps({"dtype": "float16", "nx": 301, "ny": 201, "lat0": 0, "lon0": 95,
                    "dlat": -0.25, "dlon": 0.25, "units": public_weather.GRID_UNITS[field_name],
                    "run": issued.strftime("%Y-%m-%dT%H:%M:%SZ"), "valid_time": valid.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "model": "ecmwf-ifs-0p25-open-data", "fill": -32768, "native_step_hours": 3,
                    "order": "north-to-south, west-to-east", "endian": "little", "param": public_weather.GRID_PARAMS[field_name],
                    "private_note": "PRIVATE_SENTINEL"}))
    for family in ("ecmwf_ifs", "marine"):
        base = root / "products/points" / family
        (base / "runs" / "2026-09-27T000000Z").mkdir(parents=True)
        (base / "current.json").write_text(json.dumps({"latest": "2026-09-27T000000Z", "runs": ["2026-09-27T000000Z"]}))
        coords = (-32.02109, 115.72979) if family == "ecmwf_ifs" else (-31.958336, 115.79167)
        times = [f"2026-09-27T{hour:02d}:00" for hour in range(24)]
        (base / "runs" / "2026-09-27T000000Z" / "cottesloe.json").write_text(json.dumps({"id": "cottesloe", "licence_id": "open-meteo-cc-by-4.0",
            "latitude": coords[0], "longitude": coords[1], "model": "ecmwf_ifs" if family == "ecmwf_ifs" else "best-match",
            "run": "2026-09-27T00:00:00Z", "native_step_hours": 1,
            "snapped": {"private_note": "PRIVATE_SENTINEL"}, "caution": "PRIVATE_SENTINEL",
            "daily": {"sunrise": ["PRIVATE_SENTINEL"]},
            "units": {"temperature_2m": "°C", "precipitation": "mm", "wind_speed_10m": "kn", "wave_height": "m", "wave_direction": "°", "wave_period": "s"},
            "time": times, "hourly": {"temperature_2m": [12] * 24, "precipitation": [0] * 24,
                "wind_speed_10m": [5] * 24, "wave_height": [1] * 24, "wave_direction": [180] * 24,
                "wave_period": [8] * 24, "PRIVATE_SENTINEL": [99]},
            "private_note": "PRIVATE_SENTINEL"}))
    (root / "attribution.json").write_text(json.dumps({"sources": [
        {"licence_id": "ecmwf-cc-by-4.0", "policy_url": "https://ecmwf.example", "attribution": "ECMWF", "redistribute": True,
         "private_note": "PRIVATE_SENTINEL"},
        {"licence_id": "open-meteo-cc-by-4.0", "policy_url": "https://openmeteo.example", "attribution": "Open-Meteo", "redistribute": True,
         "private_note": "PRIVATE_SENTINEL"},
        {"licence_id": "aviationweather", "attribution": "private"},
    ]}))
    if private:
        (root / "products/obs").mkdir(parents=True)
        (root / "products/obs/obs.sqlite").write_bytes(b"private")
        (root / "settings.json").write_text("private")


def test_export_is_allowlisted_and_importable(tmp_path):
    source = tmp_path / "archive"
    make_archive(source)
    bundle = tmp_path / "public.tar.gz"
    public_weather.export_snapshot(source, bundle)
    destination = tmp_path / "imported"
    public_weather.import_snapshot(bundle, destination)
    with tarfile.open(bundle) as archive:
        assert all(member.uid == member.gid == 0 and member.uname == member.gname == "" and member.mtime == 0
                   for member in archive.getmembers())
    paths = {p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()}
    assert "settings.json" not in paths
    assert not any(path.startswith("products/obs") for path in paths)
    assert "products/grids/ecmwf_ifs025/current.json" in paths
    assert "products/points/marine/runs/2026-09-27T000000Z/cottesloe.json" in paths
    assert json.loads((destination / "manifest.json").read_text())["runs"] == ["20260926T00Z", "20260927T00Z"]
    for path in destination.rglob("*.json"):
        assert "PRIVATE_SENTINEL" not in path.read_text()


def test_export_requires_public_attribution(tmp_path):
    source = tmp_path / "archive"
    make_archive(source)
    (source / "attribution.json").write_text(json.dumps({"sources": []}))
    with pytest.raises(ValueError, match="attribution"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


def test_import_rejects_traversal_and_symlink_like_entries(tmp_path):
    bundle = tmp_path / "bad.tar.gz"
    with tarfile.open(bundle, "w:gz") as archive:
        info = tarfile.TarInfo("../escape")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(ValueError, match="unsafe bundle path"):
        public_weather.import_snapshot(bundle, tmp_path / "destination")
    with tarfile.open(bundle, "w:gz") as archive:
        info = tarfile.TarInfo("products/points/marine/runs/2026-09-27T000000Z/link.json")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        archive.addfile(info)
    with pytest.raises(ValueError, match="non-regular"):
        public_weather.import_snapshot(bundle, tmp_path / "destination")


def test_import_rejects_unexpected_path_inside_public_prefix(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    bundle = tmp_path / "public.tar.gz"
    public_weather.export_snapshot(source, bundle)
    tampered = tmp_path / "tampered.tar.gz"
    with tarfile.open(bundle, "r:gz") as source_tar, tarfile.open(tampered, "w:gz") as output_tar:
        for member in source_tar.getmembers():
            output_tar.addfile(member, source_tar.extractfile(member) if member.isfile() else None)
        info = tarfile.TarInfo("products/points/marine/runs/2026-09-27T000000Z/extra.json")
        data = b'{"PRIVATE_SENTINEL": true}'
        info.size = len(data)
        output_tar.addfile(info, io.BytesIO(data))
    with pytest.raises(ValueError, match="file set mismatch"):
        public_weather.import_snapshot(tampered, tmp_path / "destination")


def test_import_rejects_corrupt_grid_hash(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    bundle = tmp_path / "public.tar.gz"
    public_weather.export_snapshot(source, bundle)
    corrupt = tmp_path / "corrupt.tar.gz"
    with tarfile.open(bundle, "r:gz") as source_tar, tarfile.open(corrupt, "w:gz") as output_tar:
        for member in source_tar.getmembers():
            data = source_tar.extractfile(member).read()
            if member.name.endswith(".f16"):
                data = b"x" * len(data)
            output_tar.addfile(member, io.BytesIO(data))
    with pytest.raises(ValueError, match="hash mismatch"):
        public_weather.import_snapshot(corrupt, tmp_path / "destination")


def test_export_rejects_invalid_public_point(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    point = source / "products/points/marine/runs/2026-09-27T000000Z/cottesloe.json"
    body = json.loads(point.read_text())
    body["latitude"] = -32.5
    point.write_text(json.dumps(body))
    with pytest.raises(ValueError, match="public Cottesloe"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


@pytest.mark.parametrize("coordinate", [float("nan"), float("inf"), "nan", True])
def test_export_rejects_nonfinite_coordinate(tmp_path, coordinate):
    source = tmp_path / "archive"
    make_archive(source)
    point = source / "products/points/marine/runs/2026-09-27T000000Z/cottesloe.json"
    body = json.loads(point.read_text())
    body["latitude"] = coordinate
    point.write_text(json.dumps(body))
    with pytest.raises(ValueError, match="non-finite|public Cottesloe"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


def test_export_rejects_stale_model_run(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    with pytest.raises(ValueError, match="hours old"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz", max_age_hours=0.01)


def test_export_rejects_partial_public_forecast(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    point = source / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/cottesloe.json"
    body = json.loads(point.read_text())
    del body["hourly"]["precipitation"]
    point.write_text(json.dumps(body))
    with pytest.raises(ValueError, match="fewer than 24"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


def test_export_rejects_a_missing_core_hour(tmp_path):
    source = tmp_path / "archive"
    make_archive(source, private=False)
    (source / "products/grids/ecmwf_ifs025/runs/20260927T00Z/tp/20260927T03Z.f16").unlink()
    with pytest.raises(ValueError, match="missing required core forecast hours"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


def test_export_rejects_private_content_inside_hourly_data(tmp_path):
    source = tmp_path / "archive"
    make_archive(source)
    path = source / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/cottesloe.json"
    body = json.loads(path.read_text())
    body["hourly"]["temperature_2m"][0] = {"note": "PRIVATE_SENTINEL"}
    path.write_text(json.dumps(body))
    with pytest.raises(ValueError, match="invalid numeric hourly"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz")


def test_import_rejects_manifest_paths_outside_exact_family(tmp_path):
    source = tmp_path / "archive"
    make_archive(source)
    bundle = tmp_path / "public.tar.gz"
    public_weather.export_snapshot(source, bundle)
    destination = tmp_path / "imported"
    public_weather.import_snapshot(bundle, destination)
    path = destination / "manifest.json"
    manifest = json.loads(path.read_text())
    entry = manifest["grid"]["fields"][0]
    for key in ("path", "sidecar"):
        previous = destination / entry[key]
        entry[key] = "arbitrary/" + previous.name
        (destination / "arbitrary").mkdir(exist_ok=True)
        previous.rename(destination / entry[key])
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="not canonical"):
        public_weather.validate_tree(destination)


def test_freshness_requires_future_coastal_coverage(tmp_path, monkeypatch):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 27, 6, tzinfo=timezone.utc)
    monkeypatch.setattr(public_weather, "datetime", FixedDateTime)
    source = tmp_path / "archive"
    make_archive(source)
    with pytest.raises(ValueError, match="lacks 24 future hours"):
        public_weather.export_snapshot(source, tmp_path / "out.tar.gz", max_age_hours=36)


@pytest.mark.skipif(not os.environ.get("ISOBAR_REAL_ARCHIVE_TEST"), reason="opt-in real archive check")
def test_real_archive_export_dry_report(tmp_path):
    source = Path.home() / "Data/isobar"
    if not source.is_dir():
        pytest.skip("local Isobar archive is unavailable")
    bundle = tmp_path / "public-real.tar.gz"
    public_weather.export_snapshot(source, bundle)
    assert bundle.stat().st_size > 0
    with tarfile.open(bundle) as archive:
        names = archive.getnames()
        assert "manifest.json" in names
