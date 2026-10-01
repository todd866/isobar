# Isobar, wherever you are

Design direction, not a claim of worldwide coverage in the released app.
The [interactive study](index.html) uses example weather and a bundled world
basemap. It works offline and does not request location permission. Its search
contains six example places; it is not a live geocoder.

## The first screen

One large regional weather map, your place, temperature, the next rain or snow, and the
same broad timeline. Everything else opens when requested.

The place name is a button. It opens one search for cities, towns, beaches and
airports, with **Use my location** alongside saved places. Results include the
region and country: London, England and London, Ontario must be distinct choices.
No country picker and no setup questionnaire.

Pinned places stay visible beside the place control. Someone working in Perth
with family in Japan should switch between **Perth** and their family's town in
one tap, without reopening search. Keep one large map; these are shortcuts, not
extra map panels. Show each place's clock at the shared selected instant, so the
time difference stays clear. The current place is visibly selected. Search adds
another place; a pin control keeps or removes it from the shortcut row.

Prepare the other pinned places in a small bounded cache, including their region
and nearby animation frames. Switching back should reuse prepared content,
including offline. No forced flyover across the globe or blank map between two
frequently viewed places. Location updates never pull someone away from Japan
while they're looking at their family's weather. The prototype starts with Perth
and Tokyo as examples; the real app does not assume where anyone's family lives.

For a first visit, offer location or search without an automatic permission
prompt. Until a place is selected, show a world overview and **Choose a place**,
with no invented local readings. Return visits open the last-viewed place. The
selector keeps recent places and lets people pin favourites; there is no hidden
home/explore mode to get stuck in. GPS is a deliberate choice, not an override
of a place being explored.
Store a public place or a coarse forecast coordinate, not a home address.

Choosing a place changes the map region, weather readings and local clock
together. Keep enough surrounding ocean and land to see weather approaching:
London needs Atlantic context, not a close-up street map. A **Local / Region**
control changes scale (labelled **Nearby / Wider** in the UI). Panning explores
without silently replacing the selected place. Preserve click-to-Now; dragging
the map must not reset the clock.

## The few things that should always be clear

| Visible | Behaviour |
| --- | --- |
| Place | Opens search; country appears where needed to avoid ambiguity. |
| Temperature | A large reading, with an explicit °C or °F. During scrubbing it follows the selected forecast time. |
| Rain or snow | Arrival time, type and amount, with the period stated compactly. Tapping opens the hourly detail. A dry forecast says “Dry next 24h.” |
| Map | One regional MSL pressure view. Temperature, rain and wind remain optional overlays. |
| Time | The selected place's date and local time. One wide hover/drag target, play and Now. |
| Layers | Rain, temperature, wind, and activity details. All optional; no activity must be selected. |

Local means the place being viewed, not the laptop's timezone. Use IANA zones,
including daylight-saving transitions and half-/quarter-hour offsets. Store time
as UTC instants. Searching/exploring another place preserves the forecast instant;
**Use my location** and **Now** reset to the present and resume playback. Day
labels, rain windows and solar shading must all use that
same context. Fly may offer UTC/Z alongside local time without changing the
everyday forecast clock.

Choose initial units from the user's system preferences, with one compact Units
menu for temperature, precipitation and wind. Keep the choice when travelling or
looking at another country. An existing Isobar user's chosen knots stay knots.
Kite and Fly retain their useful specialist conventions independently. Convert
values and labels together; don't relabel a Celsius series as Fahrenheit.

Outside Australia's warmer populated areas, precipitation also means snow and
mixed rain/snow. Show precipitation type and separate snowfall depth from liquid
equivalent. Bring frost, freezing conditions or exceptional heat forward when
relevant, rather than creating a tab for every possible weather concern.

## Optional depth follows the place

Surf asks for a coast or spot; it should not show an empty wave graph for an
inland city. Fly asks for a nearby airport or ICAO code and retains actual
METAR/TAF cloud and visibility content. Neither is on by default.

Available products are tied to their actual source coverage. A missing report is
not clear skies, zero rain or “no warnings.” Keep source freshness and missing
data in the relevant detail panel. An offline or stale view also needs one short
visible status by the time control, such as **Offline · updated 2h ago**; it must
not look live merely because cached imagery is available. Don't put a permanent qualification paragraph
over the map, and don't silently substitute another country's reports.

## What the current code really does

The current release is Australia-focused in several connected places:

- The collector crops ECMWF grids to 95–170°E, 50–0°S. The native map draws a
  fixed Australia Lambert window and the coast asset excludes most of the world.
- The collector fetches a bounded set of configured points. Changing a display
  location does not yet request a matching point forecast.
- Native place search scans WA, NSW and VIC station names. GPS inherits the saved
  place's state and timezone; those cannot be reused after international travel.
- The main native map clock uses `OwnerZone()` (Perth), even though some detail
  graphs already accept a place timezone. The website and export use Perth too.
- Marine and airport products also come from fixed configured selections.

Changing the labels alone would leave a foreign forecast under an Australian
map. Do not ship that as international support.

## Build sequence

1. **One place context.** Give each place an identity, coordinates, country,
   timezone and optional airport/coast association. Separate it from the user's
   unit preferences and the map viewport. Persist the selected place and resolve
   GPS metadata rather than copying the previous place's state/timezone. Define
   the regional window and projection contract here; the first foreign region
   must use it rather than adding another set of London-only constants.
2. **A complete vertical slice outside Australia.** Search, collect a real point
   forecast, prepare the matching regional MSL field, then show the coherent
   result. Keep the previous labelled view while preparing; failed requests offer
   Retry without replacing it with Perth data. Cancel or ignore late responses
   from previously selected places. London is a useful first case; Auckland then
   exercises the date line. IANA/DST handling, unit conversion, map wrapping and
   precipitation type are part of this slice's acceptance, not later polish.
   Share this context between web and Mac.
3. **Bounded global map delivery.** Reuse the global model field source, publish
   selectable geographic windows/tiles, and remove fixed Australia projection
   assumptions. Cache adjacent times and recently used regions. Avoid a rendered
   video for every searchable town or speculative worldwide downloads per user.
   Validate projection, longitude wrapping, animation and labels in both
   hemispheres before opening worldwide map selection.
4. **Broader everyday coverage, then specialist coverage.** Extend the already
   tested place/time/unit and rain/snow behaviour across published regions. Expand marine/airport selection
   through the same place flow; verify each warning/NOTAM source independently.

The default proposal is everyday weather worldwide first, with specialist depth
added as its sources are connected. Geographic map coverage is part of the core
experience, not something a working temperature panel can substitute for.

## Acceptance cases

- London UK versus London Canada: unambiguous search, correct map and timezone.
- New York in °F/in/mph, then Tokyo: preferences remain, day/date changes correctly.
- Perth/Japan: one-tap round trips, independent local clocks at the same instant,
  saved pins after reopening, and a prepared return trip with networking disabled.
- Auckland/Fiji: no blank seam or long way round at the date line.
- DST repeated and skipped hours; a quarter-hour zone; polar day/civil twilight.
- Location denied, offline saved place, unavailable source, and A→B→A while B's
  response arrives late. No inherited timezone, mismatched data or blank flash.
- Same time across map/readings/details. Mouse reversal changes visible frames
  continuously; click-to-Now resumes. Detail controls never shrink the main map.
- Laptop, short laptop, phone portrait/landscape and larger text. Search, saved
  places and Units remain keyboard-accessible; secondary UI closes with Escape.

## Sources and prototype limits

[Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) provides place
matches with administrative areas and timezones. Airport/beach search needs its
own matching data where these aren't represented; one search box can combine
them. [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data)
provides the global forecast source; Isobar currently retains only its Australian
crop. Provider suitability and public-service usage budgets must be checked at
implementation time, separately from this interaction design.

The study's bundled `land.js` is geometry from [Natural Earth 1:110m land](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/),
public domain, obtained from the project's `ne_110m_land.geojson` on 28 September
2026. The study's weather readings are illustrative, not a forecast. It does not
implement live geolocation, real global weather collection, airport feeds or the
production animation pipeline, and is not included in the deployed website.

## Verify the study

With Playwright installed, run `node tools/test-international.mjs` from the
repository root. `PLAYWRIGHT_MODULE` and `CHROME_PATH` can point at existing
installations. The headless check exercises four viewport sizes, search, pinned
Perth/Japan switching, shared forecast time, unit persistence, offline reuse,
layer pixels, broad scrubbing, keyboard focus and 200% text. Screenshots are
written to the temporary directory, or `ISOBAR_INTERNATIONAL_QA` when set.
