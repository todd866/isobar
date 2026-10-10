# Third-party notices

The app shell — left navigation rail, icon-over-label items, active accent bar,
surface tokens, and the review footer (Show answer, Again / Hard / Good / Easy) —
is adapted from MD3 (`src/components/AppShell.tsx`, `src/components/Navigation.tsx`,
`src/components/shared/ReviewNavigation.tsx`, `src/components/shared/ConfidenceButtons.tsx`).

MD3 is MIT licensed. Copyright (c) 2025–2026 MD3 Contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The spaced-repetition scheduler used by Train is the Isobar training module,
itself ported from Cohort under the same MIT licence. See `training/NOTICE.md`.

The coastline in `public/coast/ownchart-coast.bin` is a Natural Earth crop
(public domain), the same asset as `Resources/ownchart-coast.bin`.

`public/coast/lakes.bin` and `public/coast/rivers.bin` are Natural Earth 1:10m
lakes (with the Europe and North America supplements) and river centerlines,
public domain, packed by `tools/pack-water.py`. Close-zoom shorelines are
OpenMapTiles water polygons from OpenFreeMap
(https://tiles.openfreemap.org/planet), © OpenStreetMap contributors, ODbL.
They are fetched at run time and not stored in this tree. The coordinate cache
budget is 2 MiB (32 tiles × 64 KiB).

Town names in `public/places/world-places.json` are Natural Earth 1:10m
populated places (public domain), packed by `scripts/pack-places.mjs`.

Political borders in `public/borders/` are Natural Earth (public domain):
50m land boundaries and first-level admin lines for a wide view, 10m when
zoomed in, packed by `scripts/pack-borders.mjs`. Disputed, indefinite and
line-of-control classes are drawn dashed and are not named. State and
province names are Natural Earth's own label points.
Summit marks in `src/lib/peaks.ts` follow Natural Earth's geography-region
elevation points (public domain) for the continental high points, plus the
fourteen 8,000 m peaks, the Seven Summits and notable volcanoes. Each row
names the survey its elevation comes from.

Terrain relief is fetched at run time from Mapterhorn
(https://tiles.mapterhorn.com, https://mapterhorn.com/attribution): Copernicus
GLO-30 (© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018,
provided under COPERNICUS by the European Union and ESA) and national elevation
models under open licences (USGS 3DEP public domain, Natural Resources Canada
OGL-Canada, Geoscience Australia CC BY 4.0, and others listed there). No tiles
are stored in this tree.

Weather bytes under `public/data/` are generated locally and are not part of
this tree. ECMWF Open Data is CC BY 4.0. aviationweather.gov METAR, TAF and
SIGMET are US public domain. Bureau of Meteorology material is not exported.
