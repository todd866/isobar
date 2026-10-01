#!/usr/bin/env python3
import importlib.util
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_bundle", ROOT / "tools/check-bundle.py")
check_bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_bundle)

MAGIC = b"\xcf\xfa\xed\xfe"


class CheckBundleTests(unittest.TestCase):
    def app(self, root: Path) -> Path:
        app = root / "Isobar.app"
        executable = app / "Contents/MacOS/Isobar"
        helper = app / "Contents/Resources/collector/isobar-data"
        framework = app / "Contents/Frameworks/Extra.dylib"
        executable.parent.mkdir(parents=True)
        helper.parent.mkdir(parents=True)
        framework.parent.mkdir(parents=True)
        executable.write_bytes(MAGIC)
        helper.write_bytes(MAGIC)
        framework.write_bytes(MAGIC)
        (helper.parent / "_internal/config").mkdir(parents=True)
        (helper.parent / "_internal/config/isobar.toml").write_text("public = true\n", encoding="utf-8")
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "Isobar",
            "LSMinimumSystemVersion": "15.0",
        }))
        (app / "Contents/Resources/readme.txt").write_text("not a binary", encoding="utf-8")
        return app

    def fake_run(self, loads=None, links=None):
        loads = loads or {}
        links = links or {}

        def run(*args, **kwargs):
            if args[0] == "/usr/bin/lipo":
                return "arm64\n"
            if args[:2] == ("/usr/bin/otool", "-l"):
                return loads.get(Path(args[2]).name, "minos 15.0\n")
            if args[:2] == ("/usr/bin/otool", "-L"):
                dependency = links.get(Path(args[2]).name, "/usr/lib/libSystem.B.dylib")
                return f"{args[2]}:\n\t{dependency} (compatibility version 1.0.0, current version 1.0.0)\n"
            if args[0] == "/usr/bin/codesign":
                raise AssertionError("unsigned check must not codesign")
            return ""

        return run

    def test_checks_executable_and_other_machos_against_plist(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary))
            seen = []

            def run(*args, **kwargs):
                if args[:2] == ("/usr/bin/otool", "-l"):
                    seen.append(Path(args[2]).name)
                return self.fake_run()(*args, **kwargs)

            with patch.object(check_bundle, "run", side_effect=run):
                check_bundle.check(app, unsigned=True)
            self.assertCountEqual(seen, ["Isobar", "isobar-data", "Extra.dylib"])

    def test_rejects_symlink_that_leaves_the_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            outside = root / "outside"
            outside.write_text("secret", encoding="utf-8")
            (app / "Contents/MacOS/Isobar").unlink()
            (app / "Contents/MacOS/Isobar").symlink_to(outside)
            with patch.object(check_bundle, "run", side_effect=self.fake_run()):
                with self.assertRaisesRegex(ValueError, "symlink points outside"):
                    check_bundle.check(app, unsigned=True)

    def test_rejects_directory_symlink_that_leaves_the_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            (app / "Contents/Resources/escape").symlink_to(root)
            with patch.object(check_bundle, "run", side_effect=self.fake_run()):
                with self.assertRaisesRegex(ValueError, "symlink points outside"):
                    check_bundle.check(app, unsigned=True)

    def test_accepts_symlink_whose_target_stays_inside(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary))
            link = app / "Contents/Frameworks/Isobar"
            link.symlink_to("../MacOS/Isobar")
            with patch.object(check_bundle, "run", side_effect=self.fake_run()):
                check_bundle.check(app, unsigned=True)

    def test_rejects_newer_minos_and_external_dylib(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary))
            with patch.object(check_bundle, "run", side_effect=self.fake_run(loads={"Isobar": "minos 26.0\n"})):
                with self.assertRaisesRegex(ValueError, "requires macOS 26.0"):
                    check_bundle.check(app, unsigned=True)
            with patch.object(check_bundle, "run", side_effect=self.fake_run(links={"Extra.dylib": "/usr/local/lib/libEscape.dylib"})):
                with self.assertRaisesRegex(ValueError, "external dependency /usr/local/lib/libEscape.dylib"):
                    check_bundle.check(app, unsigned=True)


if __name__ == "__main__":
    unittest.main()
