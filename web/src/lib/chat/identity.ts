/** Signed device cookie and IP hash. The raw address is never stored. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_COOKIE = 'isobar_chat';

export function hashSecret(secret: string, kind: string, value: string): string {
  return createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex');
}

export function signDevice(id: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(`cookie:${id}`).digest('base64url');
  return `${id}.${mac}`;
}

export function readDevice(cookie: string | undefined, secret: string): string | null {
  if (!cookie || !secret) return null;
  const split = cookie.lastIndexOf('.');
  if (split <= 0) return null;
  const id = cookie.slice(0, split);
  const mac = cookie.slice(split + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const expected = createHmac('sha256', secret).update(`cookie:${id}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

export function newDevice(secret: string): { id: string; cookie: string } {
  const id = randomBytes(18).toString('base64url');
  return { id, cookie: signDevice(id, secret) };
}

export function cookieHeader(value: string, secure: boolean): string {
  const parts = [`${DEVICE_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${400 * 24 * 60 * 60}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return request.headers.get('x-real-ip')?.slice(0, 80) ?? '0.0.0.0';
}

export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
