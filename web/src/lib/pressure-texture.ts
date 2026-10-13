import { smoothGrid } from './contour';

/**
 * Prepare the two pressure endpoints for a full-resolution RG texture.
 * Keeping the smoothing and interleaving here means the render path can upload
 * one immutable endpoint texture and interpolate it in the shader each frame.
 */
export function preparePressureTexture(
  a: Float32Array,
  b: Float32Array,
  nx: number,
  ny: number,
  wraps: boolean,
): Float32Array {
  // The shader blends the prepared endpoints after smoothing.  Keep the
  // missing-data mask identical at both endpoints first so this is equivalent
  // to the CPU path, which blends a cell to NaN when either endpoint is
  // missing, then smooths the blended field.  Copying also keeps the caller's
  // frame buffers immutable while they may still be cached by the chart.
  const jointA = new Float32Array(nx * ny);
  const jointB = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      jointA[i] = a[i];
      jointB[i] = b[i];
    } else {
      jointA[i] = NaN;
      jointB[i] = NaN;
    }
  }
  const smoothA = smoothGrid(smoothGrid(jointA, nx, ny, wraps), nx, ny, wraps);
  const smoothB = smoothGrid(smoothGrid(jointB, nx, ny, wraps), nx, ny, wraps);
  const out = new Float32Array(nx * ny * 2);
  for (let i = 0; i < nx * ny; i += 1) {
    out[i * 2] = smoothA[i];
    out[i * 2 + 1] = smoothB[i];
  }
  return out;
}
