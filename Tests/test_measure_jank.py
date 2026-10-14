#!/usr/bin/env python3
"""tools/measure-jank.py must not call a map that never moves smooth."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/measure-jank.py"


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
