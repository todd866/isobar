import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentFor, parseArgs, pull, shortId } from '../../../tools/feedback-pull.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const inbox = await mkdtemp(join(tmpdir(), 'isobar-feedback-'));
  dirs.push(inbox);
  const rows = [{
    id: 'feedback-1', createdAt: new Date('2026-10-15T03:04:05.000Z'), surface: 'web', note: 'map jumped',
    record: { captured_at: '2026-10-15T03:04:05.000Z', local_time: '2026-10-15T11:04:05+08:00', app: { version: '1', build: '2', commit: 'abc' }, state: { lens: 'pressure' }, recent: [{ type: 'seek' }] },
    screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  }];
  return { inbox, rows, db: { feedback: { findMany: async () => rows } } };
}

describe('feedback-pull', () => {
  it('writes the shared record and JPEG atomically', async () => {
    const { inbox, rows, db } = await fixture();
    await expect(pull({ inbox, db })).resolves.toEqual({ found: 1, written: 1, skipped: 0 });
    const [directory] = await readdir(inbox);
    expect(directory).toMatch(/^20261015T030405Z-web-[0-9a-f]{6}$/);
    const record = JSON.parse(await readFile(join(inbox, directory, 'feedback.json'), 'utf8'));
    expect(record).toMatchObject({ schema: 'isobar-feedback/1', surface: 'web', note: 'map jumped', files: ['screen.jpg'] });
    expect(await readFile(join(inbox, directory, 'screen.jpg'))).toEqual(rows[0].screenshot);
  });

  it('skips an id already present on a repeated pull', async () => {
    const { inbox, db } = await fixture();
    await pull({ inbox, db });
    await expect(pull({ inbox, db })).resolves.toEqual({ found: 1, written: 0, skipped: 1 });
    expect((await readdir(inbox)).filter((name) => !name.startsWith('.feedback-'))).toHaveLength(1);
  });

  it('selects an alternate suffix around a different source id', async () => {
    const { inbox, rows, db } = await fixture();
    const occupied = join(inbox, `20261015T030405Z-web-${shortId(rows[0].id)}`);
    await mkdir(occupied);
    await writeFile(join(occupied, '.source-id'), 'another-feedback\n');
    await expect(pull({ inbox, db })).resolves.toEqual({ found: 1, written: 1, skipped: 0 });
    const directories = await readdir(inbox);
    expect(directories).toContain(`20261015T030405Z-web-${shortId(rows[0].id)}`);
    expect(directories).toHaveLength(2);
    await expect(pull({ inbox, db })).resolves.toEqual({ found: 1, written: 0, skipped: 1 });
    expect(await readdir(inbox)).toHaveLength(2);
  });

  it('passes a since cursor to Prisma and omits absent screenshots', async () => {
    const { inbox } = await fixture();
    const calls: unknown[] = [];
    const db = { feedback: { findMany: async (args: unknown) => { calls.push(args); return [{ id: 'empty', createdAt: new Date('2026-10-15T03:04:05Z'), surface: 'web', note: '', record: {}, screenshot: null }]; } } };
    await pull({ inbox, db, since: new Date('2026-10-14T00:00:00Z') });
    expect(calls).toEqual([{ where: { createdAt: { gt: new Date('2026-10-14T00:00:00Z') } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }]);
    const [directory] = await readdir(inbox);
    const record = JSON.parse(await readFile(join(inbox, directory, 'feedback.json'), 'utf8'));
    expect(record.note).toBeNull();
    expect(record.local_time).toBeNull();
    expect(record.files).toEqual([]);
  });

  it('honours a source record that declares a PNG screen', async () => {
    const { inbox } = await fixture();
    const db = { feedback: { findMany: async () => [{ id: 'png', createdAt: new Date('2026-10-15T03:04:05Z'), surface: 'web', note: null, record: { files: ['screen.png'] }, screenshot: Buffer.from([1, 2, 3]) }] } };
    await pull({ inbox, db });
    const [directory] = await readdir(inbox);
    expect(JSON.parse(await readFile(join(inbox, directory, 'feedback.json'), 'utf8')).files).toEqual(['screen.png']);
    expect(await readFile(join(inbox, directory, 'screen.png'))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('validates command line cursors and inbox paths', () => {
    expect(parseArgs(['--since', '2026-10-15T00:00:00Z', '--inbox', '/tmp/inbox'])).toMatchObject({ inbox: '/tmp/inbox' });
    expect(() => parseArgs(['--since', 'later'])).toThrow(/ISO date/);
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown option/);
  });

  it('normalizes non-web surfaces to the shared surface enum', () => {
    expect(documentFor({ id: 'x', createdAt: new Date(), surface: 'mac', note: null, record: {}, screenshot: null }).surface).toBe('mac');
    expect(documentFor({ id: 'x', createdAt: new Date(), surface: 'other', note: null, record: {}, screenshot: null }).surface).toBe('web');
  });
});
