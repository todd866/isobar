import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { feedbackPayloadSchema } from '@/lib/feedback/schema';
import { ownerSession } from '@/lib/feedback/owner';
import { db } from '@/lib/server/prisma';
import { foreignOrigin } from '@/lib/server/origin';
import { overAfter, record as recordThrottle } from '@/lib/server/throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_BODY = 700_000;
const MAX_SCREENSHOT = 400_000;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function decodeScreenshot(value: string | null): Buffer | null | 'invalid' {
  if (value === null) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return 'invalid';
  let bytes: Buffer;
  try { bytes = Buffer.from(value, 'base64'); } catch { return 'invalid'; }
  if (bytes.length > MAX_SCREENSHOT || bytes.length < 3 || bytes.subarray(0, 3).toString('hex') !== 'ffd8ff') return 'invalid';
  return bytes;
}

async function readBodyCapped(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      total += part.value.byteLength;
      if (total > MAX_BODY) { await reader.cancel(); return null; }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export async function GET(request: Request): Promise<Response> {
  if (!await ownerSession()) return json({ error: 'not_found' }, 404);
  const url = new URL(request.url);
  if (url.searchParams.get('access') === '1') return json({ owner: true });
  const since = url.searchParams.get('since');
  let after: Date | undefined;
  if (since) {
    after = new Date(since);
    if (!Number.isFinite(after.getTime())) return json({ error: 'since' }, 400);
  }
  try {
    const rows = await db().feedback.findMany({ where: after ? { createdAt: { gt: after } } : undefined, orderBy: { createdAt: 'asc' }, take: 500 });
    return json({ feedback: rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString(), surface: row.surface, note: row.note, record: row.record, screenshot: row.screenshot ? Buffer.from(row.screenshot).toString('base64') : null })) });
  } catch { return json({ error: 'unavailable' }, 503); }
}

export async function POST(request: Request): Promise<Response> {
  const owner = await ownerSession();
  if (!owner?.user?.id) return json({ error: 'not_found' }, 404);
  if (foreignOrigin(request)) return json({ error: 'origin' }, 403);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return json({ error: 'too_large' }, 413);
  let raw: string | null;
  try { raw = await readBodyCapped(request); } catch { return json({ error: 'body' }, 400); }
  if (raw === null) return json({ error: 'too_large' }, 413);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return json({ error: 'body' }, 400); }
  const checked = feedbackPayloadSchema.safeParse(parsed);
  if (!checked.success) return json({ error: 'body' }, 400);
  if (checked.data.record.surface !== 'web') return json({ error: 'body' }, 400);
  const screenshot = decodeScreenshot(checked.data.screenshot);
  if (screenshot === 'invalid') return json({ error: 'screenshot' }, 400);
  const files = checked.data.record.files;
  if ((screenshot && (files.length !== 1 || files[0] !== 'screen.jpg')) || (!screenshot && files.length !== 0)) return json({ error: 'body' }, 400);
  const normalizedRecord = { ...checked.data.record, note: checked.data.record.note || null };
  try {
    await recordThrottle('feedbackUser', owner.user.id);
    if (await overAfter('feedbackUser', owner.user.id)) return json({ error: 'rate_limited' }, 429);
  } catch { return json({ error: 'unavailable' }, 503); }
  try {
    const row = await db().feedback.create({ data: { surface: normalizedRecord.surface, note: normalizedRecord.note, record: normalizedRecord as Prisma.InputJsonValue, screenshot: screenshot ? new Uint8Array(screenshot) : null } });
    return json({ id: row.id, createdAt: row.createdAt.toISOString() }, 201);
  } catch { return json({ error: 'unavailable' }, 503); }
}
