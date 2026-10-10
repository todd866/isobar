/** Structured exhibits for numeric cards: a handbook table, the interpolation
 * drawn between its bracketing cells, and the worksheet steps a supported
 * follow-up asks for. Plain data so generators, tests and the view share it. */

/** One interpolation: the entry value lies `fraction` of the way from `from` to `to`. */
export interface Span {
  /** Interpolating across weight columns or down level rows. */
  axis: 'column' | 'row';
  /** Labels of the bracketing lines, as printed in the table. */
  from: string;
  to: string;
  /** The entry, as a label: "69 t", "FL335". */
  at: string;
  low: number;
  high: number;
  fraction: number;
  result: number;
}

export interface FigureTable {
  /** "Table 3.1". */
  label: string;
  /** "M 0.80 fuel flow". */
  title: string;
  /** Unit of every body cell: "kg/h". */
  unit: string;
  /** Row-header column title: "FL". */
  corner: string;
  /** Spanning header over the value columns: "Gross weight (t)". */
  group: string;
  columns: string[];
  rows: { label: string; cells: (number | null)[] }[];
  decimals: number;
  /** Mixed-unit exhibits print units in their column headings. */
  columnDecimals?: number[];
  /** Calculated cells stay unknown until their own worksheet step is solved. */
  computed?: { row: number; column: number; step: string }[];
  /** Body cells the answer reads, as [row, column]. */
  used: [number, number][];
  /** Interpolations the answer makes, in working order. */
  spans?: Span[];
  /** The cell a retest's diagnosed slip read, marked in the error tone. */
  slip?: [number, number];
}

export interface WorkStep {
  id: string;
  /** Verb-first: "Read the lower cell". */
  label: string;
  /** Where to look or what to combine: "FL340 · 68 t". */
  detail: string;
  value: number;
  tolerance: number;
  unit: string;
  decimals: number;
}

export type FigureDiagram =
  | { kind: 'wind'; track: number; from: number; speed: number; tas?: number }
  | { kind: 'route'; point: 'ETP' | 'PNR'; distance: number; end: number; boundary?: number; endLabel: string };

export function caption(table: FigureTable): string {
  return [table.label, table.title, table.unit].filter(Boolean).join(' · ');
}
