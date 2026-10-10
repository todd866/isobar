import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), record: vi.fn(), overAfter: vi.fn() }));
vi.mock('../../src/lib/server/auth', () => ({ auth: mocks.auth }));
vi.mock('../../src/lib/server/prisma', () => ({ db: mocks.db }));
vi.mock('../../src/lib/server/throttle', () => ({ record: mocks.record, overAfter: mocks.overAfter }));
import { GET } from '../../src/app/api/chat/thread/route';

beforeEach(() => { vi.resetAllMocks(); mocks.overAfter.mockResolvedValue(false); });
describe('signed-in thread route', () => {
  it('returns only place identity and wall time from map context', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
    const createdAt = new Date('2026-10-09T00:00:00Z');
    const rows = [{ id: 'm', role: 'user', lane: 'fast', status: 'complete', content: 'Why?', model: null, createdAt, images: [],
      context: { place: { id: 'perth', name: 'Perth', zone: 'PRIVATE ZONE' }, timeUtc: 'PRIVATE TIME', lens: 'PRIVATE LENS',
        camera: { lat: 10, lon: 20, zoom: 5 }, point: { lat: 49.888, lon: -119.496, name: 'Kelowna', profile: 'PRIVATE PROFILE' } } }];
    mocks.db.mockReturnValue({ chatThread: { findFirst: vi.fn(async () => ({ id: 'thread' })) }, chatMessage: { findMany: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]) } });
    const response = await GET(new Request('https://isobar.test/api/chat/thread'));
    const body = await response.json();
    expect(body.messages[0]).toEqual({ id: 'm', role: 'user', lane: 'fast', status: 'complete', content: 'Why?', model: null,
      createdAt: createdAt.toISOString(), placeKey: 'place:kelowna', images: [] });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|context|camera|profile|lens|timeUtc/);
  });

  it('rejects signed-out without constructing a DB client', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request('https://isobar.test/api/chat/thread'))).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('binds requested thread id to session user; another thread is not found', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
    const findFirst = vi.fn(async () => null);
    mocks.db.mockReturnValue({ chatThread: { findFirst } });
    const response = await GET(new Request('https://isobar.test/api/chat/thread?id=bob-thread'));
    expect(response.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'alice', id: 'bob-thread' } }));
    expect(mocks.record).toHaveBeenCalledWith('chatThread', 'alice');
  });
});

it('returns soft caveats and safe hard reasons while withholding original held content and owner reasons', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
  const base = { role: 'assistant', lane: 'fast', model: 'claude-sonnet-5-5', createdAt: new Date('2026-10-09T00:00:00Z'), images: [] };
  const rows = [
    { ...base, id: 'soft', status: 'complete', content: 'Useful weather answer.', gradeReason: 'soft: owner reason', context: { check: { severity: 'soft', line: 'Wind direction was estimated.' } } },
    { ...base, id: 'hard', status: 'held', content: 'PRIVATE ORIGINAL', gradeReason: 'held: PRIVATE REASON', context: { check: { severity: 'hard', line: 'Not answered: that reply exposed private information.' }, anchors: { places: [{ text: 'PRIVATE ANCHOR' }], times: [] } } },
    { ...base, id: 'legacy', status: 'held', content: 'PRIVATE ORIGINAL', context: null },
  ];
  mocks.db.mockReturnValue({ chatThread: { findFirst: vi.fn(async () => ({ id: 'thread' })) }, chatMessage: { findMany: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]) } });
  const response = await GET(new Request('https://isobar.test/api/chat/thread'));
  const json = await response.json();
  expect(json.messages.find((row: { id: string }) => row.id === 'soft')).toMatchObject({ content: 'Useful weather answer.', caveat: 'Wind direction was estimated.' });
  expect(json.messages.find((row: { id: string }) => row.id === 'hard')).toMatchObject({ content: 'Not answered: that reply exposed private information.' });
  expect(JSON.stringify(json)).not.toMatch(/PRIVATE|owner reason|Reply held/);
});

it('hydrates report placeholders into the existing slow-reply polling contract',async()=>{
 mocks.auth.mockResolvedValue({user:{id:'alice'}});
 const row={id:'report-run',role:'assistant',lane:'report',status:'pending',content:'',model:null,createdAt:new Date('2026-10-09T00:00:00Z'),images:[],context:{source:'report'}};
 mocks.db.mockReturnValue({chatThread:{findFirst:vi.fn(async()=>({id:'thread'}))},chatMessage:{findMany:vi.fn().mockResolvedValue([row])}});
 const body=await (await GET(new Request('https://isobar.test/api/chat/thread'))).json();
 expect(body.messages).toHaveLength(1);expect(body.messages[0]).toMatchObject({id:'report-run',lane:'slow',status:'pending'});
});

it('hydrates a report offer and its run ID without exposing the internal report draft', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'alice' } });
  const row = { id: 'offer', role: 'assistant', lane: 'fast', status: 'complete', content: 'This question needs a detailed report.', model: null,
    createdAt: new Date('2026-10-09T00:00:00Z'), images: [], context: { reportOffer: true, reportId: 'report-run', userMessageId: 'question', reportDraft: { secret: 'PRIVATE' } } };
  mocks.db.mockReturnValue({ chatThread: { findFirst: vi.fn(async () => ({ id: 'thread' })) }, chatMessage: { findMany: vi.fn().mockResolvedValue([row]) } });
  const body = await (await GET(new Request('https://isobar.test/api/chat/thread'))).json();
  expect(body.messages[0]).toMatchObject({ reportOffer: true, reportId: 'report-run', userMessageId: 'question' });
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|reportDraft/);
});
