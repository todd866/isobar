import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

from wall.server import handler_for


class WallServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "generations" / "0123456789abcdef-v4" / "frames").mkdir(parents=True)
        self.generation = self.root / "generations" / "0123456789abcdef-v4"
        (self.generation / "fronts.mp4").write_bytes(bytes(range(64)))
        (self.generation / "fronts.json").write_text('{"fps":24}')
        for i in range(8):
            (self.generation / "frames" / f"{i}.png").write_bytes(f"frame-{i}".encode())
        (self.root / "current.json").write_text(json.dumps({"generation": self.generation.name}))
        self.html = self.root / "index.html"
        self.html.write_text("wall")
        handler = handler_for(self.root, self.html, lambda: {"ok": True})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.conn = HTTPConnection("127.0.0.1", self.httpd.server_port)

    def tearDown(self):
        self.conn.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method, path, headers=None):
        self.conn.request(method, path, headers=headers or {})
        return self.conn.getresponse()

    def test_fixed_routes_and_current_switch(self):
        response = self.request("GET", "/generations/0123456789abcdef-v4/frames/7.png")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"frame-7")
        response = self.request("GET", "/frames/0.png?cache=1")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"frame-0")
        response = self.request("GET", "/../../index.html")
        self.assertEqual(response.status, 404)
        response = self.request("GET", "/generations/0123456789abcdef-v4/frames/8.png")
        self.assertEqual(response.status, 404)

    def test_range_prefix_open_ended_suffix_and_clamping(self):
        for value, expected, status in (
            ("bytes=0-3", b"\x00\x01\x02\x03", 206),
            ("bytes=4-", bytes(range(4, 64)), 206),
            ("bytes=-4", bytes(range(60, 64)), 206),
            ("bytes=60-999", bytes(range(60, 64)), 206),
        ):
            response = self.request("GET", "/fronts.mp4", {"Range": value})
            self.assertEqual(response.status, status)
            self.assertEqual(response.read(), expected)
            self.assertIn("bytes", response.getheader("Accept-Ranges"))
        response = self.request("GET", "/fronts.mp4", {"Range": "bytes=-0"})
        self.assertEqual(response.status, 416)
        self.assertEqual(response.getheader("Content-Range"), "bytes */64")
        response.read()
        response = self.request("GET", "/fronts.mp4", {"Range": "bytes=64-"})
        self.assertEqual(response.status, 416)
        response.read()
        response = self.request("GET", "/fronts.mp4", {"Range": "bytes=0-1,3-4"})
        self.assertEqual(response.status, 416)

    def test_head_has_shared_length_without_body_and_pointer_cache_policy(self):
        response = self.request("HEAD", "/fronts.mp4", {"Range": "bytes=0-7"})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.getheader("Content-Length"), "8")
        self.assertEqual(response.read(), b"")
        response = self.request("GET", "/current.json")
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertEqual(json.loads(response.read())["generation"], self.generation.name)


if __name__ == "__main__":
    unittest.main()
