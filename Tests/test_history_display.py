import hashlib
import json
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'history'))
from prepare_display_weather import prepare, quantize_weather


def product():
    frames = []
    for hour in range(24):
        frames.append({
            'time': f'1915-04-25T{hour:02d}:00Z',
            'pressure_msl': [1000.04 + hour / 10, 1001.06 + hour / 10, 1002.01 + hour / 10, 1003.09 + hour / 10],
            'u': [1.04, 2.06, 3.01, 4.09], 'v': [-1.04, -2.06, -3.01, -4.09],
            'temperature': [10.04, 11.06, 12.01, 13.09],
        })
    return {'schema_version': 1, 'product': 'isobar-historical-weather',
            'event': {'id': 'test', 'label': 'Test', 'start_date': '1915-04-25', 'end_date': '1915-04-25'},
            'grid': {'latitudes': [1, 0], 'longitudes': [0, 1], 'nx': 2, 'ny': 2,
                     'order': 'north-to-south, west-to-east', 'step_degrees': 1, 'wraps_longitude': False},
            'times': [frame['time'] for frame in frames], 'frames': frames,
            'units': {'pressure_msl': 'hPa', 'u': 'knots', 'v': 'knots', 'temperature': '°C'},
            'provenance': {'source': 'fixture'}}


class DisplayWeatherTests(unittest.TestCase):
    def test_rounding_is_bounded_and_records_source(self):
        source = product()
        result = quantize_weather(source, 'abc123', 42, 1)
        self.assertEqual(result['provenance']['display_quantization']['source_sha256'], 'abc123')
        self.assertEqual(result['provenance']['display_quantization']['source_bytes'], 42)
        self.assertEqual(result['frames'][0]['pressure_msl'], [1000.0, 1001.1, 1002.0, 1003.1])
        self.assertLessEqual(result['provenance']['display_quantization']['max_abs_rounding_error'], 0.05)

    def test_prepare_preserves_full_precision_input(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / 'full.json'
            output_path = Path(directory) / 'display.json'
            raw = json.dumps(product(), separators=(',', ':')).encode()
            source_path.write_bytes(raw)
            prepare(source_path, output_path, 1)
            self.assertEqual(hashlib.sha256(source_path.read_bytes()).hexdigest(), hashlib.sha256(raw).hexdigest())
            self.assertNotEqual(source_path.read_bytes(), output_path.read_bytes())


if __name__ == '__main__':
    unittest.main()
