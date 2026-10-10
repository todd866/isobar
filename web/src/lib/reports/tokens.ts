import { createHmac, timingSafeEqual } from 'node:crypto';
export type Purpose = 'hold' | 'preview' | 'unsubscribe';
function mac(secret: string, purpose: Purpose, id: string, version: number, expires: string) {
  if (secret.length < 16) throw new Error('Report signing secret unavailable');
  return createHmac('sha256', secret).update(`isobar-report\0${purpose}\0${id}\0${version}\0${expires}`).digest('base64url').slice(0, 32);
}
/** Unsubscribe stays usable for the subscription lifetime, independent of session. */
export function signReportToken(secret: string, purpose: Purpose, id: string, version = 1, until?: Date): string {
  const expiry = purpose === 'unsubscribe' ? '0' : Math.floor(+(until ?? new Date(Date.now() + 7 * 86_400_000)) / 1000).toString(36);
  return `${expiry}.${mac(secret, purpose, id, version, expiry)}`;
}
export function verifyReportToken(token: string | null, secret: string, purpose: Purpose, id: string, version = 1, now = new Date()): boolean {
  if (!token || !/^[a-z0-9]{1,10}\.[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const [expires, signature] = token.split('.');
  if (purpose === 'unsubscribe' ? expires !== '0' : parseInt(expires, 36) * 1000 <= +now) return false;
  try { return timingSafeEqual(Buffer.from(signature), Buffer.from(mac(secret, purpose, id, version, expires))); } catch { return false; }
}
