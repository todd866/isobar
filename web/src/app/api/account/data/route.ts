import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { readDocs, writeDoc } from '@/lib/server/store';
import { MAX_BODY_BYTES, checkDoc, parsePut } from '@/lib/account/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const fail = (error: string, status: number, extra: object = {}) => NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) return fail('auth', 401);
  return NextResponse.json({ docs: await readDocs(session.user.id) }, { headers: NO_STORE });
}

/** Body: { kind, baseRev, data }. A 409 returns the current document to merge onto. */
export async function PUT(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return fail('origin', 403);
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return fail('type', 415);
  const session = await auth();
  if (!session?.user?.id) return fail('auth', 401);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail('too-large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail('too-large', 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail('invalid', 400); }
  const put = parsePut(body);
  if (!put.ok) return fail('invalid', 400);
  const checked = checkDoc(put.kind, put.data);
  if (!checked.ok) return fail(checked.error, checked.error === 'too-large' ? 413 : 400);
  const result = await writeDoc(session.user.id, put.kind, put.baseRev, checked.data);
  if (!result.ok) return fail('conflict', 409, { current: result.current });
  return NextResponse.json({ doc: result.doc }, { headers: NO_STORE });
}
