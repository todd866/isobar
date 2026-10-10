# Painted cloud sources

Generated 9 October 2026 with the owner's GPT image access, using the built-in
`image_gen` tool in this Codex session (no API-key runner or fetched stock art).
All have real alpha. WebP conversion: `cwebp -q 90 -alpha_q 100`.

| Shipped file | Source in `build/clouds/cloud-art/` | Use |
|---|---|---|
| `painted-atlas.webp` | `cloud-atlas-source.png` | Cu, Cb, cirrus quadrants |
| `stratus.webp` | `stratus-source.png` | Crop `0 260 2048 210`; shallow OVC sheet |
| `nimbostratus.webp` | `nimbostratus-flat-source.png` | Final edited deep rain bank |

The atlas's original Ns quadrant and `nimbostratus-source.png` were rejected:
their cauliflower tops implied cumulus. They remain in the local source archive,
but the renderer uses only the separate final flat-topped Ns asset. Runtime alpha
bound trimming removes atlas padding; cloud bounds and coverage come from the
shared fixture geometry. Stratus and Ns are separate genera/assets.

The requested `~/.local/state/isobar-week/cloud-art/` destination conflicts with
the final instruction to work only inside this worktree and is outside the
writable sandbox. Source PNGs are therefore preserved under `build/clouds/`.
Build outputs are ignored and must not be committed. The image tool also keeps
its original outputs in its normal generated-images storage.

Exact prompts, including the final Ns edit, are in `prompts.md`.

## Production atlas (phase 2)

The approved five sprites are trimmed and packed by `../pack-painted.mjs` into
`web/public/sky/painted-clouds.webp`: 294,652 bytes, 772×1,291. This retains the
phase-1 significant-alpha crop threshold (32); no new art is generated.
`production-manifest.json` records the exact digest, source bytes and rectangles;
`training/src/sky/atlas.ts` is generated from those same rectangles. Native
`training/build.mjs` copies the WebP beside `sky.html` and `sky.js`.
The image and two prepared tint canvases occupy about 11.41 MiB before browser
allocation overhead. See `docs/design/sky-section.md` for measured limits.
