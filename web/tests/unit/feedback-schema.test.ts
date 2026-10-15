import { describe, expect, it } from 'vitest';
import { feedbackPayloadSchema, feedbackRecordSchema } from '@/lib/feedback/schema';

const record = {
  schema: 'isobar-feedback/1', surface: 'web',
  captured_at: '2026-10-15T04:00:00.000Z', local_time: '2026-10-15T12:00:00+08:00', note: '',
  app: { version: null, build: null, commit: null }, state: {}, recent: [], files: [],
};

describe('feedback record schema', () => {
  it('accepts the shared empty-note record', () => expect(feedbackRecordSchema.parse(record)).toEqual(record));
  it('rejects unknown top-level fields and malformed timestamps', () => {
    expect(feedbackRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
    expect(feedbackRecordSchema.safeParse({ ...record, captured_at: 'now' }).success).toBe(false);
  });
  it('accepts a null screenshot and rejects non-JPEG payloads at the payload boundary', () => {
    expect(feedbackPayloadSchema.safeParse({ record, screenshot: null }).success).toBe(true);
    expect(feedbackPayloadSchema.safeParse({ record, screenshot: 1 }).success).toBe(false);
  });
});
