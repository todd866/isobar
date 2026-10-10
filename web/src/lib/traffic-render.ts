/** Variant D canvas renderer. Geometry and palettes are shared with the type table. */
import type { TrafficGlyph } from './traffic';
import { TRAFFIC_SHAPES, TRAFFIC_PALETTES, trafficAltitudeShade, type TrafficSymbolClass } from './traffic-symbols';

// Twelve paths × two zoom tiers. Construct once, never once per contact/frame.
const paths = new Map<string, Path2D>();
function silhouette(type: TrafficSymbolClass, size: number): Path2D {
  const key = `${type}:${size}`;
  let path = paths.get(key);
  if (!path) {
    path = new Path2D();
    if (type === 'unknown') path.arc(0, 0, 2.5, 0, Math.PI * 2);
    else {
      TRAFFIC_SHAPES[type].forEach(([x, y], i) => i ? path!.lineTo(x * size, y * size) : path!.moveTo(x * size, y * size));
      path.closePath();
    }
    paths.set(key, path);
  }
  return path;
}

export function paintTraffic(ctx: CanvasRenderingContext2D, glyphs: readonly TrafficGlyph[], dpr: number, dark: boolean, underlay?: () => void): void {
  const width = ctx.canvas.width / dpr, height = ctx.canvas.height / dpr;
  const p = dark ? TRAFFIC_PALETTES.dark : TRAFFIC_PALETTES.light;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  underlay?.();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
  const ink = (mark: TrafficGlyph) => mark.color ?? (mark.vessel ? p.ship : p.air);
  // Speed vectors are forward geodesic endpoints, with no pixel clamp/minimum.
  for (const mark of glyphs) {
    if (!mark.vector || mark.densityDot) continue;
    ctx.globalAlpha = mark.opacity * .8;
    ctx.strokeStyle = ink(mark); ctx.lineWidth = .7;
    ctx.beginPath(); ctx.moveTo(mark.x, mark.y); ctx.lineTo(mark.vector.x, mark.vector.y); ctx.stroke();
    if (mark.size === 9 || mark.selected) {
      const angle = Math.atan2(mark.vector.y - mark.y, mark.vector.x - mark.x);
      const dx = Math.sin(angle) * 1.8, dy = Math.cos(angle) * 1.8;
      ctx.beginPath(); ctx.moveTo(mark.vector.x - dx, mark.vector.y + dy); ctx.lineTo(mark.vector.x + dx, mark.vector.y - dy); ctx.stroke();
    }
  }
  // Selected contacts go on top, but never change size or lose altitude shade.
  for (let pass = 0; pass < 2; pass++) for (const mark of glyphs) {
    if (Number(mark.selected) !== pass) continue;
    ctx.globalAlpha = mark.opacity;
    if (mark.densityDot) {
      ctx.fillStyle = mark.vessel ? p.dot_ship : p.dot_air;
      ctx.beginPath();
      if (mark.vessel) ctx.rect(mark.x - 1.4, mark.y - 1.4, 2.8, 2.8);
      else ctx.arc(mark.x, mark.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const s = mark.size;
      const fill = mark.aircraft ? trafficAltitudeShade(mark.aircraft.pressureAltitudeFt, dark) : p.ship;
      ctx.save(); ctx.translate(mark.x, mark.y);
      if (mark.trackDeg != null) ctx.rotate(mark.trackDeg * Math.PI / 180);
      ctx.fillStyle = fill; ctx.strokeStyle = p.halo; ctx.lineWidth = 1.5;
      const path = silhouette(mark.symbolClass, s);
      ctx.stroke(path); ctx.fill(path);
      if (mark.aircraft) { ctx.strokeStyle = p.air; ctx.lineWidth = .5; ctx.stroke(path); }
      const line = (x1: number, y1: number, x2: number, y2: number, width = 1) => {
        ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1 * s, y1 * s); ctx.lineTo(x2 * s, y2 * s); ctx.stroke();
      };
      const circle = (x: number, y: number, radius: number) => {
        ctx.beginPath(); ctx.arc(x * s, y * s, radius * s, 0, Math.PI * 2); ctx.fill();
      };
      ctx.strokeStyle = fill;
      if (mark.symbolClass === 'helicopter') {
        line(-.75, -.28, .75, -.28, 1.3); line(-.55, -.8, .55, .24, 1.1);
        ctx.fillStyle = p.halo; circle(0, -.28, .12);
      } else if (mark.symbolClass === 'regional') {
        for (const x of [-.43, .43]) { line(x - .16, -.37, x + .16, -.37, .9); line(x, -.46, x, -.05, 1.4); }
      } else if (mark.vessel) {
        ctx.fillStyle = p.sea; ctx.strokeStyle = p.sea;
        switch (mark.symbolClass) {
          case 'tanker': for (const y of [-.35, .02, .39]) circle(0, y, .14); break;
          case 'cargo': for (const y of [-.3, .1, .5]) ctx.fillRect(-.19 * s, (y - .1) * s, .38 * s, .2 * s); break;
          case 'passenger': line(0, -.5, 0, .57, Math.max(.7, s * .16)); break;
          case 'fishing': line(-.23, .31, .23, .31); circle(0, -.17, .14); break;
          case 'sail':
            ctx.beginPath(); ctx.moveTo(0, -.65 * s); ctx.lineTo(.55 * s, .43 * s); ctx.lineTo(0, .2 * s); ctx.closePath();
            ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = .55; ctx.stroke(); break;
          case 'tug': circle(0, 0, .23); break;
        }
      }
      ctx.restore();
      // Screen-vertical, single index; the index never rotates with the target.
      if (mark.altitudeBand != null) {
        const x = mark.x + s + 3, y = mark.y + 4 - mark.altitudeBand * 8 / 3;
        ctx.strokeStyle = p.muted; ctx.lineWidth = .45;
        ctx.beginPath(); ctx.moveTo(x, mark.y - 5); ctx.lineTo(x, mark.y + 5); ctx.stroke();
        ctx.strokeStyle = p.air; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.moveTo(x - 1.8, y); ctx.lineTo(x + 1.8, y); ctx.stroke();
      }
    }
    if (mark.selected) {
      ctx.strokeStyle = ink(mark); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mark.x, mark.y, mark.densityDot ? 4 : mark.size + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.font = '12px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  for (const mark of glyphs) {
    if (!mark.label || !mark.labelOrigin) continue;
    ctx.globalAlpha = mark.opacity; ctx.strokeStyle = p.halo; ctx.fillStyle = ink(mark);
    if (mark.selected && Math.abs(mark.labelOrigin.y - mark.y) > 16) {
      const x = mark.labelOrigin.x > mark.x ? mark.labelOrigin.x - 3 : mark.labelOrigin.x + mark.label.length * 7.2 + 3;
      ctx.strokeStyle = ink(mark); ctx.lineWidth = .7;
      ctx.beginPath(); ctx.moveTo(mark.x, mark.y + Math.sign(mark.labelOrigin.y - mark.y) * (mark.densityDot ? 5 : mark.size + 6));
      ctx.lineTo(x, mark.labelOrigin.y); ctx.stroke();
      ctx.strokeStyle = p.halo; ctx.lineWidth = 3;
    }
    ctx.strokeText(mark.label, mark.labelOrigin.x, mark.labelOrigin.y);
    ctx.fillText(mark.label, mark.labelOrigin.x, mark.labelOrigin.y);
  }
  ctx.restore();
}
