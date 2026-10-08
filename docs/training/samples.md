# Sample cards

> **Superseded, 7 October 2026.** These twenty samples are the 6 October design study. The shipped bank (`training/src/deck.ts`, `training/src/live.ts`) was rewritten to the question standard in [README.md](README.md#question-standard): complete scenario questions with route and UTC/local times, options that are a pilot's decision, explanations that reason then cite the Australian rule in [sources.json](sources.json). The live templates now shipped are: TAF groups in force, current SIGMET decode, destination alternate/holding (Sydney and Perth), runway most into wind, METAR ceiling, geostrophic versus surface wind, MSL-reduction artefact, and CAPE without a forecast storm. The FAA passages below are no longer sources.

Twenty original cards. Ten are scored from the Isobar store as it stood on 6 October 2026. Ten are mechanism questions. None are recalled exam items.

The machine-readable keys, product hashes and tolerances are in [samples.json](samples.json). The templates are in [templates.json](templates.json). Concept ids point at [concepts.json](concepts.json).

Store window:

- Aviation run `6a887bcd939d97fd2553`. METARs at 0830Z. SIGMETs retrieved 08:47Z. The YPPH and YSSY bytes match the 08:34Z run; I02's text is unchanged.
- ECMWF IFS 0.25° run `2026-10-06T00:00:00Z`, valid `2026-10-06T09:00:00Z`, for every grid card.
- Point series: the same 00Z run, IFS 9 km.

Situational awareness only. Not a flight briefing.

Jandakot (YPJT) is not in this aviation run, so the pair in the brief is Perth and Sydney. The template `taf-first-below-threshold` is the same question the moment YPJT is collected.

Local times below use Australia/Perth (UTC+8, no daylight saving) and Australia/Sydney. Daylight saving in New South Wales had started on Sunday 4 October 2026, so Sydney on this date is AEDT (UTC+11). The scored times are UTC.

Passage quotes from the FAA handbooks were not extracted in this session. Each physics card names the section to copy. Until that quote is stored and hashed, the card fails a Cohort export. See [sources.json](sources.json).

## Live chart

### L1 · Which TAF first goes below a teaching ceiling

- Concept `fpl.taf-threshold`. Also uses `met.ceiling`, `met.taf-groups`.
- AU `AFPL`, `AMET`.
- Layer: Fly. Difficulty: medium. Template `taf-first-below-threshold`.
- Teaching threshold, not an AIP alternate minimum and not 14 CFR 91.169: a BKN or OVC base at or below 1,500 ft, or visibility below 8,000 m. TEMPO counts. SCT does not.

Stem. On the TAFs in this run, which of YPPH and YSSY first has a group below that threshold?

Answer. **YSSY, TEMPO 0612/0618Z** (12:00–18:00Z on the 6th): `18030G40KT 3000 SHRA BKN010`. Ceiling 1,000 ft, visibility 3,000 m. In Sydney that is 23:00 AEDT to 05:00 AEDT.

YPPH does not cross the threshold in this TAF. Its lowest ceiling is `FM070900 … BKN025` (2,500 ft, visibility 9,999 m). `FM061800 … SCT008` is scattered, so it is not a ceiling.

Trap. The YSSY `FM061200` group is `BKN020` and 9,999 m, which is still above the teaching ceiling. The TEMPO at the same start time is the group that crosses.

Authority. The TAF text. The model visibility series is a different card (L10) and disagrees for Perth.

### L2 · Which Sydney runway has the headwind now

- Concept `fpl.wind-component`. AU `AFPL`.
- Layer: Fly. Difficulty: easy. Template `metar-best-headwind`.

Stem. `METAR YSSY 060830Z AUTO 25015KT 9999 // NCD 24/06 Q1016`. Which runway end has the greatest headwind?

Answer. **Runway 25.** The product's runway components, from true heading 254° and the METAR wind, are headwind +15 kt and crosswind −1 kt (from the left).

The 16 ends have only +2.1 kt of headwind and +14.9 kt of crosswind. Runway 07 is a 15 kt tailwind.

Authority. The runway array on `YSSY.json` for this run, not a recomputed heading. OurAirports headings, public-domain tag in the store, still `verify` until the terms are checked.

### L3 · Same runway, after the TAF wind change

- Concept `fpl.wind-component`. Difficulty: medium. Template `taf-steady-headwind`.

Stem. YSSY `FM061200 18028G38KT`. Using the steady 28 kt, and the true headings in the same runway file, which ends have the greatest headwind?

Answer. **16L and 16R**, both true heading 168°. Difference 12°. Headwind 27.4 kt, crosswind 5.8 kt from the right.

Runway 25 falls to 7.7 kt of headwind and 26.9 kt of crosswind. The gust (38 kt) is not the speed this card scores. At 38 kt the 16 ends would be 37.2 kt headwind; that is a different question and must say "gust".

Formula. `diff` is wind direction minus heading, wrapped to ±180°. Headwind is speed × cos(diff).

### L4 · Strongest geostrophic wind on the 09Z chart

- Concept `met.gradient-wind`. AU `AMET`.
- Layer: isobars. Difficulty: hard. Template `mslp-geostrophic-max`.

Stem. On the 00Z IFS 0.25° MSLP field valid 09Z, south of 30°S and between 112°E and 155°E, where is the strongest geostrophic wind?

Method, which is the key as much as the place. Central difference. Density 1.225 kg/m³. Coriolis `2 Ω sin φ`. Cells whose 3×3 stencil spans more than 6 hPa are dropped. The outer two cells of the grid are dropped. Latitude floor 30°, because closer to the equator the same gradient becomes a 1/f spike (230 kt was computed near 18°S, 145°E, over a 9 kt surface wind, and it is outside this mask on purpose).

The unscreened grid still produces **37.0°S 147.5°E**, about **130 kt from 090°**, gradient 7.2 hPa per 100 km, 10 m wind **6 kt**. That cell is the Victorian high country. Mean-sea-level reduction makes the tight gradient. The store has no surface geopotential, so the trainer uses the chart's land-mix screen (a land cell whose pressure disagrees with the wide smooth by more than 1.8 hPa) and does not score that cell.

Answer, after the screen, on the 09Z frame read 6 October 2026. **39.25°S 148.75°E.** About **53 kt from 219°**. Gradient 3.1 hPa per 100 km. The 130 kt cell is the artefact card, not the maximum.

Reveal. The screened number is the free-atmosphere balance on the field the chart draws, not the surface wind. Curvature is not in the key. The artefact card asks why the 130 kt is not a real wind: the land mix dropped it.

### L5 · Strongest 10 m wind on the same frame

- Concept `met.surface-friction`. Layer: wind. Difficulty: medium. Template `wind10-max`.

Stem. Same run, same valid time, 12–44°S and 112–155°E. Where is the strongest 10 m wind?

Answer. **38.0°S 149.75°E, 37.5 kt.** East of Bass Strait.

Trap. Answering the unscreened 37°S 147.5°E cell, or L4's screened cell. The 10 m maximum is east of Bass Strait.

### L6 · Where is the high

- Concept `met.pressure-systems`. Layer: isobars. Difficulty: easy. Template `mslp-high-centre`.

Stem. Same MSLP field. Highest pressure inside 10–45°S, 110–160°E, not on the outer two cells.

Answer. **1,029 hPa at 37.5°S, from 135.0°E to 136.0°E.** A ridge over the Bight, not a single point.

The lowest value inside a wider look, 992.5 hPa near 48°S 114°E, sits on the southern edge of the window. It is not offered as a low centre.

### L7 · The storm is not at the CAPE maximum

- Concept `met.thunderstorm`. AU `AMET`.
- Layer: Fly, and the MUCAPE grid (not a colour field yet). Difficulty: hard. Template `sigmet-versus-cape`.

Stem. `YBBB SIGMET I02`, valid 0730/0930Z, `FRQ TSGR` inside `S2400 E14950 - S2600 E15220 - S2720 E14740 - S2410 E14610`, top FL350. At 09Z, is the warned storm at the highest MUCAPE on the Australian window?

Answer. **No.** Inside the polygon the maximum is **1,753 J/kg at 25.0°S 148.75°E** (point-in-polygon, 193 grid cells). Over the Kimberley the grid reaches **2,932 J/kg at 17.0°S 123.75°E**, and this SIGMET file has no thunderstorm polygon there.

Reveal. CAPE is the energy if a parcel is lifted. It does not supply the lift. The SIGMET is the evidence that lift, instability and moisture have already produced frequent thunderstorms with hail. The map should centre the polygon, not the Kimberley cell.

Rights. The SIGMET string is `aviationweather` (`verify`). The CAPE number is ECMWF CC BY 4.0.

### L8 · Which airport has the higher density altitude

- Concept `perf.density-altitude`. AU `APLA`.
- Layer: temperature, with the METAR on Fly. Difficulty: medium. Template `density-altitude-pair`.

Stem. Using the 0830Z METARs and the elevation on the IFS point file (not an AIP elevation): YPPH 27 °C, Q1015, elevation 12 m; YSSY 24 °C, Q1016, elevation −1 m. Which density altitude is higher?

Rule, stated on the card. Pressure altitude in feet ≈ elevation + (1013.25 − QNH) × 30. ISA ≈ 15 − 2 × (pressure altitude / 1,000). Density altitude ≈ pressure altitude + 120 × (OAT − ISA). Sea-level rules of thumb, not a performance chart.

Answer. **YPPH, about 1,424 ft. YSSY, about 974 ft.** Same synoptic pressure, a hotter afternoon, a higher density altitude. The 4 °C gap dominates the 1 hPa gap.

Trap. Substituting the model 2 m temperature (Perth point 25.2 °C at 08Z) for the METAR. The card's authority is the METAR for OAT and QNH, and the point file for elevation only.

### L9 · Which freezing level is lower

- Concept `met.icing`. AU `AMET`. Layer: Fly. Difficulty: easy. Template `freezing-level-lower`.

Stem. The aviation product's freezing level at the two stored stations.

Answer. **YSSY, 3,352 m. YPPH, 3,485 m.** About 11,000 ft and 11,400 ft.

Check that lets the card be served. The 0 °C height interpolated between 700 and 500 hPa on the upper-air point at 09Z is about 3,354 m at YSSY and 3,511 m at YPPH. Both are within 200 m of the product field. YPPH at 09Z: 700 hPa is +2.6 °C at 3,147 m, 500 hPa is −16.1 °C at 5,767 m.

A thunderstorm top at FL350 (L7) is far above either freezing level. The ice layer is the reveal, not a second scored number.

### L10 · Model visibility is not the TAF

- Concept `met.taf-groups`. Difficulty: medium. Template `point-visibility-first-below`.
- Authority, written on the card: the IFS 9 km point visibility. Not the TAF.

Stem. Which of the Perth Airport and Sydney points first goes below 8,000 m visibility in the 00Z point series?

Answer. **Sydney, 12:00Z on the 6th, 3,700 m.** Perth Airport's series stays above 8,000 m until **18:00Z on the 7th (3,420 m)**.

The YPPH TAF in this same run never goes below 9,999 m. A learner who answers L10 from the TAF is wrong, and a learner who answers L1 from this series is wrong. The two cards exist so that split is visible.

## Physics

The scored claim does not expire when the next model run arrives. Where today's chart is the stem, the number is an illustration.

Handbook locators are the section to extract. They are not verbatim quotes.

### P1 · Why the wind does not run from high to low

- Concept `met.geostrophic`. AU `AMET`. Difficulty: medium.
- Source: FAA-H-8083-28, pressure systems and wind. Passage id `pressure-and-wind`.

Stem. Above the friction layer in the southern hemisphere, a steady wind with straight isobars blows:

- A. from the high toward the low
- B. along the isobars, high on the left
- C. along the isobars, high on the right
- D. from the low toward the high

Answer. **B.** The pressure-gradient force is toward the low. Coriolis deflects to the left until it balances that force, so the high is on the left. C is the northern-hemisphere picture and is the usual US textbook drawing. It is the wrong hemisphere, not a synonym.

### P2 · Three ingredients, and which one CAPE is not

- Concept `met.thunderstorm`. Difficulty: medium.
- Source: FAA-H-8083-28, thunderstorms. Passage id `thunderstorms`.
- Stem uses L7: Kimberley MUCAPE 2,932 J/kg and no thunderstorm SIGMET in the file.

Stem. A column with a large CAPE and no storm is missing which ingredient?

- A. Moisture, because CAPE ignores the dewpoint
- B. Instability, because CAPE is only a wind shear index
- C. Lift
- D. A freezing level below 10,000 ft

Answer. **C.** CAPE is the buoyant energy available if a parcel is lifted. It already requires instability and moisture in the profile. It does not mean the lift has occurred. D is a confusion with the icing layer.

### P3 · Absolutely unstable

- Concept `met.stability`. Difficulty: medium.
- Source: FAA-H-8083-28, stability. Passage id `stability`.

Stem. The environmental lapse rate is 3.5 °C per 1,000 ft. A lifted parcel, saturated or not, will:

- A. return to its original level
- B. stay warmer than the environment and keep rising
- C. sink once it saturates, because the saturated rate is only 1.5 °C per 1,000 ft
- D. form a stable layer at the lifting condensation level

Answer. **B.** The environment cools faster than the dry adiabatic rate (about 3 °C per 1,000 ft), so it also cools faster than the saturated rate. That is absolute instability. C describes conditional instability, which needs the environment between the two rates.

### P4 · Why a hotter day is a higher airport

- Concept `perf.density-altitude`. AU `APLA`. Difficulty: easy.
- Source: PHAK, aircraft performance, density altitude. Passage id `density-altitude`.

Stem. Two airports, same pressure altitude. The hotter one has:

- A. a lower density altitude, because hot air is lighter and the wing needs less of it
- B. a higher density altitude
- C. the same density altitude, because density altitude is only a pressure correction
- D. a higher true airspeed on the approach and a shorter roll

Answer. **B.** Density altitude adds about 120 ft for each degree Celsius above ISA. Less dense air means a longer roll and a lower climb gradient. A is the performance result described as if it were the definition. D mixes a true-airspeed increase, which does happen, with a shorter roll, which does not.

### P5 · What a gust changes in the lift equation

- Concept `aero.lift`. AU `AASA`. Difficulty: medium.
- Source: PHAK, aerodynamics, lift. Passage id `lift`.

Stem. Lift is ½ ρ V² S CL. A sharp gust increases lift mainly because it:

- A. increases density
- B. increases wing area
- C. increases V, and can increase angle of attack and therefore CL
- D. decreases weight, so the required lift falls

Answer. **C.** Density and area do not change in the gust. Weight does not change. The speed term is squared, and a vertical gust also changes the angle of attack. That is why manoeuvre speed exists (`aero.manoeuvre-speed`).

### P6 · The back of the power curve

- Concept `aero.induced-drag`. AU `AASA`, `APLA`. Difficulty: hard.
- Source: PHAK, aerodynamics, induced drag. Passage id `lift`.

Stem. On the back side of the power curve, in level flight, raising the nose without adding power:

- A. reduces induced drag, because the wing is flying faster
- B. increases induced drag, and the aeroplane can start to sink
- C. moves the centre of pressure and unloads the tail
- D. reduces parasite drag enough to restore the climb

Answer. **B.** Induced drag rises as speed falls. A higher nose without more thrust slows the aeroplane further, so the drag rise can exceed the extra lift and the flight path goes down. A has the speed change backwards.

### P7 · Stall speed in a 60° bank

- Concept `aero.load-factor`. Prerequisites `aero.stall-aoa`. Difficulty: medium.
- Source: Airplane Flying Handbook, load factor and stall speed in a turn. Passage id `load-and-va`.

Stem. In a level 60° bank the load factor is 2. The stall:

- A. occurs at the same indicated airspeed, because the critical angle is unchanged
- B. occurs at a higher indicated airspeed, about √2 times the 1 g stall speed, at the same critical angle
- C. occurs at a lower indicated airspeed, because the wing is more efficient when banked
- D. cannot occur while the altitude is held

Answer. **B.** The critical angle does not move. The faster flow needed to make twice the lift means the stall speed indicated rises with the square root of the load factor. A is the true sentence about angle, attached to the wrong instrument.

### P8 · Pitot blocked, static clear, climbing

- Concept `sys.pitot-static`. AU `AASA`. Difficulty: hard.
- Source: PHAK, pitot-static blockage. Passage id `pitot-static`.

Stem. The pitot is blocked and its drain is blocked. The static port is open. During a climb the airspeed indicator:

- A. falls toward zero
- B. stays on the speed at which the blockage happened
- C. reads higher as the aircraft climbs
- D. reads the inverse of the altimeter

Answer. **C.** The trapped pitot pressure is fixed. Static pressure falls in the climb, so the difference the indicator sees grows, and the indicated speed rises. If the static port were the one that was blocked, the altimeter would freeze and the pattern would be different. B is the answer for a blocked pitot whose drain is still open, and it is the distractor this card is for.

### P9 · Why time of useful consciousness falls

- Concept `hum.hypoxia`. AU `AHUF`. Difficulty: easy.
- Source: PHAK, aeromedical factors, hypoxia. Passage id `hypoxia`.

Stem. Time of useful consciousness gets shorter with altitude because:

- A. the oxygen fraction of the air falls below 21%
- B. the partial pressure of oxygen falls while the fraction stays about 21%
- C. haemoglobin saturates more completely in thinner air
- D. the coriolis illusion speeds up the breathing reflex

Answer. **B.** Hypoxic hypoxia at altitude is a partial-pressure problem. A is the cabin-fire or depressurised-mixture confusion. C is the opposite of the saturation curve. D belongs to `hum.vestibular`.

The legal oxygen altitude (14 CFR 91.211, or the Australian rule) is `hum.fatigue-rules`'s neighbour `sys.pressurisation` / a bank-only law card. It is not this answer.

### P10 · 130 kt and 6 kt at the same cell

- Concept `met.surface-friction`. Difficulty: hard.
- Source: FAA-H-8083-28, surface friction. Passage id `pressure-and-wind`.
- Stem is L4's cell: geostrophic estimate about 130 kt, model 10 m wind 6 kt, MSLP 1,023 hPa.

Stem. Both numbers can be an honest reading of that cell because:

- A. the grid is wrong, and the lower number should be discarded
- B. geostrophic balance is the free-atmosphere balance; the 10 m wind is in the friction layer, slower and turned toward lower pressure
- C. Coriolis reverses in the lowest 10 m, so the surface wind opposes the gradient wind
- D. a high always has a calm centre, so any nearby gradient is fictitious

Answer. **B.** Friction does not reverse Coriolis. It reduces the wind speed, so Coriolis no longer balances the pressure gradient, and the wind crosses the isobars toward lower pressure. The card recentres the map on 37°S 147.5°E and turns on the wind barbs. The 6 kt barb is the surface. The 130 kt is the spacing of the isobars, read as a free-atmosphere wind.
