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

The native reader validates a complete 0–96-hour sequence at three-hour steps,
field lengths, sidecars, units and timestamps. Float16 missing-value sentinels
become missing data. Rain is a 24-hour accumulation difference from a single
cycle, including an earlier published cycle where needed and available.

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
