import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from './prisma';
import type { DocKind } from '../account/merge';
import { deleteBillingAccount } from '../billing/service';
import { prismaBillingStore } from '../billing/prisma-store';
import { stripeClient } from '../billing/stripe';

export interface StoredDoc { data: unknown; rev: number; updatedAt: string }

const view = (row: { data: unknown; rev: number; updatedAt: Date }): StoredDoc => ({ data: row.data, rev: row.rev, updatedAt: row.updatedAt.toISOString() });

export async function readDocs(userId: string): Promise<Partial<Record<DocKind, StoredDoc>>> {
  const rows = await db().userDoc.findMany({ where: { userId } });
  const out: Partial<Record<DocKind, StoredDoc>> = {};
  for (const row of rows) out[row.kind as DocKind] = view(row);
  return out;
}

export type WriteResult = { ok: true; doc: StoredDoc } | { ok: false; current: StoredDoc | null };

/** Compare-and-set on rev: baseRev 0 creates, otherwise the row must still be at baseRev. */
export async function writeDoc(userId: string, kind: DocKind, baseRev: number, data: unknown): Promise<WriteResult> {
  const json = data as Prisma.InputJsonValue;
  try {
    if (baseRev === 0) {
      return { ok: true, doc: view(await db().userDoc.create({ data: { userId, kind, data: json, rev: 1 } })) };
    }
    // One statement: UPDATE … WHERE userId, kind AND rev = baseRev, returning the row.
    return { ok: true, doc: view(await db().userDoc.update({ where: { userId_kind: { userId, kind }, rev: baseRev }, data: { data: json, rev: { increment: 1 } } })) };
  } catch (error) {
    // P2002: created concurrently. P2025: the rev moved on (or no row yet).
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2025'))) throw error;
  }
  const row = await db().userDoc.findUnique({ where: { userId_kind: { userId, kind } } });
  return { ok: false, current: row ? view(row) : null };
}

/** Deletes the account and its chat. Usage events stay, with the user id cleared. */
export async function deleteUser(userId: string, email: string | null | undefined): Promise<void> {
  await deleteBillingAccount(prismaBillingStore(db()), process.env.STRIPE_SECRET_KEY ? stripeClient(process.env.STRIPE_SECRET_KEY) : null, userId, email ?? null);
}
