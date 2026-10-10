import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1] / "tools" / "history"))
import prepare_everest_material as material


class EverestMaterialTests(unittest.TestCase):
    def test_bounds_contain_all_route_anchors(self):
        window = material.route_pixel_bounds()
        for lat, lon in material.ROUTE_ANCHORS:
            e, n = material.utm_forward(lon, lat, 45)
            x, y = (e - material.TIE_E) / 10, (material.TIE_N - n) / 10
            self.assertGreaterEqual(x, window["x"])
            self.assertLessEqual(x, window["x"] + window["width"])
            self.assertGreaterEqual(y, window["y"])
            self.assertLessEqual(y, window["y"] + window["height"])

    def test_bounded_rgba_crop_and_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            tags = {256: 10980, 257: 10980, 33550: (10.0, 10.0, 0.0), 33922: (0, 0, 0, 399960.0, 3200040.0), 34735: (1, 1, 0, 1, 3072, 0, 1, 32645)}
            item = {"id": material.SCENE_ID, "properties": {"proj:epsg": 32645, "datetime": "2026-10-03T05:00:49Z"}, "assets": {"blue": {"href": "https://example.test/b02.tif", "raster:bands": [{"scale": .0001, "offset": 0, "nodata": 0}]}, "green": {"href": "https://example.test/b03.tif", "raster:bands": [{"scale": .0001, "offset": 0, "nodata": 0}]}, "red": {"href": "https://example.test/b04.tif", "raster:bands": [{"scale": .0001, "offset": 0, "nodata": 0}]}}}

            def fake_header(_session, _url):
                return b"header", tags

            def fake_band(_session, _url, _x, _y, size):
                return np.full((size, size), 1000, dtype=np.uint16), b"header", tags

            with patch.object(material, "stac_item", return_value=item), patch.object(material, "tiff_header", fake_header), patch.object(material, "tiff_epsg", return_value=32645), patch.object(material, "read_band", fake_band):
                result = material.prepare(Path(tmp))
            with Image.open(result["png"]) as image:
                self.assertEqual(image.size, (2048, 2048))
                self.assertEqual(image.mode, "RGBA")
            receipt = json.loads(Path(result["receipt"]).read_text())
            self.assertEqual(receipt["projection"], "EPSG:32645")
            self.assertEqual(receipt["scene_date"], "2026-10-03")
            self.assertEqual(receipt["acquisition_datetime"], "2026-10-03T05:00:49Z")
            self.assertEqual(len(receipt["source_header_sha256"]), 3)
            self.assertIn("geographic_bounds_wgs84", receipt)

    def test_nodata_is_transparent(self):
        with tempfile.TemporaryDirectory() as tmp:
            tags = {256: 10980, 257: 10980, 33550: (10.0, 10.0, 0.0), 33922: (0, 0, 0, 399960.0, 3200040.0), 34735: (1, 1, 0, 1, 3072, 0, 1, 32645)}
            item = {"id": material.SCENE_ID, "properties": {"proj:epsg": 32645, "datetime": "2026-10-03T05:00:49Z"}, "assets": {n: {"href": f"https://example.test/{b:02d}.tif", "raster:bands": [{"scale": .0001, "offset": 0, "nodata": 0}]} for n, b in (("blue", 2), ("green", 3), ("red", 4))}}
            with patch.object(material, "stac_item", return_value=item), patch.object(material, "tiff_header", return_value=(b"h", tags)), patch.object(material, "tiff_epsg", return_value=32645), patch.object(material, "read_band", return_value=(np.zeros((2048, 2048), dtype=np.uint16), b"h", tags)):
                result = material.prepare(Path(tmp))
            with Image.open(result["png"]) as image:
                alpha = np.asarray(image)[..., 3]
            self.assertEqual(int(alpha.max()), 0)


if __name__ == "__main__":
    unittest.main()
