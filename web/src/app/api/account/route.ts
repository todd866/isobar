import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth';
import { foreignOrigin } from '@/lib/server/origin';
import { deleteUser } from '@/lib/server/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** Deletes the signed-in user, their sessions and every stored document. */
export async function DELETE(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return NextResponse.json({ error: 'origin' }, { status: 403, headers: NO_STORE });
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'auth' }, { status: 401, headers: NO_STORE });
  try { await deleteUser(session.user.id, session.user.email); }
  catch { return NextResponse.json({ error: 'Account deletion failed. Try again.' }, { status: 503, headers: NO_STORE }); }
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
