# Store readiness

Run the structural check against the actual archive:

```sh
python3 tools/check-store.py --store ~/Data/isobar
```

The app now reads the collector's published products directly. A compatibility
exporter is not required. The authoritative chart pointer is
`products/grids/ecmwf_ifs025/current.json`; the old `ecmwf/latest.json` is used
only when the published grid pointer is absent. A present but invalid published
grid never silently falls back to an older prototype chart.

The app reads the store off the main thread and commits a complete snapshot.
If a reload fails after a good one, the last good run stays on screen, marked
stale, with the read error in the header tooltip; a first load, a new store
root or a change of layout fails closed instead. Weather is never kept this way.

The native reader accepts two grid schemas. Schema 1, including a pointer
with no `schema_version`, is a complete 0–96-hour sequence at three-hour steps
(33 frames). Schema 2 lists `forecast_hours` on `current.json` and on the run
`manifest.json`: 0–144 h every 3 h, then 150, 156, 162 and 168 h (53 frames).
`uniform_step_hours` is null. Each sidecar carries `lead_hours` and does not
claim a 3 h step. The two hour lists must match. A listed hour with no file
fails the run; the reader does not invent 147 h or any other gap, and it does
not reuse the previous hour. Schema 3 and any other marker fail closed. A run
directory with no manifest stays the schema 1 grid. Float16 missing-value
sentinels become missing data. Rain is the 24-hour accumulation between a
lead and the lead 24 h earlier in `forecast_hours`, including an earlier
published cycle where that pair is not in the current run. Eight frames back
is 24 h only while the step is 3 h.

Observations are read from SQLite in a read-only transaction, including
committed WAL updates. On macOS, an idle WAL may need auxiliary files recreated;
that fallback prohibits SQL writes and close-time checkpoints. The checker needs
Python 3.12 or later for this fallback. Point and kite readers follow their own current
pointers. Point forecasts are matched by distance within 30 km; the app exposes
the selected point and distance in the card tooltip. The flying summary uses
the selected airport, with true runway bearings from its archived product.
Bureau warning XML uses actual product/AMOC metadata, and expired or cancelled
products are excluded.

Use the real app code for acceptance after the structural check:

```sh
./tools/check-app.sh ~/Data/isobar build/acceptance
./tools/check-layers.sh ~/Data/isobar build/layer-acceptance
```

The app check creates no visible windows and changes neither preferences nor the
archive. It reports loaded data and preparation/navigation timings, exercises
the enlarged sequence, and writes viewport screenshots at 1440×900, 1280×720 and
1024×600 in both appearances. Inspect the images, including chart labels,
warnings, navigation and observation cards. It returns nonzero for missing
core data or viewport failures. These native macOS surfaces are not phone UIs.

The layer check starts on the Bureau map, dispatches the actual Layers menu
actions and compares chart pixels for surface temperature, temperature aloft,
no temperature and wind. It checks the popover, enlarged map and overview,
returning to Bureau, and unavailable model data. Inspect its captured maps too:
changed controls or legends alone do not prove that a layer rendered.
It uses disposable preferences, a fixed clock for fixtures, and the same window
colour profile for actual and expected captures. `tests.sh` runs these regression
checks on every build; the live-store invocation also produces inspection images.

`./tests.sh` covers legacy stores, published float16 grids, missing/truncated
fields, source health, SQLite/WAL reads, point conversion and units, warning
formats, daylight windows, runway bearings and controller refresh behavior.
All tests use temporary fixtures. Regression tests prove a newer source status
cannot relabel an older loaded chart, and dropped weather data cannot survive a
complete store refresh.

The structural check is not a full scientific or operational weather audit.
It covers built-in Perth/Sydney places; newly configured locations can lack a
nearby archived point. The Bureau PDF has no verified issue metadata, so its
age is not inferred from ECMWF. No missing rain total, wind measurement or
sunrise/sunset interval is replaced with a favourable condition.
