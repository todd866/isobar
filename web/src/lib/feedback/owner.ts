import { exactOwner } from '@/lib/agent/token';
import { auth } from '@/lib/server/auth';

export async function ownerSession() {
  const session = await auth().catch(() => null);
  return exactOwner(session?.user?.email, process.env.ISOBAR_OWNER_EMAIL) ? session : null;
}
