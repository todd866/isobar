"""Small, dependency-free HTTP surface for the generated wall bundle."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any, Callable
from urllib.parse import unquote, urlsplit
import http.server


GENERATION_RE = re.compile(r"^[a-f0-9]{16}-v[0-9]+$")
FRAME_RE = re.compile(r"^[0-7]\.png$")
ASSETS = {
    "fronts.mp4": "video/mp4",
    "fronts.json": "application/json; charset=utf-8",
}


def handler_for(root: Path, html: Path, health: Callable[[], Any]):
    """Return a request handler serving only the wall's fixed public routes."""
    root = root.resolve()
    html = html.resolve()

    class WallHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _current_generation(self) -> str | None:
            try:
                pointer = json.loads((root / "current.json").read_text())
                value = pointer.get("generation")
            except (OSError, ValueError, AttributeError):
                return None
            return value if isinstance(value, str) and GENERATION_RE.fullmatch(value) else None

        def _asset(self, generation: str, name: str) -> tuple[Path, str] | None:
            if not GENERATION_RE.fullmatch(generation):
                return None
            if name == "frames/0.png" or name == "frames/1.png" or name == "frames/2.png" or name == "frames/3.png" \
                    or name == "frames/4.png" or name == "frames/5.png" or name == "frames/6.png" or name == "frames/7.png":
                return root / "generations" / generation / "frames" / name[-5:], "image/png"
            if name in ASSETS:
                return root / "generations" / generation / name, ASSETS[name]
            return None

        def _headers(self, path: Path, content_type: str, start: int, end: int, size: int, status: int, cache: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", cache)
            self.end_headers()

        def _send_file(self, path: Path, content_type: str, cache: str = "public, max-age=31536000, immutable") -> None:
            try:
                stream = path.open("rb")
                size = os.fstat(stream.fileno()).st_size
            except OSError:
                self.send_error(404)
                return
            if size == 0:
                stream.close()
                self.send_error(404)
                return
            start, end, status = 0, size - 1, 200
            value = self.headers.get("Range")
            if value:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
                if not match or (not match.group(1) and not match.group(2)):
                    stream.close()
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                left, right = match.groups()
                if left:
                    start = int(left)
                    if start >= size:
                        stream.close()
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    suffix = int(right)
                    if suffix <= 0:
                        stream.close()
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    start = max(0, size - suffix)
                if end < start:
                    stream.close()
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            self._headers(path, content_type, start, end, size, status, cache)
            if self.command == "HEAD":
                stream.close()
                return
            try:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except BrokenPipeError:
                pass
            finally:
                stream.close()

        def _send_bytes(self, body: bytes, content_type: str, cache: str = "no-store", status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                try:
                    self.wfile.write(body)
                except BrokenPipeError:
                    pass

        def do_HEAD(self) -> None:
            self._dispatch()

        def do_GET(self) -> None:
            self._dispatch()

        def _dispatch(self) -> None:
            path = unquote(urlsplit(self.path).path)
            if path in ("/", "/index"):
                self._send_file(html, "text/html; charset=utf-8", "no-store")
                return
            if path == "/health":
                value = health()
                if isinstance(value, bytes):
                    body = value
                elif isinstance(value, str):
                    body = value.encode()
                else:
                    body = json.dumps(value).encode()
                self._send_bytes(body, "application/json; charset=utf-8", status=503 if isinstance(value, dict) and value.get("ok") is False else 200)
                return
            if path == "/current.json":
                self._send_file(root / "current.json", "application/json; charset=utf-8", "no-store")
                return
            generation = None
            name = None
            parts = path.strip("/").split("/")
            if len(parts) >= 3 and parts[0] == "generations":
                generation, name = parts[1], "/".join(parts[2:])
            elif path in ("/fronts.mp4", "/fronts.json"):
                generation, name = self._current_generation(), path[1:]
            elif len(parts) == 2 and parts[0] == "frames":
                generation, name = self._current_generation(), path.strip("/")
            if generation and name:
                resolved = self._asset(generation, name)
                if resolved:
                    self._send_file(*resolved, cache="public, max-age=31536000, immutable" if parts[0] == "generations" else "no-store")
                    return
            self.send_error(404)

        def log_message(self, *_: Any) -> None:
            return

    return WallHandler
