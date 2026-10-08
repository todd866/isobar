import importlib.util
import io
import json
import struct
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("global_parity", ROOT / "tools/check-global-parity.py")
parity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)


class GlobalParityTests(unittest.TestCase):
    def write_fixture(self, root: Path, mismatch=False, missing=False):
        old = (parity.NX, parity.NY, parity.CELLS, parity.SCHEMA2)
        parity.NX, parity.NY, parity.CELLS, parity.SCHEMA2 = 3, 2, 6, [0]
        latest = "20260102T00Z"
        prior = "20260101T00Z"
        store = root / "store"
        web = root / "web"
        for run in (latest, prior):
            (store / "products/grids/ecmwf_ifs_global/runs" / run).mkdir(parents=True)
        family = store / "products/grids/ecmwf_ifs_global"
        pointer = {"schema_version": 2, "contract": "isobar-data", "family": "grids/ecmwf_ifs_global", "latest": latest, "runs": [prior, latest], "forecast_hours": [0], "horizon_hours": 0, "uniform_step_hours": None}
        (family / "current.json").write_text(json.dumps(pointer))
        grid = {"west": -180, "east": 179.5, "north": 90, "south": -90, "step": 0.5, "nx": 3, "ny": 2, "dtype": "float16", "wraps_longitude": True}
        for run in (latest, prior):
            rd = family / "runs" / run
            run_iso = "2026-01-02T00:00:00Z"
            (rd / "manifest.json").write_text(json.dumps({**pointer, "run": run_iso, "grid": grid, "schema": 2}))
            for var in ("mslp", "t2m", "u10", "v10", "tp"):
                (rd / var).mkdir()
                values = np.array([1000, 1001, 1002, 1003, 1004, 1005], dtype="<f2")
                if var in ("u10", "v10"): values = np.zeros(6, dtype="<f2")
                if var == "tp": values = np.arange(6, dtype="<f2") + (10 if run == latest else 0)
                values.tofile(rd / var / f"{run}.f16")
                (rd / var / f"{run}.json").write_text(json.dumps({"units": "mm", "run": "2026-01-02T00:00:00Z", "valid_time": "2026-01-02T00:00:00Z", "nx": 3, "ny": 2, "dtype": "float16", "endian": "little"}))
                if run == prior and var == "tp":
                    (rd / var / "20260102T00Z.f16").write_bytes((np.array([10, 11, 12, 13, 14, 15], dtype="<f2")).tobytes())
        data = web / "data"
        data.mkdir(parents=True)
        entries = {}
        for var, values in (("mslp", [1000,1001,1002,1003,1004,1005]), ("t2m", [1000,1001,1002,1003,1004,1005]), ("wind", [0]*6), ("rain24", [10]*6)):
            if var == "wind":
                values = [0] * 6
            if mismatch and var == "mslp": values[0] += 10
            packed = np.array(values, dtype="<u2")
            frame = f"{var}.u16"
            packed.tofile(data / frame)
            units = {"mslp": "hPa", "t2m": "C", "wind": "kt", "rain24": "mm"}[var]
            entries[var] = {"frames": [frame], "units": units, "scale": 1, "offset": 0, "fill": 65535}
        manifest = {"schema": 2, "contract": "isobar-web", "run": "2026-01-02T00:00:00Z", "forecast_hours": [0], "grid": grid, "variables": entries}
        (data / "manifest.json").write_text(json.dumps(manifest))
        return old, store, data

    def run_fixture(self, root, mismatch=False, missing=False):
        old, store, web = self.write_fixture(root, mismatch=mismatch)
        return self.run_existing(root, old, store, web)

    def run_existing(self, root, old, store, web):
        try:
            with patch.object(parity, "NX", 3), patch.object(parity, "NY", 2), patch.object(parity, "CELLS", 6), patch.object(parity, "SCHEMA2", [0]):
                output = io.StringIO()
                with redirect_stdout(output):
                    parity.main(["--store", str(store), "--web-data", str(web), "--json"])
                report = json.loads(output.getvalue())
            return report
        finally:
            parity.NX, parity.NY, parity.CELLS, parity.SCHEMA2 = old

    def test_positive_shared_archive_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_fixture(Path(temp))
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["totals"]["mismatches"], 0)

    def test_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_fixture(Path(temp), mismatch=True)
            self.assertFalse(report["ok"])
            self.assertIn("mslp differs", report["checks"][0]["detail"])

    def test_missing_mask_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, store, web = self.write_fixture(root)
            packed = np.fromfile(root / "web/data/mslp.u16", dtype="<u2")
            packed[0] = 65535
            packed.tofile(root / "web/data/mslp.u16")
            report = self.run_existing(root, old, store, web)
            self.assertFalse(report["ok"])
            self.assertIn("missing mask differs", report["checks"][0]["detail"])

    def test_global_wrap_and_dateline_geometry_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, store, web = self.write_fixture(root)
            manifest_path = root / "web/data/manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["grid"]["wraps_longitude"] = False
            manifest_path.write_text(json.dumps(manifest))
            report = self.run_existing(root, old, store, web)
            self.assertFalse(report["ok"])
            manifest["variables"]["mslp"]["scale"] = 1
            manifest_path.write_text(json.dumps(manifest))
            native_manifest = store / "products/grids/ecmwf_ifs_global/runs/20260102T00Z/manifest.json"
            native = json.loads(native_manifest.read_text()); native["run"] = "2026-01-01T00:00:00Z"; native_manifest.write_text(json.dumps(native))
            report = self.run_existing(root, old, store, web)
            self.assertFalse(report["ok"])
            self.assertIn("exact global grid", report["checks"][0]["detail"])

    def test_bad_scale_and_native_run_identity_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, store, web = self.write_fixture(root)
            manifest_path = web / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["variables"]["mslp"]["scale"] = float("nan")
            manifest_path.write_text(json.dumps(manifest))
            report = self.run_existing(root, old, store, web)
            self.assertFalse(report["ok"])

    def test_rain_reset_threshold_matches_collector_policy(self):
        end = np.array([0.0, 0.0, 0.0, 0.0])
        start = np.array([0.049, 0.05, np.nextafter(0.05, np.inf), 1.0])
        values, missing = parity.accumulation_window(end, start, np.zeros(4, bool), np.zeros(4, bool))
        self.assertAlmostEqual(values[0], 0.0)
        self.assertAlmostEqual(values[1], 0.0)
        self.assertLess(values[2], -0.05)
        self.assertAlmostEqual(values[3], -1.0)
        self.assertEqual(missing.tolist(), [False, False, True, True])

    def test_input_file_mutation_fails_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, store, web = self.write_fixture(root)
            original = parity.web_frame
            changed = {"done": False}
            def mutate_after_read(path, entry, shape, snapshot=None):
                result = original(path, entry, shape, snapshot)
                if not changed["done"]:
                    path.write_bytes(path.read_bytes() + b"x")
                    changed["done"] = True
                return result
            with patch.object(parity, "web_frame", side_effect=mutate_after_read):
                report = self.run_existing(root, old, store, web)
            self.assertFalse(report["ok"])
            self.assertIn("changed during parity read", report["checks"][0]["detail"])

    def test_repeated_snapshot_read_cannot_overwrite_original_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "frame"
            snapshot = {}
            path.write_bytes(b"first")
            parity.record_snapshot(path, path.read_bytes(), snapshot)
            path.write_bytes(b"second")
            with self.assertRaisesRegex(ValueError, "changed during parity read"):
                parity.record_snapshot(path, path.read_bytes(), snapshot)

    def test_shuffle_decode_and_missing_mask(self):
        values = np.array([0x1234, 0xABCD], dtype="<u2")
        encoded = bytes([0x12, 0xAB, 0x34, 0xCD])
        self.assertTrue(np.array_equal(np.frombuffer(parity.inverse_shuffle_u16(encoded), dtype="<u2"), values))


if __name__ == "__main__":
    unittest.main()
