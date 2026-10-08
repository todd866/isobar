# Deployment coherence harness

`tools/check-deployment-coherence.py` is a bounded, read-only evidence check
for the web deployment, a selected native archive, an installed app bundle and
an optional public release endpoint. It does not build, execute, notarize,
publish, or read a personal archive unless `--store` explicitly names it.

Run only the scopes you have evidence for. For example:

```sh
python3 tools/check-deployment-coherence.py \
  --web-url https://isobar.md \
  --release-api-url https://api.github.com/repos/todd866/isobar/releases/latest \
  --expected-web-commit 0123456789abcdef0123456789abcdef01234567 \
  --now 2026-10-08T12:00:00Z --json
```

Use `--app /Applications/Isobar.app --reference-app /path/to/candidate.app`
to compare bundle metadata and SHA-256 hashes, or `--store /path/to/archive`
to check the native pointer, run manifest, first MSLP sidecar, age, coverage
and web lag. Native-only runs omit web comparison rows. `--max-model-age-hours` defaults to 18 and
`--max-run-lag-hours` defaults to 12. `--now` makes boundary tests
deterministic. A selected scope always emits checks; missing required evidence
is `fail` or `unverified` and can never produce an overall green result.

The web check reads `/data/manifest.json`, validates the schema 1 or 2 ladder
(schema 1 may omit `forecast_hours` and then defaults to 0–96 h every 3 h),
UTC timestamps, generated/run ordering, model age, dimensions, coverage,
`uint16` grid metadata, and the nested `variables[name]` field declarations.
Core fields require exact units, finite scale/offset/fill metadata, and safe
frame paths with no nulls. A legacy packed `file` is accepted as metadata
evidence but its bytes are not decoded. It also reads `/isobar-release.json`.
The minimal build stamp is
JSON with `schema: 1`, a 40-hex `source_commit`, and optional `source_tree`,
`product_version`, and `build_id`. Without `--expected-web-commit`, that
identity is observed but remains unverified. The stamp is a build-time label,
not cryptographic attestation.

The native check takes a stable pointer snapshot and retries neither an archive
refresh nor an app build. A pointer rollover during the read is reported as
`unverified`; the harness never silently mixes runs. When the global pointer is
present it is authoritative: it must be schema 2 and declare the exact seam-free
720 × 361, 0.5° grid with `wraps_longitude: true`. An invalid global pointer
fails; the Australian `ecmwf_ifs025` family is used only when no global pointer
exists, preserving legacy archives. Schema 1 may use the Australian pointer
without a run manifest. The selected family is compared with the web coverage,
forecast ladder, and global wrap flag. Run lag is signed in the report and
passes when the absolute difference is within the configured bound. The check
is metadata coherence evidence: it does not decode every product frame or claim
full numerical parity between native and web products. App identity includes a
deterministic hash of every path and payload under `Contents`, including
training resources and collector internals, plus plist version/build. Reference
comparison records changed relative paths while retaining strict full-bundle
hash and version/build matching. Hashes do not prove source identity; the app is
never executed and notarization is not claimed.

The release check accepts a published GitHub-style JSON response, finds a
macOS arm64 DMG, and verifies that the exact URL appears in server-rendered
`/download` anchor markup. Script text is ignored. A native development
version does not have to equal the latest public release; both are recorded as
separate observations.

For browser behavior and viewport checks, use the companion
`tools/check-deployed-web.mjs` suite. This Python harness is metadata coherence
evidence; it does not claim full native/web numerical parity or replace the
headless browser checks.

For decoded shared archive parity, run `tools/check-global-parity.py` with
Python 3.12 and NumPy, and explicit `--store` and `--web-data` directories.
Its regression tests run in the native gate's complete Python discovery and
the hosted Python workflow. `--web-data` names the
directory containing `manifest.json` and the packed frame files. It validates the global schema 2
pointer, ladder and seam-free geometry, then compares every cell of all 53
frames for pressure, temperature, wind speed and 24-hour rain. Web packed
uint16 frames may use raw or shuffle-gzip encoding; comparisons use the field
scale half-step plus a bounded float32 rounding term. Rain checks select the
newest retained native run covering both endpoints of each 24-hour window,
including the first 24 hours, and apply the native archive's exact reset
threshold. Every
input file read is hashed again before a pass; the report includes the bounded
snapshot file count/digest, manifest hashes and cell totals. This proves
shared archive/export values only; it does not establish native GPU shader or
rendered-pixel parity.

## Worldwide visual evidence

Run the world renderer separately against the prepared global preview:

```sh
PLAYWRIGHT_MODULE=/path/to/@playwright/test \
  node tools/check-world-rendering.mjs \
  --url http://127.0.0.1:3188 --out build/world-rendering
```

It captures pressure, temperature and wind at a world view, the dateline,
London, Tokyo and both polar boundaries. It records the actual hardware
WebGL renderer, then repeats the views with WebGL unavailable and with
initialization failing after context acquisition. The latter two must render
an opaque, non-black Canvas2D plate and field, survive a phone resize and
unmount on navigation. The download anchor is checked at 200% text size.

The report intentionally calls these captures evidence requiring manual visual
review. Geometry and non-blank pixels cannot establish readable coastlines,
correct fields, attractive pressure labels or matching native/web projections.
Inspect the viewport PNGs alongside the behavior harness's light/dark laptop
and phone captures before accepting a release.

The native suite also generates a small synthetic global archive to exercise
the controller's loader and its failure behavior alongside a valid Australian
publication. When `build/global-archive` is present, it runs the real global
renderer and complete offscreen interface at the archive's own model time.
The classic renderer checks cold coastline rasterization on a background
thread, cache reuse and 1×/2× scale changes with a five-second ceiling. That
ceiling catches the observed twenty-second stall; it is not a universal
startup benchmark or a pixel-fidelity claim. Coastline fidelity and seam
handling still require visual inspection.

`tools/sanitize.sh` also exercises the real global archive and classic coastline
under AddressSanitizer and UndefinedBehaviorSanitizer when that archive exists.
The standard regional, motion and concurrent-render sanitizer checks remain
mandatory without it.
