# Flight computer: sources and measurements

The simulated instrument is the computer (circular slide-rule) side of the
**ASA E6-B Flight Computer** (Aviation Supplies & Academics), the model in the
owner's photograph of 7 October 2026: the computer side (`face.ts`) and the
wind side (`wind.ts`, `windrender.ts`). The computer face is data (type `Face`)
so a Pooleys CRP-5 face can be added as a second variant.

## Sources

| Ref | Document | Used for |
|---|---|---|
| M | ASA, *E6-B Flight Computer Instructions*, ASA-E6B-BK, © 1992–2026. <https://asa2fly.com/content/support-files/product-manuals/E6B_Manual.pdf> (retrieved 7 Oct 2026; local copy `~/.local/state/crp-e6b/src/e6b.pdf`) | Face layout (Figure 1, p. 4), graduations (p. 5–6), every procedure and worked example, answers (p. 37–38) |
| C | ASA, *E6-B Circular Flight Computer Instructions*, ASA-E6B-CIRC, © 2014. <https://cdn.shopify.com/s/files/1/0676/8279/5797/files/Manual_-_ASA_Flight_Computer_E6B-CIRC.pdf> | Cross-check only (conversion-arrow list, p. 9; 2,000 lb = 907 kg, p. 13). It is a different instrument and is not simulated |
| ISA | ICAO Doc 7488, Manual of the ICAO Standard Atmosphere | Exact answers (`atmosphere.ts`) |

Units are the exact definitions: 1 NM = 1.852 km; 1 statute mile = 1.609344 km;
1 lb = 0.45359237 kg; 1 US gal = 3.785411784 L; 1 imp gal = 4.54609 L;
1 ft = 0.3048 m; avgas 6 lb per US gal and oil 7.5 lb per US gal (M p. 16–17).

## How the face was measured

Figure 1 (M p. 4) is a 1-bit scan (2633 × 3732 px) of the face with the disc at
1:1. The disc-edge circle was fitted (centre 1319.5, 1733 px; radius 952 px;
residual about 1 px) and the face unwrapped to polar coordinates (scripts in
`~/.local/state/crp-e6b/tools`). Radii in `face.ts` are those pixel radii, so the
proportions are the real instrument's. Angle readings are good to about ±0.5°.

## Main scales

- Outer (fixed) and middle (rotating) scales: one decade, 10–100, over 360°.
- Graduations (M p. 5–6): 0.1 from 10 to 15, 0.2 from 15 to 30, 0.5 from 30 to
  60, 1 from 60 to 100. Numerals 10–25 every unit, then 30, 35 … 60, 70, 80, 90.
- HOURS ring (M p. 6): 1:10 under 70 … 9:00 under 54; 5-minute ticks to 2:00,
  10-minute ticks after. The 60 RATE triangle and box; the boxed 10 unit index on
  both scales; the SECONDS arrow at 36 (3,600 s per hour, "just to the right of
  35", M p. 6).

## Conversion arrows

Ratios inside each family are exact. Each family has one free constant (where
the family sits on the dial); it was fitted to Figure 1.

| Arrow | Value on scale | From | Figure 1 | Designed |
|---|---|---|---|---|
| NAUT (outer) | 66.00 | anchor | 295.06° | 295.00° |
| STAT (outer), STATUTE (disc) | 75.95 | NAUT × 1.852/1.609344 | 317.04° | 316.96° |
| KM (both) | 12.223 | NAUT × 1.852 | 31.72° / 31.48° | 31.37° |
| U.S. GAL (both) | 12.80 | anchor (= 128 US fl oz) | 38.88° | 38.59° |
| IMP. GAL (both) | 10.658 | U.S. GAL × 3.785411784/4.54609 | 10.18° / 10.00° | 9.96° |
| LITERS (both) | 48.453 | U.S. GAL × 3.785411784 | 246.96° / 246.84° | 246.85° |
| FUEL LBS (outer) | 76.80 | U.S. GAL × 6 | 318.86° | 318.67° |
| OIL LBS (outer) | 96.00 | U.S. GAL × 7.5 | 353.74° | 353.62° |
| KG (disc) | 16.65 | anchor | 79.44° | 79.70° |
| LBS (outer) | 36.707 | KG / 0.45359237 | 203.58° | 203.40° |
| FT (outer) | 14.33 | anchor | 56.16° | 56.22° |
| METERS (disc) | 43.677 | FT × 0.3048 | 230.16° | 230.28° |
| SECONDS (disc) | 36 | 3,600 s | 200.88° | 200.27° |

The fitted anchors other than NAUT and U.S. GAL have no obvious round-number
reason; they are measurements. `crp.test.ts` checks every ratio and every angle
(within 0.75° of Figure 1).

## Windows: the scale laws the E6-B embodies

The disc angle θ means outer = middle × 10^(θ/360).

**Airspeed correction window** (M p. 18–19). Pressure altitude is on the base,
seen through the window; air temperature is printed on the disc beside it
(confirmed by comparing Figure 1 with Figure 13). Setting PA opposite °C gives
θ = −180·log σ, so TAS/CAS = 1/√σ with σ = δ(PA)·288.15/T. That is the
incompressible relation: CAS is treated as EAS. Pinned so that PA 0 meets +15 °C
at 1:1 (measured 37.5°).

**Density altitude window**. The ▲ index (on the disc, measured 47.3°) reads a
base scale printed at the ISA altitude of each σ, so the density altitude it shows
is exact for the σ that is set.

**Mach index** (M p. 20). Because the temperature scale is a half-decade per
decade of absolute temperature, one fixed mark on the base gives
θ = 360·log a0 + 180·log(T/T0), so Mach on the middle scale reads TAS on the
outer: a = 661.48 kt × √(T/288.15). The index lies 64.6° anticlockwise of PA 0;
it is not visible at 1:1 (it is under the disc), as in Figure 1, and appears in
the airspeed window when the disc is turned (Figure 14).

**Altitude correction window** (M p. 21–22). Here air temperature is on the base
(through the window) and pressure altitude on the disc. Each PA mark sits at the
ISA temperature for that altitude, a full decade per decade of absolute
temperature, so true height = calibrated height × T/T_ISA(PA). Pinned so PA 0
meets +15 °C at 1:1 (measured −28.0°).

**Temperature conversion arc** (base, bottom). Linear, °C −50 to +50 against
°F −58 to +122; measured 0.742° per °C with 0 °C at the bottom (180.0°).

## Inherent approximation

The airspeed window cannot model compressibility (it would need CAS in the
alignment). Against an exact ISA air-data computation, the E6-B TAS is high by:

| CAS | Pressure altitude (ISA day) | Error |
|---|---|---|
| 120 kt | 5,000 ft | +0.08 % |
| 145 kt | 15,000 ft | +0.45 % |
| 250 kt | 25,000 ft | +2.8 % |
| 300 kt | 30,000 ft | +5.3 % |

The true-altitude window assumes the ISA lapse rate between the station and the
aircraft (M p. 22 caution). The 1-in-60 rule itself is an approximation; the demo
shows the trigonometric answer beside it.

## Manual answers that disagree with the scale

- p. 37, airspeed sample 2: printed 273 kt. The density slide rule reads 276.5 kt;
  273.0 kt is the compressible answer. The printed key appears to come from an
  air data computer, not from the E6-B.
- p. 17: "2,000 lbs is 901 kg, and 160 kg is 351 lbs". Exact: 907.2 kg and
  352.7 lb (the circular manual C p. 13 prints 907). The demo shows both.
- p. 24–25: "Read 2.4° at the rate arrow" for 8 NM off with 235 NM to go.
  60 × 8 ÷ 235 = 2.04°, which is what the scale shows; the printed total (6°) is right.

## Wind side (M p. 28–35, Figures 21–25)

The slide is a polar grid: the speed arc for s knots has radius s·U about a
centre O below the grommet, and the drift lines are rays from O. With the true
course at the TRUE INDEX, the grommet on the ground-speed arc and the wind dot
drawn upwind of the grommet, the dot is the tip of the air vector. The arc
through it is the TAS and the ray through it is the wind correction angle, so
the instrument solves the wind triangle exactly; the only error is reading
(arcs every 2 kt, drift lines every 1° above 100 kt and 2° below).

`e6b.test.ts` checks the p. 30 example (230°/18 kt, TC 090°, TAS 125 → TH 095°,
GS 138), the four p. 31 samples (answers p. 38: 288/143, 133/149, 014/163,
258/240), the p. 32–35 example (TH 160, TC 180, TAS 140, GS 120 → 104°/50 kt)
and both p. 33 samples (002/17, 212/49). Each agrees with the exact vector
solution to 1e-9 and with the printed answer within one graduation.

U = 17 face units per knot was measured on Figure 21 (2-kt arc spacing). The
manual text says "each line equals 1 knot on the E6-B"; Figure 21 shows 2-kt
arcs between 130 and 150. The figure was followed. Built range 30–260 kt (the
low-speed slide).

The manual also names the removable high-speed E6-B slide accessory (E6B-SLIDE)
and says that its printed wind marks are read as **1 or 10 knots** (p. 28). The
local ASA booklet contains no dimensioned drawing, end marks, or stated maximum
for that accessory. The simulator therefore exposes a separate
`HIGH_SPEED_SLIDE` with the documented 10-kt graduation and a clearly documented
provisional 100–1000-kt teaching range, which covers the B727 400–500 kt mission
and ground speeds above 500 kt. Its schematic 3.4 face-units/kt scale is
normalized so a 100-kt wind remains
inside the plate; it is not presented as a measured ASA proportion. Both the
range and normalization are implementation assumptions, not ASA measurements;
replace them when an accessory scan or manufacturer specification is available.
The standard slide defaults remain unchanged.

## Not simulated, or not verified

- The slide's printed extras on the computer side (crosswind table,
  flight-plan block, chart scales).
- On the wind side: the frame's 0–50° scale either side of the TRUE INDEX is
  drawn every 1° (labelled by 10) as Figure 21 shows; the plate's intercardinal
  labels and tick lengths follow the figure by eye. The high-speed accessory's
  physical end marks and alternate 1-kt/10-kt printing remain unverified.
- The cursor hairline is a reading aid only; the real E6-B has none. It can be
  hidden.
- Window tick density and the ends of the window scales could not be counted
  reliably from the scan. Built: airspeed PA 0–40 (every 1,000 ft, numbered by
  5), airspeed temperature +50 to −60 (every 5 °C, numbered +50, 0, −50 as
  printed), density altitude −5 to 35 thousand (every 1,000 ft), altitude-window
  temperature −60 to +40 (every 5 °C, numbered by 20), altitude-window PA 0–30.
  Figure 1 prints the density-altitude numeral left of 0 as "5"; physically it
  is −5,000 ft and is labelled so here.
- Tick lengths and fonts follow the figure by eye. The ASA name and logo are not
  reproduced.
