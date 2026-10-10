# Operational Decision engine

Pure TypeScript; no UI, clock, network, storage or random global state. All fleet
figures are **teaching values — not for operational use**. Aircraft sheets and
MEL conditions are original inventions, not extracts from CASA/Boeing manuals.

## Entry points

- `manual.ts`: five fleet sheets, fuel/time interpolation, wind correction,
  holding/alternate fuel, corrected dispatch distances and MEL predicates.
- `weather.ts`: adapt the site's `aviation.json`, `/api/aviation` response and
  `sky.json`/point `ProfileSeries`. `weatherRequest` returns routing information;
  the caller performs I/O. Station IDs and raw bulletins remain unchanged.
- `generator.ts`: `generateDossier({seed, edition, difficulty, strand, reports})`.
  Optional `decreeId`, `shift`, `polarity` and `aircraft` constrain the exercise.
  Difficulty is Learn's continuous −4…4 scale. The same complete inputs give the
  same dossier, including narrative. Weather remains real; plans, aerodromes,
  documents and pressure scenes are fictional. `draftDossier` supports authors.
- `decrees.ts`: 19 sequential decrees, each with AU/US parameters, checks, primary
  references, a reason, citation line and two-node decision tree. Four specific
  concepts were added to the shared graph so fuel/MEL/VFR/landing evidence does
  not falsely credit adjacent skills.
- `judge.ts`: `judge(dossier, decision, {edition, responseMs})`. RELEASE requires
  every active check to pass. REFUSE is correct when at least one active decree
  fails, even if an amendment could also work. `rules` and `citations` identify
  causes. Unsupported inputs produce no scheduler evidence.
- `learn.ts`: scheduler target and evidence adapters; only assessed strands move.
  AUS law does not update US law. The caller persists and deduplicates evidence
  by `dossierId` + `decreeId` across submissions.
- `shifts.ts`: decree introduction, dossier count, citations and safe on-time
  quota. Narrative rank, Ministry pressure and rebel hooks never alter a check.
- `story/`: twelve scripted shifts. The adaptive scheduler picks each slot's
  decree and difficulty inside that shift's rules. Captain, inspector, first
  officer and rebel scenes change lines, a quota mark and an epilogue. They
  do not change a check, a stamp's correctness, or the weather.

```ts
const generated = generateDossier({
  seed: 42, edition: 'aus', difficulty: 1, strand: 'numbers', reports,
});
if (generated.kind === 'ready') {
  const result = judge(generated.dossier, { stamp: 'RELEASE' }, {
    edition: 'aus', responseMs: 18_000,
  });
  // Persist result.evidence after preventing duplicate submissions.
}
```

`intent` is author/test metadata outside the dossier; the judge never trusts it.
The generator verifies every decree (including later, scaffolded rules) and
requires exactly its intended failure. Every positive case also has a failing
counterfactual for that rule. Unsuitable weather returns `unavailable`; it is
never rewritten to force a lesson. A bounded six-station search supports a
quiet fallback to another scheduler target. Synthetic weather lives only in tests.

AMEND accepts `alternate` (an offered ID), `fuel` (total usable kg after adding
fuel), and `delay` (positive minutes, at most 24 h). Supplying `fuel` rebudgets all
surplus after reserves/diversion as holding; the same tank quantity can reallocate
existing surplus, and a new alternate can reduce holding. All active rules are then rechecked, including
mass, alternate availability, TAF time, document expiry and duty. Waiting extends
duty; it does not create rest. Weather is frozen evidence: amendments re-sample
the supplied TAF/profile, never imply a new METAR or silently refresh a forecast.

## Deliberate teaching scope

The republic's Code simplifies the linked law; the `realRule.scope` beside each
citation distinguishes statutory requirements from stricter invented rules.
References were checked against public Australian legislation and eCFR on
9 October 2026. Australian legislative material is attributed to the Commonwealth
(CC BY 4.0); US federal material is public domain. No manual tables were copied.

- Conventional aeroplanes, domestic operations, no exemptions, FRMS, extensions,
  isolated aerodromes, EDTO, in-flight replanning or critical-point additional fuel.
  `private`, `charter` and `airline` mean the stipulated Part 91, small-aircraft
  Part 135 and larger-aeroplane Part 121 teaching regimes, respectively.
- AUS weather exercises use stated IFR alternate minima. Airline cases always
  nominate an alternate. Prevailing-weather holding substitution and TAF3
  concessions are not used. The Code counts PROB conservatively in both editions.
  US private/domestic airline uses 1-2-3; charter stipulates no circling approach.
  AU adverse-weather assessment is ETA ±30 minutes (MOS 8.04), distinct from
  forecast coverage −30/+60 (7.02). US alternate weather is assessed at diversion
  ETA (91.169(c)). Every nominated alternate must be suitable, even if optional.
- Thunderstorm waiting durations in the US are an invented conservative operator
  restriction. Holding never authorises entering a thunderstorm.
- Icing uses stipulated cloud exposure and both endpoint freezing profiles. This
  is a cause-and-effect proxy, **not** a route icing prediction. Missing profiles
  remain unknown. Surface reports provide the quoted pressure/temperature
  assumptions for the runway worksheet; they are not future landing forecasts.
- Runway distances are already conservative teaching dispatch requirements,
  not real AFM landing distances to which statutory factors can be reapplied.
  QNH uses 27 ft/hPa, density altitude 120 ft/°C. Wind directions are true.
  Exercise runway lengths are declared available distances, which may be shorter
  than the fictional aerodrome's pavement. Release mass conservatively includes
  taxi fuel; no extra runway credit is taken for its burn.
- AU duty uses an explicitly elected CAO 48.1 Appendix 1 home-base Basic Limits
  scheme, starting at/after 0700. US airline uses acclimatised, unaugmented
  Part 117 Tables A/B; charter uses the stipulated regular Part 135 duty/rest
  pattern. Other cumulative/late-duty checks and subsequent rest are stipulated
  complete. Private flights do not inherit airline duty limits.
- Credential validity dates are supplied documents, not a general medical-expiry
  calculator. Logbook events stipulate correct category/type, pilot handling and
  (AU) 500 ft climb; US night means the §61.57(b) one-hour sunset/sunrise window.
  Check exemptions and instrument approach currency are outside v1. VMC drills
  are Class C below 10,000 ft only.

## Verification

From `web`: `npm test -- --run tests/unit/od-*.test.ts --maxWorkers=1`.
The engine suite contains 500 seeded plans per decree **per edition** (19,000),
positive/negative checks, unchanged weather assertions and real edition contrasts.
An additional authored pass/fail fixture for every decree and edition checks the
rules without using the generator's rejection sampling.
Manual tests use hand-computed fuel, time and distance; separate judgement tests
exercise amendments, interacting limits, attribution and scoring. No screenshots
are applicable to this engine-only work.
