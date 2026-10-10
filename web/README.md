# Isobar on the web

Australian mean-sea-level chart, and the ATPL trainer behind it. This app is
static: the chart and the aviation products are files in `public/data/`, which
is gitignored. The one database is for accounts (below); every page stays static.

## Develop

```sh
cd web
npm install
npm run dev
```

## Export

The exporter reads `~/Data/isobar` (or `ISOBAR_STORE`) and only reads it. It
writes `web/public/data/`. It copies ECMWF MSLP, 24 h rain, temperature and
wind, plus METAR, TAF and SIGMET for the aerodromes on disk. It does not copy
Bureau of Meteorology observations, warnings or charts.

```sh
cd web
npm run export-data
```

Schema 1 is 33 frames at 3 h, from 0 h to 96 h. Schema 2 writes the run's
`forecast_hours` as listed, including a 6 h tail when the archive has one. A
missing hour stays missing. It is not filled with zero and the previous hour
is not stretched across the gap.

Each variable is written one file per frame under `public/data/frames/<var>/fHHH.u16`
and listed in the manifest's `frames` (null for a missing hour). The page paints
as soon as the manifest, the coastline and the two MSLP frames around now are in
(about 270 kB), then streams the rest outward from now.

`sky.json` holds the ECMWF upper-air point profiles (13 pressure levels: height, temperature, RH, wind, cloud cover, vertical velocity; UTC times; null stays null) at the configured aerodromes, with each aerodrome's AIP elevation, for the Fly sky section (`src/lib/sky/`). `npx tsx scripts/sky-preview.ts [dir]` renders the section for YPPH/YSSY and a synthetic gallery headlessly and measures scrub frame times.

`points.json` holds the model series at each place (temperature, wind, rain,
cloud) for the header reading and the day tiles. Aviation comes from the
collector's current run (`products/aviation/current.json`).

24 h rain at +0 to +21 h has no window inside the run, so those frames come from
the newest earlier run that holds both ends of the window (as the macOS app does).

The script prints the byte size. The target is 16 MB or less.

`scripts/export-data.sh` is the same export, for launchd. `scripts/isobar.web.export.plist`
is a sample job. It is not installed. Replace `REPLACE_WITH_ABSOLUTE_PATH`,
then load it only when you mean to schedule the export. The job does not deploy.

## Trainer

`/train` mounts `training/src/mount.ts`, the same application as the native
WKWebView entry in `training/src/app.ts`. React owns only the host lifetime.
The site keeps its rail, with Review, Live, Plan, Practice Exam, Lab and Profile
in one section row inside Train. The shared `.trainer` styles stay inside that
host. Progress, adaptive skills and Lab memory share `isobar.training.v1` in
localStorage; the existing browser progress key is retained.

A static card appears before any data request finishes. The snapshot adapter
requests the manifest, its point and aviation products, and only the first MSLP
frame. It never loads a complete variable file. Aviation survives a missing
chart; absent samples stay null. Snapshot arrival preserves the current answer
and appends newly available live cards. Model points use the frame's valid time,
and a city's point reading is not presented as its airport's model sounding.
The exported products do not include the native chart PNG, screened pressure
gradients, CAPE or NOTAMs; those stay unavailable in the shared live view/cards.

## Accounts

Optional sign-in syncs settings (theme, place, speed), Train progress and E6-B
progress across devices. Auth.js v5, database sessions, Prisma 7 on Neon
Postgres (through the serverless driver adapter). Only
`/api/auth/*`, `/api/account*` are dynamic.

- Sign-in is an emailed 6-digit code (10 minutes, newest code only). The same
  email has a link back to the page the user was on; the page finishes sign-in in
  script, so a mail scanner fetching the link spends nothing. On an iPhone the
  link opens Safari, not the home-screen app, so an installed app signs in by
  typing the code.
- Limits: 5 codes per address and 20 per IP an hour; 5 wrong codes per address
  (30 per IP) in 15 minutes withdraws the code. Throttle rows hold HMACs, never
  addresses or IPs.
- `src/lib/account/merge.ts` merges a device with the account: no card, stage,
  best or flag from either side is dropped; settings are newest-per-key. The
  first sync after sign-in is the guest claim. `PUT /api/account/data` names the
  `baseRev` it merged onto; a 409 returns the current document to merge again.
- `DELETE /api/account` removes the user, sessions and documents.
  Progress on the device stays.

Env (Vercel production, and `~/.config/isobar/isobar.env` locally,
never in the repo): `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED`
(migrations), `AUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`.

```sh
DATABASE_URL_UNPOOLED=… npx prisma migrate deploy   # schema: prisma/schema.prisma
```

`AUTH_TEST_MAILBOX=1` (only honoured off Vercel) keeps mail in-process for
`tests/e2e/account.spec.ts`, which signs in against the configured database and
deletes every account it makes.

## Optional Isobar AI billing

US$5/month or US$50/year, with Stripe-hosted Checkout and Customer Portal.
With no Stripe configuration the app retains its existing free/self-host behavior.
The Account sheet is the only upgrade surface, apart from a daily free-limit link.

## Deploy

From `web/`, after a fresh export:

```sh
vercel deploy --prod
```

Configure deployment project and domain settings in the hosting provider. Deployment
is a separate step from this tree and requires maintainer approval.

`release.json` in this directory, when it contains an `https` `url`, turns the
Download button into that link. Without it the button stays **Coming soon**.
Changing the file needs a new deploy. The Mac download stays held until a
maintainer approves a notarised build.

## Tests

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Screenshots land in `test-results/visual/`. `tests/e2e/parity.spec.ts` puts the
web map beside the macOS popover renders in `test-results/parity/`, and
`tests/e2e/perf.spec.ts` writes first-chart and frame timings to
`test-results/perf/perf.json`. The browser is headless but uses the Mac's GPU
(Metal); `ISOBAR_E2E_SOFTWARE=1` falls back to SwiftShader.

For the trainer flow, viewport renders and cached-card timing:

```sh
npx playwright test train.spec.ts
```

This writes desktop (1440×900) and phone (390×844) light/dark card, worksheet,
and Lab previews to `test-results/train/web-train-*.png`. It also checks delayed
snapshot arrival, offline section navigation, remount persistence, short laptop,
landscape phone, and enlarged text. `VIEWPORT_HELPER` can point to a local
`viewport-fit.mjs` for the additional geometry checks.

In a sandbox without listening sockets, `ISOBAR_E2E_FILES=1` makes this spec
serve the production `.next` assets and data through Playwright interception.
`ISOBAR_E2E_SINGLE_PROCESS=1` and `CHROME_PATH` select the existing single-process
headless Chromium fallback. File-backed timing measures already resident asset
bytes; it is not an HTTP-cache or deployed-site measurement. No browser install
or network access is needed when the existing Chromium executable is supplied.

## Teach from the map

**Explain this chart** holds the selected chart time and makes H/L centres,
curvature-derived troughs/ridges, tight gradients and aerodromes selectable.
Each coach card is attached to its feature. Estimate first, reveal the mechanism,
or take a simpler supported question after a miss. **Today’s tour** prepares
4–5 steps from the part of the run covering now, with Back/Next/Skip. Closing
teaching restores the previous playing state and colour field. No lesson choice
is persisted. Missing or expired products remain explicit gaps.

Two-finger scrolling pans; pinch zooms about the pointer. Touch drag/pinch and
keyboard arrows, +/− and Home provide the same camera controls. The timeline
also accepts arrows, Home and End. Teaching holds timeline input while its
snapshot is displayed.

Layers → **Wind barbs** draws the model 10 m vectors, updated with chart time.
A full feather is 10 kt, half 5 kt, and a pennant 50 kt. Components `u10` and
`v10` (m/s) are included in new exports; `ISOBAR_EXPORT_WIND_COMPONENTS=0`
omits them for a smaller legacy export. Old exports still load and show wind
direction as unavailable. Check the export's printed byte count against 16 MB.

Pressure curvature is an inferred axis, not an analysed front. Geostrophic
estimates assume straight, steady flow and density 1.225 kg/m³; the cards compare
both speed and direction with the model where available. A rain accumulation
cannot establish CB presence. Aerodrome cards identify observation freshness,
TAF validity, and the groups applying at chart time. The route is a schematic
chart-reading exercise, not a flight briefing.

Feature preparation runs in a bounded worker off the animation thread. All tour
steps use one prepared snapshot; advancing and revisiting require no network.
Wind drawing is screen-spaced and updates at most about six times a second while
the base map follows its display loop.

### Local teaching QA (no external data required)

Generate the explicitly artificial fixture only when `public/data/` may be
replaced. It is never a production fallback:

```sh
node --experimental-strip-types scripts/make-teaching-fixture.ts
npm test
npm run build
npm run test:e2e
```

`ISOBAR_FIXTURE_DATE=2026-10-07` pins a fixture date for unit work. Leave it unset
for browser tests of Today’s tour. The fixture is 15.38 MB on a 241×161 grid;
the map visibly identifies it as synthetic. It never reads a maintainer archive.

`tests/e2e/teaching.spec.ts` covers the tour, wrong-answer support, feature cards,
offline Next/Back, camera input, and the 1440×900 / 390×844 light/dark screenshot
matrix. Files are `test-results/visual/map-teach-*.png`. Inspect each viewport
render, revise, and repeat before release. `perf.spec.ts` records and asserts
warm first-chart ≤1500 ms and p95 rAF interval ≤16.7 ms (rounded to 0.01 ms),
including pressure, rain, barbs and the open tour. These intervals measure
presentation cadence, not isolated GPU execution time.
