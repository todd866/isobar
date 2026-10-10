/** IEEE binary16 → number. The store's `.f16` grids are little-endian. */

export function float16ToNumber(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) {
    if (fraction === 0) return sign * 0;
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 31) {
    if (fraction === 0) return sign * Infinity;
    return NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Sentinel used by the collector for a missing sample. Not a physical pressure. */
export const FLOAT16_FILL = -32768;

export function decodeFloat16(bytes: Uint8Array, fill = FLOAT16_FILL): Float32Array {
  if (bytes.byteLength % 2 !== 0) throw new Error('float16 buffer length is odd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) {
    const value = float16ToNumber(view.getUint16(i * 2, true));
    out[i] = value === fill || !Number.isFinite(value) ? NaN : value;
  }
  return out;
}
