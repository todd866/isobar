#!/usr/bin/env python3
import importlib.util
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_release", ROOT / "tools/package-release.py")
package_release = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(package_release)


class PackageReleaseTests(unittest.TestCase):
    def app(self, root: Path) -> Path:
        app = root / "Isobar.app"
        executable = app / "Contents" / "MacOS" / "Isobar"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"candidate")
        (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "Isobar",
            "CFBundleShortVersionString": "1.8.1",
            "CFBundleVersion": "26",
            "LSMinimumSystemVersion": "15.0",
        }))
        return app

    def lipo(self, *args, **kwargs):
        return subprocess.CompletedProcess(args, 0, "arm64\n", "")

    def test_bundle_info_and_versioned_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary))
            with patch.object(package_release, "command", side_effect=self.lipo):
                info, architecture = package_release.bundle_info(app)
                paths = package_release.outputs_for(info, Path(temporary) / "release", {"zip", "dmg"})
            self.assertEqual(architecture, "arm64")
            self.assertEqual(paths["zip"].name, "Isobar-1.8.1-macOS-arm64.zip")
            self.assertEqual(paths["dmg"].name, "Isobar-1.8.1-macOS-arm64.dmg")
            self.assertEqual(paths["checksums"].name, "Isobar-1.8.1-macOS-arm64-checksums.txt")

    def test_dry_run_validates_without_writing_release_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            output = root / "release"
            with patch.object(package_release, "command", side_effect=self.lipo), \
                 patch.object(package_release, "validate_bundle") as validate:
                paths = package_release.package(app, output, {"zip"}, dry_run=True)
            validate.assert_called_once_with(app, allow_unsigned=False)
            self.assertFalse(output.exists())
            self.assertFalse(paths["zip"].exists())
            self.assertFalse(paths["checksums"].exists())

    def test_existing_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            output = root / "release"
            output.mkdir()
            target = output / "Isobar-1.8.1-macOS-arm64.zip"
            target.write_bytes(b"keep me")
            with patch.object(package_release, "command", side_effect=self.lipo), \
                 patch.object(package_release, "validate_bundle"):
                with self.assertRaisesRegex(package_release.PackageError, "overwrite"):
                    package_release.package(app, output, {"zip"}, dry_run=True)
            self.assertEqual(target.read_bytes(), b"keep me")

    def test_dmg_failure_leaves_no_release_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            output = root / "release"

            def fail_hdiutil(*args, **kwargs):
                if args[0] == "/usr/bin/lipo":
                    return self.lipo(*args, **kwargs)
                if args[0] == "/usr/bin/hdiutil":
                    raise subprocess.CalledProcessError(1, args, stderr="hdiutil failed")
                return subprocess.CompletedProcess(args, 0, "", "")

            with patch.object(package_release, "command", side_effect=fail_hdiutil), \
                 patch.object(package_release, "validate_bundle"), \
                 patch.object(package_release, "copy_app", side_effect=lambda src, dst: dst.mkdir()):
                with self.assertRaises(subprocess.CalledProcessError):
                    package_release.package(app, output, {"dmg"})
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".release-*")), [])

    def test_success_publishes_only_release_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            output = root / "release"

            def fake_command(*args, **kwargs):
                if args[0] == "/usr/bin/lipo":
                    return self.lipo(*args, **kwargs)
                if args[0] == "/usr/bin/ditto" and "-c" in args:
                    Path(args[-1]).write_bytes(b"zip")
                if args[0] == "/usr/bin/hdiutil":
                    Path(args[-1]).write_bytes(b"dmg")
                return subprocess.CompletedProcess(args, 0, "", "")

            with patch.object(package_release, "command", side_effect=fake_command), \
                 patch.object(package_release, "validate_bundle"), \
                 patch.object(package_release, "copy_app", side_effect=lambda src, dst: dst.mkdir()) as copy_app:
                paths = package_release.package(app, output, {"zip", "dmg"})
            self.assertEqual({path.name for path in output.iterdir()}, {
                "Isobar-1.8.1-macOS-arm64.zip",
                "Isobar-1.8.1-macOS-arm64.dmg",
                "Isobar-1.8.1-macOS-arm64-checksums.txt",
            })
            self.assertEqual(set(paths.values()), {
                output / "Isobar-1.8.1-macOS-arm64.zip",
                output / "Isobar-1.8.1-macOS-arm64.dmg",
                output / "Isobar-1.8.1-macOS-arm64-checksums.txt",
            })

    def test_notarized_mode_requires_real_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary))
            with patch.object(package_release, "command", side_effect=self.lipo), \
                 patch.object(package_release, "validate_bundle"):
                with self.assertRaisesRegex(package_release.PackageError, "cannot be combined"):
                    package_release.package(app, Path(temporary) / "release", {"zip"},
                                            allow_unsigned=True, notarized=True, dry_run=True)

    def test_notarization_rejection_prevents_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = self.app(root)
            output = root / "release"
            with patch.object(package_release, "command", side_effect=self.lipo), \
                 patch.object(package_release, "validate_bundle"), \
                 patch.object(package_release, "validate_notarized",
                              side_effect=package_release.PackageError("staple rejected")):
                with self.assertRaisesRegex(package_release.PackageError, "staple rejected"):
                    package_release.package(app, output, {"zip"}, notarized=True)
            self.assertFalse(output.exists())

    def test_spctl_assess_has_a_timeout(self):
        with patch.object(package_release.subprocess, "run", return_value=subprocess.CompletedProcess(("spctl",), 0, "", "")) as run:
            package_release.validate_notarized(Path("/tmp/Isobar.app"))
        spctl = [call for call in run.call_args_list if call.args and call.args[0][0] == "spctl"]
        self.assertEqual(len(spctl), 1)
        self.assertEqual(spctl[0].kwargs["timeout"], package_release.SPCTL_TIMEOUT)

    def test_dmg_root_contains_install_hint_and_applications_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "dmg"
            source = Path(temporary) / "source.app"
            source.mkdir()
            with patch.object(package_release, "copy_app", side_effect=lambda src, dst: dst.mkdir()):
                package_release.write_dmg_root(root, source)
            self.assertTrue((root / "Isobar.app").is_dir())
            self.assertTrue((root / "Applications").is_symlink())
            self.assertEqual((root / "Applications").readlink(), Path("/Applications"))
            self.assertIn("Drag Isobar to Applications", (root / "Install.txt").read_text())


if __name__ == "__main__":
    unittest.main()
