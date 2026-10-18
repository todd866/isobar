#!/usr/bin/env python3
"""Smoothness scoring rejects stalls and real label changes, not clipped lines."""
import json
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/measure-jank.py"


class NumberDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np
        cls.np = np
        spec = importlib.util.spec_from_file_location("measure_jank", SCRIPT)
        cls.jank = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.jank)

    def digits(self, x=50):
        # Fixed pixel glyphs: no system-font or platform rendering dependency.
        glyphs = [
            ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
            ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
            ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
            ["01110", "11011", "00011", "00110", "01100", "11000", "11111"],
        ]
        image = self.np.full((120, 200), 255, dtype=self.np.uint8)
        for digit, rows in enumerate(glyphs):
            for row, text in enumerate(rows):
                for col, bit in enumerate(text):
                    if bit == "1":
                        left = x + digit * 18 + col * 2
                        if left + 2 > 0 and left < image.shape[1]:
                            image[40 + row * 2:42 + row * 2, max(0, left):min(image.shape[1], left + 2)] = 0
        return image

    def test_clipped_contour_fragment_is_not_a_number(self):
        image = self.np.full((120, 200), 255, dtype=self.np.uint8)
        # A contour cut by the viewport can be compact and dense enough to
        # pass the ordinary text-size test. It is not a complete label.
        image[50:54, :30] = 0
        image[49:53, 27:32] = 0
        for edge, sample in (("left", image), ("right", self.np.fliplr(image))):
            with self.subTest(edge=edge):
                self.assertEqual(self.jank.text_blobs(sample), [])
        image[:] = 255
        image[:8, 50:80] = 0
        for edge, sample in (("top", image), ("bottom", self.np.flipud(image))):
            with self.subTest(edge=edge):
                self.assertEqual(self.jank.text_blobs(sample), [])

    def test_interior_digit_jump_is_still_counted(self):
        tracker = self.jank.Tracker()
        blobs = self.jank.text_blobs(self.digits())
        self.assertEqual(len(blobs), 4)
        tracker.update(blobs, True)
        self.assertEqual(tracker.update(self.jank.text_blobs(self.digits(55)), False)[1], 4)

    def test_digit_appearance_and_disappearance_are_still_counted(self):
        tracker = self.jank.Tracker()
        tracker.update([], True)
        for _ in range(tracker.SETTLE):
            result = tracker.update(self.jank.text_blobs(self.digits()), False)
        self.assertEqual(result[2], 4)
        for _ in range(tracker.SETTLE):
            result = tracker.update([], False)
        self.assertEqual(result[3], 4)

    def test_complete_label_near_edge_remains_detectable(self):
        # Dilation reaches the edge here, but the actual glyph is not clipped.
        self.assertEqual(len(self.jank.text_blobs(self.digits(1))), 4)


def movie(path: Path, source: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source, "-t", "2",
        "-r", "30", "-pix_fmt", "yuv420p", str(path)], check=True)


def score(path: Path, *args: str) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPT), str(path), *args],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg is not installed")
class MeasureJankTests(unittest.TestCase):
    def test_still_picture_is_not_smooth(self):
        with tempfile.TemporaryDirectory() as tmp:
            still = Path(tmp) / "still.mov"
            movie(still, "color=c=0xd8d0c0:s=320x240")
            summary = score(still)
            self.assertEqual(summary["updates_per_second"], 0)
            self.assertEqual(summary["changing_frames_per_second"], 0)
            self.assertEqual(summary["verdict"], "jumpy")

    def test_steady_motion_meets_the_update_rate(self):
        with tempfile.TemporaryDirectory() as tmp:
            moving = Path(tmp) / "moving.mov"
            # A soft gradient sliding one pixel a frame: steady, no text blobs.
            movie(moving, "gradients=s=320x240:speed=0.02:c0=0xd8d0c0:c1=0x808080:n=2")
            summary = score(moving)
            self.assertGreaterEqual(summary["changing_frames_per_second"], 25)
            slow = score(moving, "--min-updates-per-second", "60")
            self.assertEqual(slow["verdict"], "jumpy")


if __name__ == "__main__":
    unittest.main()
