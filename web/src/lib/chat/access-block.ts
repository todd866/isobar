import type { PrismaClient } from '@prisma/client';

export const ACCESS_REST_LINE = 'Chat is resting. Please try again later.';
/** Indexed, uncached stop switch: expiry and lift take effect on the next check. */
/** Scopes: 'global', a userId, or `device:<deviceHash>` for a signed-out device (md3 ai-watch, 9 Oct). */
export async function activeAccessBlock(database: Pick<PrismaClient, 'aiAccessBlock'>, userId: string | null, now = new Date(), deviceHash: string | null = null): Promise<{ blocked: boolean }> {
  try {
    const row = await database.aiAccessBlock.findFirst({
      where: { scope: { in: ['global', ...(userId ? [userId] : []), ...(deviceHash ? [`device:${deviceHash}`] : [])] }, liftedAt: null, until: { gt: now } },
      select: { id: true },
    });
    return { blocked: !!row };
  } catch { return { blocked: true }; }
}
