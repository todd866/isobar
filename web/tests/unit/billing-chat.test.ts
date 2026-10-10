import { describe, expect, it, vi } from 'vitest';
import { freeTier, paidTier, spendForIdentity } from '../../src/lib/billing/budgets';
import type { Entitlement } from '../../src/lib/billing/policy';
import { prismaAgentStore } from '../../src/lib/agent/prisma-store';

const now = new Date('2026-10-09T12:00:00Z');
const paid: Entitlement = {
  userId: 'u1', plan: 'monthly', status: 'active', currentPeriodStart: new Date('2026-10-05T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-05T00:00:00Z'), billingAnchor: new Date('2026-10-05T00:00:00Z'),
  stripeCustomerId: 'cus', stripeSubscriptionId: 'sub', cancelAtPeriodEnd: false, deleting: false,
};

describe('billing chat budgets', () => {
  it('uses the paid ladder boundaries', () => {
    expect(paidTier(0)).toBe('opus');
    expect(paidTier(4.99)).toBe('opus');
    expect(paidTier(5)).toBe('sonnet');
    expect(paidTier(7.99)).toBe('sonnet');
    expect(paidTier(8)).toBe('haiku');
    expect(paidTier(9.99)).toBe('haiku');
    expect(paidTier(10)).toBe('haiku-short');
  });

  it('soft-cuts and rests the free identity at one dollar', () => {
    expect(freeTier(0.79)).toBe('haiku');
    expect(freeTier(0.8)).toBe('haiku-short');
    expect(freeTier(1)).toBe('rest');
  });

  it('tracks a paid billing-period anchor and excludes slow rows', () => {
    expect(spendForIdentity([
      { userId: 'u1', costUsd: 2, createdAt: new Date('2026-10-04T23:59:00Z'), lane: 'fast' },
      { userId: 'u1', costUsd: 3, createdAt: new Date('2026-10-06T00:00:00Z'), lane: 'fast' },
      { userId: 'u1', costUsd: 99, createdAt: new Date('2026-10-07T00:00:00Z'), lane: 'slow' },
      { userId: 'u1', costUsd: 99, createdAt: new Date('2026-10-10T00:00:00Z'), lane: 'fast' },
    ], 'u1', null, now, paid)).toBe(3);
  });

  it('uses the calendar month for expired paid access and ignores future rows', () => {
    const expired = { ...paid, status: 'canceled', currentPeriodEnd: new Date('2026-10-08T00:00:00Z') };
    expect(spendForIdentity([
      { userId: 'u1', costUsd: 2, createdAt: new Date('2026-10-08T01:00:00Z') },
      { userId: 'u1', costUsd: 3, createdAt: new Date('2026-10-09T13:00:00Z') },
    ], 'u1', null, now, expired)).toBe(2);
  });

  it('tracks anonymous spend by device hash', () => {
    expect(spendForIdentity([
      { userId: null, deviceHash: 'd1', costUsd: 0.5, createdAt: new Date('2026-10-08T00:00:00Z') },
      { userId: null, deviceHash: 'd2', costUsd: 0.5, createdAt: new Date('2026-10-08T00:00:00Z') },
    ], null, 'd1', now)).toBe(0.5);
  });

  it('orders an eligible paid slow row ahead of FIFO when billing is enabled', async () => {
    const prior = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY: process.env.STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY: process.env.STRIPE_PRICE_YEARLY };
    Object.assign(process.env, { STRIPE_SECRET_KEY: 'x', STRIPE_WEBHOOK_SECRET: 'x', STRIPE_PRICE_MONTHLY: 'x', STRIPE_PRICE_YEARLY: 'x' });
    const paidRow = { id: 'paid', threadId: 't-paid', context: {}, createdAt: now };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(paidRow);
    const db = {
      chatCluster: { findMany: async () => [{ id: 'suspended' }] }, user: { findUnique: async () => null },
      aiAccessBlock: { findMany: async () => [] },
      chatMessage: { findFirst },
    } as never;
    try {
      const row = await prismaAgentStore(db, null).next({ id: 'agent', userId: 'caller', scope: 'owner' }, now);
      expect(row).toEqual(paidRow);
      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(findFirst.mock.calls[0][0].where.AND[1]).toEqual({ thread: { userId: 'caller' } });
      expect(findFirst.mock.calls[1][0].where.AND[1]).toMatchObject({ thread: { user: { is: { entitlement: { is: { status: 'active', currentPeriodEnd: { gt: now } } } } } } });
      // Priority changes order only: all unsuspended standing tiers stay eligible.
      const eligible = findFirst.mock.calls[1][0].where.AND[0].thread.user.is;
      expect(eligible.OR).toEqual([{ clusterId: null }, { clusterId: { notIn: ['suspended'] } }]);
      expect(eligible.AND).toContainEqual({ id: { notIn: [] } });
      expect(JSON.stringify(eligible)).not.toContain('chatStanding');
      findFirst.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...paidRow, id: 'free' });
      expect((await prismaAgentStore(db, null).next({ id: 'agent', userId: 'caller', scope: 'owner' }, now))?.id).toBe('free');
      expect(findFirst.mock.calls[2][0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      findFirst.mockReset().mockResolvedValueOnce({ ...paidRow, id: 'owner' });
      expect((await prismaAgentStore(db, null).next({ id: 'agent', userId: 'caller', scope: 'owner' }, now))?.id).toBe('owner');
      expect(findFirst).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

});
