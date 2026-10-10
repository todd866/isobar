from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from numcodecs import Blosc

sys.path.insert(0, str(Path(__file__).parents[1] / "tools/history"))
import import_arco
from import_arco import Archive, VARIABLES, dates


def args_for(root, output, step=5):
    return types.SimpleNamespace(start_date="1944-06-06", end_date="1944-06-06", step=step,
                                 max_mb=512, cache=root, output=output, event_id="dday", label="D-Day")


class FakeArchive:
    def __init__(self, cache, max_bytes):
        self.receipts = {}
        self.downloaded = 0
        self.source_times = np.array([-219144, -219143, 389447, *range(389448, 389472)], dtype="<i8")
        self.source_lat = np.arange(90, -90.01, -0.25)
        self.source_lon = np.arange(0, 360, 0.25)

    def meta(self, path):
        if path == ".zattrs":
            return {"valid_time_start": "1940-01-01T00:00:00Z", "valid_time_stop": "2026-12-31T23:00:00Z"}
        if path == "time/.zattrs":
            return {"units": "hours since 1900-01-01 00:00:00", "calendar": "proleptic_gregorian"}
        if path.endswith("/.zarray") and path.split("/")[0] == "time":
            return {"zarr_format": 2, "shape": [len(self.source_times)], "chunks": [len(self.source_times)], "filters": None,
                    "dtype": "<i8", "order": "C", "compressor": None}
        if path.endswith("/.zarray"):
            return {"zarr_format": 2, "shape": [len(self.source_times), 721, 1440], "chunks": [1, 721, 1440],
                    "dtype": "<f4", "order": "C", "filters": None, "compressor": None}
        name = path.split("/")[0]
        units = {"mean_sea_level_pressure": "Pa", "10m_u_component_of_wind": "m s**-1",
                 "10m_v_component_of_wind": "m s**-1", "2m_temperature": "K"}
        return {"units": units[name], "_ARRAY_DIMENSIONS": ["time", "latitude", "longitude"]}

    def coordinate(self, name):
        return {"time": self.source_times, "latitude": self.source_lat, "longitude": self.source_lon}[name]

    def decode(self, path, meta):
        if path.startswith("time/"):
            return self.source_times
        name, index = path.split("/")[0], int(path.split("/")[1].split(".")[0])
        values = {"mean_sea_level_pressure": 101325, "10m_u_component_of_wind": 1,
                  "10m_v_component_of_wind": 2, "2m_temperature": 273.15}
        grid = np.full((1, 721, 1440), values[name] + index, dtype="<f4")
        # The first and last latitude and source longitude 180 are sentinels.
        grid[0, 0, 720] = values[name] + 10
        grid[0, -1, 720] = values[name] + 20
        return grid


class ArcoTests(unittest.TestCase):
    def test_real_coordinate_chunk_decoding_retains_negative_time_offsets(self):
        original = np.array([-219144, -219143, 0, 389448], dtype="<i8")
        codec = Blosc(cname="lz4", clevel=5, shuffle=1)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "time").mkdir()
            (root / "time/0").write_bytes(codec.encode(original))
            actual = Archive(root, 0).decode("time/0", {"chunks": [4], "dtype": "<i8", "order": "C", "compressor": codec.get_config()})
            np.testing.assert_array_equal(actual, original)

    def test_import_uses_source_time_value_and_emits_complete_global_day(self):
        with tempfile.TemporaryDirectory() as temp:
            root, output = Path(temp) / "cache", Path(temp) / "weather.json"
            with patch.object(import_arco, "Archive", FakeArchive):
                result = import_arco.import_data(args_for(root, output))
            self.assertEqual(len(result["times"]), 24)
            self.assertEqual(result["times"][0], "1944-06-06T00:00Z")
            self.assertEqual(result["times"][-1], "1944-06-06T23:00Z")
            self.assertEqual(len(result["frames"][0]["pressure_msl"]), 2664)
            self.assertEqual(result["grid"]["latitudes"][0], 90)
            self.assertEqual(result["grid"]["latitudes"][-1], -90)
            self.assertEqual(result["units"], {"pressure_msl": "hPa", "u": "knots", "v": "knots", "temperature": "°C"})
            frame = result["frames"][0]
            self.assertAlmostEqual(frame["pressure_msl"][0], 1013.35)
            self.assertAlmostEqual(frame["pressure_msl"][-72], 1013.45)
            self.assertTrue(output.is_file())

    def test_rejects_missing_data_and_source_unit_mismatch(self):
        class BadArchive(FakeArchive):
            bad_units = False
            missing = False

            def meta(self, path):
                value = super().meta(path)
                if self.bad_units and path == "mean_sea_level_pressure/.zattrs":
                    value["units"] = "hPa"
                return value

            def decode(self, path, meta):
                value = super().decode(path, meta)
                if self.missing and path.startswith("mean_sea_level_pressure/"):
                    value[0, 0, 0] = np.nan
                return value

        with tempfile.TemporaryDirectory() as temp:
            with patch.object(import_arco, "Archive", BadArchive), self.assertRaises(ValueError):
                BadArchive.bad_units = True
                import_arco.import_data(args_for(Path(temp) / "cache", Path(temp) / "out.json"))
            with patch.object(import_arco, "Archive", BadArchive), self.assertRaises(ValueError):
                BadArchive.bad_units = False
                BadArchive.missing = True
                import_arco.import_data(args_for(Path(temp) / "cache2", Path(temp) / "out2.json"))

    def test_corrupt_source_chunk_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bad").write_bytes(b"bad")
            with self.assertRaises(ValueError):
                Archive(root, 0).decode("bad", {"chunks": [4], "dtype": "<i8", "order": "C", "compressor": None})

    def test_no_budget_means_no_network_request(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch("import_arco.admit"), patch("import_arco.urlopen") as network:
                with self.assertRaises(RuntimeError):
                    Archive(Path(temp), 0).get("field/0.0.0")
                network.assert_not_called()

    def test_dates_include_leap_day_and_cap_request(self):
        self.assertEqual(len(dates("1944-02-28", "1944-03-01")), 72)
        with self.assertRaises(ValueError):
            dates("1944-06-01", "1944-06-08")
        with self.assertRaises(ValueError):
            dates("1944-06-07", "1944-06-06")

    def test_units_keep_northward_wind_positive(self):
        self.assertAlmostEqual(101325 * VARIABLES["pressure_msl"][1], 1013.25)
        self.assertAlmostEqual(273.15 + VARIABLES["temperature"][2], 0)
        self.assertGreater(10 * VARIABLES["v"][1], 0)


if __name__ == "__main__":
    unittest.main()
