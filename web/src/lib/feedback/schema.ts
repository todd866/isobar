import { z } from 'zod';

const nullableText = z.string().nullable();

/** Shared web/Mac complaint record. Keep field names in lockstep with the Mac inbox format. */
export const feedbackRecordSchema = z.object({
  schema: z.literal('isobar-feedback/1'),
  surface: z.enum(['mac', 'web']),
  captured_at: z.string().datetime({ offset: true }),
  local_time: z.string().datetime({ offset: true }).nullable(),
  note: z.string().max(20_000).nullable(),
  app: z.object({
    version: nullableText,
    build: nullableText,
    commit: nullableText,
  }).strict(),
  state: z.record(z.string(), z.unknown()),
  recent: z.array(z.record(z.string(), z.unknown())).max(500),
  files: z.array(z.enum(['screen.jpg', 'screen.png'])).max(1),
}).strict();

export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;

export const feedbackPayloadSchema = z.object({
  record: feedbackRecordSchema,
  screenshot: z.string().nullable(),
}).strict();

export type FeedbackPayload = z.infer<typeof feedbackPayloadSchema>;
