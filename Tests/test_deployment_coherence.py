import importlib.util
import json
import plistlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("coherence", ROOT / "tools/check-deployment-coherence.py")
coherence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coherence)


class Server:
    def __init__(self, responses):
        self.responses = responses
        responses_ref = responses

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body, content_type = responses_ref.get(self.path, (b"missing", "text/plain"))
                self.send_response(200 if self.path in responses_ref else 404)
                self.send_header("Content-Type", content_type)
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def manifest(*, hours=None, grid=None):
    hours = coherence.SCHEMA2 if hours is None else hours
    return {
        "schema": 2, "contract": "isobar-web", "run": "2026-10-08T00:00:00Z",
        "generated": "2026-10-08T01:00:00Z", "forecast_hours": hours,
        "grid": grid or {"west": 95, "east": 95.25, "north": 0, "south": -0.25, "nx": 2, "ny": 2, "step": 0.25, "dtype": "uint16"},
        "variables": {name: {"frames": [f"frames/{name}/f{i:03d}.u16" for i in hours], "units": unit, "scale": 0.1, "offset": 0, "fill": 65535} for name, unit in (("mslp", "hPa"), ("rain24", "mm"), ("t2m", "C"), ("wind", "kt"))},
    }


def run_web(responses, *extra):
    with Server(responses) as base:
        extra = tuple(base + "/api" if item == "__API__" else item for item in extra)
        result = subprocess.run([sys.executable, str(ROOT / "tools/check-deployment-coherence.py"), "--web-url", base, "--now", "2026-10-08T12:00:00Z", "--json", *extra], capture_output=True, text=True)
    return json.loads(result.stdout), result.returncode


def make_store(root, schema=2):
    family = root / "products/grids/ecmwf_ifs025"
    run = family / "runs/20261008T00Z"
    (run / "mslp").mkdir(parents=True, exist_ok=True)
    pointer = {"latest": "20261008T00Z", "runs": ["20261008T00Z"]}
    if schema == 2:
        contract = {"schema_version": 2, "contract": "isobar-data", "family": "grids/ecmwf_ifs025", "horizon_hours": 168, "forecast_hours": list(range(0, 145, 3)) + [150, 156, 162, 168], "uniform_step_hours": None}
        pointer.update(contract)
        (run / "manifest.json").write_text(json.dumps(contract))
    (family / "current.json").write_text(json.dumps(pointer))
    sidecar = run / "mslp/20261008T00Z.json"
    sidecar.write_text(json.dumps({"lat0": 0, "lon0": 95, "dlat": -0.25, "dlon": 0.25, "nx": 2, "ny": 2, "run": "2026-10-08T00:00:00Z", "valid_time": "2026-10-08T00:00:00Z", "dtype": "float16", "endian": "little", "units": "hPa"}))
    return sidecar


def make_global_store(root, *, valid=True):
    family = root / "products/grids/ecmwf_ifs_global"
    run = family / "runs/20261008T00Z"
    (run / "mslp").mkdir(parents=True, exist_ok=True)
    contract = {"schema_version": 2, "contract": "isobar-data", "family": "grids/ecmwf_ifs_global", "horizon_hours": 168, "forecast_hours": coherence.SCHEMA2, "uniform_step_hours": None}
    (family / "current.json").write_text(json.dumps({"latest": "20261008T00Z", "runs": ["20261008T00Z"], **contract}))
    grid = {"west": -180, "east": 179.5, "north": 90, "south": -90, "step": 0.5, "nx": 720, "ny": 361, "dtype": "float16", "wraps_longitude": True}
    if not valid:
        grid["dtype"] = "float32"
    (run / "manifest.json").write_text(json.dumps({**contract, "grid": grid}))
    sidecar = {"lat0": 90, "lon0": -180, "dlat": -0.5, "dlon": 0.5, "nx": 720, "ny": 361, "run": "2026-10-08T00:00:00Z", "valid_time": "2026-10-08T00:00:00Z", "dtype": "float16", "endian": "little", "units": "hPa", "wraps_longitude": True}
    (run / "mslp/20261008T00Z.json").write_text(json.dumps(sidecar))


def make_app(app):
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Resources/collector/_internal/config").mkdir(parents=True)
    (app / "Contents/MacOS/Isobar").write_bytes(b"test executable, never run")
    (app / "Contents/Resources/collector/isobar-data").write_bytes(b"test collector, never run")
    (app / "Contents/Resources/collector/_internal/config/isobar.toml").write_text("public = true\n")
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "Isobar", "CFBundleShortVersionString": "2.0-dev", "CFBundleVersion": "42"}))


class DeploymentCoherenceTests(unittest.TestCase):
    def status(self, report, ident):
        return next(c["status"] for c in report["checks"] if c["id"] == ident)

    def web_rows(self, value, now="2026-10-08T12:00:00Z", stamp=None):
        checks, observations = [], {}
        stamp = {"schema": 1, "source_commit": "a" * 40} if stamp is None else stamp
        with patch.object(coherence, "fetch", side_effect=[(json.dumps(value).encode(), "application/json"), (json.dumps(stamp).encode(), "application/json")]):
            coherence.web_checks("https://fixture.invalid", "a" * 40, coherence.iso(now), 18, checks, observations)
        return {"checks": checks}

    def test_all_scopes_pass_with_real_http_and_explicit_identity(self):
        # Development app version intentionally differs from the public release.
        dmg = "https://example.test/isobar-macos-arm64.dmg"
        responses = {
            "/data/manifest.json": (json.dumps(manifest()).encode(), "application/json"),
            "/isobar-release.json": (json.dumps({"schema": 1, "source_commit": "a" * 40}).encode(), "application/json"),
            "/api": (json.dumps({"tag_name": "v1.9.0", "draft": False, "assets": [{"browser_download_url": dmg}]}).encode(), "application/json"),
            "/download": (f'<a href="{dmg}">Download for Mac</a>'.encode(), "text/html"),
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            make_store(root / "store")
            make_app(root / "installed.app")
            make_app(root / "reference.app")
            report, code = run_web(responses, "--expected-web-commit", "a" * 40, "--release-api-url", "__API__", "--store", str(root / "store"), "--app", str(root / "installed.app"), "--reference-app", str(root / "reference.app"))
            self.assertEqual(code, 0, report)
            self.assertTrue(report["ok"])
            for ident in ("native.web_lag", "native.web_ladder", "native.web_coverage", "app.reference_identity", "release.download_link", "web.build_identity"):
                self.assertEqual(self.status(report, ident), "pass")

    def test_model_age_boundary_and_independent_bad_grid_axes(self):
        value = manifest()
        self.assertEqual(self.status(self.web_rows(value, "2026-10-08T18:00:00Z"), "web.manifest.age"), "pass")
        self.assertEqual(self.status(self.web_rows(value, "2026-10-08T18:00:01Z"), "web.manifest.age"), "fail")
        for key, broken in (("south", -0.5), ("east", 95.5), ("nx", True), ("north", float("nan")), ("dtype", "float16")):
            with self.subTest(key=key):
                value = manifest()
                value["grid"][key] = broken
                self.assertEqual(self.status(self.web_rows(value), "web.manifest.grid"), "fail")

    def test_identity_is_pinned_and_schema_is_not_boolean(self):
        for stamp in ({"schema": 1, "source_commit": "b" * 40}, {"schema": True, "source_commit": "a" * 40}):
            self.assertEqual(self.status(self.web_rows(manifest(), stamp=stamp), "web.build_identity"), "fail")
        stamp = {"schema": 1, "source_commit": "a" * 40, "source_dirty": True}
        self.assertEqual(self.status(self.web_rows(manifest(), stamp=stamp), "web.build_identity"), "unverified")

    def test_repeated_frame_path_does_not_claim_complete_run(self):
        value = manifest()
        value["variables"]["mslp"]["frames"][1] = value["variables"]["mslp"]["frames"][0]
        self.assertEqual(self.status(self.web_rows(value), "web.manifest.frames"), "fail")

    def test_native_lag_is_symmetric_and_boundary_inclusive(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)
            make_store(store)
            for web_run, expected in (("2026-10-07T12:00:00Z", "pass"), ("2026-10-07T11:59:59Z", "fail"), ("2026-10-08T12:00:00Z", "pass"), ("2026-10-08T12:00:01Z", "fail")):
                with self.subTest(web_run=web_run):
                    checks = []
                    coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, (95, 95.25, 0, -0.25, 2, 2), coherence.iso(web_run), checks, {"web_hours": list(range(0, 145, 3)) + [150, 156, 162, 168]})
                    self.assertEqual(self.status({"checks": checks}, "native.web_lag"), expected)

    def test_legacy_native_without_manifest_and_missing_web_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)
            make_store(store, schema=1)
            checks = []
            coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, None, None, checks, {}, compare_web=False)
            self.assertTrue(checks and all(c["status"] == "pass" for c in checks), checks)
            self.assertFalse(any(c["id"].startswith("native.web_") for c in checks))
            checks = []
            coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, None, None, checks, {}, compare_web=True)
            for ident in ("native.web_lag", "native.web_ladder", "native.web_coverage"):
                self.assertEqual(self.status({"checks": checks}, ident), "unverified")

    def test_native_malformed_geometry_is_not_coherent(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)
            sidecar = make_store(store)
            good = json.loads(sidecar.read_text())
            for key, value in (("nx", 2.5), ("lon0", float("inf")), ("dlat", 0.25), ("dlat", -0.5), ("lat0", -91)):
                with self.subTest(key=key, value=value):
                    sidecar.write_text(json.dumps({**good, key: value}))
                    checks = []
                    coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, None, None, checks, {}, compare_web=False)
                    self.assertEqual(self.status({"checks": checks}, "native.pointer_manifest"), "fail")

    def test_global_native_is_preferred_and_requires_exact_seam_free_grid(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)
            make_store(store)
            make_global_store(store)
            checks = []
            coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12,
                                    (-180, 179.5, 90, -90, 720, 361),
                                    coherence.iso("2026-10-08T00:00:00Z"), checks,
                                    {"web_hours": coherence.SCHEMA2, "web_wraps_longitude": True})
            self.assertEqual(self.status({"checks": checks}, "native.pointer_manifest"), "pass")
            self.assertEqual(self.status({"checks": checks}, "native.web_grid_orientation"), "pass")
            make_global_store(store, valid=False)
            checks = []
            coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, None, None, checks, {}, compare_web=False)
            self.assertEqual(self.status({"checks": checks}, "native.pointer_manifest"), "fail")

    def test_green_web_fixture(self):
        responses = {
            "/data/manifest.json": (json.dumps(manifest()).encode(), "application/json"),
            "/isobar-release.json": (json.dumps({"schema": 1, "source_commit": "a" * 40, "source_tree": "x", "product_version": "1.0", "build_id": "b"}).encode(), "application/json"),
        }
        report, code = run_web(responses, "--expected-web-commit", "a" * 40)
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])

    def test_gap_and_future_fail(self):
        broken = manifest(hours=coherence.SCHEMA2[:-1] + [167])
        broken["run"] = "2026-10-08T13:00:00Z"
        report, code = run_web({"/data/manifest.json": (json.dumps(broken).encode(), "application/json"), "/isobar-release.json": (b"{}", "application/json")})
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])
        self.assertTrue(any(c["status"] == "fail" for c in report["checks"]))

    def test_missing_identity_is_unverified(self):
        report, code = run_web({"/data/manifest.json": (json.dumps(manifest()).encode(), "application/json")})
        self.assertEqual(code, 1)
        identity = next(c for c in report["checks"] if c["id"] == "web.build_identity")
        self.assertEqual(identity["status"], "unverified")

    def test_schema1_defaults_hours_and_checks_age_boundary(self):
        value = manifest(hours=coherence.SCHEMA1)
        value["schema"] = 1
        value.pop("forecast_hours")
        value["run"] = "2026-10-07T18:00:00Z"
        value["generated"] = "2026-10-07T19:00:00Z"
        report, code = run_web({"/data/manifest.json": (json.dumps(value).encode(), "application/json"), "/isobar-release.json": (json.dumps({"schema": 1, "source_commit": "a" * 40}).encode(), "application/json")}, "--expected-web-commit", "a" * 40)
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])

    def test_future_generated_and_bad_metadata_fail(self):
        value = manifest()
        value["generated"] = "2026-10-08T13:00:00Z"
        value["variables"]["wind"]["units"] = "m/s"
        value["variables"]["mslp"]["frames"][0] = None
        report, code = run_web({"/data/manifest.json": (json.dumps(value).encode(), "application/json"), "/isobar-release.json": (json.dumps({"schema": 1, "source_commit": "a" * 40}).encode(), "application/json")})
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])
        self.assertTrue(any(item["id"] == "web.manifest.frames" and item["status"] == "fail" for item in report["checks"]))

    def test_oversize_response_fails_bounded_fetch(self):
        report, code = run_web({"/data/manifest.json": (b"x" * (coherence.MAX_BYTES + 1), "application/json")})
        self.assertEqual(code, 1)
        self.assertTrue(any(item["id"] == "web.manifest.fetch" for item in report["checks"]))

    def test_paths_reject_urls_and_encoded_traversal(self):
        for value in ("https://foreign/file", "frames/%2e%2e/escape.u16", "frames/x?query=1", "frames/x#frag"):
            self.assertFalse(coherence.safe_relative(value))

    def test_release_link_must_be_real_anchor(self):
        release = {"tag_name": "v1.9.0", "draft": False, "assets": [{"browser_download_url": "https://example.test/isobar-macos-arm64.dmg"}]}
        responses = {
            "/data/manifest.json": (json.dumps(manifest()).encode(), "application/json"),
            "/isobar-release.json": (json.dumps({"schema": 1, "source_commit": "a" * 40}).encode(), "application/json"),
            "/api": (json.dumps(release).encode(), "application/json"),
            "/download": (b'<script>location="https://example.test/isobar-macos-arm64.dmg"</script>', "text/html"),
        }
        report, code = run_web(responses, "--release-api-url", "__API__")
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])

    def test_bad_invocation_has_no_traceback(self):
        result = subprocess.run([sys.executable, str(ROOT / "tools/check-deployment-coherence.py"), "--json"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)

    def test_app_version_collision_is_detected_by_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = []
            for name in ("one", "two"):
                app = root / name / "Isobar.app"
                (app / "Contents/MacOS").mkdir(parents=True)
                (app / "Contents/Resources/collector/_internal/config").mkdir(parents=True)
                (app / "Contents/MacOS/Isobar").write_bytes(b"same executable")
                (app / "Contents/Resources/collector/isobar-data").write_bytes(b"same collector")
                (app / "Contents/Resources/collector/_internal/config/isobar.toml").write_text("public = true\n")
                (app / "Contents/Resources/training.js").write_text(name)
                (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "Isobar", "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1"}))
                apps.append(app)
            result = subprocess.run([sys.executable, str(ROOT / "tools/check-deployment-coherence.py"), "--app", str(apps[0]), "--reference-app", str(apps[1]), "--json"], capture_output=True, text=True)
            report = json.loads(result.stdout)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(next(c for c in report["checks"] if c["id"] == "app.reference_identity")["status"], "fail")

    def test_native_pointer_rollover_and_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)
            family = store / "products/grids/ecmwf_ifs025"
            run = family / "runs/20261008T00Z"
            run.mkdir(parents=True)
            pointer = {"latest": "20261008T00Z", "runs": ["20261008T00Z"], "schema_version": 2, "contract": "isobar-data", "family": "grids/ecmwf_ifs025", "horizon_hours": 168, "forecast_hours": coherence.SCHEMA2}
            (family / "current.json").write_text(json.dumps(pointer))
            (run / "manifest.json").write_text(json.dumps({"schema_version": 2, "contract": "isobar-data", "family": "grids/ecmwf_ifs025", "horizon_hours": 168, "uniform_step_hours": None, "forecast_hours": coherence.SCHEMA2}))
            (run / "mslp").mkdir()
            (run / "mslp/20261008T00Z.json").write_text(json.dumps({"lat0": 0, "lon0": 95, "dlat": -0.25, "dlon": 0.25, "nx": 2, "ny": 2, "run": "2026-10-08T00:00:00Z", "valid_time": "2026-10-08T00:00:00Z", "dtype": "float16", "endian": "little", "units": "hPa"}))
            checks = []
            pointer_bytes = (family / "current.json").read_bytes()
            with patch.object(Path, "read_bytes", side_effect=[pointer_bytes, pointer_bytes + b"rollover"]):
                coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, (95, 95.25, 0, -0.25, 2, 2), coherence.iso("2026-10-08T00:00:00Z"), checks, {})
            self.assertTrue(any(c["id"] == "native.snapshot" and c["status"] == "unverified" for c in checks))
            checks = []
            coherence.native_checks(store, coherence.iso("2026-10-08T12:00:00Z"), 18, 12, (95, 95.25, 0, -0.25, 2, 2), coherence.iso("2026-10-08T12:00:00Z"), checks, {})
            self.assertTrue(any(c["id"] == "native.pointer_manifest" and c["status"] == "pass" for c in checks))


if __name__ == "__main__":
    unittest.main()
