# Isobar

A moving weather map for Australia, with the details you need when you need them.
Watch pressure systems develop, scrub to a day and hour, then explore the rain,
temperature, wind, surf or flying conditions underneath.

**[Open Isobar in your browser](https://todd866.github.io/isobar/)** ·
**[Mac download](docs/install.md)** · [Run your own website](docs/hosting.md)

The first Mac installer is awaiting Apple notarization. It will be a
self-contained download for **Apple silicon (M1 or newer), macOS 15+**:
open the disk image, drag Isobar to Applications, then open it from there.
The browser version is available now.

## Start with the weather

One map, one timeline. Let the forecast play, hover to preview a time, or drag
to hold it. Click the map to return to now and keep playing. Layers let you add
what matters and clear the rest.

- **Rain:** when it arrives, how much to expect, and the hourly breakdown.
- **Temperature:** a clear current reading, hourly forecasts and optional map colour.
- **Kite:** wind and gusts in knots, with arrows showing direction and strength.
- **Surf:** wave height, swell direction and period, wind and sea temperature.
- **Fly:** actual METAR and TAF conditions, with cloud layers drawn vertically
  and visibility horizontally. Open the atmosphere view to explore why the
  weather is happening.

## Web and Mac

The **[web app](https://todd866.github.io/isobar/)** runs in a browser with no
account or installation. It shows ECMWF pressure maps and Perth coastal rain,
temperature, wind and surf forecasts.

The **Mac app** adds Bureau charts, local observations and warnings, airport
weather, aviation notices, and an illustrated atmosphere view. Its menu bar
follows the Mac's location, with a temperature and wind reading in knots.
The arrow shows where the wind is going; the number gives its speed. Without a
location fix, Isobar uses a saved
place matching the Mac's time zone when possible. Expand the map for a larger
view with the same time, playback and scrub controls.

The Mac app includes its weather collector and keeps the latest forecast
available offline. METAR, TAF and SIGMET products are collected automatically.
For NOTAMs, open Aviation Notices and choose **NOTAC** to add your own key and
refresh. Isobar stores the key in the Mac Keychain. You can also import a
briefing. [How the collector works](https://github.com/todd866/isobar-data#notac-connection).

## Build the Mac app

For people who want to change the code or build their own copy.

You need **macOS 15+**, Xcode Command Line Tools, **Python 3.12+** and
[uv](https://docs.astral.sh/uv/). Clone the app and collector side by side:

```sh
git clone https://github.com/todd866/isobar.git
git clone https://github.com/todd866/isobar-data.git
cd isobar
./build.sh
open build/Isobar.app
```

The build runs the tests and creates a self-contained app for your Mac's
architecture. New weather data is stored in
`~/Library/Application Support/Isobar/Weather`. An existing `~/Data/isobar`
archive is reused; `ISOBAR_STORE` selects an independently managed archive.

See [releases](docs/releases.md) for packaging and publishing, [collector
bundling](docs/standalone.md), and the
[app guide](docs/app-guide.md) for aviation sources, atmosphere, data handling
and animation details.

## Run your own

The website is static HTML, CSS and JavaScript. Fork it, choose your public
forecast point and host it yourself. The [hosting guide](docs/hosting.md)
covers local previews, fresh weather exports and GitHub Pages deployment.

Isobar can also generate weather movies for a wall display. See
[wall rendering](wall/README.md) for export and playback.

## Contributing

Bug reports and pull requests are welcome. For a visual or interaction bug,
include the window size, selected layer and a screenshot if possible.

See [maintenance priorities](docs/maintenance.md) for the structural work.
Next: [making Isobar useful outside Australia](docs/design/international/README.md),
with a place-first UX study. Worldwide coverage is not in the current release.

GitHub builds the native app and runs its tests on pushes and pull requests.
The CI build skips the bundled collector; release packaging has separate checks
described in [releases.md](docs/releases.md).

Run `./tests.sh` for the native tests. With a collected archive, check the
rendered app and its layers offscreen:

```sh
python3 tools/check-store.py --store ~/Data/isobar
./tools/check-app.sh ~/Data/isobar build/acceptance
./tools/check-layers.sh ~/Data/isobar build/layer-acceptance
```

These checks exercise the real map, menu actions, timeline, weather panels,
earlier forecasts and compact layouts. [Store readiness](docs/store-readiness.md)
describes the data checks. Keep personal archives, precise locations,
credentials and imported briefings out of commits.

## License and data

Isobar's code is [MIT licensed](LICENSE). Weather data comes from ECMWF Open
Data, Open-Meteo, the Australian Bureau of Meteorology and the Aviation Weather
Center. Runways come from OurAirports, shore geometry from OpenStreetMap, and
base map geometry from Natural Earth. Data products retain their source
licenses and attribution.
