#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DATA_SOURCE=${ISOBAR_DATA_SOURCE:-"$APP_ROOT/../isobar-data"}
BUILD_ROOT=${ISOBAR_COLLECTOR_BUILD_DIR:-"$APP_ROOT/build"}
OUTPUT="$BUILD_ROOT/collector"
DIST_ROOT="$BUILD_ROOT/.collector-dist"
WORK_ROOT="$BUILD_ROOT/.collector-work"
PYTHON=${ISOBAR_BUILD_PYTHON:-}
usage() {
    echo "Usage: tools/build-collector.sh [--output DIR] [--data-source DIR]"
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; OUTPUT=$2; shift 2 ;;
        --data-source) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DATA_SOURCE=$2; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
[ -f "$DATA_SOURCE/pyproject.toml" ] || { echo "isobar-data source not found: $DATA_SOURCE" >&2; exit 1; }
if [ -z "$PYTHON" ]; then
    # Homebrew's Python may require the build machine's newest macOS. A
    # portable CPython 3.12 runtime keeps the app's supported macOS baseline.
    if command -v uv >/dev/null 2>&1; then
        export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$BUILD_ROOT/python}"
        uv python install 3.12
        PYTHON=$(uv python find --managed-python 3.12)
    fi
fi
if [ -z "$PYTHON" ]; then
    for candidate in python3.12 python3.13 python3.14 python3; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
            PYTHON=$(command -v "$candidate")
            break
        fi
    done
fi
[ -n "$PYTHON" ] || { echo "Python 3.12 or newer is required" >&2; exit 1; }
mkdir -p "$BUILD_ROOT"
VENV=$(mktemp -d "$BUILD_ROOT/collector-venv.XXXXXX")
cleanup() { rm -rf "$VENV"; }
trap cleanup EXIT HUP INT TERM
if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON" "$VENV"
    uv pip install --python "$VENV/bin/python" --editable "$DATA_SOURCE" "pyinstaller==6.16.0"
else
    "$PYTHON" -m venv "$VENV"
    "$VENV/bin/python" -m pip install --upgrade pip
    "$VENV/bin/python" -m pip install --editable "$DATA_SOURCE" "pyinstaller==6.16.0"
fi
rm -rf "$OUTPUT" "$DIST_ROOT" "$WORK_ROOT"
mkdir -p "$DIST_ROOT"
"$VENV/bin/pyinstaller" --noconfirm --clean --onedir --name isobar-data \
    --paths "$DATA_SOURCE" --collect-all eccodes --collect-all eccodeslib --collect-all eckitlib \
    --add-data "$DATA_SOURCE/config/isobar.toml:config" \
    --add-data "$DATA_SOURCE/LICENSE:licenses" \
    --hidden-import isobar_data.fetch_ecmwf --hidden-import isobar_data.cli \
    --distpath "$DIST_ROOT" --workpath "$WORK_ROOT" \
    --specpath "$BUILD_ROOT" "$SCRIPT_DIR/collector-entry.py"
mv "$DIST_ROOT/isobar-data" "$OUTPUT"
rm -rf "$DIST_ROOT" "$WORK_ROOT"
echo "Collector ready: $OUTPUT"
echo "Python build interpreter: $PYTHON"
