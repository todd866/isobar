/**
 * Catmull-Rom bicubic sample on a regular grid. A linear field is reproduced.
 * Any non-finite neighbour makes the sample missing: missing is not treated as zero.
 */

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  const d = p1;
  return ((a * t + b) * t + c) * t + d;
}

function at(grid: ArrayLike<number>, nx: number, ny: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= nx || y >= ny) return NaN;
  return grid[y * nx + x];
}

export function sampleBicubic(
  grid: ArrayLike<number>,
  nx: number,
  ny: number,
  x: number,
  y: number,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const cols = [0, 1, 2, 3].map((col) => {
    const samples = [0, 1, 2, 3].map((row) => at(grid, nx, ny, x0 - 1 + col, y0 - 1 + row));
    if (samples.some((value) => !Number.isFinite(value))) return NaN;
    return cubic(samples[0], samples[1], samples[2], samples[3], ty);
  });
  if (cols.some((value) => !Number.isFinite(value))) return NaN;
  return cubic(cols[0], cols[1], cols[2], cols[3], tx);
}
