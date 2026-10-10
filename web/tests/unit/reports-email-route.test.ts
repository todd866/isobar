import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  foreignOrigin: vi.fn(),
  record: vi.fn(),
  overAfter: vi.fn(),
  emailQuestion: vi.fn(),
}));
vi.mock('../../src/lib/server/auth', () => ({ auth: mocks.auth }));
vi.mock('../../src/lib/server/origin', () => ({ foreignOrigin: mocks.foreignOrigin }));
vi.mock('../../src/lib/server/throttle', () => ({ record: mocks.record, overAfter: mocks.overAfter }));
vi.mock('../../src/lib/reports/server', () => ({ reports: () => ({ emailQuestion: mocks.emailQuestion }) }));

import { POST } from '../../src/app/api/chat/report/route';

const request = (body: unknown, origin = 'https://isobar.md') => new Request('https://isobar.md/api/chat/report', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ISOBAR_REPORTS_ENABLED', '1');
  vi.stubEnv('AUTH_SECRET', 'auth-secret');
  vi.stubEnv('ISOBAR_OWNER_EMAIL', 'owner@example.test');
  vi.stubEnv('DATABASE_URL', 'postgres://db.example.test/isobar');
  vi.stubEnv('RESEND_API_KEY', 'resend-key');
  vi.stubEnv('EMAIL_FROM', 'Isobar <reports@example.test>');
  vi.stubEnv('ISOBAR_REPORT_SENDER_IDENTITY', 'Isobar · Perth WA');
  mocks.foreignOrigin.mockReturnValue(false);
  mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
  mocks.record.mockResolvedValue(undefined);
  mocks.overAfter.mockResolvedValue(false);
});

describe('email detailed report route', () => {
  it('authenticates before returning unavailable while rollout is disabled', async () => {
    vi.stubEnv('ISOBAR_REPORTS_ENABLED', '0');
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(503);
    expect(mocks.emailQuestion).not.toHaveBeenCalled();
  });
  it('requires same-origin and a signed-in session', async () => {
    mocks.foreignOrigin.mockReturnValue(true);
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(403);
    mocks.foreignOrigin.mockReturnValue(false);
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(401);
    expect(mocks.emailQuestion).not.toHaveBeenCalled();
  });

  it('accepts only a strict bounded messageId object', async () => {
    for (const body of [null, {}, { messageId: '' }, { messageId: 'x'.repeat(129) }, { messageId: 'm1', extra: true }, { messageId: 4 }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(mocks.emailQuestion).not.toHaveBeenCalled();
  });

  it('rejects a throttled user before queueing a report', async () => {
    mocks.overAfter.mockResolvedValue(true);
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(429);
    expect(mocks.record).toHaveBeenCalledWith('chatUser', 'alice');
    expect(mocks.emailQuestion).not.toHaveBeenCalled();
  });

  it('returns the queued report result and binds it to the session user', async () => {
    mocks.emailQuestion.mockResolvedValue({ ok: true, line: 'I’ll email you a detailed report.', reportId: 'report-1' });
    const response = await POST(request({ messageId: 'm1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, line: 'I’ll email you a detailed report.', reportId: 'report-1' });
    expect(mocks.emailQuestion).toHaveBeenCalledWith('alice', 'm1');
  });

  it('returns a conflict when the service cannot queue the request', async () => {
    mocks.emailQuestion.mockResolvedValue({ ok: false, line: 'A report is already being prepared.' });
    const response = await POST(request({ messageId: 'm1' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, line: 'A report is already being prepared.' });
  });

  it('fails closed when throttling or the report service is unavailable', async () => {
    mocks.record.mockRejectedValue(new Error('db down'));
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(503);
    mocks.record.mockResolvedValue(undefined);
    mocks.emailQuestion.mockRejectedValue(new Error('service down'));
    expect((await POST(request({ messageId: 'm1' }))).status).toBe(503);
  });
});
