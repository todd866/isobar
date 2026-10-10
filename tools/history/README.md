# Historical Isobar — first working slice

The website has a **Historical** entry in the map menu and navigation rail.
`/historical` reads a catalog of actually ingested collections and complete UTC
calendar days. The first collection is global D-Day weather, 5–6 June 1944 (48 hourly frames).
It uses direct ERA5 surface fields from the anonymous Google ARCO mirror,
with pressure contours using Isobar's existing marching-squares implementation.
World and Normandy views, zoom/pan, hourly playback and a separate original
Omaha Beach chart facsimile are available. The world uses a WWII chart palette,
red pressure contours and AI-generated paper texture at every zoom. Source detail
is behind Sources; no persistent disclaimer panels are added.

## Acquisition and local preview

Run from the repository root. Dependencies are isolated; native app/collector
credentials and production stores are not used.

```sh
uv venv build/history-venv
uv pip install --python build/history-venv/bin/python -r tools/history/requirements.txt
/usr/bin/python3 ~/.codex/power/battery_guard.py run -- \
  build/history-venv/bin/python tools/history/import_arco.py
python3 tools/history/publish_catalog.py build/history/dday-global.json \
  --maps tools/history/dday-maps.json
```

Prepare `web/public/history/world-coast.bin` from the existing Isobar resource
`Resources/world-coast.bin` (the web branch may lack the resource; use the native
checkout's identical Natural Earth 1:50m file). The map facsimile source URL is
recorded in `sources.json`; local preview uses `web/public/history/dday-map.jpg`.
The locally prepared JPEG is a 2400-pixel derivative of the source scan, preserving
orientation and the complete map. The download is 7.4 MB; derivative ~1.3 MB.
It has not been georeferenced, and is never overlaid on weather coordinates.
The generated texture is prepared at `web/public/history/themes/wwii-paper.png`;
the renderer falls back to plain cream paper if it is unavailable.
Item-level reuse assessment remains necessary before public deployment.

`cd web && npm run dev -- --hostname 127.0.0.1 --port 4319` serves the preview.
Nothing in these tools deploys, pushes, installs the Mac app, or schedules work.

## Resumable acquisition

`import_arco.py` reads the archive's actual time/latitude/longitude coordinate
arrays, pins the final ERA5 coverage from source metadata, checks source units,
and converts Pa→hPa, K→°C and m/s→knots. It reads only four surface arrays:
MSLP, 10 m u/v wind, and 2 m temperature. The source fields are global 0.25°;
the initial web product samples them at 2.5° (144×73). Hourly values are estimates;
rendered colours interpolate between samples. This is not a new fine-resolution
weather simulation. Wind points downwind.

The current reader pins the source Zarr v2 encoding and array shape. Compressed
chunks are cached below `build/history/arco-cache`; it validates decoded lengths,
finite values and physical ranges. Receipt files record each source chunk's hash.
The cache allows later higher-resolution regional products without downloading
the same global source hours again. Bad cached chunks fail closed; inspect and
remove the named corrupt chunk before resuming. No automatic retry loop.

Every network sub-job checks battery admission. Each invocation is limited to
1–7 days and a caller-specified 16–2048 MiB transfer budget; default 512 MiB.
The transfer budget conservatively reserves the response cap before each request,
so it can stop slightly early. Rerun to resume. Requests are serial with 45-second
timeouts, response caps and atomic cache writes. A day becomes selectable only
when all 24 hourly frames and required fields validate. Publication is a local,
atomic catalog switch to content-addressed assets; partial acquisition remains
in the cache and does not enter the selector.

The initial 6 June download took about 255 MiB. A validated cache replay downloaded
zero field bytes. `build/history` and `web/public/history` are ignored, preserving
the repository's rule against committing weather archives.

## Curated worldwide queue

`campaign.json` starts with D-Day, the preceding storm, Cyclone Tracy, Apollo 11
and VE Day. These are acquisition targets, not claims that all data is present.
Only successful products appear on the website.

```sh
/usr/bin/python3 ~/.codex/power/battery_guard.py run -- \
  build/history-venv/bin/python tools/history/ingest_campaign.py --jobs 1
```

The runner skips already validated products and processes at most the requested
number of new jobs (1–5). The byte cap applies per job. Run one job at a time on
the shared machine. No unattended or unlimited harvest is configured.

Map ingestion currently indexes USGS HTMC metadata, including date, geographic
bounds, downloadable formats, source identity and expected byte size. It records
`indexed`, never `downloaded`. Index metadata before selecting expensive rasters.

```sh
/usr/bin/python3 ~/.codex/power/battery_guard.py run -- \
  python3 tools/history/index_maps.py --pages 10
```

SQLite transactions retain the pagination cursor and deduplicate source IDs.
Each invocation fetches at most 10 × 100 records, capped at 4 MiB per response.
The initial batch indexed 1,000 of 186,061 records reported by USGS. That is a
metadata inventory; these maps do not appear as render-ready dates in the UI.

## Source roadmap and remaining work

`sources.json` distinguishes active, downloaded, prototype-only and planned
adapters. Direct ARCO ERA5 is the worldwide bulk weather path. NOAA 20CRv3 is the
candidate for 1806–1939; its adapter and ensemble treatment are not implemented.
The Open-Meteo adapter is retained as a small non-commercial prototype, not used
for production or bulk acquisition. Global historical map coverage needs more
archives and georeferencing, including projection/control-point residuals.

Production follow-up: move content-addressed products to object storage, serve a
small coverage index by time and area, add bounded tile/frame caches, validate
map reuse permissions and geography, then integrate/release through the web
branch's normal process. No public deployment has happened in this work.

## Validation

```sh
build/history-venv/bin/python -m unittest Tests.test_history_arco Tests.test_history_weather Tests.test_history_catalog -v
cd web && npx vitest run tests/unit/history.test.ts
```

Headless QA uses the actual global data and viewport-fit helper; includes laptop,
phone portrait/landscape, dark theme, source/map panels, 200% text, offline
scrubbing/playback and switching between both cached days. No browser windows are opened on the owner’s
screen. Native code is unchanged.

Run `node tools/history/check_browser.mjs` from the root against the prepared
local preview for repeatable panel/offline/large-text checks. `HISTORY_ORIGIN` and
`VIEWPORT_HELPER` override the local defaults.

## Release asset closure

`package_assets.py --destination /absolute/path/to/new-bundle` reads the current
catalog, validates every collection against complete weather days, and writes only
referenced assets plus coastline/paper. JSON is compacted; each file has byte size
and SHA256 in `asset-manifest.json`. The destination must not exist. Local research
Omaha facsimiles are omitted from the production manifest while their LOC source
stays linked in the UI. Copy the bundle's `history/` directory into `web/public/`
of the combined release checkout. Keep those ignored assets in the recurring web
weather refresh checkout too, so later deployments do not remove Historical.

The initial D-Day closure is 17,555,159 bytes (~16.7 MiB), down from the pretty JSON
research assets. Raw Zarr chunks, old products, PDFs and local research scans never
enter that closure. The combined release chat owns final production promotion.

## Documentary observations and plausible scenarios

The next historical lane stores qualitative observations separately from weather
fields. Eleven original brief paraphrases from the University of Houston's
Columbus journal transcription have been indexed in JSON and SQLite under
`~/Data/isobar-history/observations/`. They retain entry dates as
written, source URLs/locators, phenomenon and unmeasured values as null. 1492 dates
must not be silently treated as modern Gregorian UTC. Approximate route positions
still need scholarly reconstruction; sailing distances/speeds are not wind values.
Full copyrighted electronic transcriptions are not bundled.

A future scenario product should carry its own identity, source observation IDs,
seasonal background, analogue selection, model/version/seed, constraints and
residuals. Multiple physically coherent candidates can fit sparse evidence; a
single fitted map does not identify the actual global state. Use a distinct
scenario product (not ERA5) and keep the short distinction plus supporting detail
in Sources. No1492 weather grid is generated or selectable in the current release.
ICOADS starts1662 and EKF400 monthly reconstructions start1600; neither supplies
1492 daily observations. Candidate source metadata is in sources.json.

### Everest minute track

From the repository root:

```
web/node_modules/.bin/tsx --tsconfig web/tsconfig.json tools/history/prepare_everest_timeline.ts WEATHER.json.gz NEW_OUTPUT_DIRECTORY
```

Writes a versioned gzip dataset, source/method snapshots and SHA256 manifest.
Refuses to overwrite a prior export. Every minute carries synthetic provenance,
source anchors and clock convention; original weather metadata is retained.
