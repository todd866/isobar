import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const BUSY_STALE_MS = 30 * 60_000;
export function busySignal(value: unknown, modifiedAt: number, now = Date.now()): boolean {
  if (now - modifiedAt > BUSY_STALE_MS) return false;
  const row = value as { inFlight?: unknown } | null;
  return !row || typeof row.inFlight !== 'number' || !Number.isInteger(row.inFlight) || row.inFlight < 0 || row.inFlight > 0;
}
export async function md3Busy(file: string, now = Date.now()): Promise<boolean> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return true;
      if (now - stat.mtimeMs > BUSY_STALE_MS) return false;
      if (stat.size > 4096) return true;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) return true;
      return busySignal(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), stat.mtimeMs, now);
    } finally { await handle.close(); }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
