/** Local SVG supports: a wind vector triangle and distance along the route. */
import type { FigureDiagram } from './figure.ts';
import { esc } from './html.ts';
import { fmt } from './skills/format.ts';

export interface DiagramState {
  revealed: boolean;
  solved: (id: string) => boolean;
  answerSolved: boolean;
}

export function supportDiagram(diagram: FigureDiagram, state: DiagramState): string {
  const value = (id: string, n: number, unit: string, decimals = 1) => `${state.revealed || state.solved(id) ? fmt(n, decimals) : '?'} ${unit}`;
  if (diagram.kind === 'route') {
    const start = 24, end = 296;
    const x = start + diagram.distance / diagram.end * (end - start);
    const done = state.revealed || state.answerSolved;
    const distance = done ? `${fmt(diagram.distance, 1)} nm` : '? nm';
    const boundary = diagram.boundary == null ? '' : (() => {
      const bx = start + diagram.boundary / diagram.end * (end - start);
      return `<line class="tick" x1="${bx}" x2="${bx}" y1="45" y2="63"/><text x="${bx}" y="85" text-anchor="middle">Z1 / Z2 · ${fmt(diagram.boundary!, 0)}</text>`;
    })();
    return `<figure class="figure support-figure route-ruler" aria-label="${diagram.point} along the route from departure: ${esc(distance)}">
      <svg viewBox="0 0 320 115" role="img" aria-hidden="true">
        <text x="24" y="16">Departure</text><text x="296" y="16" text-anchor="end">${diagram.endLabel}</text>
        <line class="axis" x1="24" x2="296" y1="54" y2="54"/>
        ${done ? `<line class="vector" x1="24" x2="${x}" y1="54" y2="54"/>` : ''}
        <path class="tick" d="M24 47v14 M296 47v14"/>
        <text x="24" y="106">0 nm</text><text x="296" y="106" text-anchor="end">${fmt(diagram.end, 0)} nm</text>
        ${boundary}${done ? `<circle class="point" cx="${x}" cy="54" r="5"/>` : ''}
        <text class="answer-label" x="${done ? x : 160}" y="38" text-anchor="middle">${diagram.point} · ${distance}</text>
      </svg>
    </figure>`;
  }
  const angle = ((diagram.from - diagram.track + 540) % 360) - 180;
  const rad = angle * Math.PI / 180;
  const cross = diagram.speed * Math.sin(rad), tail = -diagram.speed * Math.cos(rad);
  // Track points to the right; the wind vector points downwind, opposite “from”.
  const isGs = diagram.tas != null;
  const air = isGs ? Math.sqrt(diagram.tas! ** 2 - cross ** 2) : 0;
  const scale = isGs ? 235 / (diagram.tas! + diagram.speed) : 100 / diagram.speed;
  const ox = isGs ? 28 : 172, oy = 103;
  const ax = ox + air * scale, ay = oy + (isGs ? cross * scale : 0);
  const gx = ax + tail * scale, gy = isGs ? oy : oy - cross * scale;
  const line = (kind: string, x1: number, y1: number, x2: number, y2: number) => {
    const direction = Math.atan2(y2 - y1, x2 - x1), size = 6;
    return `<line class="${kind}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><path class="${kind}" d="M${x2 - size * Math.cos(direction - 0.5)} ${y2 - size * Math.sin(direction - 0.5)} L${x2} ${y2} L${x2 - size * Math.cos(direction + 0.5)} ${y2 - size * Math.sin(direction + 0.5)}"/>`;
  };
  const picture = isGs
    ? `${line('air-vector', ox, oy, ax, ay)}${line('vector', ax, ay, gx, gy)}${line('ground-vector', ox, oy, gx, gy)}`
    : `<path class="axis" d="M${ox} ${oy}H${gx}V${gy}"/>${line('vector', ox, oy, gx, gy)}`;
  return `<figure class="figure support-figure wind-sketch" aria-label="Wind triangle: track ${diagram.track} degrees true, wind from ${diagram.from} at ${diagram.speed} knots; arrows point downwind">
    <svg viewBox="0 0 320 174" role="img" aria-hidden="true">
      <text x="12" y="18">Track ${fmt(diagram.track, 0)}°T →</text>
      <text x="308" y="18" text-anchor="end">Wind from ${diagram.from}° / ${diagram.speed} kt</text>
      <line class="axis dashed" x1="20" x2="298" y1="103" y2="103"/>${picture}
      <text x="12" y="143">Cross ${value('cross', cross, 'kt')}</text>
      <text x="308" y="143" text-anchor="end">Tail ${value('tail', tail, 'kt')}</text>
      ${isGs ? `<text class="air-label" x="12" y="164">TAS ${value('tas', diagram.tas!, 'kt')}</text><text class="answer-label" x="308" y="164" text-anchor="end">GS ${value('gs', air + tail, 'kt')}</text>` : `<text x="160" y="164" text-anchor="middle">θ ${value('angle', angle === -180 ? 180 : angle, '°', 0)} · tail positive</text>`}
    </svg>
  </figure>`;
}
