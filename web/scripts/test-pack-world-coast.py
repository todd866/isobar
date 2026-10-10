#!/usr/bin/env python3
"""Focused stdlib tests for pack-world-coast.py."""

from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("pack-world-coast.py")
SPEC = importlib.util.spec_from_file_location("pack_world_coast", MODULE_PATH)
assert SPEC and SPEC.loader
PACKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKER)


def polygon_shapefile(parts: list[list[tuple[float, float]]], shape_type: int = 5) -> bytes:
    points = [point for part in parts for point in part]
    offsets = []
    cursor = 0
    for part in parts:
        offsets.append(cursor)
        cursor += len(part)
    if points:
        box = (min(x for x, _ in points), min(y for _, y in points), max(x for x, _ in points), max(y for _, y in points))
    else:
        box = (0.0, 0.0, 0.0, 0.0)
    content = struct.pack("<i", shape_type)
    if shape_type == 5:
        content += struct.pack("<4dii", *box, len(parts), len(points))
        content += struct.pack(f"<{len(offsets)}i", *offsets)
        content += struct.pack(f"<{len(points) * 2}d", *(coordinate for point in points for coordinate in point))
    record = struct.pack(">ii", 1, len(content) // 2) + content
    header = bytearray(100)
    struct.pack_into(">i", header, 0, 9994)
    struct.pack_into(">i", header, 24, (100 + len(record)) // 2)
    struct.pack_into("<i", header, 28, 1000)
    struct.pack_into("<i", header, 32, shape_type)
    return bytes(header) + record


def parse_ocst(data: bytes) -> list[list[tuple[int, int]]]:
    if data[:4] != b"OCST" or struct.unpack_from("<H", data, 4)[0] != 1:
        raise AssertionError("bad OCST header")
    ring_count = struct.unpack_from("<H", data, 6)[0]
    cursor = 8
    rings = []
    for _ in range(ring_count):
        count = struct.unpack_from("<H", data, cursor)[0]
        assert count >= 3
        cursor += 2
        values = struct.unpack_from(f"<{count * 2}h", data, cursor)
        cursor += count * 4
        rings.append(list(zip(values[::2], values[1::2])))
    assert cursor == len(data)
    return rings


class PackWorldCoastTests(unittest.TestCase):
    def test_tiny_ring_falls_back_after_simplification(self):
        tiny = [(0.0, 0.0), (0.01, 0.0), (0.01, 0.01), (0.0, 0.01)]
        blob, _, _ = PACKER.encode([[(round(x * 100), round(y * 100)) for x, y in tiny]], 0.02)
        self.assertEqual(len(parse_ocst(blob)[0]), 4)

    def test_holes_and_output_are_deterministic(self):
        outer = [(0, 0), (100, 0), (100, 100), (0, 100)]
        hole = [(25, 25), (25, 75), (75, 75), (75, 25)]
        first = PACKER.encode([outer, hole], 0.01)[0]
        second = PACKER.encode([outer, hole], 0.01)[0]
        self.assertEqual(first, second)
        self.assertEqual(len(parse_ocst(first)), 2)

    def test_reader_accepts_null_and_rejects_unsupported_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            null = Path(directory) / "null.shp"
            null.write_bytes(polygon_shapefile([], 0))
            self.assertEqual(PACKER.read_shape_parts(null), [])
            unsupported = Path(directory) / "unsupported.shp"
            unsupported.write_bytes(polygon_shapefile([], 3))
            with self.assertRaises(ValueError):
                PACKER.read_shape_parts(unsupported)

    def test_quantized_subpixel_part_is_explicitly_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "subpixel.shp"
            source.write_bytes(polygon_shapefile([[(0.001, 0.001), (0.002, 0.001), (0.001, 0.002), (0.001, 0.001)]]))
            omitted = []
            parts = PACKER.read_shape_parts(source, omitted)
            self.assertEqual(parts, [])
            self.assertEqual(len(omitted), 1)

    def test_abab_ring_is_omitted_by_distinct_vertex_check(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "abab.shp"
            source.write_bytes(polygon_shapefile([[(1, 1), (2, 2), (1, 1), (2, 2), (1, 1)]]))
            omitted = []
            self.assertEqual(PACKER.read_shape_parts(source, omitted), [])
            self.assertEqual(len(omitted), 1)
            with self.assertRaises(ValueError):
                PACKER.encode([[(100, 100), (200, 200), (100, 100)]], 0.01)


if __name__ == "__main__":
    unittest.main()
