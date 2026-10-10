import 'server-only';

/** The origin the browser used. `next start` can report localhost in request.url
 * when the browser asked for 127.0.0.1, so read the Host header (Vercel sets
 * x-forwarded-host and x-forwarded-proto). */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = (request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Same-origin check for state-changing requests: a cross-site fetch sends a foreign Origin. */
export function foreignOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin !== requestOrigin(request);
}
