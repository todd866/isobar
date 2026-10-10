/** Styles for the E6-B instrument, injected once by `mountE6B`. Uses the trainer's
 * md3 tokens when present and falls back to its own, so the module also works on
 * a bare page (the website's E6-B route).
 *
 * Face rules are scoped to `.e6b-art`, the class on the drawn groups, never to
 * the outer `<svg>`: the printed face is drawn as SVG images that embed this
 * sheet (no page ancestors there), and the loupe shows the highlights through
 * `<use>`, whose shadow copy has no outer `<svg>` ancestor either. A rule
 * written `.e6b-svg .tick` leaves those copies unstyled (a solid black disc). */
export const E6B_CSS = `
.e6b {
  --e6b-face: #fbfaf6;
  --e6b-face-edge: #d9d5ca;
  --e6b-disc: #ffffff;
  --e6b-window: #eeece5;
  --e6b-ink: #15171a;
  --e6b-blue: #1d4e9e;
  --e6b-hl: var(--md-tertiary, #b0552f);
  --e6b-cursor: #d2302c;
  --e6b-brass-1: #f3dc9a;
  --e6b-brass-2: #a8803a;
  --e6b-page: transparent;
  --e6b-surface: var(--md-surface-container-lowest, #ffffff);
  --e6b-surface-2: var(--md-surface-container-low, #f2f6f7);
  /* The page under the instrument: what the loupe shows off the face. */
  --e6b-desk: var(--md-surface, #f8fafb);
  --e6b-line: var(--md-outline-soft, rgba(115, 119, 127, 0.32));
  --e6b-text: var(--md-on-surface, #171d22);
  --e6b-dim: var(--md-on-surface-variant, #4d5860);
  --e6b-primary: var(--md-primary, #1c5888);
  --e6b-on-primary: var(--md-on-primary, #fff);
  --e6b-primary-c: var(--md-primary-container, #d9ecff);
  --e6b-on-primary-c: var(--md-on-primary-container, #1c507b);
  --e6b-good: var(--md-success, #007f54);
  --e6b-good-c: var(--md-success-container, #cdf5df);
  --e6b-on-good-c: var(--md-on-success-container, #055a3b);
  --e6b-bad: var(--md-error, #bb3734);
  --e6b-bad-c: var(--md-error-container, #ffe2de);
  --e6b-on-bad-c: var(--md-on-error-container, #793a35);
  --e6b-chip: var(--md-surface-container-high, #e1eaed);
  --e6b-shadow: 0 30px 60px -18px rgba(24, 32, 40, 0.30), 0 6px 18px rgba(24, 32, 40, 0.10);
  --e6b-pop: 0 12px 32px rgba(20, 28, 36, 0.16), 0 2px 6px rgba(20, 28, 36, 0.08);
  --e6b-wind-grid: #2a5ea8;
  --e6b-wind-grid-bg: #f7f9fc;
  --e6b-band: #141518;
  --e6b-band-ink: #f6f5f0;
  --e6b-pencil: #2b2b2b;
  --e6b-plate: rgba(214, 228, 240, 0.36);
  --e6b-plate-solid: #ffffff;
  font-variant-numeric: tabular-nums;
  color: var(--e6b-text);
  min-height: 0;
  -webkit-tap-highlight-color: transparent;
}
:root[data-theme="dark"] .e6b, .e6b[data-theme="dark"] {
  --e6b-face: #16181b; --e6b-face-edge: #2c2f34; --e6b-disc: #1d2024; --e6b-window: #0b0c0e;
  --e6b-ink: #ecebe5; --e6b-blue: #8fb6ff; --e6b-cursor: #ff5a4f;
  --e6b-surface: var(--md-surface-container-low, #171d21); --e6b-surface-2: var(--md-surface-container, #1d252a); --e6b-desk: var(--md-surface, #12161a);
  --e6b-text: var(--md-on-surface, #e3e3e3); --e6b-dim: var(--md-on-surface-variant, #c3c6cf);
  --e6b-line: var(--md-outline-soft, rgba(141, 145, 153, 0.30)); --e6b-primary: var(--md-primary, #6e9fcc); --e6b-on-primary: var(--md-on-primary, #00213b);
  --e6b-primary-c: var(--md-primary-container, #1a4b73); --e6b-on-primary-c: var(--md-on-primary-container, #d0e8ff);
  --e6b-good: var(--md-success, #59aa83); --e6b-good-c: var(--md-success-container, #005638); --e6b-on-good-c: var(--md-on-success-container, #bcf4d6);
  --e6b-bad: var(--md-error, #e57d74); --e6b-bad-c: var(--md-error-container, #7f201f); --e6b-on-bad-c: var(--md-on-error-container, #ffdbd7);
  --e6b-chip: var(--md-surface-container-high, #273137);
  --e6b-shadow: 0 30px 70px -16px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.04);
  --e6b-pop: 0 14px 36px rgba(0, 0, 0, 0.55);
  --e6b-wind-grid: #8fb6ff; --e6b-wind-grid-bg: #15171b; --e6b-band: #0b0c0e; --e6b-band-ink: #ecebe5;
  --e6b-pencil: #f2f0e8; --e6b-plate: rgba(150, 180, 210, 0.16); --e6b-plate-solid: #1d2024;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .e6b:not([data-theme="light"]) {
    --e6b-face: #16181b; --e6b-face-edge: #2c2f34; --e6b-disc: #1d2024; --e6b-window: #0b0c0e;
    --e6b-ink: #ecebe5; --e6b-blue: #8fb6ff; --e6b-cursor: #ff5a4f;
    --e6b-surface: var(--md-surface-container-low, #171d21); --e6b-surface-2: var(--md-surface-container, #1d252a); --e6b-desk: var(--md-surface, #12161a);
    --e6b-text: var(--md-on-surface, #e3e3e3); --e6b-dim: var(--md-on-surface-variant, #c3c6cf);
    --e6b-line: var(--md-outline-soft, rgba(141, 145, 153, 0.30)); --e6b-primary: var(--md-primary, #6e9fcc); --e6b-on-primary: var(--md-on-primary, #00213b);
    --e6b-primary-c: var(--md-primary-container, #1a4b73); --e6b-on-primary-c: var(--md-on-primary-container, #d0e8ff);
    --e6b-good: var(--md-success, #59aa83); --e6b-good-c: var(--md-success-container, #005638); --e6b-on-good-c: var(--md-on-success-container, #bcf4d6);
    --e6b-bad: var(--md-error, #e57d74); --e6b-bad-c: var(--md-error-container, #7f201f); --e6b-on-bad-c: var(--md-on-error-container, #ffdbd7);
    --e6b-chip: var(--md-surface-container-high, #273137);
    --e6b-shadow: 0 30px 70px -16px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.04);
    --e6b-pop: 0 14px 36px rgba(0, 0, 0, 0.55);
    --e6b-wind-grid: #8fb6ff; --e6b-wind-grid-bg: #15171b; --e6b-band: #0b0c0e; --e6b-band-ink: #ecebe5;
    --e6b-pencil: #f2f0e8; --e6b-plate: rgba(150, 180, 210, 0.16); --e6b-plate-solid: #1d2024;
  }
}
.e6b button { font: inherit; color: inherit; cursor: pointer; }
.e6b button:focus-visible, .e6b input:focus-visible, .e6b .chip:focus-visible { outline: 2px solid var(--e6b-primary); outline-offset: 2px; }

/* Layout: the instrument is the stage; the chrome is one strip below it. */
.e6b.lab { container: e6b / size; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 10px; }
.e6b.card { display: grid; gap: 8px; }
.e6b-stage { position: relative; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 10px; }
.e6b.card .e6b-stage { grid-template-rows: auto; }
/* Wide: task card left, the instrument as large as the height allows in the middle, the readout right. */
@container e6b (min-width: 980px) {
  .e6b-stage { grid-template-columns: minmax(340px, 1fr) min(calc(100cqh - 76px), calc(100cqw - 700px)) minmax(260px, 1fr); grid-template-rows: minmax(0, 1fr); gap: 0; }
  .e6b-task { grid-column: 1; grid-row: 1; align-self: start; max-width: 360px; margin-right: 16px; }
  .e6b-dial { grid-column: 2; grid-row: 1; }
  .e6b-readpanel:not([hidden]) { display: grid; grid-column: 3; grid-row: 1; align-self: end; justify-self: end; width: min(260px, 100%); margin-left: 20px; }
  .strip .readout { visibility: hidden; }
}
.e6b-dial { position: relative; z-index: 3; min-width: 0; min-height: 0; height: 100%; display: grid; place-items: center; perspective: 1800px; }
.e6b.card .e6b-dial { height: auto; }
.e6b-shadow { position: absolute; border-radius: 50%; box-shadow: var(--e6b-shadow); pointer-events: none; }
.e6b.zoomed .e6b-shadow { display: none; }
.e6b-svg {
  position: relative; display: block; width: auto; max-width: 100%; height: 100%; aspect-ratio: 1;
  touch-action: none; user-select: none; -webkit-user-select: none; outline: none; border-radius: 50%;
}
.e6b.card .e6b-svg { height: auto; width: 100%; max-height: min(560px, 70vh); }
.e6b-svg:focus-visible { outline: 2px solid var(--e6b-primary); outline-offset: 4px; }

/* The view handle is outside the calculation controls, like turning the case. */
.e6b-view-knob { position: absolute; left: 4px; bottom: 4px; width: 48px; height: 48px; padding: 0; border-radius: 50%; display: grid; place-content: center; justify-items: center; gap: 0; border: 1px solid var(--e6b-line); background: var(--e6b-surface); color: var(--e6b-dim); box-shadow: 0 2px 5px #0001; touch-action: none; cursor: grab !important; z-index: 3; }
.e6b-view-knob svg { width: 26px; height: 26px; display: block; }
.e6b-view-knob .ring { fill: none; stroke: currentColor; stroke-width: 2; opacity: .45; }
.e6b-view-knob .up { fill: var(--e6b-cursor); }
.e6b-view-knob .down { fill: currentColor; opacity: .6; }
.e6b-view-knob.turned { color: var(--e6b-text); border-color: var(--e6b-cursor); }
.e6b-view-knob span { font-size: 10px; line-height: 1; }
.e6b[data-hover="view"] .e6b-svg, .e6b.dragging-view .e6b-svg { cursor: grab; }
.e6b.dragging-view .e6b-svg { cursor: grabbing; }
.e6b-view-knob:active { cursor: grabbing !important; }
.e6b .auto-turn[aria-pressed="true"] { background: var(--e6b-primary-c); color: var(--e6b-on-primary-c); }
/* Direct manipulation: a rotate cursor on the disc, the knurl lights up, the hairline thickens. */
.e6b[data-hover="disc"] .e6b-svg { cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath d='M22 9a10 10 0 1 0 1 8' fill='none' stroke='white' stroke-width='5' stroke-linecap='round'/%3E%3Cpath d='M22 9a10 10 0 1 0 1 8' fill='none' stroke='%231d4e9e' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M23.5 2.5v8h-8z' fill='%231d4e9e' stroke='white' stroke-width='1.2'/%3E%3C/svg%3E") 14 14, grab; }
.e6b[data-hover="cursor"] .e6b-svg, .e6b[data-hover="slide"] .e6b-wind { cursor: grab; }
.e6b[data-hover="base"] .e6b-svg { cursor: crosshair; }
.e6b[data-hover="plate"] .e6b-wind { cursor: grab; }
.e6b.dragging .e6b-svg { cursor: grabbing; }
.e6b-knurl { opacity: 0; transition: opacity 160ms; pointer-events: none; }
.e6b[data-hover="disc"] .e6b-knurl, .e6b.dragging-disc .e6b-knurl { opacity: 1; }
.e6b[data-hover="base"] .e6b-art, .e6b.dragging-ring .e6b-art { cursor: grab; }
.e6b-art .knurl { stroke: var(--e6b-blue); stroke-width: 2.4; opacity: 0.55; }
.e6b-art .knurl-ring { fill: none; stroke: color-mix(in srgb, var(--e6b-blue) 22%, transparent); stroke-width: 18; }
.e6b[data-hover="cursor"] .e6b-art .cursor-line, .e6b.dragging-cursor .e6b-art .cursor-line { stroke-width: 5; }
.e6b[data-hover="cursor"] .e6b-art .cursor-handle rect, .e6b.dragging-cursor .e6b-art .cursor-handle rect { filter: brightness(1.12); }

/* The face (both the dial and its loupe copy). */
.e6b-svg text, .e6b-art text { font-family: "Avenir Next Condensed", "DIN Condensed", "Roboto Condensed", "Arial Narrow", sans-serif; text-anchor: middle; dominant-baseline: central; }
.e6b-art .face-text { fill: var(--e6b-ink); font-weight: 500; letter-spacing: 0.04em; }
.e6b-art .base-face { fill: var(--e6b-face); stroke: var(--e6b-face-edge); stroke-width: 6; }
.e6b-art .base-rim { fill: none; stroke: var(--e6b-face-edge); stroke-width: 2; }
.e6b-art .window-floor { fill: var(--e6b-window); }
.e6b-art .tick { stroke: var(--e6b-ink); fill: none; stroke-linecap: butt; }
.e6b-art .num { fill: var(--e6b-ink); font-weight: 700; }
.e6b-art .unit { fill: var(--e6b-ink); font-weight: 600; letter-spacing: 0.03em; }
.e6b-art .box { fill: var(--e6b-ink); }
.e6b-art .on-box { fill: var(--e6b-face); }
.e6b-art .arrow { stroke: var(--e6b-ink); stroke-width: 4; }
.e6b-art .head, .e6b-art .rate { fill: var(--e6b-ink); }
.e6b-art .rule { stroke: var(--e6b-ink); stroke-width: 3; }
.e6b-art .plate { fill: var(--e6b-ink); }
.e6b-art .plate-text { fill: var(--e6b-disc); letter-spacing: 0.06em; }
.e6b-art .disc-face { fill: var(--e6b-disc); stroke: var(--e6b-face-edge); stroke-width: 3; }
.e6b-art .disc-halo { fill: none; stroke: rgba(0, 0, 0, 0.5); stroke-width: 8; }
.e6b-art .window-edge { fill: none; stroke: var(--e6b-ink); stroke-width: 3; opacity: 0.55; }
.e6b-art .disc-ring { fill: none; stroke: var(--e6b-blue); stroke-width: 4; }
.e6b-art .e6b-disc .tick, .e6b-art .e6b-disc .arrow, .e6b-art .e6b-disc .rule { stroke: var(--e6b-blue); }
.e6b-art .e6b-disc .num, .e6b-art .e6b-disc .unit, .e6b-art .e6b-disc .face-text, .e6b-art .e6b-disc .head,
.e6b-art .e6b-disc .rate, .e6b-art .e6b-disc .box, .e6b-art .e6b-disc .plate { fill: var(--e6b-blue); }
.e6b-art .e6b-disc .on-box, .e6b-art .e6b-disc .plate-text { fill: var(--e6b-disc); }
.e6b-art .cursor-band { fill: color-mix(in srgb, var(--e6b-cursor) 8%, transparent); stroke: color-mix(in srgb, var(--e6b-cursor) 28%, transparent); stroke-width: 2; }
.e6b-art .cursor-line { stroke: var(--e6b-cursor); stroke-width: 3; transition: stroke-width 120ms; }
.e6b-art .cursor-handle rect { fill: var(--e6b-cursor); stroke: color-mix(in srgb, var(--e6b-cursor) 60%, #000); stroke-width: 3; }
.e6b-art .cursor-handle path { fill: #fff; stroke: none; opacity: 0.95; }
.e6b-art .cursor-handle { cursor: grab; }
.e6b.zoomed .e6b-art { cursor: grab; }
.e6b.dragging-pan .e6b-art { cursor: grabbing; }
.e6b-art .hub { stroke: var(--e6b-brass-2); stroke-width: 4; }
.e6b-art .hub-dot { fill: var(--e6b-brass-2); opacity: 0.6; }

/* Coach marks: the marks involved glow; green when aligned. */
.e6b-art .hl rect { fill: color-mix(in srgb, var(--e6b-hl) 16%, transparent); stroke: var(--e6b-hl); stroke-width: 7; }
.e6b-art .hl { animation: e6bPulse 1.6s ease-in-out infinite; }
.e6b-art .hl.ok rect { fill: color-mix(in srgb, var(--e6b-good) 18%, transparent); stroke: var(--e6b-good); }
.e6b-art .hl.ok { animation: none; }
.e6b-art .hl.hover rect { fill: color-mix(in srgb, var(--e6b-primary) 22%, transparent); stroke: var(--e6b-primary); stroke-width: 10; }
.e6b-art .hl.hover { animation: none; }
@keyframes e6bPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.e6b-art .target-line { stroke: var(--e6b-cursor); stroke-width: 4; stroke-dasharray: 22 16; opacity: 0.7; fill: none; }
.e6b-art .turn-arc, .e6b-wind .turn-arc { fill: none; stroke: var(--e6b-hl); stroke-width: 12; stroke-linecap: round; stroke-dasharray: 26 18; opacity: 0.75; animation: e6bMarch 0.9s linear infinite; }
.e6b-art .turn-head, .e6b-wind .turn-head { fill: var(--e6b-hl); }
@keyframes e6bMarch { to { stroke-dashoffset: -44; } }
.e6b-art .aligned-tick circle, .e6b-wind .aligned-tick circle { fill: var(--e6b-good); }
.e6b-art .aligned-tick path, .e6b-wind .aligned-tick path { fill: none; stroke: #fff; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round; }
.e6b-art.e6b-ghost { opacity: 0.5; pointer-events: none; }
.e6b-art.e6b-ghost .disc-face, .e6b-art.e6b-ghost .disc-halo, .e6b-art.e6b-ghost .window-edge { fill: none; stroke: none; }
.e6b-art.e6b-ghost .e6b-disc .tick, .e6b-art.e6b-ghost .e6b-disc .arrow, .e6b-art.e6b-ghost .e6b-disc .rule, .e6b-art.e6b-ghost .disc-ring { stroke: var(--e6b-good); }
.e6b-art.e6b-ghost .e6b-disc .num, .e6b-art.e6b-ghost .e6b-disc .unit, .e6b-art.e6b-ghost .e6b-disc .face-text, .e6b-art.e6b-ghost .e6b-disc .head,
.e6b-art.e6b-ghost .e6b-disc .rate, .e6b-art.e6b-ghost .e6b-disc .box, .e6b-art.e6b-ghost .e6b-disc .plate { fill: var(--e6b-good); }
.e6b-art.e6b-ghost .ghost-line { stroke: var(--e6b-good); stroke-width: 5; stroke-dasharray: 20 14; }
.e6b-art .tag rect { fill: var(--e6b-surface); stroke: currentColor; stroke-width: 3; }
.e6b-art .tag text { fill: currentColor; font-size: 50px; font-weight: 700; font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; }
.e6b-art .tag.outer { color: var(--e6b-ink); }
.e6b-art .tag.inner { color: var(--e6b-blue); }
.e6b-guide, .e6b-tags { pointer-events: none; }

/* The readout as an instrument block beside the dial (wide screens); in the strip otherwise. */
.e6b-readpanel { display: none; }
.e6b-readpanel { gap: 2px; box-sizing: border-box; padding: 10px 14px; border-radius: 14px; background: var(--e6b-surface); border: 1px solid var(--e6b-line); }
.e6b-readpanel .rp-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 28px; }
.e6b-readpanel .k { font-size: 13px; color: var(--e6b-dim); }
.e6b-readpanel b { font-size: 20px; font-weight: 600; }
.e6b-readpanel .rp-row.blue b { color: var(--e6b-blue); }

/* Loupe, centre button, flip */
.e6b-loupe {
  position: absolute; left: 0; top: 0; width: 132px; height: 132px; border-radius: 50%; overflow: hidden;
  pointer-events: auto; touch-action: none; cursor: grab; z-index: 2; background: var(--e6b-desk);
  box-shadow: 0 0 0 2px var(--e6b-brass-2), 0 0 0 5px color-mix(in srgb, var(--e6b-brass-1) 70%, transparent), 0 10px 24px rgba(0, 0, 0, 0.28);
  will-change: transform;
}
.e6b-loupe svg { width: 100%; height: 100%; display: block; pointer-events: none; }
.e6b.dragging-loupe .e6b-loupe { cursor: grabbing; }
/* Turning parts are promoted only while something moves (see markMoving). */
.e6b.moving .e6b-svg > .e6b-art, .e6b.moving .e6b-svg .e6b-disc, .e6b.moving .e6b-svg .e6b-cursor,
.e6b.moving .wind-view, .e6b.moving .wind-plate, .e6b.moving .wind-slide { will-change: transform; }
.e6b-centre {
  position: absolute; right: 6px; bottom: 6px; width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid var(--e6b-line); background: var(--e6b-surface); color: var(--e6b-dim);
  font-size: 18px; line-height: 1; opacity: 0; pointer-events: none; transition: opacity 160ms;
}
.e6b.zoomed .e6b-centre { opacity: 1; pointer-events: auto; }
.e6b-dial.flip-out .e6b-svg { transform: rotateY(90deg); transition: transform 230ms cubic-bezier(0.4, 0, 1, 1); }
.e6b-dial.flip-in .e6b-svg { animation: e6bFlipIn 230ms cubic-bezier(0, 0, 0.2, 1); }
@keyframes e6bFlipIn { from { transform: rotateY(-90deg); } to { transform: rotateY(0); } }

/* Wind side */
.e6b-wind .slide-card { fill: var(--e6b-disc); stroke: var(--e6b-face-edge); stroke-width: 4; }
.e6b-wind .slide-grid-bg { fill: var(--e6b-wind-grid-bg); }
.e6b-wind .arc { fill: none; stroke: var(--e6b-wind-grid); stroke-width: 3; }
.e6b-wind .arc.major { stroke-width: 5.5; }
.e6b-wind .ray { fill: none; stroke: var(--e6b-wind-grid); stroke-width: 2.6; }
.e6b-wind .centre { stroke: var(--e6b-wind-grid); stroke-width: 6; }
.e6b-wind .slide-tag { fill: var(--e6b-wind-grid-bg); }
.e6b-wind .slide-num { fill: var(--e6b-wind-grid); font-size: 40px; font-weight: 600; }
.e6b-wind .slide-drift { fill: var(--e6b-wind-grid); font-size: 34px; font-weight: 600; paint-order: stroke; stroke: var(--e6b-wind-grid-bg); stroke-width: 8px; }
.e6b-wind .slide-text { fill: var(--e6b-ink); font-size: 44px; text-anchor: start; dominant-baseline: auto; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; }
.e6b-wind .slide-text.head { font-weight: 800; }
.e6b-wind .slide-rule { stroke: var(--e6b-ink); stroke-width: 3; }
.e6b-wind .frame-ring { fill: var(--e6b-band); stroke: var(--e6b-face-edge); stroke-width: 4; }
.e6b-wind .frame-tick { stroke: var(--e6b-band-ink); stroke-width: 3.5; fill: none; }
.e6b-wind .frame-num { fill: var(--e6b-band-ink); font-size: 46px; font-weight: 500; }
.e6b-wind .index-box { fill: var(--e6b-face); }
.e6b-wind .index-text { fill: var(--e6b-ink); font-size: 40px; font-weight: 800; letter-spacing: 0.08em; }
.e6b-wind .index-tri { fill: var(--e6b-face); }
.e6b-wind .plate-glass { fill: var(--e6b-plate); stroke: color-mix(in srgb, var(--e6b-ink) 25%, transparent); stroke-width: 3; }
.e6b-wind .plate-band { fill: var(--e6b-face); }
.e6b-wind .plate-tick { stroke: var(--e6b-ink); stroke-width: 3.5; fill: none; }
.e6b-wind .plate-num { fill: var(--e6b-ink); font-size: 56px; font-weight: 700; }
.e6b-wind .plate-point { fill: var(--e6b-ink); font-size: 30px; font-weight: 700; }
.e6b-wind .plate-tri { fill: var(--e6b-ink); }
.e6b-wind .card-box { fill: var(--e6b-ink); }
.e6b-wind .card-text { fill: var(--e6b-face); font-size: 60px; font-weight: 800; }
.e6b-wind .card-tri { fill: var(--e6b-ink); }
.e6b-wind .plate-edge { fill: none; stroke: color-mix(in srgb, var(--e6b-ink) 45%, transparent); stroke-width: 3; }
.e6b-wind .plate-grip { fill: none; stroke: color-mix(in srgb, var(--e6b-primary) 30%, transparent); stroke-width: 172; opacity: 0; transition: opacity 160ms; pointer-events: none; }
.e6b[data-hover="plate"] .e6b-wind .plate-grip, .e6b.dragging-plate .e6b-wind .plate-grip { opacity: 0.6; }
.e6b-wind .slide-grip rect { fill: var(--e6b-surface); stroke: var(--e6b-face-edge); stroke-width: 4; }
.e6b-wind .slide-grip path { stroke: var(--e6b-dim); stroke-width: 6; stroke-linecap: round; }
.e6b[data-hover="slide"] .e6b-wind .slide-grip rect, .e6b.dragging-slide .e6b-wind .slide-grip rect { stroke: var(--e6b-primary); }
.e6b-wind .pencil-line { stroke: var(--e6b-pencil); stroke-width: 4; stroke-dasharray: 10 10; opacity: 0.7; }
.e6b-wind .pencil-dot { fill: var(--e6b-pencil); stroke: var(--e6b-plate-solid); stroke-width: 4; }
.e6b-wind .grommet { stroke: var(--e6b-brass-2); stroke-width: 5; }
.e6b-wind .grommet-hole { fill: var(--e6b-plate-solid); stroke: var(--e6b-brass-2); stroke-width: 3; }
.e6b-wind .grommet-cross { stroke: var(--e6b-pencil); stroke-width: 3; }
.e6b-wind .hl-ring { fill: none; stroke: var(--e6b-hl); stroke-width: 8; animation: e6bPulse 1.6s ease-in-out infinite; }
.e6b-wind .hl-ring.ok { stroke: var(--e6b-good); animation: none; }
.e6b-wind .hl-arc { fill: none; stroke: var(--e6b-hl); stroke-width: 10; opacity: 0.8; }
.e6b-wind .dot-target { fill: color-mix(in srgb, var(--e6b-hl) 24%, transparent); stroke: var(--e6b-hl); stroke-width: 9; stroke-dasharray: 14 10; animation: e6bPulse 1.6s ease-in-out infinite; }
.e6b-wind .dot-target-core { fill: var(--e6b-hl); }
.e6b-wind .slide-cue path { fill: var(--e6b-hl); animation: e6bPulse 1.2s ease-in-out infinite; }
.e6b-wind .wind-hl { pointer-events: none; }

/* The strip: one slim row of controls under the instrument. */
.e6b-strip { position: relative; min-width: 0; container: strip / inline-size; }
@container strip (max-width: 1240px) { .e6b .strip .end .tbtn span { display: none; } }
@container strip (max-width: 1060px) { .e6b .stages .chev, .e6b .transport .count { display: none; } .e6b .picker { max-width: 180px; } }
.e6b .strip { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 6px 8px; border-radius: 16px; background: var(--e6b-surface-2); border: 1px solid var(--e6b-line); }
.e6b .strip .grp { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 1 auto; }
.e6b .strip .modes, .e6b .strip .end { flex: none; }
.e6b .strip .grp.end { margin-left: auto; }
.e6b .strip .ctx { gap: 10px; }
.e6b .readout { flex: 1 1 auto; min-width: 0; display: flex; justify-content: center; gap: 16px; font-size: 14px; white-space: normal; }
.e6b .readout .ro .k { color: var(--e6b-dim); font-size: 12px; }
.e6b .readout .ro b { font-weight: 600; font-size: 15px; }
.e6b .readout .ro.blue b { color: var(--e6b-blue); }
.e6b .seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--e6b-chip); }
.e6b .seg button { border: 0; background: transparent; height: 32px; padding: 0 14px; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--e6b-dim); }
.e6b .seg button[aria-checked="true"] { background: var(--e6b-surface); color: var(--e6b-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
.e6b .picker { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 12px; border-radius: 10px; border: 1px solid var(--e6b-line); background: var(--e6b-surface); font-size: 14px; font-weight: 500; max-width: 260px; }
.e6b .picker > span:not(.sk):not(.caret) { white-space: normal; }
.e6b .picker .caret { color: var(--e6b-dim); font-size: 11px; }
.e6b .sk { display: inline-block; width: 1em; text-align: center; font-size: 13px; color: var(--e6b-dim); }
.e6b .sk.learning { color: var(--e6b-hl); }
.e6b .sk.fluent { color: var(--e6b-good); }
.e6b .stages { display: inline-flex; align-items: center; gap: 2px; }
.e6b .stages .chev { color: var(--e6b-dim); font-size: 12px; opacity: 0.6; }
.e6b .stages .pip { height: 30px; padding: 0 10px; border-radius: 999px; border: 0; background: transparent; color: var(--e6b-dim); font-size: 13px; }
.e6b .stages .pip.done { color: var(--e6b-good); }
.e6b .stages .pip.done::before { content: "✓ "; }
.e6b .stages .pip.now { background: var(--e6b-primary-c); color: var(--e6b-on-primary-c); font-weight: 600; }
.e6b .transport { display: inline-flex; align-items: center; gap: 4px; }
.e6b .transport button { width: 34px; height: 32px; border-radius: 8px; border: 1px solid var(--e6b-line); background: var(--e6b-surface); font-size: 13px; }
.e6b .transport button.play { width: 40px; background: var(--e6b-primary); color: var(--e6b-on-primary); border-color: transparent; }
.e6b .transport .count { margin-left: 4px; font-size: 12px; color: var(--e6b-dim); min-width: 2.4em; }
.e6b .tbtn { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border-radius: 10px; border: 1px solid transparent; background: transparent; color: var(--e6b-dim); font-size: 13px; }
.e6b .tbtn:hover { background: var(--e6b-chip); }
.e6b .tbtn.on { color: var(--e6b-text); }
.e6b .tbtn:first-letter { font-size: 16px; }
.e6b .tbtn.flip { display: none; }
.e6b .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--e6b-dim); cursor: pointer; }
.e6b .switch input { width: 32px; height: 20px; appearance: none; -webkit-appearance: none; border-radius: 999px; background: var(--md-outline-variant, #c3c6cf); position: relative; margin: 0; cursor: pointer; transition: background 140ms; }
.e6b .switch input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 140ms; }
.e6b .switch input:checked { background: var(--e6b-primary); }
.e6b .switch input:checked::after { transform: translateX(12px); }
.e6b .timer { font-size: 13px; color: var(--e6b-dim); min-width: 4.2em; }
.e6b .timer.exam { color: var(--e6b-text); font-weight: 600; }
.e6b .menu { position: absolute; bottom: calc(100% + 8px); left: 8px; z-index: 6; width: min(360px, calc(100vw - 32px)); max-height: min(70vh, 640px); overflow: auto; padding: 6px; border-radius: 14px; background: var(--e6b-surface); border: 1px solid var(--e6b-line); box-shadow: var(--e6b-pop); }
.e6b .menu .mh { margin: 8px 10px 4px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--e6b-dim); }
.e6b .menu button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; text-align: left; font-size: 14px; }
.e6b .menu button:hover { background: var(--e6b-chip); }
.e6b .menu button[aria-current="true"] { background: var(--e6b-primary-c); color: var(--e6b-on-primary-c); }
.e6b .menu .l { flex: 1; }
.e6b .menu .d { font-size: 12px; color: var(--e6b-dim); }

/* Task card */
.e6b-task { position: relative; z-index: 2; display: grid; gap: 10px; padding: 14px 16px 16px; border-radius: 16px; background: var(--e6b-surface); border: 1px solid var(--e6b-line); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); min-width: 0; }
.e6b-task[hidden] { display: none; }
.e6b-task .kicker { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--e6b-dim); }
.e6b-task .dots { display: inline-flex; gap: 4px; }
.e6b-task .kicker .src { font-weight: 400; opacity: 0.7; cursor: help; }
.e6b-task .dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--e6b-chip); }
.e6b-task .dots i.now { background: var(--e6b-primary); }
.e6b-task .dots i.done, .e6b-task .dots i.ok { background: var(--e6b-good); }
.e6b-task .dots i.miss { background: var(--e6b-bad); }
.e6b-task .stem { margin: 0; font-size: 15px; line-height: 1.45; }
.e6b-task .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.e6b-task .chip { display: inline-flex; align-items: baseline; gap: 4px; height: 28px; align-items: center; padding: 0 10px; border-radius: 8px; background: var(--e6b-chip); font-size: 13px; font-weight: 600; cursor: default; }
.e6b-task .chip .k { font-weight: 400; color: var(--e6b-dim); }
.e6b-task .chip:not(.plain):hover, .e6b-task .chip:not(.plain):focus { background: var(--e6b-primary-c); color: var(--e6b-on-primary-c); }
.e6b-task .chip:not(.plain):hover .k { color: inherit; }
.e6b-task .navlog { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; border: 1px solid var(--e6b-line); border-radius: 10px; }
.e6b-task .navlog .cell { display: grid; gap: 1px; padding: 5px 8px; text-align: right; }
.e6b-task .navlog .cell + .cell { border-left: 1px solid var(--e6b-line); }
.e6b-task .navlog .k { font-size: 11px; color: var(--e6b-dim); }
.e6b-task .navlog b { font-size: 15px; font-weight: 600; }
.e6b-task .navlog .empty b { color: var(--e6b-dim); font-weight: 400; }
.e6b-task .navlog .given b { color: var(--e6b-dim); font-style: italic; }
.e6b-task .entry { display: grid; gap: 8px; }
.e6b-task .erow { display: flex; align-items: flex-end; gap: 8px; }
.e6b-task .field { display: grid; gap: 3px; flex: 1 1 auto; min-width: 0; position: relative; }
.e6b-task .field > span:first-child { font-size: 11px; color: var(--e6b-dim); letter-spacing: 0.04em; }
.e6b-task .field input { height: 40px; min-width: 0; border-radius: 10px; border: 1px solid var(--md-outline-variant, #c3c6cf); background: var(--e6b-surface); color: var(--e6b-text); padding: 0 64px 0 10px; font-size: 16px; font-variant-numeric: tabular-nums; }
.e6b-task .field input:disabled { opacity: 0.55; }
.e6b-task .field.locked input { background: var(--e6b-surface-2); border-color: transparent; }
.e6b-task .field .unit { position: absolute; right: 10px; bottom: 11px; font-size: 12px; color: var(--e6b-dim); pointer-events: none; }
.e6b-task .go { height: 40px; padding: 0 16px; border-radius: 10px; border: 0; background: var(--e6b-primary); color: var(--e6b-on-primary); font-size: 14px; font-weight: 600; }
.e6b-task .ghostbtn { height: 40px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--e6b-line); background: transparent; font-size: 14px; }
.e6b-task .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.e6b-task .verdict { display: flex; gap: 10px; padding: 10px 12px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
.e6b-task .verdict .mark { font-weight: 700; font-size: 16px; }
.e6b-task .verdict p { margin: 0; }
.e6b-task .verdict p + p { margin-top: 4px; }
.e6b-task .verdict .diag { font-weight: 600; }
.e6b-task .verdict .sub { font-size: 13px; opacity: 0.9; }
.e6b-task .verdict.good { background: var(--e6b-good-c); color: var(--e6b-on-good-c); }
.e6b-task .verdict.bad { background: var(--e6b-bad-c); color: var(--e6b-on-bad-c); }
.e6b-task .decision { display: grid; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--e6b-line); }
.e6b-task .decision p { margin: 0; font-size: 14px; line-height: 1.4; }
.e6b-task .decision .yn { display: flex; gap: 8px; }
.e6b-task .decision .yn button { height: 36px; min-width: 72px; border-radius: 10px; border: 1px solid var(--e6b-line); background: var(--e6b-surface); font-weight: 600; }
.e6b-task .decision .yn button[aria-pressed="true"] { background: var(--e6b-primary-c); color: var(--e6b-on-primary-c); border-color: transparent; }
.e6b-task .decision .good { color: var(--e6b-good); }
.e6b-task .decision .bad { color: var(--e6b-bad); }

/* Coach bubble, hung beside the marks it talks about. */
.e6b-coach { position: absolute; inset: 0; pointer-events: none; z-index: 4; }
.e6b-coach[hidden] { display: none; }
.e6b-coach .bubble { position: absolute; left: 0; top: 0; width: max-content; max-width: 280px; pointer-events: auto; padding: 10px 12px 12px; border-radius: 14px; background: var(--e6b-surface); color: var(--e6b-text); border: 1px solid var(--e6b-line); box-shadow: var(--e6b-pop); transition: transform 180ms cubic-bezier(0.2, 0, 0, 1); border-left: 4px solid var(--e6b-hl); }
.e6b.dragging .e6b-coach .bubble { transition: none; }
.e6b-coach .bubble.ok { border-left-color: var(--e6b-good); }
.e6b-coach .bubble.watch, .e6b-coach .bubble.auto { border-left-color: var(--e6b-primary); }
.e6b-coach .bubble.ghost { border-left-color: var(--e6b-good); }
.e6b-coach .act { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; font-size: 13px; font-weight: 700; }
.e6b-coach .act .n { margin-left: auto; padding-left: 12px; font-weight: 500; color: var(--e6b-dim); font-size: 12px; }
.e6b-coach .act .tick { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--e6b-good); color: #fff; font-size: 11px; }
.e6b-coach .say { margin: 0; font-size: 14px; line-height: 1.4; }
.e6b-coach .go { margin-top: 10px; height: 34px; padding: 0 14px; border-radius: 10px; border: 0; background: var(--e6b-primary); color: var(--e6b-on-primary); font-size: 13px; font-weight: 600; }
.e6b-coach .bubble.ok .go { background: var(--e6b-good); color: #fff; }

/* How it works */
.e6b-overlay { position: absolute; inset: 0; z-index: 8; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--e6b-surface-2) 55%, transparent); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.e6b-overlay[hidden] { display: none; }
.e6b .how { box-sizing:border-box; position: relative; width: min(860px, 100%); max-height: 100%; overflow: auto; padding: 22px 26px; border-radius: 18px; background: var(--e6b-surface); border: 1px solid var(--e6b-line); box-shadow: var(--e6b-pop); }
.e6b .how h2 { margin: 0 0 8px; padding-right: 44px; font-size: 18px; }
.e6b .how p { margin: 0 0 10px; font-size: 14px; line-height: 1.5; color: var(--e6b-dim); max-width: 70ch; }
.e6b .how .close { position: absolute; right: 12px; top: 12px; width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--e6b-chip); }
.e6b .how svg { width: 100%; height: auto; display: block; margin: 6px 0 12px; touch-action: none; cursor: ew-resize; }
.e6b .how .rail { stroke: var(--e6b-ink); stroke-width: 2; }
.e6b .how .rail.blue { stroke: var(--e6b-blue); }
.e6b .how path.ink { stroke: var(--e6b-ink); stroke-width: 2; }
.e6b .how path.blue { stroke: var(--e6b-blue); stroke-width: 2; }
.e6b .how text { font-size: 15px; font-weight: 600; text-anchor: middle; dominant-baseline: central; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; }
.e6b .how text.ink { fill: var(--e6b-ink); }
.e6b .how text.blue { fill: var(--e6b-blue); }
.e6b .how .probe { stroke: var(--e6b-cursor); stroke-width: 2.5; }
.e6b .how .pr { fill: var(--e6b-cursor); font-size: 17px; }
.e6b .how .br { fill: none; stroke-width: 2; }
.e6b .how .br.blue { stroke: var(--e6b-blue); }
.e6b .how .brl { font-size: 13px; }
.e6b .how .brl.blue { fill: var(--e6b-blue); }

.e6b .how h3 { margin: 14px 0 6px; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--e6b-dim); }
.e6b .how .inputs { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: 13px; }
.e6b .how .inputs dt { font-weight: 600; }
.e6b .how .inputs dd { margin: 0; color: var(--e6b-dim); }
.e6b-hint { position: absolute; left: 50%; bottom: 12px; z-index: 3; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 8px 14px; border-radius: 999px; background: color-mix(in srgb, var(--e6b-text) 86%, transparent); color: var(--e6b-surface); font-size: 13px; pointer-events: none; animation: e6bFade 400ms ease-out; white-space: normal;  }
.e6b-hint[hidden] { display: none; }
@keyframes e6bFade { from { opacity: 0; transform: translate(-50%, 6px); } }

/* Card variant (beside a question in the trainer) */
.e6b.card .strip { min-height: 44px; }

/* Phone: task card on top, the instrument full width, the strip at the bottom. */
@media (max-width: 760px) { .e6b-loupe { width: 96px; height: 96px; } }
@container e6b (max-width: 760px) {
  .e6b-stage { gap: 8px; }
  .e6b-task { padding: 10px 12px 12px; gap: 8px; border-radius: 14px; max-height: 40cqh; overflow: auto; overscroll-behavior: contain; }
  .e6b-task .field > span:first-child { display: none; }
  .e6b-task .field input { height: 38px; }
  .e6b-task .navlog .cell { padding: 3px 8px; }
  .e6b-task .stem { font-size: 14px; }
  .e6b .strip { display: grid; grid-template-columns: auto 1fr; grid-template-areas: "ro ro" "modes end" "ctx ctx"; gap: 6px; padding: 6px; }
  .e6b .strip.card { grid-template-areas: "ro end"; }
  .e6b .strip .modes { grid-area: modes; }
  .e6b .strip .ctx { grid-area: ctx; justify-content: space-between; }
  .e6b .strip .grp.end { grid-area: end; margin-left: 0; justify-content: flex-end; gap: 2px; }
  .e6b .strip .end .seg { display: none; }
  .e6b .strip .end .flip { display: inline-flex; }
  .e6b .strip .end .flip span { display: inline; }
  .e6b .readout { grid-area: ro; justify-content: space-between; gap: 8px; font-size: 13px; padding: 2px 6px 0; }
  .e6b .readout .ro .k { font-size: 11px; }
  .e6b .seg button { padding: 0 10px; height: 32px; }
  .e6b .tbtn { padding: 0 8px; height: 36px; min-width: 36px; justify-content: center; }
  .e6b .tbtn span { display: none; }
  .e6b .stages .pip { padding: 0 7px; }
  .e6b .picker { max-width: none; flex: 1 1 140px; min-width: 120px; }
  .e6b .strip .ctx { flex-wrap: wrap; row-gap: 6px; }
  .e6b .how { padding: 16px; }
  .e6b .how .scroller { overflow-x: auto; margin: 0 -16px; padding: 0 16px; }
  .e6b .how .scroller svg { width: 720px; max-width: none; }
  .e6b .how .inputs { grid-template-columns: 1fr; gap: 0; }
  .e6b .how .inputs dd { margin-bottom: 6px; }
  .e6b-hint { white-space: normal; border-radius: 14px; text-align: center; }
  .e6b-coach .bubble { max-width: 220px; padding: 8px 10px 10px; }
  .e6b-coach .say { font-size: 13px; }
}
/* Physical print stays black/blue on white, including on the dark desk. */
.e6b-art, .e6b-wind, .e6b-loupe {
  --e6b-face:#f9fafb; --e6b-face-edge:#b9c0c8; --e6b-disc:#fff;
  --e6b-window:#e9edf1; --e6b-ink:#10151c; --e6b-blue:#164d9d;
  --e6b-wind-grid:#21569c; --e6b-wind-grid-bg:#f4f7fb; --e6b-band:#10151b;
  --e6b-band-ink:#fff; --e6b-pencil:#182332; --e6b-plate:rgba(215,231,244,.16); --e6b-plate-solid:#f8fafc;
}
.e6b-art .tag { --e6b-surface:#fff; }
.e6b-art .disc-halo { stroke-width:5; opacity:.28; }
.e6b-art .window-edge { stroke:#8090a0; opacity:.55; }
.e6b-art .hub { stroke:#6c7278; stroke-width:3; }
.e6b-art .hub-dot { fill:#5a626b; opacity:1; stroke:#e9edf2; stroke-width:3; }
.e6b-art .hub-ring { fill:none; stroke:#fafcff; stroke-width:3; opacity:.85; }
.e6b .strip { flex-wrap:wrap; }
.e6b .picker { max-width:none; height:auto; min-height:36px; white-space:normal; }
.e6b .strip .grp { min-width:0; }
.e6b .strip .end { flex-wrap:wrap; }
.e6b .strip .auto-turn span, .e6b .strip [data-e6b="upright"] span { display:inline !important; }
.e6b .strip .auto-turn { border:1px solid var(--e6b-line); }
.e6b-task { max-height:100%; overflow:auto; overscroll-behavior:contain; box-sizing:border-box; }
.e6b .procedure-entry { display:flex; gap:8px; align-items:end; }
.e6b-coach .why { border:0;background:none;color:var(--e6b-primary);min-height:32px;margin:6px 0 0 8px;font-size:13px;text-decoration:underline; }
.e6b-coach .why-text { margin-top:8px; }
.e6b .procedure-feedback { margin:0; font-size:13px; line-height:1.4; }
/* Guided procedure: question and stepper on one row, the step under it, then the entry. */
.e6b-task .qrow { display:flex; align-items:flex-start; gap:8px; }
.e6b-task .qrow .stem { flex:1 1 auto; min-width:0; margin:0; }
.e6b-task .stepper { flex:0 0 auto; display:flex; align-items:center; gap:2px; margin:-4px -6px 0 0; }
.e6b-task .stepper .sn { min-width:30px; text-align:center; font-size:13px; color:var(--e6b-dim); font-variant-numeric:tabular-nums; }
.e6b-task .stepper .sbtn { width:36px; height:36px; padding:0; border-radius:50%; border:1px solid var(--e6b-line); background:var(--e6b-surface); color:var(--e6b-text); font-size:20px; line-height:1; cursor:pointer; }
.e6b-task .stepper .sbtn:disabled { opacity:.35; cursor:default; }
.e6b-task .stepper .sbtn.go { background:var(--e6b-primary); color:var(--e6b-on-primary); border-color:transparent; margin:0; }
.e6b-task .step { margin:0; font-size:14px; font-weight:600; line-height:1.35; color:var(--e6b-text); }
.e6b-task .step.ok { color:var(--e6b-good); }
.e6b-task .step .tick { margin-right:4px; }
.e6b .tour-skip { position:absolute; right:12px; top:12px; pointer-events:auto; min-height:40px; padding:0 14px; border:1px solid var(--e6b-line); border-radius:10px; background:var(--e6b-surface); }
.e6b-dial.slide-flip .wind-slide { opacity:.2; transition:opacity 120ms; }
.e6b-dial.slide-flip .wind-slide-turn { transform:rotateX(90deg); transform-origin:center; transition:transform 250ms ease; }
.e6b-launch { display:grid; gap:16px; }
.e6b-launch h1 { font-size:28px; letter-spacing:.04em; margin:0; }
.e6b-launch h2 { font-size:13px; font-weight:600; color:var(--e6b-dim); margin:0; }
.e6b-launch button { text-align:left; min-height:44px; border:1px solid var(--e6b-line); background:var(--e6b-surface); border-radius:9px; padding:9px 11px; }
.e6b-launch .e6b-continue { display:grid; grid-template-columns:1fr auto; background:var(--e6b-primary); color:var(--e6b-on-primary); gap:3px; }
.e6b-continue b { grid-column:2;grid-row:1 / 3; align-self:center; }
.e6b-continue span { font-size:13px; }
.e6b-launch-actions, .e6b-missions { display:grid; gap:8px; }
.e6b-launch .e6b-daily { display:grid; gap:2px; }
.e6b-daily span { font-size:12px; color:var(--e6b-dim); }
.e6b-mission strong { font-size:13px; font-weight:500; }
.e6b-section-head { display:flex; align-items:center;justify-content:space-between; margin-bottom:6px; }
.e6b-section-head span { font-size:12px; color:var(--e6b-dim); }
.e6b-curriculum ul { list-style:none;padding:0;margin:0; }
.e6b-skill { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:7px 0;border-top:1px solid var(--e6b-line); }
.e6b-skill-head { display:grid;gap:2px;font-size:13px; }
.e6b-state { font-size:11px;color:var(--e6b-dim); }
.e6b-state-fluent { color:var(--e6b-good); }
.e6b-exercises { display:flex;gap:4px; }
.e6b-launch .e6b-exercise { min-height:36px;min-width:32px;text-align:center;padding:5px; }
.e6b.home .e6b-task { max-width:380px; }
.e6b.home .ctx, .e6b.touring .ctx { display:none; }
.e6b.home .e6b-readpanel, .e6b.touring .e6b-readpanel { display:none; }
.e6b-component-table { width:100%;height:100%;min-width:0;background:#fff;border-radius:12px; }
.e6b-component-table text { font-family:-apple-system,Arial,sans-serif;fill:#15212e;text-anchor:start; }
.e6b-component-table .table-title { font-size:46px;font-weight:700; }
.e6b-component-table .table-note { font-size:32px; }
.e6b-component-table .table-axis { font-size:36px;font-weight:600; }
.e6b-component-table .table-cell rect { fill:#f7f9fc;stroke:#c8d0d9;stroke-width:.5; }
.e6b-component-table .table-cell text { font-size:36px; }
.e6b-component-table .table-cell-active-head .table-head,.e6b-component-table .table-cell-active-cross .table-cross { fill:#1d4e9e;font-weight:700; }
.e6b-component-table .table-cell-active rect { fill:#fff1d0;stroke:#ae6729;stroke-width:1.5; }
.e6b.components .e6b-shadow,.e6b.components .e6b-loupe,.e6b.components .e6b-view-knob { display:none !important; }
/* Height-aware landscape layout: task, instrument, one current coach action.
 * Reading panels scroll deliberately; the working instrument never does. */
@container e6b (min-width:700px) and (max-height:560px) {
  .e6b-stage { grid-template-columns:minmax(190px,1fr) minmax(240px,1.2fr) minmax(190px,1fr);grid-template-rows:minmax(0,1fr);gap:10px; }
  .e6b-task { grid-column:1;grid-row:1;max-height:100%;max-width:none;margin:0;padding:10px; }
  .e6b-dial { grid-column:2;grid-row:1; }
  .e6b-coach { position:relative;inset:auto;grid-column:3;grid-row:1;min-height:0;overflow:auto;align-self:center;max-height:100%; }
  .e6b-coach .bubble { position:relative;transform:none !important;box-sizing:border-box;max-width:100%;width:100%; }
  .e6b-readpanel { display:none !important; }
  .strip .readout { visibility:visible; }
  .e6b-loupe { width:86px;height:86px; }
  .e6b .strip { gap:4px;padding:4px; }
  .e6b .strip .readout { order:4;flex-basis:100%;font-size:12px; }
  .e6b .strip .end .seg { display:none; }
  .e6b .strip .end .flip { display:inline-flex; }
  .e6b .strip .end { margin-left:auto; }
  .e6b .tbtn { padding:0 6px; }
  .e6b .strip .ctx { flex-wrap:wrap; }
  .e6b .strip .ctx .picker { max-width:160px; }
  .e6b .tour-skip { position:relative;right:auto;top:auto;margin-top:8px; }
}
@container e6b (max-width:699px) {
  .e6b-stage { grid-template-rows:auto minmax(220px,1fr) auto; }
  .e6b-task { max-height:28cqh;grid-row:1;max-width:none !important; }
  .e6b-dial { grid-row:2; }
  .e6b-coach { position:relative;inset:auto;grid-row:3;max-height:25cqh;overflow:auto; }
  .e6b-coach .bubble { position:relative;transform:none !important;box-sizing:border-box;max-width:none;width:100%;box-shadow:0 2px 6px #0001; }
  .e6b .strip { grid-template-columns:1fr;grid-template-areas:"modes" "ctx" "end" "ro";gap:3px; }
  .e6b .strip .modes { justify-content:center; }
  .e6b .strip .grp.end { justify-content:center;flex-wrap:wrap; }
  .e6b .strip .ctx { justify-content:center; }
  .e6b .strip .ctx .picker { flex:1 1 100px; }
  .e6b .strip .end .flip span { display:none; }
  .e6b .strip .readout { font-size:12px;flex-wrap:wrap;justify-content:center; }
  .e6b .tour-skip { position:relative;right:auto;top:auto;margin-top:8px; }
  .e6b .how { box-sizing:border-box; }
}
/* Menu: everything that is not the current step. Labelled rows, 44 pt. */
.e6b .more-panel { position:absolute; right:0; bottom:calc(100% + 6px); z-index:7; box-sizing:border-box; width:min(300px,100%); overflow:auto; display:grid; gap:2px; padding:6px; border-radius:14px; background:var(--e6b-surface); border:1px solid var(--e6b-line); box-shadow:var(--e6b-pop); }
.e6b .mrow { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:0 10px; border:0; border-radius:8px; background:transparent; color:var(--e6b-text); text-align:left; font-size:14px; }
.e6b .mrow:hover, .e6b .mrow:active { background:var(--e6b-chip); }
.e6b .mrow .g { width:1.3em; text-align:center; color:var(--e6b-dim); }
.e6b .mrow .l { flex:1 1 auto; }
.e6b .mrow .state { font-size:13px; color:var(--e6b-dim); text-align:right; }
.e6b .mrow .state.on { color:var(--e6b-primary); font-weight:600; }
.e6b .mrow.switch { cursor:pointer; }
.e6b .mseg { padding:2px; }
.e6b .mseg .seg { display:flex; }
.e6b .mseg .seg button { flex:1 1 0; height:40px; }
.e6b .menu-button { border:1px solid var(--e6b-line); color:var(--e6b-text); }
.e6b .menu-button[aria-expanded="true"] { background:var(--e6b-primary-c); color:var(--e6b-on-primary-c); border-color:transparent; }
.e6b .menu-button .caret { font-size:10px; color:var(--e6b-dim); }
.e6b .procedure-entry .field > span:first-child { display:none; }
/* Coach buttons: Next (and Skip tour) inside the bubble, never a loose card. */
.e6b-coach .btns { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.e6b-coach .btns .go { margin-top:0; }
.e6b-coach .btns .tour-skip { position:static; min-height:34px; padding:0 12px; font-size:13px; }
.e6b-coach .act .h { min-width:0; }
.e6b-coach .transport { margin-left:8px; }
/* Phone portrait: one task line / the instrument at full width / one coach line /
 * the readings / one control row. Every control is a labelled 44 pt target;
 * secondary controls fold into More. No inner scroll box clips a line. */
@container e6b (max-width:699px) or ((max-height:440px) and (max-width:999px)) {
  .e6b.lab { gap:4px; }
  .e6b-stage { gap:4px; grid-template-rows:auto minmax(0,1fr) auto; }
  .e6b-task { padding:4px 10px 6px; gap:4px; border-radius:12px; max-height:none; overflow:visible; }
  .e6b.home .e6b-task { max-height:none; padding:0; border:0; background:none; box-shadow:none; }
  .e6b-task .kicker { display:none; }
  .e6b-task .kicker .src { display:none; }
  .e6b-task .stem { font-size:14px; line-height:1.35; }
  .e6b-task .field input { height:44px; font-size:16px; padding-right:10px; }
  .e6b-task .field .unit { display:none; }
  .e6b-task .go, .e6b-task .ghostbtn { height:44px; }
  .e6b-task .chip { height:30px; }
  .e6b-task .stem { white-space:normal; }
  .e6b-task .erow:has(input:disabled), .e6b-task .erow:has(.field.locked) { display:none; }
  .e6b-task .field > span:first-child { display:none; }
  .e6b-task .stepper .sbtn { width:44px; height:44px; }
  .e6b-task .qrow { align-items:center; }
  .e6b-task .stepper { margin:-4px -6px -4px 0; }
  .e6b-task .step { font-size:14px; }
  .e6b .procedure-entry { align-items:center; }
  .e6b .procedure-entry .field { flex:1 1 auto; }
  .e6b .procedure-entry .field > span:first-child { display:none; }
  .e6b-next { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:0 14px; border:0; border-radius:12px; background:var(--e6b-primary); color:var(--e6b-on-primary); font-size:15px; font-weight:600; text-align:left; }
  .e6b-next .g { font-size:12px; }
  .e6b-next .n { margin-left:auto; font-weight:500; opacity:.85; font-variant-numeric:tabular-nums; }
  .e6b-hint { display:none !important; }
  .e6b-view-knob { left:0; bottom:0; width:44px; height:44px; }
  .e6b-view-knob span { display:none; }
  .e6b-centre { right:0; bottom:0; width:44px; height:44px; }
  .e6b-coach { max-height:none; overflow:visible; }
  .e6b-coach .bubble { display:flex; align-items:center; gap:8px; min-height:44px; box-sizing:border-box; padding:2px 2px 2px 10px; border-radius:12px; }
  .e6b-coach .txt { flex:1 1 auto; min-width:0; }
  .e6b-coach .say { margin:0; font-size:14px; line-height:1.3; display:flex; align-items:center; gap:4px; min-height:44px; }
  .e6b-coach .say .n { color:var(--e6b-dim); font-size:12px; font-variant-numeric:tabular-nums; margin-right:2px; }
  .e6b-coach .say .tick { display:inline-grid; place-items:center; width:16px; height:16px; border-radius:50%; background:var(--e6b-good); color:#fff; font-size:10px; margin-right:4px; vertical-align:1px; }
  .e6b-coach .say .line { display:block; min-height:44px; flex:1 1 auto; padding:0; border:0; background:none; font:inherit; color:inherit; text-align:left; text-decoration:underline dotted color-mix(in srgb, var(--e6b-dim) 60%, transparent); text-underline-offset:3px; }
  .e6b-coach .btns { flex:none; display:flex; flex-direction:row; flex-wrap:nowrap; gap:4px; margin:0; }
  .e6b-coach .btns .go, .e6b-coach .btns .tour-skip { margin:0; min-height:44px; height:44px; padding:0 12px; }
  .e6b-coach .transport { display:inline-flex; gap:4px; margin:0; }
  .e6b-coach .transport button { width:44px; height:44px; border-radius:10px; border:1px solid var(--e6b-line); background:var(--e6b-surface); font-size:14px; }
  .e6b-coach .transport button.play { background:var(--e6b-primary); color:var(--e6b-on-primary); border-color:transparent; }
  .e6b .strip.dock { display:flex; flex-wrap:nowrap; align-items:center; gap:6px; min-height:44px; padding:0; border:0; border-radius:0; background:none; }
  .e6b .dock .readout { order:0; flex:1 1 auto; min-width:0; grid-area:auto; visibility:visible; display:flex; justify-content:space-around; align-items:baseline; column-gap:8px; padding:0 2px; font-size:12px; flex-wrap:wrap; }
  .e6b .dock .readout:empty { display:none; }
  .e6b .dock .readout .ro { display:inline-flex; align-items:baseline; gap:4px; white-space:nowrap; }
  .e6b .dock .readout .ro .k { font-size:11px; }
  .e6b .dock .readout .ro b { font-size:16px; font-variant-numeric:tabular-nums; }
  .e6b .dock .paren, .e6b .dock .long { display:none; }
  .e6b .dock-row { display:flex; align-items:center; gap:6px; min-width:0; }
  .e6b .dock-row .seg { flex:1 1 auto; display:flex; padding:3px; }
  .e6b .dock-row .seg button { flex:1 1 0; height:38px; padding:0 8px; font-size:14px; white-space:nowrap; }
  .e6b .dbtn { flex:none; display:inline-flex; align-items:center; justify-content:center; gap:6px; min-width:44px; height:44px; padding:0 12px; border-radius:10px; border:1px solid var(--e6b-line); background:var(--e6b-surface); color:var(--e6b-text); font-size:14px; font-weight:500; white-space:nowrap; }
  .e6b .dbtn .caret { font-size:10px; color:var(--e6b-dim); }
  .e6b .dbtn[aria-expanded="true"] { background:var(--e6b-primary-c); color:var(--e6b-on-primary-c); border-color:transparent; }
  .e6b .stage-seg button[aria-current="true"] { background:var(--e6b-surface); color:var(--e6b-text); font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,0.12); }
  .e6b .stage-seg button.done { color:var(--e6b-good); }
  .e6b .stage-seg .tick { margin-right:3px; }
  .e6b .more-panel { position:absolute; right:0; bottom:calc(100% + 6px); z-index:7; box-sizing:border-box; width:min(300px,100%); max-height:calc(100cqh - 120px); overflow:auto; display:grid; gap:2px; padding:6px; border-radius:14px; background:var(--e6b-surface); border:1px solid var(--e6b-line); box-shadow:var(--e6b-pop); }
  .e6b .mrow { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:0 10px; border:0; border-radius:8px; background:transparent; color:var(--e6b-text); text-align:left; font-size:15px; }
  .e6b .mrow:active { background:var(--e6b-chip); }
  .e6b .mrow .g { width:1.3em; text-align:center; color:var(--e6b-dim); }
  .e6b .mrow .l { flex:1 1 auto; }
  .e6b .mrow .state { font-size:13px; color:var(--e6b-dim); text-align:right; }
  .e6b .mrow .state.on { color:var(--e6b-primary); font-weight:600; }
  .e6b .mrow.switch { cursor:pointer; }
  .e6b .mseg { padding:2px; }
  .e6b .mseg .seg { display:flex; }
  .e6b .mseg .seg button { flex:1 1 0; height:40px; }
  .e6b .e6b-strip > .menu { left:0; width:100%; box-sizing:border-box; bottom:calc(100% + 6px); max-height:calc(100cqh - 120px); }
  .e6b .e6b-strip > .menu button { min-height:44px; }
  .e6b .how { max-height:100%; }
}
/* Phone on its side: the instrument at full height on the left; problem, entry,
 * coach line and the readings stacked on the right. */
@container e6b (max-height:440px) and (min-width:560px) and (max-width:999px) {
  .e6b.lab { position:relative; grid-template-columns:auto minmax(0,1fr); grid-template-rows:auto auto minmax(0,1fr) auto; column-gap:10px; row-gap:6px; }
  .e6b-stage { display:contents; }
  .e6b-dial { grid-column:1; grid-row:1 / span 4; height:100cqh; width:100cqh; max-width:60cqw; }
  .e6b-task { grid-column:2; grid-row:1; max-width:none !important; margin:0; align-self:start; }
  .e6b-coach { grid-column:2; grid-row:2; position:relative; inset:auto; align-self:start; }
  .e6b-coach .bubble { position:relative; transform:none !important; width:100%; max-width:none; }
  .e6b-strip { grid-column:2; grid-row:4; align-self:end; }
  .e6b-readpanel { display:none !important; }
  .e6b-overlay { grid-column:1 / -1; grid-row:1 / -1; }
}

/* --- Teaching flow: one problem card, one obvious next action ------------------ */
.e6b.flowing .e6b-coach { display:none !important; }
.e6b-task .flow { display:grid; gap:8px; }
.e6b-task .fhead { display:flex; align-items:baseline; gap:8px; min-width:0; }
.e6b-task .fbeats { display:inline-flex; gap:2px; font-size:15px; line-height:1; color:var(--e6b-dim); opacity:.55; }
.e6b-task .fbeats i { font-style:normal; }
.e6b-task .fbeats i.past { color:var(--e6b-good); opacity:1; }
.e6b-task .fbeats i.on { color:var(--e6b-primary); opacity:1; font-weight:700; }
.e6b-task .fbeats:has(i.on) { opacity:1; }
.e6b-task .fq { flex:1 1 auto; min-width:0; font-size:14px; color:var(--e6b-dim); }
.e6b-task .fn { font-size:12px; color:var(--e6b-dim); font-variant-numeric:tabular-nums; }
.e6b-task .fline { margin:0; font-size:16px; font-weight:650; line-height:1.3; color:var(--e6b-text); }
.e6b-task .fline.ok { color:var(--e6b-good); }
.e6b-task .fline .tick { margin-right:6px; }
.e6b-task .fwhy, .e6b-task .fnote { margin:0; font-size:13.5px; line-height:1.35; color:var(--e6b-dim); }
.e6b-task .fnote { color:var(--e6b-text); font-variant-numeric:tabular-nums; }
.e6b-task .fwhy::before { content:"why · "; font-weight:600; }
.e6b-task .fbad { margin:0; font-size:13.5px; line-height:1.35; color:var(--e6b-bad); }
.e6b-task .fentry { display:flex; gap:8px; }
.e6b-task .fentry input { flex:1 1 auto; min-width:0; height:40px; padding:0 10px; border-radius:10px; border:1px solid var(--e6b-line); background:var(--e6b-surface); color:var(--e6b-text); font-size:16px; }
.e6b-task .facts { display:flex; gap:8px; justify-content:flex-end; align-items:center; }
.e6b-task .fbtn { height:38px; padding:0 14px; margin:0; border-radius:10px; font-size:14px; font-weight:600; }
.e6b-task .fbtn.ghostbtn { border:1px solid var(--e6b-line); background:var(--e6b-surface); color:var(--e6b-text); }
.e6b-task [data-next="true"] { box-shadow:0 0 0 3px color-mix(in srgb, var(--e6b-primary) 35%, transparent); }
/* The part to move glows and pulses; where it goes is a dashed ring. */
.e6b-art .flow-src .halo, .e6b-wind .flow-src .halo { fill:color-mix(in srgb, var(--e6b-hl) 38%, transparent); stroke:none; animation:e6bGlow 1.3s ease-in-out infinite; transform-box:fill-box; transform-origin:center; }
.e6b-art .flow-src .core, .e6b-wind .flow-src .core { fill:none; stroke:var(--e6b-hl); stroke-width:14; }
.e6b-art .flow-dst circle, .e6b-wind .flow-dst circle { fill:none; stroke:var(--e6b-hl); stroke-width:7; stroke-dasharray:18 14; opacity:.85; }
.e6b-art .flow-read circle, .e6b-wind .flow-read circle { fill:color-mix(in srgb, var(--e6b-good) 16%, transparent); stroke:var(--e6b-good); stroke-width:8; animation:e6bPulse 1.6s ease-in-out infinite; }
@keyframes e6bGlow { 0%,100% { opacity:.35; transform:scale(.85); } 50% { opacity:1; transform:scale(1.15); } }
.flow-base, .flow-disc, .flow-cur, .flow-plate, .flow-wind { pointer-events:none; }
.e6b .flow-pointer { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:5; overflow:visible; display:none; }
.e6b .flow-pointer .fp { fill:none; stroke:var(--e6b-hl); stroke-width:2; stroke-dasharray:6 5; opacity:.9; }
.e6b .flow-pointer marker path { fill:var(--e6b-hl); }
.e6b .flow-hand { position:absolute; left:-20px; top:-20px; width:40px; height:40px; border-radius:50%; z-index:6; pointer-events:none; display:none;
  background:radial-gradient(circle, color-mix(in srgb, var(--e6b-text) 55%, transparent) 0 9px, color-mix(in srgb, var(--e6b-text) 18%, transparent) 10px 19px, transparent 20px);
  will-change:transform, opacity; }
/* Wind side: the pencil. */
.e6b-pencil { position:absolute; right:4px; top:4px; z-index:3; display:none; flex-direction:column; gap:6px; }
.e6b[data-showing="wind"] .e6b-pencil { display:flex; }
.e6b-pencil button { width:44px; height:44px; padding:0; border-radius:50%; border:1px solid var(--e6b-line); background:var(--e6b-surface); color:var(--e6b-text); font-size:20px; line-height:1; box-shadow:0 2px 5px #0001; }
.e6b-pencil button[aria-pressed="true"] { background:var(--e6b-primary-c); color:var(--e6b-on-primary-c); border-color:transparent; }
@container e6b (max-width:699px) {
  .e6b.flowing .e6b-task { grid-row:3; }
  .e6b.flowing .e6b-dial { grid-row:2; }
  .e6b-task .flow { gap:6px; }
  .e6b-task .fline { font-size:15px; }
  .e6b-task .fentry input, .e6b-task .fbtn { height:44px; }
  .e6b-task .fhead .fq { white-space:normal; }
}
@media (prefers-reduced-motion: reduce) { .e6b-art .flow-src .halo, .e6b-wind .flow-src .halo, .e6b-art .flow-read circle, .e6b-wind .flow-read circle { animation:none; opacity:.8; } }
@media (prefers-reduced-motion: reduce) {
  .e6b-art .hl, .e6b-wind .hl-ring, .e6b-wind .dot-target, .e6b-wind .slide-cue path { animation: none; }
  .e6b-art .turn-arc, .e6b-wind .turn-arc { animation: none; }
  .e6b-coach .bubble { transition: none; }
}
`;

let injected = false;
export function injectE6BStyles(doc: Document = document): void {
  if (injected || doc.getElementById('e6b-styles')) { injected = true; return; }
  const style = doc.createElement('style');
  style.id = 'e6b-styles';
  style.textContent = E6B_CSS;
  doc.head.appendChild(style);
  injected = true;
}
