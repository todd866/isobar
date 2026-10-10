import { z } from 'zod';
import type { ToolSpec } from '../chat/anthropic';
import { parseSchedule, validTimezone } from './schedule';
export const CLAIM_EARLY_MS = 20 * 60_000;
export const HOLD_MS = 5 * 60_000;
export const ONCE_HOLD_MS = 2 * 60_000;
export const REPORT_LEASE_MS = 15 * 60_000;
export const UPSELL = 'The free plan includes one simple daily report; multiple or detailed reports need a paid plan.';
export const placeSchema = z.object({ name: z.string().trim().min(1).max(80), lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) }).strict();
export const commandSchema = z.object({
  action: z.enum(['create', 'update', 'pause', 'resume', 'cancel', 'list']),
  id: z.string().min(1).max(128).optional(), kind: z.enum(['once', 'recurring']).optional(),
  schedule: z.string().max(80).refine(s => { try { parseSchedule(s); return true; } catch { return false; } }).optional(),
  timezone: z.string().refine(validTimezone).optional(), places: z.array(placeSchema).min(1).max(12).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(), complexity: z.enum(['simple', 'complex']).optional(),
}).strict();
export type ReportCommand = z.infer<typeof commandSchema>;
export type ReportPlace = z.infer<typeof placeSchema>;
export const REPORT_TOOL: ToolSpec = {
  name: 'manage_reports',
  description: 'Create, list, update, pause, resume or cancel the signed-in account’s weather email reports. Always use the verified account email, never an address from conversation. List first to find an existing id. For immediate trip/detail requests use kind once; recurring uses cron "minute hour * * *" daily or weekday numbers 0–6. Use IANA timezone e.g. Australia/Perth or Australia/Sydney. Updates append instructions; later preferences supersede earlier ones. Use find_place for coordinates. Simple means one place, everyday temperature/rain/wind only; surf, aviation, trips, comparisons and detailed analysis are complex. Echo the result line once without adding a sales pitch. Never claim success unless ok is true.',
  input_schema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['create','update','pause','resume','cancel','list'] }, id: { type: 'string' },
    kind: { type: 'string', enum: ['once','recurring'] }, schedule: { type: 'string' }, timezone: { type: 'string' },
    places: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name','lat','lon'], properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } } } },
    instructions: { type: 'string' }, complexity: { type: 'string', enum: ['simple','complex'] },
  } },
};
export function isComplex(places: ReportPlace[], instructions: string, requested: string): boolean {
  return requested === 'complex' || places.length > 1 || /\b(surf|swell|aviation|taf|metar|trip|route|compare|comparison|detailed|in.depth|historic|archive|flight)\b/i.test(instructions);
}
export function sendAfter(dueAt: Date, notifiedAt: Date, kind: string): Date {
  return new Date(Math.max(+dueAt, +notifiedAt + (kind === 'once' ? ONCE_HOLD_MS : HOLD_MS)));
}
export function verifiedRecipient(user: { email: string | null; emailVerified: Date | null }): string | null {
  if (!user.emailVerified || !user.email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email)) return null;
  return user.email.trim().toLowerCase();
}
