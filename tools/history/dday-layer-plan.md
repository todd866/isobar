# D-Day shared-map scene

Implemented on `codex/everest-visuals-20261010` in the Everest worktree. Opens D-Day on 6 June 1944 at 06:00 UTC, with Normandy framed and global zoom retained. Explicit date/hour selections still win.

## Delivered

- Shared camera, map canvas, transport and clock; no dedicated history viewer.
- Five beach anchors, five planned airborne-zone anchors, four German formation anchors.
- Five named American warships. Assignments come from NHHC; the approach waypoints, clock and movement between them are synthetic. No digitized deck-log fixes are claimed.
- Eight political-control labels and four national border pairs in western Europe.
- Political, military and ship switches inside the existing Data sources panel. Per-feature sources and reconstruction methods are disclosed there.
- Zoom-dependent detail and label collision reservations. National context labels give way to operational detail.
- Scene assets are bundled: toggles, time interpolation and zoom do not fetch additional scene data.
- Historical coastline LOD tolerances reduced to 0.04° / 0.12° to avoid coarse angular outlines across Europe.

## Geometry and provenance

`dday-scene.json` contains the operational anchors and ship tracks. `dday-context.json` contains control labels, unit anchors and sourced boundary segments. Feature dates, positional scale, methods and source references remain in the assets and are accessible in the source panel. Positional scale is an authored estimate, not a statistical confidence interval.

Border geometry was extracted from shared country-polygon edges in Natural Earth 1:50m countries. The independently downloaded input was 3,083,490 bytes with SHA-256 `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb`. Every emitted edge was checked against the shared source-edge intersection: France–Spain 73, France–Belgium 67, Belgium–Netherlands 60, France–Switzerland 60. This is modern reference geometry selected for stable historical national border pairs; it is not a comprehensive dated 1944 political boundary dataset. Occupation labels are separate from national borders.

No continuous Normandy military front is rendered. Formation anchors describe approximate sectors, and planned airborne anchors do not purport to reproduce actual drop scatter. The full fleet and British/Canadian naval assignments are not yet represented.

## Validation and release handoff

- TypeScript check.
- 12 focused unit tests across historical scenes, chart loading and historical catalog.
- Headless browser D-Day test: layer switches, correct dates, unchanged camera through day changes, laptop/phone/landscape labels and no page errors.
- Separate headless viewport audit: 1280×720, 390×844, 844×390, 200% text with source panel; inspected viewport screenshots.
- Offline layer switches and return from 5 June to 6 June checked.
- Refuter found unsupported MultiLineString border geometry; renderer fixed and re-reviewed with no remaining blocker.
- Browser checks used software rendering only. Hardware acceptance and deployment remain with the release owner.

Evidence is in ignored `build/history/qa/dday-*` files. Stop local server after handoff. Cherry-pick this implementation together with the preceding draft asset commit if the latter is absent. Integrate only the MapExperience hunks, preserving the release owner's newer historical-day race and compact point-panel fixes.
