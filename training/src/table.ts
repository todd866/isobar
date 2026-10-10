/** Handbook figures: a printed-style data table and the interpolation drawn
 * as a number line between its bracketing values. HTML strings, like view.ts. */

import { caption, type FigureTable, type Span } from './figure.ts';
import { esc } from './html.ts';
import { fmt } from './skills/format.ts';

export interface TableMarks {
  /** Mark the cells the answer reads, with their row and column headers. */
  used: boolean;
  /** Mark the cell a diagnosed slip read. */
  slip: boolean;
  revealed?: boolean;
  stepSolved?: (id: string) => boolean;
}

function has(cells: [number, number][], r: number, c: number): boolean {
  return cells.some(([ur, uc]) => ur === r && uc === c);
}

export function renderTable(table: FigureTable, marks: TableMarks): string {
  const used = marks.used ? table.used : [];
  const slip = marks.slip && table.slip ? [table.slip] : [];
  const usedRows = new Set(used.map(([r]) => r));
  const usedCols = new Set(used.map(([, c]) => c));
  const heads = table.columns.map((label, c) => (
    `<th scope="col" class="col${usedCols.has(c) ? ' on' : ''}">${esc(label)}</th>`
  )).join('');
  const body = table.rows.map((row, r) => {
    const cells = row.cells.map((value, c) => {
      const cross = usedRows.has(r) || usedCols.has(c) ? ' cx' : '';
      const cls = has(used, r, c) ? ' used' : has(slip, r, c) ? ' slip' : cross;
      const computed = table.computed?.find((cell) => cell.row === r && cell.column === c);
      const hidden = computed && !marks.revealed && !marks.stepSolved?.(computed.step);
      const text = hidden ? '<span aria-label="calculate">?</span>' : value == null ? '<span aria-label="blank">—</span>' : fmt(value, table.columnDecimals?.[c] ?? table.decimals);
      return `<td class="n${cls}">${text}</td>`;
    }).join('');
    return `<tr${usedRows.has(r) ? ' class="on"' : ''}><th scope="row">${esc(row.label)}</th>${cells}</tr>`;
  }).join('');
  return `<table class="hb" data-table>
    <caption>${esc(caption(table))}</caption>
    <thead>
      <tr><th scope="col" rowspan="2" class="corner">${esc(table.corner)}</th><th scope="colgroup" colspan="${table.columns.length}" class="group">${esc(table.group)}</th></tr>
      <tr>${heads}</tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

const FRACTIONS: [number, string][] = [[0.5, '½'], [0.25, '¼'], [0.75, '¾'], [1 / 3, '⅓'], [2 / 3, '⅔']];

export function fractionText(f: number): string {
  const known = FRACTIONS.find(([value]) => Math.abs(value - f) < 1e-6);
  return known ? known[1] : fmt(f, 2);
}

/** One interpolation as a ruler: bracketing labels above, their values below,
 * the entry marked at its fraction. The result shows only once `solved`. */
export function numberLine(span: Span, decimals: number, unit: string, solved: boolean): string {
  const x0 = 28;
  const x1 = 292;
  const x = x0 + span.fraction * (x1 - x0);
  const result = solved ? fmt(span.result, decimals) : '?';
  const label = `${span.at} is ${fractionText(span.fraction)} of the way from ${span.from} to ${span.to}${solved ? `: ${fmt(span.result, decimals)} ${unit}` : ''}`;
  return `<figure class="ruler" aria-label="${esc(label)}">
    <svg viewBox="0 0 320 64" role="img" aria-hidden="true">
      <line class="axis" x1="${x0}" y1="30" x2="${x1}" y2="30"/>
      <line class="seg" x1="${x0}" y1="30" x2="${x.toFixed(1)}" y2="30"/>
      <line class="tick" x1="${x0}" y1="23" x2="${x0}" y2="37"/>
      <line class="tick" x1="${x1}" y1="23" x2="${x1}" y2="37"/>
      <text class="lab" x="${x0}" y="15" text-anchor="middle">${esc(span.from)}</text>
      <text class="lab" x="${x1}" y="15" text-anchor="middle">${esc(span.to)}</text>
      <text class="val" x="${x0}" y="54" text-anchor="middle">${fmt(span.low, decimals)}</text>
      <text class="val" x="${x1}" y="54" text-anchor="middle">${fmt(span.high, decimals)}</text>
      <circle class="dot" cx="${x.toFixed(1)}" cy="30" r="5"/>
      <text class="at" x="${x.toFixed(1)}" y="15" text-anchor="middle">${esc(span.at)} · ${fractionText(span.fraction)}</text>
      <text class="res${solved ? ' solved' : ''}" x="${x.toFixed(1)}" y="54" text-anchor="middle">${result}</text>
    </svg>
  </figure>`;
}

export interface FigureState {
  /** 0 none, 1 used cells, 2 cells and number lines. */
  support: 0 | 1 | 2;
  revealed: boolean;
  /** Whether number line `index` shows its result (its step solved, or revealed). */
  solved: (index: number) => boolean;
  stepSolved?: (id: string) => boolean;
}

export function handbookFigure(table: FigureTable, state: FigureState): string {
  const marked = state.revealed || state.support >= 1;
  const rulers = (state.revealed || state.support >= 2) && table.spans?.length
    ? `<div class="rulers">${table.spans.map((span, i) => numberLine(span, table.decimals, table.unit, state.revealed || state.solved(i))).join('')}</div>`
    : '';
  return `<figure class="figure handbook">
    <div class="hb-wrap" role="region" aria-label="${esc(caption(table))}" tabindex="0">${renderTable(table, { used: marked, slip: state.support >= 2, revealed: state.revealed, stepSolved: state.stepSolved })}</div>
    ${rulers}
  </figure>`;
}
