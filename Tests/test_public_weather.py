#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


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
        times = [f"2026-09-27T{hour:02d}:00" for hour in range(24)]
        points = [("cottesloe", (-32.02109, 115.72979) if family == "ecmwf_ifs" else (-31.958336, 115.79167))]
        if family == "ecmwf_ifs":
            points.append(("yssy", (-33.946, 151.177)))
        for point_id, coords in points:
            body = {"id": point_id, "licence_id": "open-meteo-cc-by-4.0",
                "latitude": coords[0], "longitude": coords[1], "model": "ecmwf_ifs" if family == "ecmwf_ifs" else "best-match",
                "run": "2026-09-27T00:00:00Z", "native_step_hours": 1,
                "snapped": {"private_note": "PRIVATE_SENTINEL"}, "caution": "PRIVATE_SENTINEL",
                "daily": {"sunrise": ["PRIVATE_SENTINEL"]},
                "timezone": "PRIVATE_SENTINEL",
                "units": {"temperature_2m": "°C", "precipitation": "mm", "wind_speed_10m": "kn", "wave_height": "m", "wave_direction": "°", "wave_period": "s"},
                "time": times, "hourly": {"temperature_2m": [12] * 24, "precipitation": [0] * 24,
                    "wind_speed_10m": [5] * 24, "wave_height": [1] * 24, "wave_direction": [180] * 24,
                    "wave_period": [8] * 24, "PRIVATE_SENTINEL": [99]},
                "private_note": "PRIVATE_SENTINEL"}
            (base / "runs" / "2026-09-27T000000Z" / f"{point_id}.json").write_text(json.dumps(body))
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


class PublicWeatherTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_export_is_allowlisted_and_importable(self):
        source = self.tmp_path / "archive"
        make_archive(source)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        destination = self.tmp_path / "imported"
        public_weather.import_snapshot(bundle, destination)
        with tarfile.open(bundle) as archive:
            self.assertTrue(all(member.uid == member.gid == 0 and member.uname == member.gname == "" and member.mtime == 0
                                for member in archive.getmembers()))
        paths = {p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()}
        self.assertNotIn("settings.json", paths)
        self.assertFalse(any(path.startswith("products/obs") for path in paths))
        self.assertIn("products/grids/ecmwf_ifs025/current.json", paths)
        self.assertIn("products/points/marine/runs/2026-09-27T000000Z/cottesloe.json", paths)
        self.assertIn("products/points/ecmwf_ifs/runs/2026-09-27T000000Z/yssy.json", paths)
        sydney = json.loads((destination / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/yssy.json").read_text())
        self.assertEqual(sydney["timezone"], "Australia/Sydney")
        self.assertNotIn("daily", sydney)
        self.assertEqual(json.loads((destination / "manifest.json").read_text())["runs"], ["20260926T00Z", "20260927T00Z"])
        for path in destination.rglob("*.json"):
            self.assertNotIn("PRIVATE_SENTINEL", path.read_text())

    def test_export_replaces_a_synced_temp_file(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        replaced = []
        synced = []
        real_replace = os.replace

        def spy_replace(src, dst):
            replaced.append((Path(src), Path(dst)))
            return real_replace(src, dst)

        def spy_fsync(fd):
            synced.append(fd)

        with patch.object(public_weather.os, "replace", side_effect=spy_replace), patch.object(public_weather.os, "fsync", side_effect=spy_fsync):
            public_weather.export_snapshot(source, bundle)
        self.assertTrue(bundle.is_file())
        self.assertTrue(synced)
        self.assertEqual(len(replaced), 1)
        src, dst = replaced[0]
        self.assertEqual(dst, bundle)
        self.assertEqual(src.parent, bundle.parent)
        self.assertNotEqual(src, bundle)
        self.assertFalse(src.exists())
        self.assertFalse(any(path.name.startswith(f".{bundle.name}.") for path in bundle.parent.iterdir()))

    def test_export_failure_leaves_no_partial_tarball(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        with patch.object(public_weather.os, "replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                public_weather.export_snapshot(source, bundle)
        self.assertFalse(bundle.exists())
        self.assertFalse(any(path.name.startswith(f".{bundle.name}.") for path in self.tmp_path.iterdir()))

    def test_import_replaces_empty_destination_without_removing_it_first(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        destination = self.tmp_path / "imported"
        destination.mkdir()
        removed = []
        real_replace = os.replace

        def spy_replace(src, dst):
            self.assertTrue(destination.is_dir())
            return real_replace(src, dst)

        with patch.object(public_weather.os, "replace", side_effect=spy_replace), patch.object(public_weather.shutil, "rmtree", side_effect=lambda path, *args, **kwargs: removed.append(path)):
            public_weather.import_snapshot(bundle, destination)
        self.assertTrue((destination / "manifest.json").is_file())
        self.assertFalse(any(Path(path) == destination for path in removed))

    def test_failed_import_rename_keeps_the_destination(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        destination = self.tmp_path / "imported"
        destination.mkdir()
        marker = destination / "keep"
        marker.write_text("keep", encoding="utf-8")
        # The importer refuses a non-empty destination before staging. An empty
        # directory is the case os.replace must not delete ahead of the rename.
        marker.unlink()
        with patch.object(public_weather.os, "replace", side_effect=OSError("rename failed")):
            with self.assertRaises(OSError):
                public_weather.import_snapshot(bundle, destination)
        self.assertTrue(destination.is_dir())

    def test_export_requires_public_attribution(self):
        source = self.tmp_path / "archive"
        make_archive(source)
        (source / "attribution.json").write_text(json.dumps({"sources": []}))
        with self.assertRaisesRegex(ValueError, "attribution"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_import_rejects_traversal_and_symlink_like_entries(self):
        bundle = self.tmp_path / "bad.tar.gz"
        with tarfile.open(bundle, "w:gz") as archive:
            info = tarfile.TarInfo("../escape")
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(ValueError, "unsafe bundle path"):
            public_weather.import_snapshot(bundle, self.tmp_path / "destination")
        with tarfile.open(bundle, "w:gz") as archive:
            info = tarfile.TarInfo("products/points/marine/runs/2026-09-27T000000Z/link.json")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            archive.addfile(info)
        with self.assertRaisesRegex(ValueError, "non-regular"):
            public_weather.import_snapshot(bundle, self.tmp_path / "destination")

    def test_import_rejects_unexpected_path_inside_public_prefix(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        tampered = self.tmp_path / "tampered.tar.gz"
        with tarfile.open(bundle, "r:gz") as source_tar, tarfile.open(tampered, "w:gz") as output_tar:
            for member in source_tar.getmembers():
                output_tar.addfile(member, source_tar.extractfile(member) if member.isfile() else None)
            info = tarfile.TarInfo("products/points/marine/runs/2026-09-27T000000Z/extra.json")
            data = b'{"PRIVATE_SENTINEL": true}'
            info.size = len(data)
            output_tar.addfile(info, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "file set mismatch"):
            public_weather.import_snapshot(tampered, self.tmp_path / "destination")

    def test_import_rejects_corrupt_grid_hash(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        corrupt = self.tmp_path / "corrupt.tar.gz"
        with tarfile.open(bundle, "r:gz") as source_tar, tarfile.open(corrupt, "w:gz") as output_tar:
            for member in source_tar.getmembers():
                data = source_tar.extractfile(member).read()
                if member.name.endswith(".f16"):
                    data = b"x" * len(data)
                output_tar.addfile(member, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            public_weather.import_snapshot(corrupt, self.tmp_path / "destination")

    def test_export_rejects_invalid_public_point(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        point = source / "products/points/marine/runs/2026-09-27T000000Z/cottesloe.json"
        body = json.loads(point.read_text())
        body["latitude"] = -32.5
        point.write_text(json.dumps(body))
        with self.assertRaisesRegex(ValueError, "public Cottesloe"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_export_rejects_nonfinite_coordinate(self):
        for index, coordinate in enumerate((float("nan"), float("inf"), "nan", True)):
            with self.subTest(coordinate=coordinate):
                source = self.tmp_path / f"archive-{index}"
                make_archive(source)
                point = source / "products/points/marine/runs/2026-09-27T000000Z/cottesloe.json"
                body = json.loads(point.read_text())
                body["latitude"] = coordinate
                point.write_text(json.dumps(body, allow_nan=True))
                with self.assertRaisesRegex(ValueError, "non-finite|public Cottesloe"):
                    public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_export_rejects_stale_model_run(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        with self.assertRaisesRegex(ValueError, "hours old"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz", max_age_hours=0.01)

    def test_export_rejects_partial_public_forecast(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        point = source / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/cottesloe.json"
        body = json.loads(point.read_text())
        del body["hourly"]["precipitation"]
        point.write_text(json.dumps(body))
        with self.assertRaisesRegex(ValueError, "fewer than 24"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_export_rejects_a_missing_core_hour(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        (source / "products/grids/ecmwf_ifs025/runs/20260927T00Z/tp/20260927T03Z.f16").unlink()
        with self.assertRaisesRegex(ValueError, "missing required core forecast hours"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_export_rejects_private_content_inside_hourly_data(self):
        source = self.tmp_path / "archive"
        make_archive(source)
        path = source / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/cottesloe.json"
        body = json.loads(path.read_text())
        body["hourly"]["temperature_2m"][0] = {"note": "PRIVATE_SENTINEL"}
        path.write_text(json.dumps(body))
        with self.assertRaisesRegex(ValueError, "invalid numeric hourly"):
            public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz")

    def test_import_rejects_manifest_paths_outside_exact_family(self):
        source = self.tmp_path / "archive"
        make_archive(source)
        bundle = self.tmp_path / "public.tar.gz"
        public_weather.export_snapshot(source, bundle)
        destination = self.tmp_path / "imported"
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
        with self.assertRaisesRegex(ValueError, "not canonical"):
            public_weather.validate_tree(destination)

    def test_export_keeps_seven_day_daily_and_hourly_series(self):
        source = self.tmp_path / "archive"
        make_archive(source, private=False)
        start = datetime(2026, 9, 27, tzinfo=timezone.utc)
        times = [(start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M") for hour in range(168)]
        days = [(start + timedelta(days=day)).strftime("%Y-%m-%d") for day in range(7)]
        maxima = [28.9, 24.5, 22.4, 22.5, 21.8, 25.4, 17.1]
        for point_id, zone in (("cottesloe", "Australia/Perth"), ("yssy", "Australia/Sydney")):
            path = source / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z" / f"{point_id}.json"
            body = json.loads(path.read_text())
            body["time"] = times
            body["timezone"] = zone
            body["units"]["weather_code"] = "wmo code"
            body["hourly"] = {key: ([12] * 168 if key == "temperature_2m" else [0] * 168) for key in body["hourly"] if key != "PRIVATE_SENTINEL"}
            body["hourly"]["wind_speed_10m"] = [5] * 168
            body["hourly"]["precipitation"] = [0] * 168
            body["hourly"]["weather_code"] = [3] * 168
            body["daily"] = {"time": days, "temperature_2m_max": maxima, "temperature_2m_min": [13.5, 17.4, 15.7, 13.4, 13.9, 16.2, 13.0],
                             "precipitation_sum": [0, 5.6, 10.3, 0.2, 0, 0, 3.0], "precipitation_hours": [0, 2, 4, 1, 0, 0, 1],
                             "weather_code": [3, 80, 95, 51, 3, 3, 51], "wind_speed_10m_max": [12] * 7,
                             "sunrise": [f"{day}T05:31+10:00" for day in days], "sunset": ["PRIVATE_SENTINEL"] * 7,
                             "private_note": "PRIVATE_SENTINEL"}
            path.write_text(json.dumps(body))
        public_weather.export_snapshot(source, self.tmp_path / "week.tar.gz")
        destination = self.tmp_path / "week"
        public_weather.import_snapshot(self.tmp_path / "week.tar.gz", destination)
        sydney = json.loads((destination / "products/points/ecmwf_ifs/runs/2026-09-27T000000Z/yssy.json").read_text())
        self.assertEqual(len(sydney["time"]), 168)
        self.assertEqual(sydney["timezone"], "Australia/Sydney")
        self.assertEqual(sydney["daily"]["temperature_2m_max"], maxima)
        self.assertEqual(sydney["daily"]["weather_code"], [3, 80, 95, 51, 3, 3, 51])
        self.assertEqual(sydney["daily"]["sunrise"][0], "2026-09-27T05:31+10:00")
        self.assertNotIn("sunset", sydney["daily"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(sydney))
        manifest = json.loads((destination / "manifest.json").read_text())
        self.assertEqual({item["id"] for item in manifest["points"]["places"]}, {"cottesloe", "yssy"})
        self.assertEqual(next(item["timezone"] for item in manifest["points"]["places"] if item["id"] == "yssy"), "Australia/Sydney")

    def test_freshness_requires_future_coastal_coverage(self):
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 27, 6, tzinfo=timezone.utc)

        source = self.tmp_path / "archive"
        make_archive(source)
        with patch.object(public_weather, "datetime", FixedDateTime):
            with self.assertRaisesRegex(ValueError, "lacks 24 future hours"):
                public_weather.export_snapshot(source, self.tmp_path / "out.tar.gz", max_age_hours=36)

    @unittest.skipUnless(os.environ.get("ISOBAR_REAL_ARCHIVE_TEST"), "opt-in real archive check")
    def test_real_archive_export_dry_report(self):
        source = Path.home() / "Data/isobar"
        if not source.is_dir():
            self.skipTest("local Isobar archive is unavailable")
        bundle = self.tmp_path / "public-real.tar.gz"
        public_weather.export_snapshot(source, bundle)
        self.assertGreater(bundle.stat().st_size, 0)
        with tarfile.open(bundle) as archive:
            names = archive.getnames()
            self.assertIn("manifest.json", names)


if __name__ == "__main__":
    unittest.main()
