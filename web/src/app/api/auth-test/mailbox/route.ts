import { NextResponse, type NextRequest } from 'next/server';
import { readTest, testMailboxEnabled } from '@/lib/server/mailbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Playwright reads the last sign-in mail here. 404 unless AUTH_TEST_MAILBOX=1 off Vercel. */
export function GET(request: NextRequest): Response {
  if (!testMailboxEnabled()) return new NextResponse(null, { status: 404 });
  const mail = readTest(request.nextUrl.searchParams.get('email') ?? '');
  return mail ? NextResponse.json(mail, { headers: { 'Cache-Control': 'no-store' } }) : new NextResponse(null, { status: 404 });
}
