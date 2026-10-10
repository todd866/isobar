/**
 * Frame transfer encoding. `raw` is little-endian uint16, cell by cell.
 * `shuffle-gzip` stores the same uint16 values with all high bytes first, then
 * all low bytes (smooth fields then compress about 13% better), gzip-compressed.
 * Lossless: every hour and every quantised value survives.
 */

export type FrameEncoding = 'raw' | 'shuffle-gzip';

export function shuffleUint16(body: Uint8Array): Uint8Array {
  const cells = body.byteLength / 2;
  const out = new Uint8Array(body.byteLength);
  for (let i = 0; i < cells; i += 1) {
    out[i] = body[i * 2 + 1];
    out[cells + i] = body[i * 2];
  }
  return out;
}

export function unshuffleUint16(planes: Uint8Array): Uint8Array {
  const cells = planes.byteLength / 2;
  const out = new Uint8Array(planes.byteLength);
  for (let i = 0; i < cells; i += 1) {
    out[i * 2] = planes[cells + i];
    out[i * 2 + 1] = planes[i];
  }
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Raw uint16 bytes for a fetched frame. A host that already undid the gzip
 * (Content-Encoding) hands over the planes directly; the gzip magic tells which.
 */
export async function decodeFrameBytes(bytes: Uint8Array, encoding: FrameEncoding): Promise<Uint8Array> {
  if (encoding === 'raw') return bytes;
  const planes = bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  return unshuffleUint16(planes);
}
