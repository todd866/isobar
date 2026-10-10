# Isobar

A moving weather map of the whole world, with the details you need when you need them.
Watch pressure systems develop, scrub to a day and hour, then explore the rain,
temperature, wind, surf or flying conditions underneath.

**[Open Isobar in your browser](https://isobar.md)** ·
**[Download Isobar 1.11.2 for Mac](https://github.com/todd866/isobar/releases/download/v1.11.2/Isobar-1.11.2-macOS-arm64.dmg)** ·
[Run your own website](docs/hosting.md)

The Mac app is for **Apple silicon (M1 or newer), macOS 15+**. The signed,
Apple-notarized download covers the whole world. Open the
disk image, drag Isobar to Applications, then open it from there.
[Installation guide](docs/install.md).

## Start with the weather

One map, one timeline. The forecast drifts forward on its own; scrub or hover
to choose a time, hold the map to freeze it, and press Now to return to the
present at **Real time** speed. Accelerated playback is labelled in forecast
minutes per second. Hover waits briefly before moving the timeline, so passing
the pointer across it does not change the time. Click-drag pans; pinch zooms;
the 2D/3D toggle selects the map mode, and two-finger vertical movement tilts and horizontal movement orbits in 3D.
North-up restores orientation; Recenter returns to the chosen place. Lenses add detail
for the activity you are planning:

- **Rain:** when it arrives, how much to expect, and the hourly breakdown.
- **Temperature:** a clear current reading, hourly forecasts and optional map colour.
- **Kite:** wind and gusts in knots, with arrows showing direction and strength.
- **Surf:** wave height, swell direction and period, wind and sea temperature.
- **Fly:** actual METAR and TAF conditions, with cloud layers drawn vertically
  and visibility horizontally. Open the atmosphere view to explore why the
  weather is happening.

## Web and Mac

The **[web app](https://isobar.md)** runs in a browser with no account or
installation. It has an interactive ECMWF pressure map with rain, wind and
temperature fields, plus [ATPL practice](https://isobar.md/train), an
[E6-B computer](https://isobar.md/e6b) and an [instrument lab](https://isobar.md/lab).
The web and Mac apps have different feature sets. Web Kite and Surf show
local wind and sea forecasts, while Fly adds an atmospheric cross-section.
**Historical** opens D-Day, Everest 1953 and Cyclone Tracy in the shared map.
D-Day adds dated forces and estimated ship movements; Everest includes the ascent
and detailed terrain. Tracy combines coarse reanalysis with a compact cyclone
reconstructed from best-track positions and intensity. Assumptions and sources
are available in Data sources. **Present day** returns to current weather. The
web history views use the same map, timeline and lens vocabulary as the present
map; the native history map is still a parity item.
In web 3D, Slice narrows terrain and atmospheric wind together. Orbit changes its
bearing and the slider moves it across the landscape; the point cross-section
follows the same cut. Both maps use bounded curved trails for illustrative
upper-air motion. These are still developing teaching views, not resolved storm simulations.
Aircraft replay uses observations captured during the current viewing session;
it cannot recover flights from before capture began.

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

| Workflow | Web | Mac |
|---|---|---|
| Map, timeline, lenses, pan/zoom and 2D/3D camera | Shared interaction model, including historical map routes | Native map, offline archive, 2D/3D camera and local products |
| Point detail and atmosphere | General point/sounding, marine and terrain panels | Airport and upper-air atmosphere views; general point parity remains open |
| Historical weather | Shared map, timeline and event/day views | Data readers exist; user-facing history map remains open |
| Learn and Ask | Newer Learn flows and Ask Isobar | Bundled Training window; native Learn/Ask parity remains open |

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

The current web app runs at [isobar.md](https://isobar.md). This repository
also contains the earlier static site in `site/`; its [hosting guide](docs/hosting.md)
covers local previews, weather exports and GitHub Pages deployment.

Isobar can also generate weather movies for a wall display. See
[wall rendering](wall/README.md) for export and playback.

## Contributing

Bug reports and pull requests are welcome. For a visual or interaction bug,
include the window size, selected layer and a screenshot if possible.


## In development

The web app at isobar.md currently leads on worldwide place and aerodrome
search, units (AUS / US / local), general point sounding, historical map
workflows, Ask Isobar and the newer Learn profile and review flows. Native and
web share the map camera, timeline and weather-lens interaction model, but
native Ask, the history map, general point/sounding parity and the newer Learn
semantics remain in development. A zoomed-in view draws 2 hPa isobars and
names nearby towns.

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
