import importlib.util
import io
import struct
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("everest", HERE / "tools/history/prepare_everest_imagery.py")
everest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(everest)


class Response:
    def __init__(self, status, body, content_range):
        self.status_code, self.headers = status, {"Content-Range": content_range}
        self.raw = io.BytesIO(body)

    def close(self):
        pass


class Session:
    def __init__(self, response):
        self.response = response

    def get(self, *args, **kwargs):
        return self.response


class EverestImageryTests(unittest.TestCase):
    def test_range_rejects_unbounded_or_mismatched_responses(self):
        for response in (Response(200, b"1234", "bytes 0-3/4"), Response(206, b"1234", "bytes 1-4/4")):
            with self.assertRaises(RuntimeError):
                everest.get_range(Session(response), "https://example.invalid/a", 0, 3)

    def test_utm_forward_matches_known_everest_zone(self):
        east, north = everest.utm_forward(86.9250, 27.9881, 45)
        self.assertAlmostEqual(east, 492632, delta=100)
        self.assertAlmostEqual(north, 3095886, delta=100)

    def test_radiometry_and_nodata_are_explicit(self):
        rgb, nodata = everest.render_rgb([np.array([[0, 10000]], dtype=np.uint16)] * 3, [{"scale": 0.0001, "offset": -0.1, "nodata": 0}] * 3)
        self.assertTrue(nodata[0, 0])
        self.assertEqual(tuple(rgb[0, 0]), (0, 0, 0))
        self.assertGreater(int(rgb[0, 1, 0]), 200)

    def test_stac_scale_offset_not_solar_factor(self):
        band = everest.band_radiometry({"raster:bands": [{"scale": .0001, "offset": -.1, "nodata": 0}]})
        rgb, missing = everest.render_rgb([np.array([[0, 1000, 11000]], dtype=np.uint16)] * 3, [band] * 3)
        self.assertEqual(rgb[0, 1].tolist(), [0, 0, 0])
        self.assertEqual(rgb[0, 2].tolist(), [255, 255, 255])
        self.assertFalse(missing[0, 1])
        with self.assertRaises(RuntimeError):
            everest.band_radiometry({"raster:bands": [{"scale": .0001}]})

    def test_tiff_rational_and_header_validation(self):
        head = bytearray(65536)
        struct.pack_into("<4sI", head, 0, b"II*\0", 8)
        tags = [(256, 4, 1, 2), (257, 4, 1, 2), (258, 3, 1, 16), (259, 3, 1, 8),
                (277, 3, 1, 1), (317, 3, 1, 2), (322, 3, 1, 1024), (323, 3, 1, 1024),
                (324, 4, 1, 4000), (325, 4, 1, 1), (339, 3, 1, 1),
                (282, 5, 1, 1200), (33550, 12, 3, 1000), (33922, 12, 6, 1024), (34735, 3, 4, 1120)]
        struct.pack_into("<H", head, 8, len(tags))
        for i, (tag, typ, count, value) in enumerate(tags):
            p = 10 + i * 12
            struct.pack_into("<HHI", head, p, tag, typ, count)
            if typ == 3 and count == 1:
                struct.pack_into("<H", head, p + 8, value)
            else:
                struct.pack_into("<I", head, p + 8, value)
        struct.pack_into("<II", head, 1200, 300, 2)
        struct.pack_into("<ddd", head, 1000, 10.0, 10.0, 0.0)
        struct.pack_into("<dddddd", head, 1024, 0.0, 0.0, 0.0, 399960.0, 3200040.0, 0.0)
        struct.pack_into("<HHHH", head, 1120, 1, 1, 0, 0)
        _, parsed = everest.tiff_header(Session(Response(206, bytes(head), "bytes 0-65535/99999")), "x")
        self.assertEqual(parsed[282], 150.0)
        self.assertEqual(parsed[33550][0], 10.0)
        self.assertEqual(parsed[33922][3], 399960.0)


if __name__ == "__main__":
    unittest.main()
