/** Display helpers for numeric drills. */

export function fmt(value: number, digits = 0): string {
  const sign = value < 0 ? '−' : '';
  const body = Math.abs(value).toLocaleString('en-AU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return sign + body;
}

export function formatTolerance(tolerance: number): string {
  if (tolerance === 0) return '±0';
  const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(tolerance) - 1e-9)));
  const body = tolerance.toLocaleString('en-AU', {
    minimumFractionDigits: Number.isInteger(tolerance) ? 0 : digits,
    maximumFractionDigits: digits,
  });
  return `±${body}`;
}

/** Accept a typed drill answer: unicode minus, spaces and thousands commas. */
export function parseEntry(text: string): number | null {
  const cleaned = text.trim().replace(/−/g, '-').replace(/,/g, '').replace(/\s/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
