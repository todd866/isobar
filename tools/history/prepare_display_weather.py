#!/usr/bin/env python3
"""Create a compact, audited display copy of a historical weather product.

The input remains immutable. Every weather value is rounded to the requested
decimal precision, the source hash is recorded in provenance, and complete_days
validates the result before it is written. This is a packaging step, not a
scientific regridding or a replacement for the full-precision archive.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile

try:
    from .publish_catalog import complete_days
except ImportError:
    from publish_catalog import complete_days

FIELDS = ('pressure_msl', 'u', 'v', 'temperature')


def _write_atomic(value: object, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with open(fd, 'wb', closefd=True) as stream:
            stream.write(encoded)
        Path(name).replace(path)
    finally:
        Path(name).unlink(missing_ok=True)


def quantize_weather(weather: dict, source_sha256: str, source_bytes: int, decimals: int = 1) -> dict:
    if type(decimals) is not int or not 0 <= decimals <= 6:
        raise ValueError('decimals must be an integer from 0 to 6')
    complete_days(weather)
    result = deepcopy(weather)
    factor = 10 ** decimals
    maximum_error = 0.0
    for index, frame in enumerate(result['frames']):
        source_frame = weather['frames'][index]
        for field in FIELDS:
            values = frame[field]
            original = source_frame[field]
            rounded = [round(value * factor) / factor for value in values]
            maximum_error = max(maximum_error, *(abs(a - b) for a, b in zip(original, rounded)))
            frame[field] = rounded
    provenance = dict(result.get('provenance') or {})
    provenance['display_quantization'] = {
        'tool': 'tools/history/prepare_display_weather.py',
        'decimals': decimals,
        'unit_step': 1 / factor,
        'max_abs_rounding_error': round(maximum_error, 12),
        'source_sha256': source_sha256,
        'source_bytes': source_bytes,
        'fields': list(FIELDS),
    }
    result['provenance'] = provenance
    complete_days(result)
    return result


def prepare(source: Path, output: Path, decimals: int = 1) -> dict:
    if source.resolve()==output.resolve() or output.exists():
        raise ValueError('display output must be a new path')
    raw = source.read_bytes()
    source_sha256 = hashlib.sha256(raw).hexdigest()
    weather = json.loads(raw)
    if not isinstance(weather, dict):
        raise ValueError('weather product must be a JSON object')
    result = quantize_weather(weather, source_sha256, len(raw), decimals)
    _write_atomic(result, output)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--decimals', type=int, default=1)
    args = parser.parse_args()
    result = prepare(args.source, args.output, args.decimals)
    print(f"Prepared {len(result['frames'])} complete hourly frames at {args.decimals} decimals")


if __name__ == '__main__':
    main()
