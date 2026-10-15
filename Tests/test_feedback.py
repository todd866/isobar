import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOL = Path(__file__).parents[1] / "tools" / "feedback.py"


class FeedbackToolTests(unittest.TestCase):
    def test_list_newest_first_and_show(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".feedback-staging").mkdir()
            (root / ".feedback-staging" / "feedback.json").write_text("{}", encoding="utf-8")
            (root / "bad").mkdir()
            (root / "bad" / "feedback.json").write_text("[]", encoding="utf-8")
            records = [
                ("20261015T010000Z-mac-aabbcc", "2026-10-15T01:00:00Z", "old", "Pressure"),
                ("20261015T020000Z-mac-ddeeff", "2026-10-15T02:00:00Z", "new owner note", "Rain"),
            ]
            for name, captured, note, lens in records:
                directory = root / name
                directory.mkdir()
                (directory / "feedback.json").write_text(json.dumps({
                    "schema": "isobar-feedback/1", "surface": "mac",
                    "captured_at": captured,
                    "note": note, "state": {"lens": lens}, "files": ["screen.png"],
                }), encoding="utf-8")
            result = subprocess.run([sys.executable, str(TOOL), "--inbox", str(root), "list"], capture_output=True, text=True, check=True)
            self.assertLess(result.stdout.index("ddeeff"), result.stdout.index("aabbcc"))
            shown = subprocess.run([sys.executable, str(TOOL), "--inbox", str(root), "show", "20261015T020000Z-mac-ddeeff"], capture_output=True, text=True, check=True)
            self.assertIn('"new owner note"', shown.stdout)
            self.assertIn(str(root / "20261015T020000Z-mac-ddeeff" / "screen.png"), shown.stdout)
            after = subprocess.run([sys.executable, str(TOOL), "list", "--inbox", str(root)], capture_output=True, text=True, check=True)
            self.assertNotIn("feedback-staging", after.stdout)

    def test_ambiguous_prefix_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for suffix in ("aaaaaa", "aaaaab"):
                directory = root / ("20261015T010000Z-mac-" + suffix)
                directory.mkdir()
                (directory / "feedback.json").write_text(json.dumps({"captured_at": "2026-10-15T01:00:00Z", "surface": "mac", "state": {}, "files": []}), encoding="utf-8")
            result = subprocess.run([sys.executable, str(TOOL), "show", "--inbox", str(root), "20261015T010000Z-mac-aaaa"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ambiguous", result.stderr)

    def test_missing_date_and_multiline_note_are_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, captured in [("naive", "2026-10-15T02:00:00"), ("missing", None)]:
                directory = root / name
                directory.mkdir()
                (directory / "feedback.json").write_text(json.dumps({
                    "schema": "isobar-feedback/1", "surface": "web", "captured_at": captured,
                    "state": None, "note": "first line\nsecond line", "files": [None, "screen.png"],
                }))
            listed = subprocess.run([sys.executable, str(TOOL), "list", "--inbox", str(root)],
                                    capture_output=True, text=True, check=True)
            self.assertEqual(len(listed.stdout.splitlines()), 2)
            self.assertIn("first line second line", listed.stdout)
            shown = subprocess.run([sys.executable, str(TOOL), "show", "naive", "--inbox", str(root)],
                                   capture_output=True, text=True, check=True)
            self.assertIn(str(root / "naive" / "screen.png"), shown.stdout)


if __name__ == "__main__":
    unittest.main()
