#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function usage() { return `Usage:
  ai-block.mjs block --scope global|USER_ID --until ISO --reason TEXT --source TEXT
  ai-block.mjs lift --id ID
  ai-block.mjs list

Writes AiAccessBlock through the configured DATABASE_URL. It never prints secrets.`; }

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!['block', 'lift', 'list'].includes(command)) throw new Error('command must be block, lift, or list');
  const out = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const name = key.slice(2); const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (name in out) throw new Error(`duplicate --${name}`);
    const allowed = command === 'block' ? ['scope', 'until', 'reason', 'source'] : command === 'lift' ? ['id'] : [];
    if (!allowed.includes(name)) throw new Error(`unknown option --${name}`);
    out[name] = value;
  }
  if (command === 'block') {
    if (!out.scope || !out.until || !out.reason || !out.source) throw new Error('block requires --scope, --until, --reason, and --source');
    if (out.scope !== 'global' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(out.scope)) throw new Error('scope must be global or a literal user id');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(out.until)) throw new Error('--until must be an ISO date with timezone');
    const until = new Date(out.until);
    if (!Number.isFinite(until.getTime()) || until <= new Date()) throw new Error('--until must be a future ISO date');
    if (out.reason.length > 1000 || out.source.length > 200) throw new Error('reason or source is too long');
    out.until = until;
  } else if (command === 'lift') {
    if (!out.id || Object.keys(out).some((key) => !['command', 'id'].includes(key))) throw new Error('lift requires exactly --id');
  } else if (Object.keys(out).length !== 1) throw new Error('list takes no options');
  return out;
}

export function activeBlock(row, now = new Date()) { return !!row && !row.liftedAt && new Date(row.until) > now; }

async function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/package.json'));
  const { PrismaClient } = require('@prisma/client');
  const { PrismaNeon } = require('@prisma/adapter-neon');
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.command === 'help') { process.stdout.write(`${usage()}\n`); return; }
  const db = options.db ?? await database();
  try {
    if (args.command === 'block') {
      const row = await db.aiAccessBlock.create({ data: { scope: args.scope, until: args.until, reason: args.reason, source: args.source } });
      process.stdout.write(`${JSON.stringify({ id: row.id, scope: row.scope, until: row.until.toISOString() })}\n`);
    } else if (args.command === 'lift') {
      const result = await db.aiAccessBlock.updateMany({ where: { id: args.id, liftedAt: null }, data: { liftedAt: new Date() } });
      const row = await db.aiAccessBlock.findUnique({ where: { id: args.id }, select: { id: true, liftedAt: true } });
      if (!row) throw new Error('block not found');
      process.stdout.write(`${JSON.stringify({ id: row.id, liftedAt: row.liftedAt?.toISOString() ?? null, changed: result.count === 1 })}\n`);
    } else {
      const rows = await db.aiAccessBlock.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
      process.stdout.write(`${JSON.stringify(rows.map((row) => ({ ...row, active: activeBlock(row) })))}\n`);
    }
  } finally { await db.$disconnect(); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write('ai-block: operation failed\n'); process.exitCode = 1; });
