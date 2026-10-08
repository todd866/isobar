# ATPL trainer

A theory trainer for the Australian ATPL (aeroplane). The lab is today's Isobar chart. Concept ids are shared with a later US track; the trainer does not serve FAA ATP or ACS references. The owner, 6 October 2026: the useful questions are weather interpretation, why a weather process happens, and the meteorology, flight planning and engineering around that. The best way to learn it is to look at today's data.

This directory is the syllabus, the concept graph, the card generator contract and a worked sample. It does not change the app. It is not a flight briefing.

| File | What it is |
|---|---|
| [concepts.json](concepts.json) | One concept graph: id, title, CASA exam refs, FAA ACS refs, prerequisites, physics links, AU/US difference, teaching mode, map layer |
| [templates.json](templates.json) | How a live card is built, graded and rejected |
| [sources.json](sources.json) | Australian instruments and Bureau guides, with the rights class of each, and the verified rule list (`rules[]`) every card is checked against |
| [samples.md](samples.md) | Twenty cards. Ten are computed from the store on 6 October 2026 |
| [samples.json](samples.json) | The keys, hashes and tolerances for those ten |

## Syllabus

Australian target: the ATPL (aeroplane) theory subjects under the [Part 61 Manual of Standards](https://www.legislation.gov.au/F2014L01585/latest/text) (legislative instrument F2014L01585). CASA examines seven subjects. Aerodynamics is not an eighth exam. It sits inside aerodynamics and aircraft systems, and again inside performance.

| Code | Subject | In this graph |
|---|---|---|
| AALW | Air law | `law.*`. Bank only. CASR Part 61 privileges, transition altitude, alternate requirement |
| ANAV | Navigation | `nav.*`. Time zones are live. Great-circle geometry is a mechanism |
| AFPL | Flight planning | `fpl.*`. Wind components and TAF thresholds are the live core |
| AMET | Meteorology | `met.*`. Most of the live cards |
| AHUF | Human factors | `hum.*`. The owner calls this human performance. Physiology is a mechanism. Duty limits are bank only |
| AASA | Aerodynamics and aircraft systems | `aero.*` and `sys.*`. Aircraft general knowledge is this exam, not a separate one |
| APLA | Performance and loading | `perf.*`. Density altitude is live. A loading sheet needs an aircraft, so it stays bank only |

The four-letter codes are the examination booking codes. The MOS text was not re-opened on 6 October 2026, because outbound fetches were blocked in the session that wrote this. Paragraph numbers inside the MOS are absent on purpose. Confirm the codes against the current compilation before they become exam-target weights.

US target: [FAA-S-ACS-11](https://www.faa.gov/training_testing/testing/acs), the Airline Transport Pilot and Type Rating for Airplane Airman Certification Standards. The graph uses the knowledge-area names (weather information, cross-country flight planning, performance and limitations, operation of systems, human factors, regulations). The lettered task codes were not re-read from the current PDF. Do not invent `I.C.K2`.

Where Australia and the United States differ, the concept carries an `au_us` sentence. The differences that change the answer, rather than the units, are:

- Southern-hemisphere geostrophic wind (high on the left) against the usual US diagram (high on the right).
- INTER and CAVOK exist on Australian TAFs. They are not US TAF groups.
- Transition altitude: 10,000 ft in Australia, 18,000 ft in the United States.
- Alternate minima: AIP Australia against 14 CFR 91.169 and the part 121 dispatch rules.
- Cruising levels: the AIP table against 14 CFR 91.179.
- QNH in hectopascals against an altimeter subscale in inches of mercury.

Those cards take `practiceLocale` `au` or `us`. A miss on one does not schedule the other as the same fact.

## How a concept is taught

`mode` on each concept:

- **live-chart.** Stem and key come from the current store: the ECMWF run, a METAR, a TAF, a SIGMET. If the key cannot be recomputed, the card is not served.
- **physics-why.** The scored claim is a mechanism. Today's chart may be the picture. The claim is still true tomorrow.
- **bank-only.** A legal rule, a copyrighted chart, or a sum that needs an aircraft or a route. Original wording. Never a recalled CASA or FAA item.

`layer` is where the reveal puts the map:

| Layer | What the learner sees |
|---|---|
| `isobars` | The playing MSLP chart |
| `wind` | Wind-speed field and barbs |
| `temperature` | Temperature field |
| `rain` | Rain field |
| `fly` | The Fly lens: METAR, TAF groups, runway components, SIGMET |
| `upper-point` | The IFS upper-air point at YPPH or YSSY. Not a map layer yet |
| `none` | Nothing in the store can show it |

`prerequisites` is the teaching order. `why` points at the mechanism a correct answer should open, which is often a different concept from the one the stem tested. Both are edges in the same graph. The graph is a DAG; the check at the bottom of this file's validation list fails if either edge dangles.

Fronts are `physics-why` even though the layer is `isobars`. The store has no analysed front. A generator that draws one from a kink in the isobars will eventually be wrong, and the card will look official.

## Live cards

[templates.json](templates.json) is the generator. Each template names one authority product, the inputs, the formula, the traps, and a difficulty.

An instance id is the template, the store run, the valid time, and the sha256 of the authority product. The next model run is a new instance. Scheduling remembers the concept. It does not ask yesterday's TAF again.

Difficulty:

- **Easy.** One station, one field, one comparison. L2, L6, L9.
- **Medium.** A definition has to be applied, or the card has named which product wins. L1 (SCT is not a ceiling; TEMPO counts), L3 (steady wind, not the gust), L8, L10 (the model is not the TAF).
- **Hard.** A grid, or a contrast whose obvious answer is the neighbouring maximum. L4 (geostrophic, with a latitude floor), L7 (the SIGMET is not the CAPE maximum).

The card is served only if a fresh read of the store reproduces the frozen key inside the tolerance (1 kt of wind, 5 kt of geostrophic speed, 0.5° of position, 0.5 hPa, 50 J/kg, 50 ft of density altitude, exact hour or exact TAF group). Missing data skips the card. A missing visibility is not zero.

Rules that keep a generated answer honest:

- Ceiling means the lowest BKN or OVC. FEW and SCT are not a ceiling. CAVOK is a pass against a ceiling threshold, not a missing group.
- A numeric ceiling and visibility on a live card is a teaching threshold. The stem says so. The AIP alternate minima and 14 CFR 91.169 are `law.alternate`, bank only.
- TEMPO and INTER count only when the stem says they count.
- Geostrophic speed is a central difference on MSLP, density 1.225 kg/m³, `f = 2 Ω sin φ`, and only at 30° or more from the equator. The 10 m wind at the same cell is part of the key. The card must not call the geostrophic number a surface wind.
- A pressure extremum on the outer two rows or columns is not a centre.
- One authority per card. L1 is the TAF. L10 is the point series. On 6 October they disagree at Perth, and both cards are right.
- Australian cards stay in metres, feet, hPa, knots and UTC.

The worked set is [samples.md](samples.md). It was computed from `~/Data/isobar` for aviation run `6a887bcd939d97fd2553` and ECMWF run `2026-10-06T00:00:00Z` valid 09Z. Hashes are in [samples.json](samples.json).

## Cohort

Read from `~/Projects/cohort` (MIT code, CC BY content). Isobar reuses the engine's shape. It does not reuse a single medical question.

### Reuse

| Piece | Where it lives | What Isobar takes |
|---|---|---|
| Concept | `prisma/schema/concepts.prisma` `Concept` | `name`, `prerequisiteIds`, topics. Our id is the stable id. Their cuid is an implementation detail |
| Question linked to concepts | `QuestionConcept` in `prisma/schema/content.prisma` | One primary concept, extra concepts allowed. `isPrimary` marks the one a miss scaffolds |
| Locale | `Question.practiceLocale` `'au' \| 'us'` | Required when `au_us` changes the answer |
| Provenance envelope | Open question JSON `publicUsmle.evidence` (`sourceId`, `passageId`, licence class `foss`) and `itemText.licence` `CC-BY-4.0` | Same shape for an aviation item. The field can be renamed. The rule cannot: every question carries a source passage |
| Source registry | `src/lib/usmle/open-source-registry.ts` | HTTPS canonical URL, passage locator, optional quote, sha256 over the quote set, a `verifiedAt` date. The release check rejects a receipt older than 90 days |
| Export fails closed | `scripts/foss/distribution.ts` `openQuestionRightsIssues` | No envelope, item text not marked CC BY 4.0, or evidence licence outside `cc-by-4.0`, `cc-by-sa-4.0`, `cc0-1.0`, `us-gov`: the export stops. `us-gov` is accepted only on a `.gov` host |
| Public reviewer order | `src/lib/usmle/step1-adaptive.ts` | The MVP scheduler. Three tiers. Two correct answers at a tier before promotion (`PROMOTION_STREAK = 2`). One miss demotes immediately and the next items prefer the same ladder, then the same domain. Pure functions, no database |
| Recall update | `src/lib/knowledge/state.ts` `computeKnowledgeState` | Decay since last exposure, then a gain, then a projection to an exam date. Half-life is 7 days at confidence 0 and 21 days at confidence 1 (`DECAY_PARAMS` in `types.ts`) |
| Event log | `LearningEvent` in `prisma/schema/progress.prisma` | `mcq_attempted`, `isCorrect`, `responseMs`, and the concept ids. The log is the record. `ConceptState` is a cache |
| Exam blueprint slot | `src/lib/exam-target/registry-data.ts` | The public registry ships empty. Register an Isobar target whose domains are the seven CASA codes plus the ACS areas. Do not import a university blueprint |

`EXPOSURE_WEIGHTS.mcq_attempted` is 0.7 for a correct answer and 0.3 for a wrong one. `applyExposure` only moves recall upward, so a miss still raises recall a little. The tier rule is what makes the next question easier. That split is worth keeping for a handbook question. For a live chart-reading card, pass strength 0 on a miss so a wrong reading of today's TAF does not look like progress. That is a deliberate change to the published weight, and it should be named in the call, not hidden inside a copy of the function.

The unified scheduler (`src/lib/knowledge/unified-scheduler.ts`) ranks weak concepts by `recallOnExamDay`, chooses a probe when confidence is low, and walks a 3,072-dimensional embedding with cosine distance in Postgres. That is the engine the owner means by "scheduled over a concept embedding". It needs the database, the vectors and an exam date. It is the wrong first dependency for a menu-bar lens.

### Adapt

- Live cards are not a stable bank. Cohort's retirement and variant suppression assume a question id that still means the same thing next week. Key the schedule by concept id. Retire the instance when its run is no longer current.
- Embeddings wait. The prerequisite edge is the ladder `step1-adaptive` already wants (`ladderId`). Add vectors only if a later host runs the unified scheduler.
- Rights. FAA handbooks are US government work and can become `us-gov` evidence once a verbatim passage is hashed. ECMWF open data is CC BY 4.0 and can be evidence now. The Aviation Weather Center feed is `verify`: the store says the API page states no licence. A card that needs the verbatim METAR or SIGMET line does not go through `foss:export`. OurAirports is marked public domain in the store and stays `verify` until that claim is checked.
- CASA exam banks, AIP plates and Bureau chart images are not source passages. Cite the instrument. Write the question.

### Native lens, not a web component first

Build the MVP as a Learn lens in the Mac app, beside Fly. The map stays up. One card is one row: the concept, the stem, the choices, and the layer it will show. The reveal recentres or switches that layer. Hover already holds a time; the card should pin the valid time the key was computed for, and release should resume the drift. Pause still dies when the map closes.

A shared component in `site/` can render the same JSON against an exported frame later. It cannot drive the Metal layer, the camera, or the playback hold. Building it first would fork the question format and teach against a reduced map. Share the template runner and the validator. Do not share a second scheduler.

### What an answer does

1. Grade against the frozen key. If the store has moved past the tolerance, withdraw the card instead of marking the learner wrong.
2. Append a `LearningEvent`: concept ids, correct or not, response time, template id, product hash.
3. Move the tier with `rankAdaptive` / `nextTier`. A miss pulls the next card from the prerequisite ladder of that concept.
4. For a physics card, update recall with `computeKnowledgeState` and the published weights. For a live card, use strength 0 on a miss.
5. When an exam date exists, `projectRecallToExamDay` is the number the later unified scheduler would rank on. The MVP does not need to show it. Cohort's public reviewer deliberately shows what you have seen and what you got right, and does not show a predicted score. Keep that.

## Sources

Every rule a card states was verified on 2026-10-07 against the primary Australian text, and the section is recorded in [sources.json](sources.json) (`rules[]`, one entry per rule with URL, section and the card ids that rely on it). FAA handbooks are not sources for this bank.

| Document | URL | Use |
|---|---|---|
| Part 91 MOS 2020, compilation F2026C00587 | https://www.legislation.gov.au/F2020L01514/latest/text | Forecast coverage (s 7.02), relevant weather, alternates and holding (Ch 8), fuel (Ch 19) |
| Part 121 MOS 2020, compilation F2026C00215 | https://www.legislation.gov.au/F2020L01561/latest/text | Fuel definitions (s 1.04), cumulative cloud and PROB (s 4.06), fuel requirements (Ch 7) |
| BoM aviation knowledge-centre guides | https://www.bom.gov.au/aviation/knowledge-centre/ | TAF and TAF3, METAR/SPECI, SIGMET, AIRMET, fog, thunderstorms, icing, stability, Area QNH, glossary |
| BoM Manual of Aviation Meteorology | https://www.bom.gov.au/aviation/knowledge-centre/ | Mechanism cards: pressure and wind, fronts, stability, icing |

Not cited: AIP Australia GEN 3.5 could not be fetched on 2026-10-07 (HTTP 404 from airservicesaustralia.com), so no card relies on it. ECMWF open data (CC BY 4.0) supplies the grids the chart cards read.

### Question standard

Every card, static or live, is linted by `training/src/validate.ts` (`lintCard`) and the tests fail on a breach:

- The stem is a complete question of at least eight words ending in `?`, giving route, UTC and local time where relevant, and asking one thing a pilot decides.
- Three or four complete, parallel, unique options; no "all/none of the above"; distractors are real misconceptions.
- The explanation reasons first, then names the rule and its Australian source (`Part 91 MOS`, `Part 121 MOS`, `BoM`).
- No feed talk: `snapshot`, `run`, `product`, `bucket` are banned words.
- Live cards quote today's raw TAF/METAR/SIGMET text in the stem and carry a `figure` (`title`, `lines`, `highlight`) whose lines contain every highlighted token; a live template with nothing to decide is dropped, not padded.

Question text written for this trainer can be CC BY 4.0. The evidence passage has its own licence. Export fails closed when they are mixed up.

Question text written for this trainer can be CC BY 4.0. The evidence passage has its own licence. Export fails closed when they are mixed up.

## Build

MVP is a Learn lens with the meteorology and flight-planning live cards. Nothing else.

1. **Validator, still outside the app.** A small program reads `templates.json`, the store, and recomputes the ten live keys in `samples.json`. It already has a one-shot check (see below). Promote that into something `tests.sh` can call only when a fixture store is passed in. Do not point a test at `~/Data/isobar`.
2. **Learn lens.** One card over the existing map. Pin the valid time while it is up. Reveal switches to the concept's layer. No second forecast clock. Follow the UX contract: the map keeps playing, a lens does not become the default, and the card is a row rather than a paragraph. The footer carries "situational awareness only", not a sentence in the stem.
3. **Scheduler.** Copy the behaviour of `step1-adaptive.ts` (the two-correct promotion, the immediate demotion, the prerequisite ladder). Log answers locally in the LearningEvent shape. No Postgres and no embeddings in this phase.
4. **Physics bank.** Extract and hash the ten handbook passages. Until the hash exists, those cards stay out of any export.
5. **Performance and systems, where the map already has the number.** Density altitude and the freezing level are in the sample set and can join the lens. Pitot-static, load factor and hypoxia do not need a layer.
6. **Law, as a locale-specific bank.** Register the seven CASA subjects as an exam target only after the MOS codes have been checked against the current instrument. US cards are a second locale, not a translation.
7. **Site.** Render the same instances on an exported frame if the public map is still the lab. Do not start here.

Files a later change will touch, and this one does not: a new lens beside `aviationview`, the lens switch in `main.m`, the UX contract once the behaviour is real, and a test that grades a fixture store.

## Checks run with these files

The concept graph was loaded and checked for a closed DAG: every prerequisite and every `why` link resolves, and neither edge set contains a cycle. Every template's concept id and every sample's concept id is in the graph. The ten live keys were recomputed from `~/Data/isobar` against the hashes in `samples.json`.

## Assumptions

- The seven CASA subject names are current. The booking codes need a confirmation pass against F2014L01585 and the exam page before they are weights.
- FAA-S-ACS-11's knowledge-area names are the right join key. The task letters are deliberately missing.
- AC 00-45 may already have been superseded by FAA-H-8083-28. The handbook is the passage source until the circular is re-checked.
- Point-file elevation (12 m at Perth Airport, −1 m at Sydney) is the elevation the density-altitude card uses. It is not the AIP aerodrome elevation.
- The geostrophic card reports a balance, with the 10 m wind beside it. It is not a forecast wind.
- YPJT is the aerodrome the owner named and the one this store does not have yet.
