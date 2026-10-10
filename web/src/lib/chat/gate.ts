/** Owner session, or the digest secret as a header or a bearer token. */

import { timingSafeEqual } from 'node:crypto';
import { ownerAllowed } from './admin-view';

export function secretMatch(candidate: string | null | undefined, secret: string | null | undefined): boolean {
  if (!candidate || !secret) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function presentedSecret(header: string | null, authorization: string | null): string | null {
  if (header?.trim()) return header.trim();
  const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

export function ownerGate(input: {
  sessionEmail: string | null | undefined;
  ownerEmail: string | null | undefined;
  header: string | null;
  authorization: string | null;
  secret: string | null;
}): boolean {
  if (ownerAllowed(input.sessionEmail, input.ownerEmail)) return true;
  return secretMatch(presentedSecret(input.header, input.authorization), input.secret);
}
