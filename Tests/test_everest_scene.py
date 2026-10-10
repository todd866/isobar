import json
import unittest
from pathlib import Path


SCENE = Path(__file__).parents[1] / 'tools/history/everest-1953-scene.json'


class EverestSceneTests(unittest.TestCase):
    def test_everest_scene_keeps_approximate_route_and_documentary_time_semantics(self):
        scene = json.loads(SCENE.read_text())
        assert scene['event']['id'] == 'everest-1953'
        assert scene['geography']['route_classification'].startswith('approximate schematic')
        camp9 = next(item for item in scene['documentary_temperature_anchors']['records'] if item['place'] == 'Camp 9')
        assert camp9['date'] == '1953-05-29'
        assert camp9['temperature_c'] == -27.2
        assert camp9['time_local_published'] == '03:00'
        assert 'timezone' in scene['documentary_temperature_anchors']['interpretation']
        assert all('utc' not in record for record in scene['documentary_temperature_anchors']['records'])


    def test_everest_scene_source_receipt_is_explicit(self):
        receipt = json.loads(SCENE.read_text())['documentary_temperature_anchors']['source_receipt']
        assert receipt['url'].startswith('https://www.cambridge.org/')
        assert len(receipt['sha256']) == 64
        assert receipt['bytes'] > 0
        assert receipt['locator'].startswith('Journal of Glaciology, Table II')


if __name__ == "__main__":
    unittest.main()
