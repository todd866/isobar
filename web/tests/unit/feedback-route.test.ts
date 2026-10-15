import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  overAfter: vi.fn(),
  recordThrottle: vi.fn(),
}));
vi.mock('@/lib/server/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/server/prisma', () => ({ db: () => ({ feedback: { create: mocks.create, findMany: mocks.findMany } }) }));
vi.mock('@/lib/server/throttle', () => ({ overAfter: mocks.overAfter, record: mocks.recordThrottle }));

import { GET, POST } from '@/app/api/feedback/route';

const record = {
  schema: 'isobar-feedback/1', surface: 'web',
  captured_at: '2026-10-15T04:00:00.000Z', local_time: '2026-10-15T12:00:00+08:00', note: '',
  app: { version: null, build: null, commit: null }, state: {}, recent: [], files: [],
};
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://isobar.md/api/feedback', {
  method: 'POST', headers: { origin: 'https://isobar.md', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ISOBAR_OWNER_EMAIL', 'owner@example.test');
  mocks.auth.mockResolvedValue({ user: { id: 'owner-1', email: 'owner@example.test' } });
  mocks.create.mockResolvedValue({ id: 'feedback-1', createdAt: new Date('2026-10-15T04:00:01Z') });
  mocks.findMany.mockResolvedValue([]);
  mocks.overAfter.mockResolvedValue(false);
});

describe('feedback owner API', () => {
  it('hides capability and writes from non-owners', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'other', email: 'other@example.test' } });
    expect((await GET(new Request('https://isobar.md/api/feedback?access=1'))).status).toBe(404);
    expect((await POST(request({ record, screenshot: null }))).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an oversized request before parsing or writing', async () => {
    const response = await POST(request({ record, screenshot: null }, { 'content-length': '700001' }));
    expect(response.status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('stores a valid JPEG payload and returns its id', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const response = await POST(request({ record: { ...record, files: ['screen.jpg'] }, screenshot: jpeg }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'feedback-1', createdAt: '2026-10-15T04:00:01.000Z' });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ surface: 'web', screenshot: expect.any(Uint8Array) }) }));
  });

  it('rejects a missing owner id and mismatched image metadata', async () => {
    mocks.auth.mockResolvedValue({ user: { email: 'owner@example.test' } });
    expect((await POST(request({ record, screenshot: null }))).status).toBe(404);
    mocks.auth.mockResolvedValue({ user: { id: 'owner-1', email: 'owner@example.test' } });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    expect((await POST(request({ record, screenshot: jpeg }))).status).toBe(400);
  });

  it('limits writes in a one-minute window', async () => {
    for (let i = 0; i < 11; i++) expect((await POST(request({ record, screenshot: null }))).status).toBe(201);
    mocks.overAfter.mockResolvedValue(true);
    expect((await POST(request({ record, screenshot: null }))).status).toBe(429);
  });

  it('passes a valid since cursor to the listing query', async () => {
    const response = await GET(new Request('https://isobar.md/api/feedback?since=2026-10-15T04:00:00.000Z'));
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdAt: { gt: new Date('2026-10-15T04:00:00.000Z') } } }));
  });
});

describe('feedback ingress edges', () => {
  it('caps the streamed body even without content-length', async () => {
    expect((await POST(request({ padding: 'x'.repeat(700_001) }))).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('fails closed for signed out, unconfigured owner, and auth errors', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request('https://isobar.md/api/feedback'))).status).toBe(404);
    mocks.auth.mockResolvedValue({ user: { id: 'owner-1', email: 'owner@example.test' } });
    vi.stubEnv('ISOBAR_OWNER_EMAIL', '');
    expect((await GET(new Request('https://isobar.md/api/feedback?access=1'))).status).toBe(404);
    mocks.auth.mockRejectedValue(new Error('session unavailable'));
    expect((await POST(request({ record, screenshot: null }))).status).toBe(404);
  });
  it('normalizes only empty notes and rejects oversized JPEGs', async () => {
    expect((await POST(request({ record, screenshot: null }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ note: null, record: expect.objectContaining({ note: null }) }) }));
    const image = Buffer.alloc(400_001); image.set([0xff, 0xd8, 0xff]);
    expect((await POST(request({ record: { ...record, files: ['screen.jpg'] }, screenshot: image.toString('base64') }))).status).toBe(400);
  });
});
