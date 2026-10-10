import copy
import importlib.util
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "tools/history/import_weather.py"
SPEC = importlib.util.spec_from_file_location("import_weather", MODULE_PATH)
weather = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = weather
SPEC.loader.exec_module(weather)


def raw_payload(points=None):
    points = points or weather.POINTS
    times = weather.expected_times()
    result = []
    for lat, lon in points:
        result.append({
            "latitude": lat, "longitude": lon,
            "hourly_units": {"pressure_msl": "hPa", "wind_speed_10m": "kn", "wind_direction_10m": "°", "temperature_2m": "°C"},
            "hourly": {"time": times,
                       "pressure_msl": [1000 + i for i in range(120)],
                       "wind_speed_10m": [10.0] * 120,
                       "wind_direction_10m": [90.0] * 120,
                       "temperature_2m": [15.0] * 120},
        })
    return result if len(result) != 1 else result[0]


class HistoryWeatherTests(unittest.TestCase):
    def test_normalizes_91_points_and_converts_meteorological_wind(self):
        output = weather.normalize_payload(raw_payload())
        self.assertEqual(len(output["grid"]["points"]), 91)
        self.assertEqual(output["grid"]["nx"], 13)
        self.assertEqual(output["grid"]["ny"], 7)
        self.assertEqual(len(output["times"]), 120)
        self.assertEqual(output["frames"][0]["pressure_msl"][0], 1000)
        self.assertAlmostEqual(output["frames"][0]["u"][0], -10.0)
        self.assertAlmostEqual(output["frames"][0]["v"][0], 0.0, places=8)
        self.assertEqual(output["units"]["u"], "knots")
        self.assertEqual(output["provenance"]["returned"], {"point_count": 91, "hour_count": 120})

    def test_rejects_missing_nonfinite_wrong_units_and_wrong_time_length(self):
        for mutation in ("missing", "nonfinite", "units", "length", "times"):
            payload = raw_payload()
            body = payload[0]
            if mutation == "missing":
                del body["hourly"]["temperature_2m"]
            elif mutation == "nonfinite":
                body["hourly"]["pressure_msl"][4] = float("nan")
            elif mutation == "units":
                body["hourly_units"]["wind_speed_10m"] = "m/s"
            elif mutation == "length":
                body["hourly"]["wind_direction_10m"] = body["hourly"]["wind_direction_10m"][:-1]
            else:
                body["hourly"]["time"][0] = "1944-06-03T01:00Z"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                weather.normalize_payload(payload)

    def test_requests_are_explicit_and_bounded(self):
        url = weather.request_url(weather.POINTS[:20])
        self.assertIn("model=era5", url)
        self.assertIn("wind_speed_unit=kn", url)
        self.assertEqual(len(weather.POINTS), 91)
        with self.assertRaises(ValueError):
            weather.request_url(weather.POINTS[:21])

    def test_custom_event_grid_and_date_range_are_supported_and_capped(self):
        config = weather.make_config("1944-06-03", "1944-06-03", west=0, east=1, south=0, north=1,
                                     step=1, event_id="test", event_label="Test event")
        payload = raw_payload(config["points"])
        for body in payload:
            body["hourly"]["time"] = weather.expected_times(config["start_date"], config["end_date"])
            for key in weather.VARIABLES:
                if key != "time":
                    body["hourly"][key] = body["hourly"][key][:24]
        output = weather.normalize_payload(payload, config=config)
        self.assertEqual(output["event"]["id"], "test")
        self.assertEqual(len(output["grid"]["points"]), 4)
        self.assertEqual(len(output["frames"]), 24)
        with self.assertRaises(ValueError):
            weather.make_config("1944-06-01", "1944-06-08")
        with self.assertRaises(ValueError):
            weather.make_config(west=0, east=20, south=0, north=20, step=1)

    def test_write_is_atomic_and_json_disallows_nonfinite(self):
        value = weather.normalize_payload(raw_payload())
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "history.json"
            weather.write_atomic(value, destination)
            decoded = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(decoded["event"]["id"], "dday")
            self.assertFalse(any(math.isnan(item) for item in decoded["frames"][0]["u"]))


if __name__ == "__main__":
    unittest.main()
