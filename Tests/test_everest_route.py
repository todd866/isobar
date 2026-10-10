import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "tools" / "history"))
from prepare_everest_route import STAGES, reconstruct


class TerrainFixture:
    def sample(self, lon, lat):
        # A bounded synthetic DEM fixture with a ridge and a saddle. The live
        # acquisition uses the same sampler contract with retained Terrarium tiles.
        return 5200 + (lat - 27.97) * 25000 + (lon - 86.85) * 9000 + 420 * __import__('math').sin((lon - 86.85) * 180) * __import__('math').sin((lat - 27.96) * 220)


class EverestRouteTests(unittest.TestCase):
    def test_dense_route_contains_named_corridor(self):
        points = reconstruct(TerrainFixture())
        self.assertGreater(len(points), len(STAGES) * 4)
        self.assertEqual(points[0]["stage"], STAGES[0][0])
        self.assertEqual(points[-1]["stage"], STAGES[-1][0])
        self.assertTrue(all(point["synthetic"] for point in points))
        self.assertTrue({point["stage"] for point in points}.issuperset(stage[0] for stage in STAGES))

    def test_steps_are_bounded_and_path_is_not_anchor_straight_line(self):
        points = reconstruct(TerrainFixture())
        distances = [((b["lon"] - a["lon"]) * 98000) ** 2 + ((b["lat"] - a["lat"]) * 111132) ** 2 for a, b in zip(points, points[1:])]
        self.assertLess(max(distances) ** .5, 140)
        headings = {round(__import__('math').atan2(b["lon"] - a["lon"], b["lat"] - a["lat"]), 3) for a, b in zip(points, points[1:])}
        self.assertGreater(len(headings), 3)

    def test_published_geometry_is_continuous_and_visits_every_corridor_gate(self):
        path = Path(__file__).parents[1] / "web/src/lib/terrain/everest-route.json"
        route = json.loads(path.read_text())
        points = route["points"]
        def distance(a, b):
            return math.hypot((b["lon"]-a["lon"])*98000, (b["lat"]-a["lat"])*111132)
        steps = [distance(a,b) for a,b in zip(points,points[1:])]
        self.assertGreater(min(steps), 1)
        self.assertLess(max(steps), 76)
        self.assertTrue(8000 < sum(steps) < 20000)
        for gate in route["receipt"]["stage_anchors"]:
            self.assertLess(min(distance(gate,p) for p in points), 1)
        self.assertTrue(all(5000 < p["elevation_m"] < 9000 for p in points))
        self.assertTrue(all(27.95 < p["lat"] < 28.01 and 86.84 < p["lon"] < 86.94 for p in points))

    def test_missing_dem_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "missing DEM"):
            reconstruct(type("Missing", (), {"sample": lambda *_: None})())


if __name__ == "__main__":
    unittest.main()
