import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  reports: { claim: vi.fn(), maintenance: vi.fn() },
  record: vi.fn(),
  overAfter: vi.fn(),
}));
vi.mock('../../src/lib/server/prisma', () => ({ db: () => ({ agentToken: { findUnique: mocks.token } }) }));
vi.mock('../../src/lib/server/throttle', () => ({ clientIp: () => '127.0.0.1', record: mocks.record, overAfter: mocks.overAfter }));
vi.mock('../../src/lib/agent/token', () => ({ exactOwner: () => true, hashAgentToken: () => 'hash', TOKEN_PATTERN: /^token$/ }));
vi.mock('../../src/lib/reports/server', () => ({ reports: () => mocks.reports }));
vi.mock('../../src/lib/reports/config', () => ({ reportsEnabled: () => false }));

import { POST } from '../../src/app/api/agent/reports/route';

const request = (action: 'claim' | 'maintenance') => new Request('https://isobar.md/api/agent/reports', {
  method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
  body: JSON.stringify({ action, host: 'isobar', role: 'primary' }),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_SECRET', 'auth-secret');
  vi.stubEnv('ISOBAR_OWNER_EMAIL', 'owner@example.test');
  mocks.token.mockResolvedValue({ id: 'agent-token', revokedAt: null, scope: 'owner', user: { email: 'owner@example.test' } });
  mocks.record.mockResolvedValue(undefined);
  mocks.overAfter.mockResolvedValue(false);
});

describe('disabled report agent routes', () => {
  it.each(['claim', 'maintenance'] as const)('returns no work for %s without invoking the service', async (action) => {
    const response = await POST(request(action));
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(mocks.reports[action]).not.toHaveBeenCalled();
  });
});
