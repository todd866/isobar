import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  databaseConfigured: vi.fn(() => true),
  db: vi.fn(() => { throw new Error('database should not be touched'); }),
  record: vi.fn(),
  overAfter: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../src/lib/server/auth', () => ({ auth: mocks.auth }));
vi.mock('../../src/lib/server/prisma', () => ({ databaseConfigured: mocks.databaseConfigured, db: mocks.db }));
vi.mock('../../src/lib/server/throttle', () => ({ record: mocks.record, overAfter: mocks.overAfter }));
vi.mock('../../src/lib/server/origin', () => ({ foreignOrigin: () => false, requestOrigin: () => 'https://isobar.md' }));
vi.mock('../../src/lib/chat/handler', () => ({ chatEnv: () => ({ authSecret: 'unused' }) }));
vi.mock('../../src/lib/chat/identity', () => ({
  DEVICE_COOKIE: 'device', clientIp: () => '198.51.100.10', cookieHeader: () => '', cookieValue: () => null,
  newDevice: () => ({ id: 'device', cookie: 'device=1' }), readDevice: () => null,
}));

import { POST } from '../../src/app/api/usage/route';

describe('usage route test traffic', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops marked traffic before database configuration, throttling, or auth', async () => {
    const response = await POST(new Request('https://isobar.md/api/usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'isobar-test': '1' },
      body: JSON.stringify({ events: [{ kind: 'lens', at: new Date().toISOString(), payload: {} }] }),
    }));
    expect(response.status).toBe(204);
    expect(mocks.databaseConfigured).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.overAfter).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
