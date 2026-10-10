import { describe, expect, it } from 'vitest';
import { activeAccessBlock } from '../../src/lib/chat/access-block';

function database(rows: any[]) {
  return { aiAccessBlock: { findFirst: async ({ where }: any) => rows.find((row) => where.scope.in.includes(row.scope) && row.liftedAt === null && row.until > where.until.gt) ?? null } } as any;
}

describe('supervisor access blocks', () => {
  it('blocks global and user scopes, including the owner, then permits expiry or lift', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const global = { scope: 'global', until: new Date(now.getTime() + 60_000), liftedAt: null, reason: 'window' };
    const db = database([global]);
    expect((await activeAccessBlock(db, 'owner', now)).blocked).toBe(true);
    global.until = new Date(now.getTime());
    expect((await activeAccessBlock(db, 'owner', now)).blocked).toBe(false);
    const user = { scope: 'alice', until: new Date(now.getTime() + 60_000), liftedAt: null, reason: 'user' };
    const userDb = database([user]);
    expect((await activeAccessBlock(userDb, 'alice', now)).blocked).toBe(true);
    expect((await activeAccessBlock(userDb, 'bob', now)).blocked).toBe(false);
    user.liftedAt = now;
    expect((await activeAccessBlock(userDb, 'alice', now)).blocked).toBe(false);
  });

  it('fails closed when the supervisor table cannot be read', async () => {
    const broken = { aiAccessBlock: { findFirst: async () => { throw new Error('offline'); } } } as any;
    expect((await activeAccessBlock(broken, null, new Date())).blocked).toBe(true);
  });
});
