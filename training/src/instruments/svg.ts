import { esc } from '../html.ts';
export const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));
export const n = (x: number, decimals = 0): string => Number.isFinite(x) ? x.toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : 'Unavailable';
export const signed = (x: number, d = 0): string => `${x > 0 ? '+' : ''}${n(x, d)}`;
export function text(x: number, y: number, content: string, cls = '', anchor = 'start'): string {
  return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(content)}</text>`;
}
export function line(x1: number, y1: number, x2: number, y2: number, cls = '', extra = ''): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" ${extra}/>`;
}
export function handle(x: number, y: number, key: string, label: string, tone = 'air'): string {
  return `<g class="i-handle ${tone}" data-handle="${key}" role="button" tabindex="0" aria-label="${esc(label)}"><title>${esc(label)} · drag, scroll or use arrow keys</title><circle class="handle-hit" cx="${x}" cy="${y}" r="38"/><circle class="handle-ring" cx="${x}" cy="${y}" r="12"/><circle class="handle-dot" cx="${x}" cy="${y}" r="3"/></g>`;
}
export function arrow(x1: number, y1: number, x2: number, y2: number, cls = 'air'): string {
  const a = Math.atan2(y2-y1,x2-x1), r = 12;
  return line(x1,y1,x2,y2,`vector ${cls}`) + `<path class="arrow-tip ${cls}" d="M${x2} ${y2} L${x2-r*Math.cos(a-.45)} ${y2-r*Math.sin(a-.45)} L${x2-r*Math.cos(a+.45)} ${y2-r*Math.sin(a+.45)} Z"/>`;
}
export function plane(x: number, y: number, bearing = 0, scale = 1): string {
  return `<path class="i-plane" transform="translate(${x} ${y}) rotate(${bearing}) scale(${scale})" d="M0 -20 Q4 -18 4 -7 L22 6 L22 10 L4 4 L3 15 L9 19 L9 22 L0 19 L-9 22 L-9 19 L-3 15 L-4 4 L-22 10 L-22 6 L-4 -7 Q-4 -18 0 -20Z"/>`;
}
