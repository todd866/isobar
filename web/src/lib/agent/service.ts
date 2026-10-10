import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { postScreen } from '../chat/watcher';
import { exactOwner, hashAgentToken, TOKEN_PATTERN, type AgentPrincipal, type TokenRecord } from './token';

export const LEASE_MS = 15 * 60_000;
export const MAX_REPLY_CHARS = 20_000;
export const MAX_AGENT_BODY_BYTES = 1_450_000;
export interface ReplyImage { src: string; alt: string }
export interface AgentReply {
  text: string; model: string; toolsUsed: string[]; images: ReplyImage[];
  briefing?: { keyNumbers: string[]; sources: string[] };
  usage?: { promptTokens?: number; completionTokens?: number; latencyMs?: number };
}
export interface Candidate { id: string; threadId: string; createdAt: Date; context: unknown }
export interface ClaimPayload {
  question: string; context: unknown; thread: { role: 'user' | 'assistant'; content: string }[];
  user: { level: string | null; goal: string | null };
}
export type AgentAction = 'pending' | 'claim' | 'reply' | 'release' | 'heartbeat' | 'health';
export interface AgentStore {
  token(hash: string): Promise<TokenRecord | null>;
  touchToken(id: string, now: Date): Promise<boolean>;
  expire(now: Date): Promise<void>;
  next(caller: AgentPrincipal, now: Date, olderThan?: Date): Promise<Candidate | null>;
  claim(caller: AgentPrincipal, row: Candidate, leaseId: string, now: Date, until: Date, host: string, olderThan?: Date): Promise<boolean>;
  payload(row: Candidate): Promise<ClaimPayload>;
  reply(caller: AgentPrincipal, id: string, leaseId: string, now: Date, reply: AgentReply, host: string): Promise<boolean>;
  release(caller: AgentPrincipal, id: string, leaseId: string, now: Date, host: string): Promise<boolean>;
  health(now: Date): Promise<unknown>;
  heartbeat(caller: AgentPrincipal, input: { host: string; role: string; runtime: string; version: string }, now: Date): Promise<void>;
}
export interface AgentDeps {
  store: AgentStore; secret: string; ownerEmail: string | null; now: () => Date;
  limited: (request: Request, tokenId: string | null) => Promise<boolean>;
}
export function agentJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'private, no-store', ...(status === 429 ? { 'retry-after': '20' } : {}) } });
}

// No URL attachments: inline PNGs stay in the private thread and cannot beacon.
export function validPng(src: string): boolean {
  if (src.length > 700_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return false;
  const bytes = Buffer.from(src.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length > 512_000 || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 2048 && height <= 2048;
}
export const STANDBY_MS = 90_000;
const hostSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const claimSchema = z.object({ host: hostSchema, role: z.enum(['primary', 'standby']), standbyMs: z.number().int().min(STANDBY_MS).max(86_400_000).optional() }).strict();
const heartbeatSchema = z.object({ host: hostSchema, role: z.enum(['primary', 'standby']), runtime: z.enum(['idle', 'waiting', 'claude', 'codex', 'cursor']), version: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/) }).strict();
const identity = { id: z.string().min(1).max(128), leaseId: z.string().uuid(), host: hostSchema };
const releaseSchema = z.object(identity).strict();
const replySchema = z.object({
  ...identity,
  text: z.string().trim().min(1).max(MAX_REPLY_CHARS),
  model: z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/),
  toolsUsed: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)).max(32),
  images: z.array(z.object({ src: z.string().refine(validPng), alt: z.string().trim().max(240) }).strict()).max(2).default([]),
  briefing: z.object({ keyNumbers: z.array(z.string().trim().min(1).max(300)).max(24), sources: z.array(z.string().trim().min(1).max(500)).max(24) }).strict().optional(),
  usage: z.object({
    promptTokens: z.number().int().min(0).max(100_000_000).optional(),
    completionTokens: z.number().int().min(0).max(100_000_000).optional(),
    latencyMs: z.number().int().min(0).max(LEASE_MS).optional(),
  }).strict().optional(),
}).strict();

/** The cap applies while reading, including chunked requests without Content-Length. */
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_AGENT_BODY_BYTES) { await reader.cancel(); throw new Error('body'); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

export async function claimNext(caller: AgentPrincipal, store: AgentStore, now: () => Date, options: { host: string; olderThan?: Date }) {
  await store.expire(now());
  // Another daemon may win the CAS after our read; try the next row, bounded.
  for (let race = 0; race < 8; race++) {
    const row = await store.next(caller, now(), options.olderThan);
    if (!row) return null;
    const at = now(), until = new Date(at.getTime() + LEASE_MS), leaseId = randomUUID();
    if (!await store.claim(caller, row, leaseId, at, until, options.host, options.olderThan)) continue;
    try {
      return { id: row.id, ...await store.payload(row), leaseId, leaseUntil: until.toISOString() };
    } catch (error) {
      await store.release(caller, row.id, leaseId, now(), options.host);
      throw error;
    }
  }
  return null;
}

export async function postAgent(action: AgentAction, request: Request, deps: AgentDeps): Promise<Response> {
  if (!deps.secret) return agentJson({ error: 'unavailable' }, 503);
  if (await deps.limited(request, null)) return agentJson({ error: 'rate-limited' }, 429);
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!bearer || !TOKEN_PATTERN.test(bearer)) return agentJson({ error: 'unauthorized' }, 401);
  const caller = await deps.store.token(hashAgentToken(bearer, deps.secret));
  if (!caller || caller.revokedAt || (caller.scope !== 'user' && caller.scope !== 'owner') ||
      (caller.scope === 'owner' && !exactOwner(caller.email, deps.ownerEmail))) return agentJson({ error: 'unauthorized' }, 401);
  if (await deps.limited(request, caller.id)) return agentJson({ error: 'rate-limited' }, 429);
  if (!await deps.store.touchToken(caller.id, deps.now())) return agentJson({ error: 'unauthorized' }, 401);
  if (action === 'pending') return agentJson({ error: 'gone' }, 410);
  if (action === 'health') {
    if (caller.scope !== 'owner') return agentJson({ error: 'forbidden' }, 403);
    return agentJson(await deps.store.health(deps.now()));
  }
  let input: unknown;
  try { input = await body(request); } catch { return agentJson({ error: 'invalid-body' }, 400); }
  if (action === 'claim') {
    const parsed = claimSchema.safeParse(input);
    if (!parsed.success) return agentJson({ error: 'invalid-body' }, 400);
    const { host, role, standbyMs = STANDBY_MS } = parsed.data;
    return agentJson(await claimNext(caller, deps.store, deps.now, { host, olderThan: role === 'standby' ? new Date(deps.now().getTime() - standbyMs) : undefined }));
  }
  if (action === 'heartbeat') {
    if (caller.scope !== 'owner') return agentJson({ error: 'forbidden' }, 403);
    const parsed = heartbeatSchema.safeParse(input);
    if (!parsed.success) return agentJson({ error: 'invalid-body' }, 400);
    await deps.store.heartbeat(caller, parsed.data, deps.now());
    return agentJson({ ok: true });
  }
  if (action === 'release') {
    const parsed = releaseSchema.safeParse(input);
    if (!parsed.success) return agentJson({ error: 'invalid-body' }, 400);
    const ok = await deps.store.release(caller, parsed.data.id, parsed.data.leaseId, deps.now(), parsed.data.host);
    return agentJson(ok ? { ok: true } : { error: 'lease-lost' }, ok ? 200 : 409);
  }
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) return agentJson({ error: 'invalid-body' }, 400);
  const reply = parsed.data;
  const screened = [reply.text, reply.model, ...reply.toolsUsed, ...reply.images.map((image) => image.alt), ...reply.briefing?.keyNumbers ?? [], ...reply.briefing?.sources ?? []].some((text) => postScreen(text, '').hard.length);
  if (screened) return agentJson({ error: 'reply-held' }, 422);
  const ok = await deps.store.reply(caller, reply.id, reply.leaseId, deps.now(), reply, reply.host);
  return agentJson(ok ? { ok: true } : { error: 'lease-lost' }, ok ? 200 : 409);
}
