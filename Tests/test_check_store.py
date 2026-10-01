import importlib.util
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("check_store", Path(__file__).parents[1] / "tools/check-store.py")
check_store = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_store)


NOW = check_store.iso("2026-09-26T12:00:00Z")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_store(tmp_path, *, daemon_run="20260926T00Z", old_run="20260926T00Z", truncated=False):
    store = tmp_path / "store"
    run = "20260926T00Z"
    run_dir = store / "ecmwf" / run
    run_dir.mkdir(parents=True)
    write_json(store / "ecmwf/latest.json", {"run": old_run, "path": run})
    write_json(store / "status.json", {"sources": [{"id": "ecmwf-open-data", "ok": True}]})
    write_json(run_dir / "manifest.json", {
        "schema": 1, "run": "2026-09-26T00:00:00Z", "generated": "2026-09-26T01:00:00Z",
        "grid": {"west": 100, "east": 100.25, "north": 0, "south": -0.25, "nx": 2, "ny": 2, "step": 0.25, "dtype": "float32", "endian": "little"},
        "times": ["2026-09-26T00:00:00Z", "2026-09-26T03:00:00Z"],
        "variables": {name: {"file": f"{name}.f32"} for name in check_store.REQUIRED_VARIABLES},
    })
    for name in check_store.REQUIRED_VARIABLES:
        (run_dir / f"{name}.f32").write_bytes(b"0" * (2 * 2 * 2 * 4 - (1 if truncated and name == "msl" else 0)))
    for place, wmo, geohash, _lat, _lon in check_store.DEFAULT_PLACES:
        write_json(store / "products/obs" / f"{wmo}.json", {"observations": {"data": [{"local_date_time_full": "20260926120000", "air_temp": 20}]}})
        write_json(store / "products/points" / f"{geohash}.json", {"hourly": [{"time": "2026-09-26T12:00:00Z", "wind_speed_kmh": 20}]})
    chart = store / "products/charts/IDG00073.pdf"
    chart.parent.mkdir(parents=True, exist_ok=True)
    chart.write_bytes(b"%PDF-1.7\n")
    return store


def make_native_store(tmp_path, *, truncated=False, missing_observation_column=None):
    store = tmp_path / "native-store"
    run = "20260926T00Z"
    run_dir = store / "products/grids/ecmwf_ifs025/runs" / run
    write_json(store / "products/grids/ecmwf_ifs025/current.json", {"latest": run, "runs": [run]})
    write_json(store / "status.json", {"sources": [{"id": "ecmwf-open-data", "ok": True}]})
    units = {"mslp": "hPa", "t850": "degC", "t2m": "degC", "u10": "m/s", "v10": "m/s", "tp": "mm"}
    for variable, unit in units.items():
        for lead in range(0, 97, 3):
            day = 26 + lead // 24
            hour = lead % 24
            valid = f"202609{day:02d}T{hour:02d}Z"
            sidecar = {
                "ny": 2, "nx": 2, "units": unit, "run": "2026-09-26T00:00:00Z",
                "valid_time": f"2026-09-{day:02d}T{hour:02d}:00:00Z",
                "dtype": "float16", "endian": "little",
                "order": "north-to-south, west-to-east",
                "lat0": 0.0, "lon0": 95.0, "dlat": -0.25, "dlon": 0.25,
                "fill": -32768, "native_step_hours": 3,
                "param": {"mslp": "msl", "t850": "t", "t2m": "2t", "u10": "10u", "v10": "10v", "tp": "tp"}[variable],
            }
            write_json(run_dir / variable / f"{valid}.json", sidecar)
            size = 8 - (1 if truncated and variable == "mslp" and lead == 0 else 0)
            # 1024 hPa is an in-range little-endian float16 sample. Zeros are not.
            sample = b"\x00\x64" if variable == "mslp" else b"\x00\x00"
            (run_dir / variable / f"{valid}.f16").write_bytes((sample * 4)[:size])
    import sqlite3
    db_path = store / "products/obs/obs.sqlite"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    obs_columns = [
        "wmo INTEGER", "aifstime_utc TEXT", "product_id TEXT", "name TEXT",
        "lat REAL", "lon REAL", "air_temp REAL", "wind_dir TEXT",
        "wind_dir_deg REAL", "wind_spd_kmh REAL", "gust_kmh REAL",
        "wind_spd_kt REAL", "gust_kt REAL", "press_msl REAL",
        "press_tend TEXT", "rain_trace TEXT", "cloud_base_m REAL", "vis_km REAL",
    ]
    if missing_observation_column:
        obs_columns = [column for column in obs_columns if not column.startswith(missing_observation_column + " ")]
    connection.execute("CREATE TABLE obs (" + ", ".join(obs_columns) + ")")
    insert_columns = [column.split(" ", 1)[0] for column in obs_columns]
    placeholders = ", ".join("?" for _ in insert_columns)
    for _place, wmo, _geohash, lat, lon in check_store.DEFAULT_PLACES:
        values = {
            "wmo": int(wmo), "aifstime_utc": "20260926120000", "product_id": "IDW60901",
            "name": _place, "lat": lat, "lon": lon, "air_temp": 20, "wind_dir": "W",
            "wind_dir_deg": 270, "wind_spd_kmh": 10, "gust_kmh": 15, "wind_spd_kt": 5.4,
            "gust_kt": 8.1, "press_msl": 1015, "press_tend": "r", "rain_trace": "0.0",
            "cloud_base_m": 3000, "vis_km": 10,
        }
        connection.execute(
            "INSERT INTO obs (" + ", ".join(insert_columns) + ") VALUES (" + placeholders + ")",
            tuple(values[column] for column in insert_columns),
        )
    connection.commit()
    connection.close()
    write_json(store / "products/points/ecmwf_ifs/current.json", {
        "latest": "2026-09-26T000000Z", "runs": ["2026-09-26T000000Z"],
    })
    start = datetime(2026, 9, 26, tzinfo=timezone.utc)
    times = [(start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M:%SZ") for hour in range(96)]
    for place, _wmo, _geohash, lat, lon in check_store.DEFAULT_PLACES:
        write_json(store / "products/points/ecmwf_ifs/runs/2026-09-26T000000Z" / f"{place.lower()}.json", {
            "latitude": lat, "longitude": lon, "time": times,
            "units": {"temperature_2m": "°C", "wind_speed_10m": "kn", "wind_direction_10m": "°"},
            "hourly": {"temperature_2m": [20] * len(times), "wind_speed_10m": [10] * len(times), "wind_direction_10m": [270] * len(times)},
        })
    write_json(store / "products/kite/current.json", {
        "latest": "2026-09-26T000000Z", "runs": ["2026-09-26T000000Z"],
    })
    write_json(store / "products/kite/runs/2026-09-26T000000Z/cottesloe.json", {
        "id": "cottesloe", "hours": [], "run": "2026-09-26T00:00:00Z",
    })
    chart = store / "products/charts/IDG00073.pdf"
    chart.parent.mkdir(parents=True, exist_ok=True)
    chart.write_bytes(b"%PDF-1.7\n")
    return store


class CheckStoreTests(unittest.TestCase):
    def store(self, **kwargs):
        self.tempdir = tempfile.TemporaryDirectory()
        return make_store(Path(self.tempdir.name), **kwargs)

    def tearDown(self):
        if hasattr(self, "tempdir"):
            self.tempdir.cleanup()

    def test_ready_fixture(self):
        report = check_store.preflight(self.store(), NOW)
        self.assertTrue(report["ok"])
        self.assertTrue(report["app_consumable"])
        self.assertFalse(report["archive_present"])

    def test_daemon_only_is_distinguished_and_fails(self):
        store = self.store()
        (store / "ecmwf").rename(store / "ecmwf-legacy-missing")
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["archive_present"])
        self.assertFalse(report["app_consumable"])
        self.assertTrue(any("legacy ECMWF pointer" in item for item in report["errors"]))

    def test_truncated_float32_fails(self):
        report = check_store.preflight(self.store(truncated=True), NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("expected 32" in item for item in report["errors"]))

    def test_pointer_mismatch_fails(self):
        report = check_store.preflight(self.store(daemon_run="20260926T06Z"), NOW)
        self.assertTrue(report["ok"])
        self.assertFalse(any("pointer mismatch" in item for item in report["errors"]))

    def test_pointer_label_cannot_hide_older_loaded_manifest(self):
        report = check_store.preflight(self.store(daemon_run="20260926T06Z", old_run="20260926T06Z"), NOW)
        self.assertEqual(report["ecmwf"]["loaded_run"], "20260926T00Z")
        self.assertFalse(any("pointer mismatch" in item for item in report["errors"]))

    def test_run_only_legacy_pointer_is_supported(self):
        store = self.store()
        write_json(store / "ecmwf/latest.json", {"run": "20260926T00Z"})
        self.assertTrue(check_store.preflight(store, NOW)["ok"])

    def test_explicit_variable_requires_file_even_when_default_exists(self):
        store = self.store()
        path = store / "ecmwf/20260926T00Z/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["variables"]["msl"] = {}
        write_json(path, manifest)
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ecmwf"]["consumable"])
        self.assertTrue(any("legacy ECMWF msl" in item for item in report["errors"]))

    def test_malformed_input_fails_without_raising(self):
        store = self.store()
        (store / "products/points/qd63czw.json").write_text("{", encoding="utf-8")
        (store / "products/charts/IDG00073.pdf").write_bytes(b"broken")
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(report["ecmwf"]["consumable"])
        self.assertTrue(any("point forecast Perth coast" in item for item in report["errors"]))
        self.assertTrue(any("not a PDF" in item for item in report["errors"]))

    def test_malformed_observation_shapes_are_reported(self):
        store = self.store()
        write_json(store / "products/obs/94614.json", {"observations": []})
        write_json(store / "products/obs/94768.json", {"observations": {"data": {}}})
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertEqual(sum("observation" in item for item in report["errors"]), 2)

    def test_observation_without_temperature_can_still_be_read(self):
        store = self.store()
        write_json(store / "products/obs/94614.json", {"observations": {"data": [{"local_date_time_full": "20260926120000"}]}})
        report = check_store.preflight(store, NOW)
        self.assertFalse(any("Perth" in item and "observation" in item for item in report["errors"]))

    def test_unsafe_manifest_path_does_not_fallback(self):
        store = self.store()
        manifest_path = store / "ecmwf/20260926T00Z/manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["variables"]["msl"]["file"] = "../outside.f32"
        manifest_path.write_text(json.dumps(manifest))
        report = check_store.preflight(store, NOW)
        self.assertTrue(any("unsafe" in item for item in report["errors"]))
        self.assertFalse(report["ecmwf"]["consumable"])

    def test_daemon_pointer_is_reported_when_legacy_pointer_missing(self):
        store = self.store()
        (store / "ecmwf/latest.json").unlink()
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["app_consumable"])
        self.assertTrue(any("legacy ECMWF pointer" in item for item in report["errors"]))

    def test_missing_or_failed_unrelated_source_is_not_healthy(self):
        store = self.store()
        for value in (None, {"sources": [{"id": "open-meteo-ifs", "ok": True}]}, {"sources": [{"id": "ecmwf-open-data", "ok": False}]}, {"sources": [{"id": "ecmwf-ifs", "ok": False}]}):
            with self.subTest(value=value):
                if value is None:
                    (store / "status.json").unlink()
                else:
                    write_json(store / "status.json", value)
                report = check_store.preflight(store, NOW)
                self.assertFalse(report["source_health"]["ok"])

    def test_legacy_source_health_is_supported(self):
        store = self.store()
        write_json(store / "status.json", {"sources": [{"id": "ecmwf-ifs", "ok": True}]})
        self.assertTrue(check_store.preflight(store, NOW)["ok"])

    def test_native_published_store_is_ready_without_legacy_files(self):
        self.tempdir = tempfile.TemporaryDirectory()
        report = check_store.preflight(make_native_store(Path(self.tempdir.name)), NOW)
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual(report["ecmwf"]["mode"], "native")
        self.assertEqual(report["ecmwf"]["fields"]["mslp"], 33)
        self.assertTrue(all(report["locations"]["observations"].values()))

    def test_versioned_chart_and_warnings_are_consumable_without_legacy_files(self):
        store = self.store()
        chart = store / "products/charts/IDG00073.pdf"
        chart.unlink()
        run = store / "products/charts/runs/20260926T00Z"
        run.mkdir(parents=True)
        (run / "IDG00073.pdf").write_bytes(b"%PDF-1.7\n")
        write_json(store / "products/charts/current.json", {"latest": "20260926T00Z", "runs": ["20260926T00Z"]})
        warning_dir = store / "products/warnings/runs/20260926T00Z"
        warning_dir.mkdir(parents=True)
        (warning_dir / "IDW20100.xml").write_text("<warnings/>", encoding="utf-8")
        write_json(store / "products/warnings/current.json", {"latest": "20260926T00Z", "runs": ["20260926T00Z"]})
        report = check_store.preflight(store, NOW)
        self.assertTrue(report["ok"], report["errors"])
        self.assertTrue(report["charts"]["prognosis_pdf"])
        self.assertEqual(report["charts"]["warning_xml"], 1)

    def test_invalid_published_pointer_does_not_fallback_to_legacy_chart(self):
        store = self.store()
        write_json(store / "products/charts/current.json", {"latest": "../old"})
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertFalse(report["charts"]["prognosis_pdf"])
        self.assertTrue(any("published charts pointer" in item for item in report["errors"]))

    def test_missing_published_warning_run_does_not_fallback_to_legacy_warnings(self):
        store = self.store()
        warning_dir = store / "products/warnings"
        warning_dir.mkdir(parents=True)
        (warning_dir / "legacy.xml").write_text("<warnings/>", encoding="utf-8")
        write_json(warning_dir / "current.json", {"latest": "missing"})
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertEqual(report["charts"]["warning_xml"], 0)
        self.assertTrue(any("published warnings pointer" in item for item in report["errors"]))

    def test_observation_reader_is_query_only_and_missing_db_does_not_create(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        db_path = store / "products/obs/obs.sqlite"
        connection = check_store.open_observation_db(db_path)
        with self.assertRaises(sqlite3.OperationalError):
            connection.execute("CREATE TABLE should_not_exist (id INTEGER)")
        connection.close()
        missing = store / "products/obs/missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            check_store.open_observation_db(missing)
        self.assertFalse(missing.exists())

    def test_observation_reader_handles_idle_wal_without_writing_weather(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        db_path = store / "products/obs/obs.sqlite"
        writer = sqlite3.connect(db_path)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("UPDATE obs SET air_temp = 21 WHERE wmo = 94614")
        writer.commit()
        writer.close()
        connection = check_store.open_observation_db(db_path)
        self.assertEqual(connection.execute("SELECT air_temp FROM obs WHERE wmo = 94614").fetchone()[0], 21)
        with self.assertRaises(sqlite3.OperationalError):
            connection.execute("UPDATE obs SET air_temp = 99 WHERE wmo = 94614")
        connection.close()

    def test_observation_reader_forced_cantopen_fallback_is_safe(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        db_path = store / "products/obs/obs.sqlite"
        before = db_path.read_bytes()
        real_connect = sqlite3.connect

        class CantOpen(sqlite3.OperationalError):
            @property
            def sqlite_errorcode(self):
                return sqlite3.SQLITE_CANTOPEN

        def connect_with_idle_wal_failure(target, *args, **kwargs):
            if isinstance(target, str) and target.endswith("?mode=ro"):
                raise CantOpen("simulated idle WAL sidecar failure")
            return real_connect(target, *args, **kwargs)

        with patch.object(check_store.sqlite3, "connect", side_effect=connect_with_idle_wal_failure):
            connection = check_store.open_observation_db(db_path)
            no_checkpoint = sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE
            self.assertTrue(connection.getconfig(no_checkpoint))
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM obs").fetchone()[0], 2)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE obs SET air_temp = 99 WHERE wmo = 94614")
            connection.close()
        self.assertEqual(db_path.read_bytes(), before)

    def test_native_truncated_field_fails(self):
        self.tempdir = tempfile.TemporaryDirectory()
        report = check_store.preflight(make_native_store(Path(self.tempdir.name), truncated=True), NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("native ECMWF mslp" in item for item in report["errors"]))

    def test_native_kite_pointer_is_consumed(self):
        self.tempdir = tempfile.TemporaryDirectory()
        report = check_store.preflight(make_native_store(Path(self.tempdir.name)), NOW)
        self.assertTrue(report["kite"]["native"])
        self.assertEqual(report["kite"]["spots"], 1)

    def test_native_sidecar_dimensions_must_match(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        sidecar = store / "products/grids/ecmwf_ifs025/runs/20260926T00Z/t2m/20260926T03Z.json"
        value = json.loads(sidecar.read_text())
        value["nx"] = 3
        write_json(sidecar, value)
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("dimensions" in item for item in report["errors"]))

    def test_native_observation_must_be_recent_and_numeric(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        import sqlite3
        connection = sqlite3.connect(store / "products/obs/obs.sqlite")
        connection.execute("UPDATE obs SET aifstime_utc = '20200101000000', air_temp = 'M'")
        connection.commit()
        connection.close()
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("observation Perth coast" in item for item in report["errors"]))

    def test_native_observation_requires_full_archive_schema(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name), missing_observation_column="product_id")
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("missing required columns" in item for item in report["errors"]))

    def test_native_point_hourly_must_be_columnar_numeric_arrays(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        point = store / "products/points/ecmwf_ifs/runs/2026-09-26T000000Z/perth coast.json"
        value = json.loads(point.read_text())
        value["hourly"] = [{"temperature_2m": 20}]
        write_json(point, value)
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("surface point within 30km of Perth coast" in item for item in report["errors"]))

    def test_boolean_temperature_is_not_a_measurement(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        point = store / "products/points/ecmwf_ifs/runs/2026-09-26T000000Z/perth coast.json"
        value = json.loads(point.read_text())
        self.assertTrue(check_store.surface_point_valid(value, NOW))
        value["hourly"]["temperature_2m"] = [True] * len(value["time"])
        self.assertFalse(check_store.surface_point_valid(value, NOW))
        write_json(point, value)
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("Perth coast" in item for item in report["errors"]))

    def test_closer_invalid_point_does_not_hide_a_valid_series(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        run = store / "products/points/ecmwf_ifs/runs/2026-09-26T000000Z"
        valid = json.loads((run / "perth coast.json").read_text())
        closer = json.loads((run / "perth coast.json").read_text())
        closer["hourly"]["temperature_2m"] = [True] * len(closer["time"])
        write_json(run / "perth coast.json", closer)
        valid["longitude"] = valid["longitude"] + 0.12
        write_json(run / "perth-farther.json", valid)
        report = check_store.preflight(store, NOW)
        self.assertTrue(report["locations"]["point_forecasts"]["Perth coast"], report["errors"])
        self.assertTrue(report["ok"], report["errors"])

    def test_short_or_stale_point_series_is_not_ready(self):
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        run = store / "products/points/ecmwf_ifs/runs/2026-09-26T000000Z"
        for count, ready in ((71, False), (72, True)):
            with self.subTest(hours=count):
                start = NOW
                times = [(start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M:%SZ") for hour in range(count)]
                for place, _wmo, _geohash, lat, lon in check_store.DEFAULT_PLACES:
                    write_json(run / f"{place.lower()}.json", {
                        "latitude": lat, "longitude": lon, "time": times,
                        "units": {"temperature_2m": "°C", "wind_speed_10m": "kn", "wind_direction_10m": "°"},
                        "hourly": {"temperature_2m": [20] * count, "wind_speed_10m": [10] * count, "wind_direction_10m": [270] * count},
                    })
                report = check_store.preflight(store, NOW)
                self.assertEqual(report["ok"], ready, report["errors"])
        stale_now = check_store.iso("2026-09-27T13:00:00Z")
        report = check_store.preflight(store, stale_now)
        self.assertFalse(report["ok"])
        self.assertTrue(any("stale" in item and "36" in item for item in report["errors"]))
        self.assertFalse(any("not consumed by this app" in item for item in report["warnings"]))

    def test_native_mslp_must_be_finite_and_in_range(self):
        check_store.validate_mslp_grid(b"\x00\x64" * 4)
        check_store.validate_mslp_grid(b"\x00\xf8" + b"\x00\x64" * 3)
        for payload in (b"\x00\x7c" * 4, b"\x00\x00" * 4, b"\x00\xf8" * 4):
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, "non-finite or out of range|no finite"):
                    check_store.validate_mslp_grid(payload)
        self.tempdir = tempfile.TemporaryDirectory()
        store = make_native_store(Path(self.tempdir.name))
        (store / "products/grids/ecmwf_ifs025/runs/20260926T00Z/mslp/20260926T00Z.f16").write_bytes(b"\x00\x00" * 4)
        report = check_store.preflight(store, NOW)
        self.assertFalse(report["ok"])
        self.assertTrue(any("out of range" in item for item in report["errors"]))
        self.assertFalse(any("not consumed by this app" in item for item in report["warnings"]))


if __name__ == "__main__":
    unittest.main()
