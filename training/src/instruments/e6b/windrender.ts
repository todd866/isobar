/** SVG for the wind side: the sliding grid, the azimuth plate and the fixed frame.
 * Layout follows ASA Figure 21 (manual p. 29). Pure strings. */
import { HIGH_SPEED_SLIDE, PLATE_R, SLIDE, U, type WindSlide } from './wind.ts';
import { polar } from './render.ts';

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Slide coordinates: O (speed 0) at (0, 0), arcs above it (y negative). */
function slideSvg(prefix: string, slide: WindSlide): string {
  const { minKt, maxKt, halfWidth, arcStepKt, driftStepDeg } = slide;
  const units = 'unitsPerKt' in slide ? slide.unitsPerKt : U;
  const top = -(maxKt * units) - 1250;
  const bottom = -(minKt * units) + 380;
  const arcs: string[] = [];
  for (let s = minKt || arcStepKt; s <= maxKt; s += arcStepKt) {
    const r = s * units;
    const major = slide.id === 'high' ? s % 50 === 0 : s % 10 === 0;
    const half = Math.min(80, (Math.asin(Math.min(1, halfWidth / r)) * 180) / Math.PI);
    const [ax, ay] = polar(-half, r);
    const [bx, by] = polar(half, r);
    arcs.push(`<path class="${major ? 'arc major' : 'arc'}" d="M${f(ax)} ${f(ay)}A${f(r)} ${f(r)} 0 0 1 ${f(bx)} ${f(by)}"/>`);
  }
  const rays: string[] = [];
  for (let d = -60; d <= 60; d += driftStepDeg) {
    if (d === 0) continue;
    const fromKt = slide.id === 'high' ? Math.max(10, minKt) : Math.abs(d) % 2 === 0 ? minKt : 100;
    const toKt = maxKt;
    const [x1, y1] = polar(d, fromKt * units);
    const [x2, y2] = polar(d, toKt * units);
    rays.push(`M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`);
  }
  const labels: string[] = [];
  const labelStep = slide.id === 'high' ? 50 : 10;
  for (let s = Math.max(labelStep, minKt + (labelStep - (minKt % labelStep)) % labelStep); s <= maxKt; s += labelStep) {
    labels.push(`<g transform="translate(0 ${f(-s * units)})"><rect class="slide-tag" x="-58" y="-24" width="116" height="48"/><text class="slide-num">${s}</text></g>`);
  }
  const driftArcs = slide.id === 'high' ? [250, 500, 750, 1000] : [60, 100, 150, 200, 250];
  for (const along of driftArcs) {
    for (let d = 5; d <= 45; d += 5) {
      const r = along * units;
      if (r * Math.sin((d * Math.PI) / 180) > halfWidth - 40) continue;
      for (const side of [-1, 1]) {
        const [x, y] = polar(side * d, r - 14);
        labels.push(`<text class="slide-drift" x="${f(x)}" y="${f(y)}">${d}</text>`);
      }
    }
  }
  const instructions = [
    'For Ground Speed and True Heading:',
    slide.id === 'high' ? 'HIGH SPEED: each printed arc = 10 knots' : 'STANDARD: each printed arc = 2 knots',
    '1. Set Wind Direction under True Index',
    '2. Mark Wind Velocity up from center point',
    '3. Set True Course under True Index',
    '4. Slide Wind Velocity mark to True Air Speed',
    '5. Ground Speed reads under center',
    '6. Wind Correction Angle reads between center line and Wind Velocity mark',
  ].map((line, i) => `<text class="slide-text${i ? '' : ' head'}" x="${-halfWidth + 70}" y="${f(top + 110 + i * 70)}">${line}</text>`).join('');
  const rule = `<path class="slide-rule" d="M${-halfWidth + 40} ${f(top + 640)}H${halfWidth - 40}"/><text class="slide-text" x="${-halfWidth + 70}" y="${f(top + 730)}">TRUE HEADING = TRUE COURSE + RIGHT / − LEFT CORRECTION</text>`;
  return `<defs><clipPath id="${prefix}-slide"><rect x="${-halfWidth}" y="${f(top)}" width="${halfWidth * 2}" height="${f(bottom - top)}" rx="24"/></clipPath></defs>
    <rect class="slide-card" x="${-halfWidth}" y="${f(top)}" width="${halfWidth * 2}" height="${f(bottom - top)}" rx="24"/>
    <g clip-path="url(#${prefix}-slide)">
      <rect class="slide-grid-bg" x="${-halfWidth}" y="${f(-(maxKt * units) - 30)}" width="${halfWidth * 2}" height="${f((maxKt - minKt) * units + 60)}"/>
      ${arcs.join('')}<path class="ray" d="${rays.join('')}"/>
      <path class="centre" d="M0 ${f(-minKt * units)}V${f(-maxKt * units)}"/>
      ${labels.join('')}
    </g>
    ${instructions}${rule}`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function plateSvg(): string {
  const band0 = PLATE_R;
  const band1 = 1172;
  const ticks: string[] = [];
  for (let a = 0; a < 360; a += 1) {
    const len = a % 10 === 0 ? 58 : a % 5 === 0 ? 40 : 24;
    const [x1, y1] = polar(a, band1);
    const [x2, y2] = polar(a, band1 - len);
    ticks.push(`M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`);
  }
  const numbers: string[] = [];
  for (let a = 0; a < 360; a += 10) {
    if (a % 90 === 0) continue;
    numbers.push(`<g transform="rotate(${a}) translate(0 -1070)"><text class="plate-num">${a}</text></g>`);
  }
  const points = POINTS.map((name, i) => {
    const a = i * 22.5;
    if (i % 4 === 0) {
      return `<g transform="rotate(${a}) translate(0 -1068)"><rect class="card-box" x="-38" y="-40" width="76" height="80"/><text class="card-text">${name}</text><path class="card-tri" d="M0 -98L-16 -68H16Z"/></g>`;
    }
    return `<g transform="rotate(${a}) translate(0 -1022)"><path class="plate-tri" d="M0 -26L-8 -12H8Z"/><text class="plate-point">${name}</text></g>`;
  }).join('');
  return `<circle class="plate-glass" r="${band0}"/>
    <path class="plate-band" fill-rule="evenodd" d="M${-band1} 0A${band1} ${band1} 0 1 0 ${band1} 0A${band1} ${band1} 0 1 0 ${-band1} 0ZM${-band0} 0A${band0} ${band0} 0 1 0 ${band0} 0A${band0} ${band0} 0 1 0 ${-band0} 0Z"/>
    <path class="plate-tick" d="${ticks.join('')}"/>${numbers.join('')}${points}
    <circle class="plate-edge" r="${band1 + 4}"/>`;
}

function frameSvg(): string {
  const r0 = 1180;
  const ticks: string[] = [];
  for (let a = -50; a <= 50; a += 1) {
    const len = a % 10 === 0 ? 46 : a % 5 === 0 ? 34 : 20;
    const [x1, y1] = polar(a, r0);
    const [x2, y2] = polar(a, r0 + len);
    ticks.push(`M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`);
  }
  const labels: string[] = [];
  for (let a = -50; a <= 50; a += 10) {
    if (a === 0) continue;
    labels.push(`<g transform="rotate(${a}) translate(0 -1262)"><text class="frame-num">${Math.abs(a)}</text></g>`);
  }
  return `<path class="frame-ring" fill-rule="evenodd" d="M-1330 0A1330 1330 0 1 0 1330 0A1330 1330 0 1 0 -1330 0ZM-1176 0A1176 1176 0 1 0 1176 0A1176 1176 0 1 0 -1176 0Z"/>
    <path class="frame-tick" d="${ticks.join('')}"/>${labels.join('')}
    <g transform="translate(0 -1292)"><rect class="index-box" x="-150" y="-30" width="300" height="60" rx="6"/><text class="index-text">TRUE INDEX</text><path class="index-tri" d="M0 62L-20 30H20Z"/></g>`;
}

export interface WindSvg { slide: string; plate: string; frame: string }

export function renderWind(prefix: string, slide: WindSlide = SLIDE): WindSvg {
  return { slide: slideSvg(prefix, slide), plate: plateSvg(), frame: frameSvg() };
}

/** Render both physical slide inserts for a selector/flip control. */
export function renderWindSlides(prefix: string): { low: WindSvg; high: WindSvg } {
  return { low: renderWind(`${prefix}-low`, SLIDE), high: renderWind(`${prefix}-high`, HIGH_SPEED_SLIDE) };
}
