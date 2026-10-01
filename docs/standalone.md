# Standalone collector

`tools/build-collector.sh` builds a PyInstaller one-folder executable for the
Python collector. It creates a temporary virtual environment below `build/`,
installs the sibling `isobar-data` checkout and the pinned PyInstaller release,
then writes a copy-ready `build/collector/` directory. The source checkout and
temporary environment are not included in that directory.

The default source is `../isobar-data`. A self-hosted checkout can be used with
`ISOBAR_DATA_SOURCE=/path/to/isobar-data tools/build-collector.sh`, or the
equivalent `--data-source` option. `--output` selects another destination, such
as `--output build/Isobar.app/Contents/Resources/collector`.

The executable preserves the collector CLI: `run`, `retain`, `import-notams`
and `fetch-notams`, with `--data-dir` and `--config`. `--check-runtime` verifies
bundled configuration and a native ecCodes GRIB encode/decode round trip.

The folder is built for the host architecture and operating-system ABI. A
binary built on Apple silicon is not a universal Intel binary; build once per
target architecture (or build on a targeted builder). PyInstaller also bundles
the native ecCodes libraries discovered in the build environment,
so the resulting folder must be shipped intact.
