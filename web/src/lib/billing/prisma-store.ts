import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { BillingConflict, type BillingStore } from './service';

export function prismaBillingStore(database: PrismaClient): BillingStore {
  return {
    get: (userId) => database.entitlement.findUnique({ where: { userId } }),
    async userForCustomer(stripeCustomerId) {
      return (await database.entitlement.findUnique({ where: { stripeCustomerId }, select: { userId: true } }))?.userId ?? null;
    },
    async locked(userId, fn) {
      return database.$transaction(async (tx) => {
        // Existing user lock also serializes a checkout against account deletion.
        // READ COMMITTED + read-after-lock lets a waiter see the previous commit.
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        if (!rows.length) throw new BillingConflict('Account no longer exists');
        return fn({
          row: () => tx.entitlement.findUnique({ where: { userId } }),
          async save(patch) {
            await tx.entitlement.upsert({ where: { userId }, create: { userId, ...patch }, update: patch });
          },
          async checkoutSessionId() { return (await tx.entitlement.findUnique({ where: { userId }, select: { checkoutSessionId: true } }))?.checkoutSessionId ?? null; },
          async seen(id) { return !!await tx.billingEvent.findUnique({ where: { id }, select: { id: true } }); },
          async mark(id) { await tx.billingEvent.create({ data: { id } }); },
          async removeUser(email) {
            await tx.usageEvent.updateMany({ where: { userId }, data: { userId: null } });
            await tx.verificationToken.deleteMany({ where: { identifier: email ?? '' } });
            await tx.user.delete({ where: { id: userId } });
          },
        });
      }, { maxWait: 10_000, timeout: 60_000 });
    },
  };
}
