/** Unsigned 16-bit quantisation. `fill` (default 65535) is missing, never a real sample. */

export const UINT16_FILL = 65535;

export interface QuantScale {
  scale: number;
  offset: number;
  fill?: number;
}

export function quantise(value: number, scale: QuantScale): number {
  const fill = scale.fill ?? UINT16_FILL;
  if (!Number.isFinite(value)) return fill;
  const raw = Math.round((value - scale.offset) / scale.scale);
  if (raw < 0 || raw >= fill) return fill;
  return raw;
}

export function dequantise(raw: number, scale: QuantScale): number {
  const fill = scale.fill ?? UINT16_FILL;
  if (raw === fill) return NaN;
  return raw * scale.scale + scale.offset;
}

export function decodeUint16(bytes: Uint8Array, scale: QuantScale): Float32Array {
  if (bytes.byteLength % 2 !== 0) throw new Error('uint16 buffer length is odd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = dequantise(view.getUint16(i * 2, true), scale);
  return out;
}

export function encodeUint16(values: ArrayLike<number>, scale: QuantScale): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setUint16(i * 2, quantise(values[i], scale), true);
  return bytes;
}
