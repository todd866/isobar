# Teaching instruments

Five offline instruments share one shell: wind triangle, ISA/altimetry,
interpolation ruler, CG balance beam, and climb/descent profile. Open **Lab**
in the trainer rail, or use `dist/index.html?lab=wind&mode=free&theme=dark`.
Instrument IDs are `wind`, `atmosphere`, `interpolation`, `balance`, `profile`.

```ts
import { mount } from './instruments/index.ts';
const instrument = mount(host, {
  instrument: 'wind', mode: 'learn', seed: 7,
  // card: currentCard, // optional matching numeric drill
});
// Before removing the host:
instrument.destroy();
```

The host must have a bounded height. `instruments.css` is included by the
offline build. All definitions and B727 data are bundled ahead of navigation;
there are no network requests or image downloads. Definitions in `registry.ts`
can also be imported without the DOM shell.

## Teaching and input

- **Learn:** estimate → animated worked mechanism → one highlighted control →
  solve the original problem. Answers stay hidden during estimate and solo.
- **Practice:** generated local scenario → estimate → solve. A miss exposes
  worked arithmetic and an easier, single-control manipulation before retrying
  the original problem. Next problem changes the seeded scenario.
- **Free play:** all controls and readings; the graphic occupies the stage.
- **How it works:** the same working instrument alongside its mechanism,
  conventions and model limits.

Drag the coloured handles, scroll over a handle or slider, or focus one with
Tab and use arrow keys (Shift increases the step). Dragging the wind tip changes
direction and speed together; guided work holds speed fixed. Pinch zooms the
diagram without changing the problem. Touch pointers, ctrl-wheel trackpad pinch
and Safari gesture events are supported. Reset restores the original problem
and scale. Reduced motion presents the demonstration's final position directly.
Animation and input paints share `requestAnimationFrame`; destruction cancels
listeners and pending frames.

Colour links handles, labels and readout tags. Text also names the quantity and
invalid state. A ring marks the current teaching control. Ordinary phone and
laptop views retain the diagram and essential controls; short landscape puts
secondary inputs in a Controls drawer. Large text and explanatory reading can
scroll. Text is never ellipsized.

## Card supports

`support.ts` maps supported skills. The generated `numeric.given` values and
existing table/diagram metadata preserve the learner's actual problem. A numeric
miss opens the matching instrument next to the worksheet on a wide view; a phone
shows it with **Return to drill**. Worksheet input retains the mounted instrument
and its current step. Instrument attempts do not alter review grades or progress.

Wind-component, groundspeed, ISA, table lookup/interpolation and loading supports
use the card's inputs. Forecast-level support teaches the actual cruise height's
two-thirds/half-height calculation; selecting and interpolating the published
forecast rows remains in the worksheet. Other skills retain their existing
worksheets. A direction-only wind card labels its additional TAS as illustrative.

## Calculation contracts

- **Wind:** true bearings, wind **from**, velocity arrows downwind. Exact vector
  closure, heading correction and groundspeed. The 1-in-60 overlay is explicitly
  approximate. No `e6b/` instrument exists on this branch: the overlay provides
  the equivalent geometric E6-B answer and describes the manual wind-side setup.
- **Atmosphere:** B727 ISA and density model. Pressure altitude follows the
  indicated altitude and selected subscale; actual QNH changes true altitude.
  True height uses a first-order pressure correction and constant temperature
  offset above a sea-level reference. Cold error isolates temperature with QNH
  matched. Named Australian approach exercises are labelled reference exercises,
  not real approach data or an operational cold-correction calculator.
  A table-entry drill shows its rounded 3°C/5°C entry beside raw ISA deviation,
  in place of the density-altitude tag. Retests retain this rounding convention.
- **Interpolation:** bracketing B727 handbook cells, weight fraction, difference
  and difference × fraction; single or bilinear interpolation. Card support
  preserves published-cell rounding and card tolerances.
- **Balance:** B727 zone/hold arms, 82 kg adults, tank loading order, index units
  and weight-dependent CG limits come from `b727/model.ts`. The free instrument
  moves one passenger group, one cargo group and fuel. Card supports retain the
  given initial aircraft and subtract a moved load at its original arm. Capacity
  and structural checks remain distinct from forward/aft CG.
- **Profile:** B727 climb/descent integration, signed tailwind × elapsed time,
  climb wind at two-thirds height and descent wind at the altitude midpoint.
  Departure and landing weights are explicit; cruise fuel burn is not solved.
  Real airport coordinates produce great-circle route distances, not airways.
  The 3× rule shows geometric altitude loss only. Invalid/unflyable cases stay
  unavailable, including overlapping climb/descent and reversed weight loss.

These are inspectable training models, not approved aircraft performance data.

## Verification

From `training/`, using the installed dependencies:

```sh
npm test
npm run build
node --experimental-strip-types tools/instrument-check.mjs ../build/instruments/final
```

Use `TRAINING_SINGLE_PROCESS=1` only when the local sandbox cannot launch the
ordinary headless Chromium process tree. The browser check reuses
`VIEWPORT_HELPER` (default: Ian's `.ux-authoring/viewport-fit.mjs`) when present,
with a basic local geometry fallback. It writes actual viewport screenshots,
`acceptance.json`, and measures input-update frame cadence. It checks all five
instruments at 1440×900 and 390×844 in both themes, lessons and easier retries,
matching card support, touch/scroll/pinch/keyboard, short landscape, larger text,
offline navigation and browser errors. Inspect the images as well as the numbers.

Pure tests cover vector closure and impossible tracks, altitude conventions,
interpolation corner/linearity cases, loading moments/limits, climb/descent wind
corrections and invalid inputs. Lesson tests cover each instrument's progression,
scenario variation, card context, invalid events and support recovery.
