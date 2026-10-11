/**
 * Continuous sampling for the coarse atmospheric grids used by historical
 * cyclone reconstructions. The source grid stays untouched; only the point
 * interpolation changes from bilinear (piecewise planar) to a monotone cubic
 * surface, so pressure cannot overshoot the four surrounding source rows.
 */
export interface ScalarGrid {
  values: ArrayLike<number>;
  nx: number;
  ny: number;
  west: number;
  north: number;
  step: number;
  wrapsLongitude?: boolean;
}

function finite(value: number): value is number {
  return Number.isFinite(value);
}

function harmonic(a: number, b: number): number {
  if (!finite(a) || !finite(b) || a * b <= 0) return 0;
  return 2 * a * b / (a + b);
}

/** Monotone cubic Hermite interpolation over one unit interval. */
function cubic(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const d0 = y1 - y0;
  const d1 = y2 - y1;
  const d2 = y3 - y2;
  const m1 = harmonic(d0, d1);
  const m2 = harmonic(d1, d2);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y1
    + (t3 - 2 * t2 + t) * m1
    + (-2 * t3 + 3 * t2) * y2
    + (t3 - t2) * m2;
}

/**
 * Sample a north-to-south, west-to-east regular grid with monotone bicubic
 * interpolation. Longitude wraps only when explicitly declared. Missing
 * source cells return null rather than manufacturing a pressure value.
 */
export function sampleMonotoneBicubic(grid: ScalarGrid, lon: number, lat: number): number | null {
  const { values, nx, ny, west, north, step } = grid;
  if (!(nx >= 2 && ny >= 2 && step > 0) || values.length < nx * ny) return null;
  const wraps = grid.wrapsLongitude === true;
  let gx = (lon - west) / step;
  if (wraps) gx = ((gx % nx) + nx) % nx;
  else if (gx < 0 || gx > nx - 1) return null;
  const gy = (north - lat) / step;
  if (gy < 0 || gy > ny - 1) return null;

  const x = Math.floor(gx);
  const y = Math.floor(gy);
  const tx = gx - x;
  const ty = gy - y;
  const column = (index: number): number | null => {
    if (wraps) return ((index % nx) + nx) % nx;
    return Math.max(0, Math.min(nx - 1, index));
  };
  const row = (index: number) => Math.max(0, Math.min(ny - 1, index));
  const at = (ix: number, iy: number): number | null => {
    const col = column(ix);
    if (col == null) return null;
    const value = values[row(iy) * nx + col];
    return finite(value) ? value : null;
  };

  const rows: number[] = [];
  for (let j = y - 1; j <= y + 2; j += 1) {
    const p0 = at(x - 1, j);
    const p1 = at(x, j);
    const p2 = at(x + 1, j);
    const p3 = at(x + 2, j);
    if (p0 == null || p1 == null || p2 == null || p3 == null) return null;
    rows.push(cubic(p0, p1, p2, p3, tx));
  }
  return cubic(rows[0], rows[1], rows[2], rows[3], ty);
}
