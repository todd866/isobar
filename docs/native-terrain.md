# Native terrain checkpoints

## 14 October 2026 — tile preparation

Stage 1 prepares Mapterhorn's 512 px Terrarium WebP tiles. `terrain.m` owns
fetch, raw-channel decoding, a 32-tile memory cache, and a 200 MiB encoded disk
cache under `~/Library/Caches/Isobar/terrain`. Four background workers admit at
most 40 tile jobs and 32 waiters per tile. Invalid/oversubscribed requests fail
asynchronously. Offline/fixture reads never write. Cancelled generations cannot
publish newer-view state. Temporary downloads are resource-time-limited; the
8 MiB input limit bounds decoding and application heap use, not the temporary
NSURLSession download file before completion.

`terrainmap.m` coalesces camera changes, builds at most 1.5 million RG texels
(physical metres plus explicit coverage), and publishes immutable CPU samples
and a Metal texture. Bilinear queries require all contributing samples; gaps
stay unknown. Partial current-view coverage is intentional. Cancelled or
superseded mosaics never publish. The production map never waits for terrain.

The tile endpoint has source-specific licences, not blanket CC BY. References:
[format and endpoint](https://mapterhorn.com/data-access/),
[source register](https://download.mapterhorn.com/attribution.json).
The map's shared source line and tooltip include Mapterhorn, Copernicus and
national-source attribution. Fixture URLs, hashes, physical samples and the
surveyed-summit/DEM distinction are in `Tests/fixtures/terrain/README.md`.

Focused checks: strict clang (`-Wall -Wextra -Werror`), 27 decoder/cache checks,
11 deterministic NSURLProtocol transport checks, 17 mosaic checks, and ASan/UBSan
for the new decode/mosaic paths. Count summaries exclude the final `ok` line.
The transport tests cover valid-body HTTP 500, 404, coalescing, actual started
request cancellation followed by same-key replacement, and waiter saturation.
No live network is used by these tests.

Offscreen captures: `tools/capture-terrain.sh EVIDENCE_DIRECTORY` uses the
repository weather fixture, never the installed app or owner's archive. It
prepares real terrain, captures five places × three pitches × light/dark, and
prints covered texels. Stage 1 captures intentionally show the unchanged flat
surface; they prove preparation/attribution, not rendered relief. Evidence:
`~/.local/state/isobar-overnight-20261013/mac-terrain/shots/stage1/`.

Review: standing refuter and scoped Cursor Ask review. Fixed callback reentrancy,
failed-context decoding, generation fencing, omitted completions, corrupt-cache
handling, response validation, cancellation waits, and extreme planner casts.
The first draft's blanket licence and weak fixture assertions were replaced.
Dateline, edge, partial coverage and malformed input are checked. Disk writes
were already atomic; the review's contrary claim was rejected after inspection.

Still pending at this checkpoint: shaded relief, DEM coastline fill, displaced
mesh, common height exaggeration, depth-aware overlays/picks, sky/haze/MSAA,
closer 3D zoom, frame-cost acceptance, and atmosphere-ground profile.

## 14 October 2026 — shaded land

Stage 2 shades measured elevations in `terrainshader.inc`, with a restrained
hypsometric tint beneath the unchanged Bureau weather ramps. Relief eases from
zero at a 75° latitude span to full strength at 12°. At measured pixels the
zero-elevation DEM water surface defines the land/sea edge; the coarse vector
coastline fades away with relief. Missing weather remains missing and numeric
weather samples are unchanged. Terrain outside the weather grid is geographic
context only, never an extrapolated forecast.

Coverage is deliberately conservative: all bilinear contributors must be
measured, so the footprint next to a missing tile can retain a one-texel flat
fringe. Nearest-neighbour coverage would falsely permit interpolation through
unknown elevations. Hillshade requires its four neighbours too; incomplete
neighbours suppress shading, not the central elevation tint. New camera plans
cancel obsolete tile work before acquiring the bounded request slots.

This is still a shaded sea-level surface. Stage 3 must add actual mesh geometry,
shared height exaggeration, terrain intersection/occlusion for every overlay,
far-field coverage, sky/haze/MSAA and measured combined frame cost. Stage 4's
atmosphere-ground profile remains gated on that result. The stage 2 screenshots
must not be presented as side-on mountains.

Focused stage 2 validation: 17 mosaic checks and 13 relief-render checks pass
with strict clang. The relief checks cover both appearances, zero-strength
identity, overlaid weather, physical numeric sampling and missing-tile identity.
The 30 offscreen captures (five places × three tilts × light/dark) were inspected;
full-size evidence is in
`~/.local/state/isobar-overnight-20261013/mac-terrain/shots/stage2/`.
The visible far-edge flat band in steep views is a pending mesh-stage issue.

Final cancellation review replaced the mosaic batch's dispatch group with an
ARC-owned condition and counter. A cancelled tile request intentionally suppresses
its callback; an unmatched group entry could therefore retain the abandoned group.
The replacement keeps the same 100 ms cancellation polling and generation fence
without retaining unfinished group state. The bounded counter and tile dictionary
are locked together; callbacks never take the map-state lock.
