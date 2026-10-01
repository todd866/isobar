# Maintenance priorities

## Checks on each change

GitHub runs the full native test suite and an ad-hoc macOS 15 development build
on pushes and pull requests. The job checks the executable's version against its
bundle metadata. The collector repository separately runs its locked Python test
suite on Linux. Neither job needs provider accounts or signing credentials.

Locally, `./build.sh` runs the native tests and builds the self-contained app.
`./tests.sh` includes controller/store-refresh and layer integration checks as
well as the individual model/parser tests. For the real archive and prepared
movie path, run the offscreen checks described in [app-guide.md](app-guide.md).
Release packaging, notarization and installation checks are separate;
[releases.md](releases.md) describes them. A green development build is not a
notarized release.

## Active priorities

- [ ] Extract the selected place, forecast instant and unit preferences from the
   controller into a small state model. Preserve existing timeline, layer and
   store-refresh behavior with integration tests during extraction.
- [x] Mark product-family payloads and pointers in the collector and reject
   incompatible versions or families in native readers. Legacy files remain
   readable while their contract is known.
- [ ] Share fixture archives between app and collector, including coordinate,
   unit, timezone and missing-value cases. The root `manifest.json` remains an
   index rather than the only schema gate.
- [ ] Generalise the regional grid/renderer contract, then connect a foreign place
   end to end. Use the [international UX study](design/international/README.md)
   for place switching and acceptance cases. Do not label Australian map data
   as a foreign forecast.
- [ ] Connect pinned Perth ↔ Japan switching to real forecasts: matching regional
  maps, local clocks, preserved forecast time and units, and cached return trips.
- [ ] Verify switching, offline behaviour, smooth scrubbing and viewport fit;
  run both repositories' checks before publishing.
- [x] Add a manual in-app NOTAC connection, refresh and remove flow; keep each
  pilot's key in the local macOS login Keychain and out of public site code.
  The app uses the standard login Keychain so self-built and Developer ID
  copies work without a provisioned app-identifier entitlement. It does not
  request iCloud Keychain synchronisation.
- [x] Test the signed collector against a pilot's live key. On 28 September,
  the manual refresh published 87 NOTAC notices for YPPH, YPJT and YMMM.
  Automatic refresh remains a separate feature.

`FullscreenWindow` is now a separate module. Continue splitting
`Sources/main.m` along the tested place, time, layout and playback boundaries.
Avoid a broad file shuffle while behavior is still changing.

The website's 390×844 large-text map clipping fix passed the headless viewport
suite and its first Pages deploy. Notarization needs a saved Apple credential
profile before a public Mac download can ship.

## Audit decisions, September 2026

The version/help output, deployment target, duplicate atmosphere test and
location request API have been corrected. macOS uses its single authorized
location status for the When In Use request. The collector now attributes NOTAC
products through its source ledger, and its active design documents describe
the actual GRIB pipeline rather than the superseded grid proposal.

SIGMET checks remain every five minutes. The current cadence is within the
[AWC API's published limits](https://aviationweather.gov/data/api/); the old
twice-hourly design note was obsolete. Conditional requests and scheduler
backoff remain in place.
