# Hosting Isobar

The website is static HTML, CSS and JavaScript in `site/`. Its only data entry
point is `site/data/current.json`; the manifest names prepared map images and
hourly coastal readings. No account or server is needed to view it.

## Build a weather snapshot

On macOS, install Xcode Command Line Tools, Python 3.12+ and uv. Clone the two
repositories side by side, then collect and render:

```sh
git clone https://github.com/todd866/isobar.git
git clone https://github.com/todd866/isobar-data.git
cd isobar-data
uv run isobar-data run --profile public-web --data-dir ../isobar/build/web-weather
cd ../isobar
./tools/export-site.sh build/web-weather site/data
python3 -m http.server --directory site 8080
```

Open `http://localhost:8080`. The export uses ECMWF model maps and the public
Perth coastal forecast. It never copies Bureau charts, personal locations,
observations, imported briefings, credentials or the archive as a whole.

Serve the contents of `site/` with any static host. Export fresh data at least
twice daily. Prepare a new site directory and switch the whole directory
atomically, retaining the previous deployment if collection or rendering fails.
The manifest includes the model issue time; exporting an older run does not
make the forecast new.

## GitHub Pages

Enable **GitHub Actions** as the Pages source. **Collect public weather** runs
twice daily on Linux, reuses published grids, and uploads a validated public
snapshot. **Publish site** renders that snapshot on macOS, checks the browser
experience and deploys it. Source updates reuse the latest successful collection
instead of downloading the entire forecast again. Failed jobs leave the previous
deployment intact. The data cache retains two model runs; completed movies are
also cached so browser checks can be retried without rendering them again.
Either workflow can also be run manually.

To bootstrap a deployment, create a snapshot from a complete local archive:

```sh
python3 tools/public-weather.py export PATH_TO_ARCHIVE public-weather.tar.gz
python3 tools/public-weather.py import public-weather.tar.gz build/web-weather
```

The helper retains only the latest two ECMWF grid runs and the named public
coastal forecast, validates every file and removes other metadata. Attach the
bundle to a release tagged `weather-bootstrap` in your repository (mark it as a
prerelease, not the latest release). The workflows use this when no collection
artifact is available. Publication requires a model run less than 36 hours old
and at least 24 hours of coastal coverage; an expired bootstrap cannot replace
the working website. Change the collector repository in `collect-weather.yml`
if you maintain a fork; keep its revision pinned to a reviewed commit.

An optional `site/release.json` supplies a verified Mac download:

```json
{"url":"https://github.com/OWNER/isobar/releases/download/TAG/Isobar-VERSION-macOS-arm64.dmg","label":"Apple silicon (M1 or newer) · macOS 15+"}
```

The Download control reads this independently of the weather feed, so a forecast
outage cannot hide an available installer. GitHub Release `.dmg` and `.zip` URLs
are supported. The label describes supported Macs; the button supplies the
download action. While preparing a release, use `{"status":"preparing"}`.
Without a valid release URL, the control shows the preparation state and source
link. Never publish a guessed or broken download URL. See [releases](releases.md)
for the build, notarization and publishing steps.

## Browser checks

Install Playwright in your development environment and its Chromium browser,
then run `node tools/test-site.mjs`. Set `PLAYWRIGHT_MODULE` or `CHROME_PATH` to
use an existing installation. Checks run headlessly and cover laptop/phone
viewports, enlarged text, actual map changes, offline reuse, retry and response
races. Screenshots go to the system temporary directory.
