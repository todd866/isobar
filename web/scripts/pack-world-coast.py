#!/usr/bin/env python3
"""Pack Natural Earth 10m land into the web OCST coastline format.

The input is a Polygon/MultiPolygon ESRI shapefile.  The reader is deliberately
stdlib-only so generation cannot depend on the web application's node_modules.
Every shapefile part is retained as a ring, including holes; the browser's
even-odd fill rule gives those parts their intended meaning.  Coordinates are
quantized to the OCST v1 hundredth-degree representation before simplification
so output is stable across runs and platforms.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import struct
import tempfile
from pathlib import Path

MAX_BYTES = 1 << 20
MAX_RING_POINTS = 0xFFFF
EPSILONS = (0.01, 0.015, 0.02)


def read_shape_parts(source: Path, omitted_parts: list[int] | None = None) -> list[list[tuple[int, int]]]:
    data = source.read_bytes()
    if len(data) < 100 or struct.unpack_from(">i", data, 0)[0] != 9994:
        raise ValueError(f"not an ESRI shapefile: {source}")
    parts: list[list[tuple[int, int]]] = []
    cursor = 100
    while cursor + 8 <= len(data):
        _, words = struct.unpack_from(">ii", data, cursor)
        cursor += 8
        end = cursor + words * 2
        if end > len(data):
            raise ValueError("truncated shapefile record")
        shape_type = struct.unpack_from("<i", data, cursor)[0]
        if shape_type == 0:  # Null shape
            cursor = end
            continue
        if shape_type != 5:
            raise ValueError(f"unsupported shapefile shape type {shape_type}")
        if shape_type == 5:  # Polygon
            part_count, point_count = struct.unpack_from("<ii", data, cursor + 36)
            part_offsets = struct.unpack_from(
                f"<{part_count}i", data, cursor + 44
            )
            points_offset = cursor + 44 + part_count * 4
            points = struct.unpack_from(f"<{point_count * 2}d", data, points_offset)
            for start, stop in zip(part_offsets, (*part_offsets[1:], point_count)):
                ring: list[tuple[int, int]] = []
                for index in range(start, stop):
                    pair = (
                        int(round(points[index * 2] * 100.0)),
                        int(round(points[index * 2 + 1] * 100.0)),
                    )
                    if not ring or pair != ring[-1]:
                        ring.append(pair)
                if len(ring) >= 2 and ring[0] == ring[-1]:
                    ring.pop()
                if len(ring) < 3 or len(set(ring)) < 3:
                    # The source contains sub-pixel islands that collapse at
                    # OCST's 0.01° precision. They have no representable area
                    # in this format, so omit them explicitly and report the
                    # count instead of inventing a polygon.
                    if omitted_parts is not None:
                        omitted_parts.append(1)
                    continue
                parts.append(ring)
        cursor = end
    if cursor != len(data):
        raise ValueError("trailing shapefile bytes")
    return parts


def perpendicular_distance(point: tuple[int, int], start: tuple[int, int], end: tuple[int, int]) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = (dx * dx + dy * dy) ** 0.5
    if length == 0:
        return ((point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2) ** 0.5
    return abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / length


def simplify_ring(ring: list[tuple[int, int]], epsilon_degrees: float) -> list[tuple[int, int]]:
    """RDP in quantized hundredths of a degree, retaining ring endpoints."""
    if len(ring) < 4:
        return ring
    epsilon = epsilon_degrees * 100.0
    keep = bytearray(len(ring))
    keep[0] = 1
    keep[-1] = 1
    stack = [(0, len(ring) - 1)]
    while stack:
        start, end = stack.pop()
        farthest = -1
        distance = epsilon
        for index in range(start + 1, end):
            candidate = perpendicular_distance(ring[index], ring[start], ring[end])
            if candidate > distance:
                distance = candidate
                farthest = index
        if farthest >= 0:
            keep[farthest] = 1
            stack.append((start, farthest))
            stack.append((farthest, end))
    return [point for index, point in enumerate(ring) if keep[index]]


def encode(parts: list[list[tuple[int, int]]], epsilon: float) -> tuple[bytes, int, int]:
    rings = []
    for ring in parts:
        if len(ring) < 3 or len(set(ring)) < 3:
            raise ValueError("cannot encode a ring with fewer than three distinct points")
        simplified = simplify_ring(ring, epsilon)
        # OCST and the browser parser require a polygon ring. Tiny islands can
        # legitimately collapse under RDP, so retain their original geometry.
        rings.append(simplified if len(simplified) >= 3 else ring)
    if len(rings) > 0xFFFF:
        raise ValueError("OCST v1 cannot encode more than 65535 rings")
    if any(len(ring) > MAX_RING_POINTS for ring in rings):
        raise ValueError(f"epsilon {epsilon} leaves a ring over {MAX_RING_POINTS} points")
    blob = bytearray(b"OCST")
    blob += struct.pack("<HH", 1, len(rings))
    for ring in rings:
        blob += struct.pack("<H", len(ring))
        for lon, lat in ring:
            blob += struct.pack("<hh", lon, lat)
    return bytes(blob), len(rings), sum(len(ring) for ring in rings)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    omitted_parts: list[int] = []
    parts = read_shape_parts(args.source, omitted_parts)
    if omitted_parts:
        print(f"omitted quantized parts={len(omitted_parts)}")
    candidates: list[tuple[float, bytes, int, int]] = []
    for epsilon in EPSILONS:
        blob, rings, points = encode(parts, epsilon)
        print(f"epsilon={epsilon:g} bytes={len(blob)} rings={rings} points={points}")
        if len(blob) <= MAX_BYTES:
            candidates.append((epsilon, blob, rings, points))
    if not candidates:
        raise SystemExit("no requested simplification fits the 1 MiB OCST budget")
    epsilon, blob, rings, points = candidates[0]
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    # Replace atomically so a local preview never observes a partial OCST file.
    with tempfile.NamedTemporaryFile(dir=args.destination.parent, prefix=f".{args.destination.name}.", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(blob)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, args.destination)
    print(
        f"selected epsilon={epsilon:g} bytes={len(blob)} rings={rings} "
        f"points={points} sha256={sha256(blob)}"
    )


if __name__ == "__main__":
    main()
