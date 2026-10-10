import { NextRequest, NextResponse } from 'next/server';
import { handlers } from '@/lib/server/auth';
import { clear, clientIp, over, overAfter, record, sweep } from '@/lib/server/throttle';
import { databaseConfigured, db } from '@/lib/server/prisma';
import { foreignOrigin, requestOrigin } from '@/lib/server/origin';
import { CODE_PARAM, EMAIL_PARAM, ERROR_PARAM, normalEmail, safeReturn } from '@/lib/account/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const normal = (email: string | null) => normalEmail(email) ?? '';

function back(request: NextRequest, callbackUrl: string | null, error: string): NextResponse {
  const url = safeReturn(requestOrigin(request), callbackUrl);
  url.searchParams.set(ERROR_PARAM, error);
  return NextResponse.redirect(url, 303);
}

/** Code entry: at most five misses per address (and thirty per IP) in 15 minutes;
 * past that the outstanding code is withdrawn and a new one must be requested. */
async function callback(request: NextRequest): Promise<Response> {
  const email = normal(request.nextUrl.searchParams.get('email'));
  const callbackUrl = request.nextUrl.searchParams.get('callbackUrl');
  const ip = clientIp(request);
  if (!email) return back(request, callbackUrl, 'code');
  // Count the attempt before checking it, so a burst of parallel guesses
  // cannot all pass the limit before any failure is recorded.
  await Promise.all([record('codeEmail', email), record('codeEmailDay', email), record('codeIp', ip)]);
  if (await overAfter('codeEmail', email) || await overAfter('codeEmailDay', email) || await overAfter('codeIp', ip)) {
    await db().verificationToken.deleteMany({ where: { identifier: email } });
    return back(request, callbackUrl, 'locked');
  }
  const response = await handlers.GET(request);
  const location = response.headers.get('location') ?? '';
  let failed = response.status >= 400;
  try { failed ||= new URL(location, requestOrigin(request)).searchParams.has('error'); } catch { failed = true; }
  if (failed) return back(request, callbackUrl, 'code');
  await Promise.all([clear('codeEmail', email), clear('codeEmailDay', email)]);
  return response;
}

/** Sending: at most five codes per address and twenty per IP an hour. */
async function sendCode(request: NextRequest): Promise<Response> {
  let email = '';
  try { email = normal(String((await request.clone().formData()).get('email') ?? '')); } catch { /* the handler rejects it */ }
  const ip = clientIp(request);
  if (email && (await over('sendEmail', email) || await over('sendIp', ip))) {
    return NextResponse.json({ url: `${requestOrigin(request)}/?error=RateLimited` }, { status: 429 });
  }
  if (email) {
    await Promise.all([record('sendEmail', email), record('sendIp', ip)]);
    // A fresh code starts a fresh attempt budget, so a stranger spamming wrong
    // codes for your address can only cancel the code in flight, not lock you out.
    await clear('codeEmail', email);
  }
  if (Math.random() < 0.1) void sweep();
  return handlers.POST(request);
}

const VERIFIED = 'x-isobar-verified';

/** A sign-in link, opened directly, never signs the browser in (login CSRF): it
 * lands on the page with the code filled in, and sign-in waits for a tap that
 * posts to /api/auth/verify from this site. */
function toPage(request: NextRequest): NextResponse {
  const params = request.nextUrl.searchParams;
  const url = safeReturn(requestOrigin(request), params.get('callbackUrl'));
  const token = params.get('token'), email = params.get('email');
  if (token) url.searchParams.set(CODE_PARAM, token);
  if (email) url.searchParams.set(EMAIL_PARAM, email);
  return NextResponse.redirect(url, 303);
}

/** The tap: a same-origin POST of the code. Cross-site posts carry a foreign Origin. */
async function verify(request: NextRequest): Promise<Response> {
  if (foreignOrigin(request)) return new NextResponse(null, { status: 403 });
  let form: FormData;
  try { form = await request.formData(); } catch { return back(request, null, 'code'); }
  const token = String(form.get('code') ?? ''), email = String(form.get('email') ?? '');
  const callbackUrl = String(form.get('callbackUrl') ?? '/');
  const url = new URL('/api/auth/callback/email', requestOrigin(request));
  url.search = new URLSearchParams({ token, email, callbackUrl }).toString();
  const headers = new Headers(request.headers);
  headers.set(VERIFIED, '1');
  return callback(new NextRequest(url, { method: 'GET', headers }));
}

export async function GET(request: NextRequest): Promise<Response> {
  // No database: a signed-out visitor still asks /api/auth/session on load.
  // A 500 becomes a console error. Answer signed out instead.
  if (!databaseConfigured() && request.nextUrl.pathname.endsWith('/session')) {
    return NextResponse.json(null, { headers: { 'cache-control': 'no-store' } });
  }
  if (request.nextUrl.pathname.endsWith('/callback/email')) {
    return request.headers.get(VERIFIED) === '1' && request.method === 'GET' && !request.body
      ? callback(request) : toPage(request);
  }
  return handlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (request.nextUrl.pathname.endsWith('/signin/email')) return sendCode(request);
  if (request.nextUrl.pathname.endsWith('/verify')) return verify(request);
  return handlers.POST(request);
}
