#!/bin/sh
# Prepare the hosted Python dependencies inside the immutable local export.
set -eu
cd "$(dirname "$0")/.."
command -v python3.12 >/dev/null || { echo 'Install Python 3.12 before running Python checks.' >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo 'Install ffmpeg before running Python checks.' >&2; exit 1; }
command -v ffprobe >/dev/null || { echo 'Install ffprobe (from ffmpeg) before running Python checks.' >&2; exit 1; }
python3.12 -m venv --clear build/ci-python
PYTHON=build/ci-python/bin/python
# NumPy/SciPy are required by the unchanged native offscreen jank scorer.
"$PYTHON" -m pip --isolated install --disable-pip-version-check --no-cache-dir pytest pytest-timeout pillow numpy scipy -r tools/history/requirements.txt
"$PYTHON" --version
"$PYTHON" -m pip --isolated list --disable-pip-version-check
