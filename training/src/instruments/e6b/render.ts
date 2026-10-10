/** SVG for a flight-computer face. Pure strings: no DOM, so the tests can read it.
 * The base (fixed) and the disc (rotating) are separate groups; the controller
 * turns the disc group. Window scales on the base show through cut-outs in the disc.
 */
import type { Face, Label, Layer, Mark, Scale, Text, Window } from './face.ts';
import { angleOf } from './slide.ts';

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

export function polar(angle: number, r: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
}

function ticksPath(scale: Scale): string {
  return scale.ticks.map((tick) => {
    const [x1, y1] = polar(tick.angle, scale.r);
    const [x2, y2] = polar(tick.angle, scale.r + scale.dir * tick.length);
    return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
  }).join('');
}

function label(item: Label, r: number, cls = 'num', flip = false): string {
  const upright = flip && Math.cos((item.angle * Math.PI) / 180) < -0.2 ? ' rotate(180)' : '';
  const text = item.boxed
    ? `<rect class="box" x="${f(-item.size * 0.62)}" y="${f(-item.size * 0.6)}" width="${f(item.size * 1.24)}" height="${f(item.size * 1.2)}"/><text class="${cls} on-box" font-size="${item.size}"${item.weight ? ` font-weight="${item.weight}"` : ''}>${item.text}</text>`
    : `<text class="${cls}" font-size="${item.size}"${item.weight ? ` font-weight="${item.weight}"` : ''}>${item.text}</text>`;
  return `<g transform="rotate(${f(item.angle)}) translate(0 ${f(-r)})${upright}">${text}</g>`;
}

function scaleSvg(scale: Scale): string {
  const width = scale.id === 'outer' || scale.id === 'middle' ? 4.6 : 3.6;
  return `<g class="scale" data-scale="${scale.id}"><path class="tick" stroke-width="${width}" d="${ticksPath(scale)}"/>${scale.labels.map((item) => label(item, scale.labelR, 'num', scale.id === 'celsius' || scale.id === 'fahrenheit')).join('')}</g>`;
}

/** A conversion arrow: outer marks point inward from above the numerals, disc marks outward from the numeral ring. */
function markSvg(item: Mark): string {
  const angle = angleOf(item.value);
  const base = item.layer === 'base';
  const tip = base ? 1150 : 1040;
  const tail = base ? 1222 : 1000;
  const [x1, y1] = polar(angle, tail);
  const [x2, y2] = polar(angle, tip);
  const head = base ? -1 : 1;
  const [hx, hy] = polar(angle, tip - head * 22);
  const [lx, ly] = polar(angle - 0.55, tip - head * 22);
  const [rx, ry] = polar(angle + 0.55, tip - head * 22);
  void hx; void hy;
  const textR = base ? 1250 : 1004;
  const textAngle = angle + item.textShift;
  return `<g class="mark" data-mark="${item.id}"><path class="arrow" d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}"/><path class="head" d="M${f(x2)} ${f(y2)}L${f(lx)} ${f(ly)}L${f(rx)} ${f(ry)}Z"/>${label({ angle: textAngle, text: item.text, size: base ? 30 : 28, weight: 600 }, textR, 'unit', base)}</g>`;
}

function arcPathId(prefix: string, r: number, angle: number): string {
  return `${prefix}-arc-${Math.round(r)}-${Math.round(angle * 10)}`;
}

/** Text on a circle, centred on `angle`; flipped to read left-to-right at the bottom. */
function textSvg(prefix: string, item: Text, defs: string[]): string {
  const weight = item.weight ? ` font-weight="${item.weight}"` : '';
  if (item.at) {
    const rule = item.rule ? `<path class="rule" d="M${f(item.at.x - 300)} ${f(item.at.y - item.size * 1.05)}h600"/>` : '';
    return `${rule}<text class="face-text" x="${f(item.at.x)}" y="${f(item.at.y)}" font-size="${item.size}"${weight} text-anchor="${item.anchor ?? 'start'}">${item.text}</text>`;
  }
  const arc = item.arc!;
  const id = arcPathId(prefix, arc.r, arc.angle);
  const bottom = Math.cos((arc.angle * Math.PI) / 180) < -0.2;
  const r = bottom ? arc.r + item.size * 0.35 : arc.r - item.size * 0.35;
  const span = 170;
  const [sx, sy] = polar(arc.angle + (bottom ? span / 2 : -span / 2), r);
  const [ex, ey] = polar(arc.angle + (bottom ? -span / 2 : span / 2), r);
  defs.push(`<path id="${id}" d="M${f(sx)} ${f(sy)}A${f(r)} ${f(r)} 0 0 ${bottom ? 0 : 1} ${f(ex)} ${f(ey)}"/>`);
  return `<text class="face-text" font-size="${item.size}"${weight}><textPath href="#${id}" startOffset="50%" text-anchor="middle">${item.text}</textPath></text>`;
}

function sector(w: Window): string {
  const [ax, ay] = polar(w.from, w.r1);
  const [bx, by] = polar(w.to, w.r1);
  const [cx, cy] = polar(w.to, w.r0);
  const [dx, dy] = polar(w.from, w.r0);
  const large = w.to - w.from > 180 ? 1 : 0;
  return `M${f(ax)} ${f(ay)}A${w.r1} ${w.r1} 0 ${large} 1 ${f(bx)} ${f(by)}L${f(cx)} ${f(cy)}A${w.r0} ${w.r0} 0 ${large} 0 ${f(dx)} ${f(dy)}Z`;
}

function circle(r: number): string {
  return `M${-r} 0A${r} ${r} 0 1 0 ${r} 0A${r} ${r} 0 1 0 ${-r} 0Z`;
}

/** The 60 rate triangle, the RATE box on the hours ring and the density-altitude index. */
function discFurniture(face: Face): string {
  const a = angleOf(face.index.rate);
  const [t1x, t1y] = polar(a, 1046);
  const [t2x, t2y] = polar(a - 2.1, 968);
  const [t3x, t3y] = polar(a + 2.1, 968);
  const triangle = `<path class="rate" d="M${f(t1x)} ${f(t1y)}L${f(t2x)} ${f(t2y)}L${f(t3x)} ${f(t3y)}Z"/>`;
  const rateBox = `<g transform="rotate(${f(a)}) translate(0 -884)"><rect class="box" x="-40" y="-44" width="80" height="88"/><text class="num on-box" font-size="44" font-weight="700" y="-12">60</text><text class="num on-box" font-size="20" font-weight="700" y="26">RATE</text></g>`;
  const d = face.index.density;
  const [i1x, i1y] = polar(d, 826);
  const [i2x, i2y] = polar(d - 1.3, 800);
  const [i3x, i3y] = polar(d + 1.3, 800);
  const index = `<path class="rate" d="M${f(i1x)} ${f(i1y)}L${f(i2x)} ${f(i2y)}L${f(i3x)} ${f(i3y)}Z"/>`;
  const plate = (text: string, angle: number) =>
    `<g transform="rotate(${f(angle)}) translate(0 -790)"><rect class="plate" x="-92" y="-22" width="184" height="44" rx="3"/><text class="plate-text" font-size="30" font-weight="700">${text}</text></g>`;
  return `${triangle}${rateBox}${index}${plate('DENSITY', d - 7.6)}${plate('ALTITUDE', d + 7.8)}`;
}

function machIndex(face: Face): string {
  const a = face.index.mach;
  const [x1, y1] = polar(a, 600);
  const [x2, y2] = polar(a, 648);
  const [lx, ly] = polar(a - 1.2, 628);
  const [rx, ry] = polar(a + 1.2, 628);
  return `<g class="mark" data-mark="mach"><path class="arrow" d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}"/><path class="head" d="M${f(x2)} ${f(y2)}L${f(lx)} ${f(ly)}L${f(rx)} ${f(ry)}Z"/>${label({ angle: a, text: 'MACH NO.', size: 22, weight: 600 }, 578, 'unit')}${label({ angle: a, text: 'INDEX', size: 22, weight: 600 }, 552, 'unit')}</g>`;
}

export interface FaceSvg { defs: string; base: string; disc: string }

/** The disc's working marks alone (inner scale, window scales, indices), for the
 * ghost that shows where the disc should be. No face, texts or hours ring. */
export function renderGhost(face: Face): string {
  const keep = new Set(['middle', 'temp-as', 'pa-alt']);
  const scales = face.scales.filter((item) => item.layer === 'disc' && keep.has(item.id)).map(scaleSvg).join('');
  return `${scales}${discFurniture(face)}`;
}

export function renderFace(face: Face, prefix: string): FaceSvg {
  const defs: string[] = [`<linearGradient id="${prefix}-sheen" x1="0" y1="0" x2=".75" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".65"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#8396ae" stop-opacity=".12"/></linearGradient>`];
  const byLayer = (layer: Layer) => face.scales.filter((item) => item.layer === layer).map(scaleSvg).join('');
  const marksOn = (layer: Layer) => face.marks.filter((item) => item.layer === layer).map(markSvg).join('');
  const textsOn = (layer: Layer) => face.texts.filter((item) => item.layer === layer).map((item) => textSvg(prefix, item, defs)).join('');
  const windows = face.windows.map(sector).join('');
  const base = `<circle class="base-face" r="${face.radius.base}"/>
    <circle fill="url(#${prefix}-sheen)" r="${face.radius.base-4}"/>
    <circle class="base-rim" r="${face.radius.base - 6}"/>
    <path class="window-floor" d="${circle(face.radius.disc - 4)}"/>
    <circle class="disc-halo" r="${face.radius.disc - 2}" filter="url(#${prefix}-lift)"/>
    ${byLayer('base')}${machIndex(face)}${marksOn('base')}${textsOn('base')}`;
  const disc = `<path class="disc-face" fill-rule="evenodd" d="${circle(face.radius.disc)}${windows}"/>
    <path fill="url(#${prefix}-sheen)" fill-rule="evenodd" d="${circle(face.radius.disc)}${windows}"/>
    <path class="window-edge" d="${windows}"/>
    <circle class="disc-ring" r="952"/>
    ${byLayer('disc')}${marksOn('disc')}${discFurniture(face)}${textsOn('disc')}`;
  return { defs: defs.join(''), base, disc };
}
