import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

from wall import publish_raw, render

STORE = Path(os.environ["ISOBAR_WALL_STORE"]) if os.environ.get("ISOBAR_WALL_STORE") else None
NOW = datetime(2026, 9, 27, 4, tzinfo=timezone.utc)


def make_point_store(root: Path, precipitation=None, wind_speed=6, wind_direction=90):
    for name in ("ecmwf_ifs", "marine"):
        pointer = root / "products/points" / name
        pointer.mkdir(parents=True)
        run = "20260927T0000Z"
        (pointer / "current.json").write_text(json.dumps({"latest": run, "runs": [run]}))
        times = [(NOW.replace(minute=0) + render.timedelta(hours=i)).isoformat() for i in range(14)]
        values = {"time": times, "hourly": {}}
        if name == "ecmwf_ifs":
            values["units"] = {"precipitation": "mm", "wind_speed_10m": "kn", "wind_direction_10m": "°"}
            values["hourly"] = {"precipitation": precipitation if precipitation is not None else [1.0] * 14,
                                "wind_speed_10m": [wind_speed] * 14, "wind_direction_10m": [wind_direction] * 14}
        else:
            values["units"] = {"wave_height": "m", "wave_period": "s", "wave_direction": "°"}
            values["hourly"] = {"wave_height": [1.0] * 13, "wave_period": [12.0] * 13, "wave_direction": [225] * 13}
        run_dir = pointer / "runs" / run
        run_dir.mkdir(parents=True)
        (run_dir / "cottesloe.json").write_text(json.dumps(values))


class WallRenderTests(unittest.TestCase):
    def test_current_pointer_rejects_unlisted_and_traversing_latest(self):
        with tempfile.TemporaryDirectory() as temp:
            pointer = Path(temp) / "products/points/ecmwf_ifs"
            pointer.mkdir(parents=True)
            (pointer / "current.json").write_text(json.dumps({"latest": "../escape", "runs": ["../escape"]}))
            with self.assertRaises(render.RenderError):
                render.current_pointer(Path(temp), "ecmwf_ifs")

    def test_point_conditions_require_units_and_reject_nan_bool_and_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp); (store / "manifest.json").write_text("{}")
            values = [1.0] * 14; values[2] = None
            make_point_store(store, precipitation=values, wind_speed=True, wind_direction=float("nan"))
            conditions = render.point_conditions(store, NOW)
            self.assertIsNone(conditions["rain"]["mm"])
            self.assertEqual(conditions["rain"]["coveredHours"], 11)
            self.assertIsNone(conditions["wind"]["kt"])
            self.assertIsNone(conditions["wind"]["from"])
            self.assertEqual(conditions["wind"]["compass"], "—")
            self.assertEqual(conditions["surf"]["compass"], "SW")
            ecmwf = next((store / "products/points/ecmwf_ifs/runs").iterdir()) / "cottesloe.json"
            data = json.loads(ecmwf.read_text()); data["units"]["wind_speed_10m"] = "mph"; ecmwf.write_text(json.dumps(data))
            self.assertIsNone(render.point_conditions(store, NOW)["wind"]["kt"])

    def test_point_conditions_sum_only_complete_twelve_hour_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp); (store / "manifest.json").write_text("{}")
            make_point_store(store, precipitation=[0.25] * 14)
            conditions = render.point_conditions(store, NOW)
            self.assertEqual(conditions["rain"]["coveredHours"], 12); self.assertEqual(conditions["rain"]["mm"], 3.0)
            self.assertEqual(conditions["wind"]["compass"], "E")
            self.assertEqual(conditions["wind"]["from"], 90)
            self.assertEqual(conditions["surf"]["compass"], "SW")

    def test_chart_labels_require_eight_parsed_dates(self):
        labels = ["10am Monday September 28, 2026", "10pm Monday September 28, 2026",
                  "10am Tuesday September 29, 2026", "10pm Tuesday September 29, 2026",
                  "10am Wednesday September 30, 2026", "10pm Wednesday September 30, 2026",
                  "10am Thursday October 1, 2026", "10pm Thursday October 1, 2026"]
        with mock.patch.object(render.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "\n".join(labels), "")) as run:
            self.assertEqual(render.chart_labels(Path("chart.pdf"), "2026-09-27T01:10:52Z"), labels)
        self.assertGreater(run.call_args.kwargs["timeout"], 0)
        with mock.patch.object(render.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "\n".join(labels[:7]), "")):
            with self.assertRaises(render.RenderError) as caught:
                render.chart_labels(Path("chart.pdf"), "2026-09-27T01:10:52Z")
        self.assertNotIn("2026-09-27T01:10:52Z", str(caught.exception))
        invalid = labels.copy()
        invalid[0] = "10am Monday September 31, 2026"
        with mock.patch.object(render.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "\n".join(invalid), "")):
            with self.assertRaises(render.RenderError):
                render.chart_labels(Path("chart.pdf"), None)

    def test_pdftoppm_has_a_timeout(self):
        with mock.patch.object(render.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "")) as run:
            with self.assertRaises(render.RenderError):
                render.render_panel(Path("chart.pdf"), 0, (8, 8))
        self.assertIn("pdftoppm", run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs["timeout"], render.CHART_TOOL_TIMEOUT)

    def test_label_to_utc_converts_bureau_est(self):
        self.assertEqual(render.label_to_utc("10am Monday September 28, 2026"), "2026-09-28T00:00:00Z")

    def test_atomic_failure_preserves_existing_pointer_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "products/charts").mkdir(parents=True)
            (root / "manifest.json").write_text(json.dumps({"products": [{"id": "chart-IDG00073.pdf"}]}))
            (root / "products/charts/IDG00073.pdf").write_bytes(b"pdf")
            old = {"generation": "old"}; (root / "current.json").write_text(json.dumps(old))
            blank = Image.new("RGB", (580, 436))
            with mock.patch.object(render, "render_panel", return_value=blank), mock.patch.object(render, "chart_labels", return_value=[f"Panel {i}" for i in range(1, 9)]), mock.patch.object(render, "point_conditions", return_value={"rain": {"mm": None}, "wind": {"kt": None, "from": None}, "surf": {"metres": None, "period": None, "from": None}}), mock.patch.object(render, "build_fronts_video", side_effect=render.RenderError("encode failed")):
                with self.assertRaises(render.RenderError): render.render(root, root / "current.png", NOW)
            self.assertEqual(json.loads((root / "current.json").read_text()), old)
            self.assertFalse(any(p.name.startswith(".") for p in (root / "generations").iterdir()))

    def test_same_pdf_reuses_cached_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "products/charts").mkdir(parents=True)
            (root / "manifest.json").write_text(json.dumps({"products": [{"id": "chart-IDG00073.pdf"}]}))
            (root / "products/charts/IDG00073.pdf").write_bytes(b"pdf")
            conditions = {"rain": {"mm": None}, "wind": {"kt": None, "from": None}, "surf": {"metres": None, "period": None, "from": None}}
            def fake_movie(folder, *args):
                (folder / "fronts.mp4").write_bytes(b"movie")
                (folder / "fronts.json").write_text(json.dumps({"labels": [f"Panel {i}" for i in range(1, 9)]}))
            with mock.patch.object(render, "render_panel", return_value=Image.new("RGB", (580, 436))), mock.patch.object(render, "chart_labels", return_value=[f"Panel {i}" for i in range(1, 9)]), mock.patch.object(render, "point_conditions", return_value=conditions), mock.patch.object(render, "build_fronts_video", side_effect=fake_movie) as build:
                render.render(root, root / "current.png", NOW); render.render(root, root / "current.png", NOW)
            build.assert_called_once()
            pointer = json.loads((root / "current.json").read_text())
            self.assertTrue(pointer["generation"].endswith(f"-v{render.RENDERER_VERSION}"))

    def test_partial_generation_is_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "products/charts").mkdir(parents=True)
            (root / "manifest.json").write_text(json.dumps({"products": [{"id": "chart-IDG00073.pdf"}]}))
            (root / "products/charts/IDG00073.pdf").write_bytes(b"pdf")
            digest = hashlib.sha256(b"pdf").hexdigest()[:16]
            partial = root / "generations" / f"{digest}-v{render.RENDERER_VERSION}"
            partial.mkdir(parents=True)
            (partial / "junk").write_text("partial", encoding="utf-8")
            conditions = {"rain": {"mm": None}, "wind": {"kt": None, "from": None, "compass": "—"}, "surf": {"metres": None, "period": None, "from": None, "compass": "—"}}
            def fake_movie(folder, *args):
                (folder / "fronts.mp4").write_bytes(b"movie")
                (folder / "fronts.json").write_text(json.dumps({"labels": [f"Panel {i}" for i in range(1, 9)]}))
            with mock.patch.object(render, "render_panel", return_value=Image.new("RGB", (580, 436))), mock.patch.object(render, "chart_labels", return_value=[f"Panel {i}" for i in range(1, 9)]), mock.patch.object(render, "point_conditions", return_value=conditions), mock.patch.object(render, "build_fronts_video", side_effect=fake_movie):
                render.render(root, root / "current.png", NOW)
            self.assertTrue((partial / "fronts.mp4").is_file())
            self.assertFalse((partial / "junk").exists())

    def test_serve_starts_from_last_good_generation_when_refresh_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            generation = root / "generations" / "0123456789abcdef-v7"
            (generation / "frames").mkdir(parents=True)
            (generation / "fronts.mp4").write_bytes(b"movie")
            (generation / "fronts.json").write_text("{}", encoding="utf-8")
            (root / "current.json").write_text(json.dumps({"generation": generation.name}), encoding="utf-8")
            started = {}

            class FakeServer:
                def __init__(self, address, handler):
                    started["address"] = address
                def serve_forever(self):
                    started["served"] = True
                def server_close(self):
                    started["closed"] = True

            with mock.patch.object(render.WallServer, "refresh", side_effect=render.RenderError("offline")), mock.patch.object(render.http.server, "ThreadingHTTPServer", FakeServer):
                render.serve(root, root / "current.png", "127.0.0.1", 0)
            self.assertTrue(started.get("served"))
            self.assertEqual(json.loads((root / "current.json").read_text())["generation"], generation.name)
            with mock.patch.object(render.WallServer, "refresh", side_effect=render.RenderError("offline")):
                with self.assertRaises(render.RenderError):
                    render.serve(root / "empty", root / "empty" / "current.png", "127.0.0.1", 0)

    def test_ffprobe_timeout_and_optional_extras(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            frames = folder / "frames"
            frames.mkdir()
            for index in range(10):
                Image.new("RGB", (8, 8), "white").save(frames / f"{index}.png")
            labels = ["10am Monday September 28, 2026", "10pm Monday September 28, 2026",
                      "10am Tuesday September 29, 2026", "10pm Tuesday September 29, 2026",
                      "10am Wednesday September 30, 2026", "10pm Wednesday September 30, 2026",
                      "10am Thursday October 1, 2026", "10pm Thursday October 1, 2026"]
            def fake_run(args, **kwargs):
                if args[0] == "ffprobe":
                    self.assertEqual(kwargs.get("timeout"), render.PROBE_TIMEOUT)
                    return subprocess.CompletedProcess(args, 0, "15\n", "")
                Path(args[-1]).write_bytes(b"movie")
                return subprocess.CompletedProcess(args, 0, "", "")
            (folder / "chart.pdf").write_bytes(b"pdf")
            with mock.patch.object(render.shutil, "which", return_value="ffmpeg"), mock.patch.object(render.subprocess, "run", side_effect=fake_run):
                render.build_fronts_video(folder, folder / "chart.pdf", labels)
        with mock.patch.object(publish_raw.subprocess, "check_output", return_value=b"{}") as probe:
            self.assertEqual(publish_raw.probe(Path("movie.mp4")), {})
        self.assertEqual(probe.call_args.kwargs["timeout"], publish_raw.PROBE_TIMEOUT)
        declared = (Path(__file__).parent / "pyproject.toml").read_text()
        self.assertIn('numpy = ["numpy"]', declared)
        self.assertIn('scipy = ["scipy"]', declared)
        self.assertIn('pymupdf = ["pymupdf"]', declared)

    @unittest.skipUnless(STORE and STORE.is_dir(), "set ISOBAR_WALL_STORE for archive integration")
    def test_real_archive_render_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "current.png"; render.render(STORE, output, NOW)
            pointer = json.loads((output.parent / "current.json").read_text())
            generation = output.parent / pointer["video"].rsplit("/", 1)[0]
            self.assertEqual(Image.open(output).size, (1600, 1200))
            self.assertEqual(len(json.loads((generation / "fronts.json").read_text())["keyframes"]), 8)

    def test_motion_fixture_tracks_translated_shape_and_static_landmark(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); frames = folder / "frames"; frames.mkdir()
            chart_pdf = Path(temp) / "chart.pdf"; chart_pdf.write_bytes(b"fixture")
            for index in range(8):
                image = Image.new("RGB", (580, 436), "white"); draw = ImageDraw.Draw(image)
                draw.rectangle((30, 30, 42, 42), fill="black"); x = 100 + index * 30
                draw.ellipse((x - 12, 190, x + 12, 214), fill=(220, 30, 30)); image.save(frames / f"{index}.png")
            labels = ["10am Monday September 28, 2026", "10pm Monday September 28, 2026",
                      "10am Tuesday September 29, 2026", "10pm Tuesday September 29, 2026",
                      "10am Wednesday September 30, 2026", "10pm Wednesday September 30, 2026",
                      "10am Thursday October 1, 2026", "10pm Thursday October 1, 2026"]
            render.build_fronts_video(folder, chart_pdf, labels)
            midpoint = Path(temp) / "mid.png"
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", "7.5", "-i", str(folder / "fronts.mp4"), "-frames:v", "1", str(midpoint)], check=True)
            with Image.open(midpoint).convert("RGB") as image:
                pixels = image.load(); red = [(x, y) for y in range(image.height) for x in range(image.width) if pixels[x, y][0] > 150 and pixels[x, y][1] < 100]; black = [(x, y) for y in range(image.height) for x in range(image.width) if max(pixels[x, y]) < 40]
            self.assertTrue(red); self.assertGreater(sum(x for x, _ in red) / len(red), 250)
            # The source panels are 580x436, then the movie filter scales the
            # map to fit 1280x630 and pads it into a 1280x720 canvas.  The
            # source landmark therefore lands at x ~= 30 * 1280 / 580, while
            # the caption ink is also black and must be excluded from the
            # source-map assertion.
            map_black = [(x, y) for x, y in black if 48 <= y <= 678]
            self.assertTrue(map_black)
            scale = 630 / 436
            expected_x = (1280 - 580 * scale) / 2 + 30 * scale
            self.assertLess(abs(sum(x for x, _ in map_black) / len(map_black) - expected_x), 18)


if __name__ == "__main__": unittest.main()
