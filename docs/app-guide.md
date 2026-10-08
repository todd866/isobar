# Isobar native app guide

How the Mac app uses weather data, draws the atmosphere and prepares animation.
For interaction decisions and their rationale, see the [UX contract](design/ux-contract.md).

## Forecast data

The bundled collector refreshes weather while the app is running and leaves
the latest successful archive available offline. The native reader follows the
collector's `current.json` pointers.

- ECMWF IFS 0.25° grids are stored as per-time little-endian float16 files.
- Bureau observations use a read-only SQLite snapshot and warning XML.
- Open-Meteo supplies surface point forecasts and published kite spot data.
- Airport products provide METAR and raw TAF conditions.
- The ECMWF evolving map is the default native forecast surface; the Bureau
  prognosis PDF remains available as a chart layer.

Local forecasts use the closest collected point within 30 km. Observation
cards keep the station and forecast-point distance available in detail. TAF
change times are read from the source and converted from UTC for display. A
ceiling uses BKN, OVC or VV; FEW and SCT alone do not create a ceiling.

Forecast age describes the chart that is actually loaded. Failed health checks
and charts older than 18 hours are marked stale. A newer run that cannot be
read leaves the last good chart playing, marked stale, until a complete run
arrives. Missing values remain
unknown. Partial model runs are rejected. Older float32 stores remain readable
when the published grid pointer is absent.

The rain colour layer shows the preceding 24 hours from accumulation pairs in
one model cycle. Blue through purple indicates increasing totals, with a visible
millimetre scale. Missing totals show “Rain unavailable at this time”; they are
not treated as zero. Early frames use both ends of the complete 24-hour window from the newest
retained earlier cycle that covers it. Adjacent-frame interpolation blends that
field into the first current-cycle total at 24 h. Unknown schemas, incompatible
sidecars and empty windows are skipped; absent windows and cells remain missing. This is model precipitation, not observed radar.
Hourly rain uses the hour
ending at each source timestamp; the graph covers 24 buckets from the current
hour. The display rounds the glance total but keeps supplied precision in
inspection. Weather labels follow the archived
[Open-Meteo weather codes](https://open-meteo.com/en/docs/ecmwf-api).

## Aviation

The Fly view shows the current METAR and raw TAF directly. It lays out cloud
bases vertically and visibility horizontally on a fixed 0–60,000 ft AGL
schematic. Cumulonimbus is an anvil with a red "TS" tag; towering cumulus is a turret. An INTER or TEMPO thunderstorm is a tinted band with "TS" across its time span, and vicinity thunder is the word "VCTS" at the edge of the sky. The METAR row names the convective base first ("CB 3,500"). Prevailing and conditional TAF scenes are separate. TAF times
beyond the source remain empty rather than being invented.

The latest METAR remains above the scene. Civil twilight follows the selected
airport and forecast instant using the solar centre at −6°, with BCT and ECT
shown where available. The sky tint is deliberately gentle. TAF cloud bases
are AGL; ECMWF geopotential heights are AMSL and are never substituted for
one another.

The collector includes Australian FIR SIGMETs. In Aviation Notices, **NOTAC**
adds a pilot's personal API key to the Mac Keychain, refreshes NOTAMs on demand,
or removes the key. Briefings can also be imported from ICAO text or canonical
JSON. The viewer preserves scheduled and estimated wording; SIGMET coverage is
regional, not an airport radius. The NOTAC connection still needs a live-key
acceptance check before automatic refresh is enabled.

## Atmosphere and traffic

Fly → Atmosphere uses a fixed 0–20 km column. The standard atmosphere gives a
reference temperature curve and tropopause. The airport profile adds model
temperature, moisture, cloud fraction, freezing levels, inversions, wind in
knots and model vertical motion across 13 pressure levels up to 50 hPa.
Vertical motion is a schematic model ascent/descent value, not a lift estimate.

Small aircraft markers provide reference levels: light aircraft, glider, PC-9,
King Air, 747, U-2 and SR-71. Scrubbing moves them through the profile. An
optional **Airborne now** layer shows recent ADS-B signals within 80 nautical
miles of the airport. It uses [ADSB.lol open data](https://www.adsb.lol/docs/open-data/api/),
keeps signals in memory, refreshes once a minute while visible and expires old
positions after 90 seconds. Forecast scrubbing hides live traffic. The data is
available under ODbL 1.0.

## Animation and interaction

Playback interpolates the raw ECMWF fields and renders intermediate pressure
maps locally. It shows one pressure field at a time, without crossfading
contours. A bounded cache prepares nearby frames; wind interpolation uses
vectors and the coastline stays fixed. The Mac app does not prepare a movie.

Animation speed is visible beside **Play/Pause** on both map sizes; the control
shows the current multiplier. It is also available in **Settings → Playback**. **1× is one forecast minute per real second**. Choices are 1×, 2×,
4×, 8×, 16×, 32×, 64×, 128× and 256×, with 8× as the default. The choice is remembered.
The former Slow/Medium/Fast preference is retired and starts at the new 8×
default once; subsequent selections use the exact multiplier.

**Layers** selects one colour field: pressure only, 24-hour rain, wind speed,
surface temperature, or temperature at 850 hPa. Pressure contours stay visible,
and wind-direction barbs can be switched independently. Place readings are
grouped separately from colour layers. Rain, wind and temperature each have a
scale on the map. Full-map visibility and radar need additional data sources;
airport visibility remains in the Fly view.

The map remains one persistent surface in the expanded view. The compact
footer holds current temperature, wind, place and warning actions; pressure
and warning detail opens from the observation button. The bottom transport
holds play, now, step controls and the large timeline. Zoom and earlier-run
comparison stay in the toolbar. Reduced Motion is respected.

The motion is an interpolation of forecast fields, not a new high-resolution
forecast. Contour labels, forecast edges and rain boundaries can therefore
show artefacts while the underlying data changes between model steps.

For a local movie export, see [wall rendering](../wall/README.md). Exporting a
movie does not cast it to a television. The earlier Bureau image-morphing
prototype remains behind `ISOBAR_EXPERIMENTAL_MOTION=1` for development.

## Packaging and checks

`build.sh` builds `build/Isobar.app` for the current architecture, bundles the
collector, validates nested libraries and signs when a Developer ID is
available. `ISOBAR_ADHOC=1` forces ad hoc signing. `ISOBAR_ARCHS=native` is the
default; explicit `arm64` and `x86_64` builds are supported.

The build runs `tests.sh`, which covers the pure data model, forecast views,
aviation views, rain, motion, map detail, published-grid cache behavior and
the layer acceptance harness. The offscreen app harness checks navigation,
timeline scrubbing, animation preparation, light and dark rendering, compact
windows and the expanded single-map view.

The app does not install or activate itself during these checks. Keep test
archives separate from personal weather stores, and do not commit generated
archives, credentials, NOTAM imports or precise private locations.
