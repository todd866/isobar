#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INBOX = join(process.env.HOME || '', 'Library/Application Support/Isobar/feedback');

export function parseArgs(argv) {
  const out = { since: null, inbox: DEFAULT_INBOX };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg !== '--since' && arg !== '--inbox') throw new Error(`unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--since') {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error('--since must be an ISO date');
      out.since = date;
    } else out.inbox = resolve(value);
  }
  return out;
}

export function shortId(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 6);
}

function iso(value, fallback) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
}

export function documentFor(row) {
  const source = row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? row.record : {};
  const capturedAt = iso(source.captured_at, row.createdAt);
  const hasScreen = row.screenshot != null && byteLength(row.screenshot) > 0;
  const declaredPng = Array.isArray(source.files) && source.files.includes('screen.png');
  const screenName = declaredPng ? 'screen.png' : 'screen.jpg';
  const files = hasScreen ? [screenName] : [];
  return {
    schema: 'isobar-feedback/1',
    surface: row.surface === 'mac' ? 'mac' : 'web',
    captured_at: capturedAt,
    local_time: typeof source.local_time === 'string' ? source.local_time : null,
    note: row.note || null,
    app: source.app ?? { version: null, build: null, commit: null },
    state: source.state ?? {},
    recent: Array.isArray(source.recent) ? source.recent : [],
    files,
  };
}

function byteLength(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'base64');
  return value.byteLength ?? value.length ?? 0;
}

function screenshotBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.from(value);
}

async function writeRecord(row, inbox, document) {
  const date = new Date(document.captured_at);
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? shortId(row.id) : shortId(`${row.id}:${attempt}`);
    const directory = `${stamp}-${document.surface}-${suffix}`;
    const target = join(inbox, directory);
    try {
      const sourceId = await readFile(join(target, '.source-id'), 'utf8');
      if (sourceId.trim() === String(row.id)) return false;
      continue;
    } catch (error) {
      if (error.code === 'ENOENT') {
        try { await access(target); } catch (missing) {
          if (missing.code === 'ENOENT') { /* target is available */ } else throw missing;
        }
        // An existing directory from an older pull has no sidecar; preserve it
        // and use the next deterministic suffix.
        try { await access(target); continue; } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      } else throw error;
    }
    const staging = await mkdtemp(join(inbox, `.feedback-${shortId(row.id)}-`));
    try {
      await writeFile(join(staging, 'feedback.json'), `${JSON.stringify(document)}\n`, { encoding: 'utf8', flag: 'wx' });
      const image = screenshotBuffer(row.screenshot);
      if (image) await writeFile(join(staging, document.files[0]), image, { flag: 'wx' });
      await writeFile(join(staging, '.source-id'), `${String(row.id)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(staging, target);
      return true;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        try {
          const sourceId = await readFile(join(target, '.source-id'), 'utf8');
          if (sourceId.trim() === String(row.id)) return false;
        } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`could not allocate feedback directory for ${String(row.id)}`);
}

async function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const require = createRequire(join(ROOT, '../web/package.json'));
  const { PrismaClient } = require('@prisma/client');
  const { PrismaNeon } = require('@prisma/adapter-neon');
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });
}

export async function pull(options = {}) {
  const inbox = resolve(options.inbox ?? DEFAULT_INBOX);
  await mkdir(inbox, { recursive: true });
  const db = options.db ?? await database();
  const ownsDb = !options.db;
  try {
    const where = options.since ? { createdAt: { gt: options.since } } : undefined;
    const rows = await db.feedback.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    let written = 0;
    for (const row of rows) {
      if (await writeRecord(row, inbox, documentFor(row))) written += 1;
    }
    return { found: rows.length, written, skipped: rows.length - written };
  } finally { if (ownsDb) await db.$disconnect(); }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('Usage: feedback-pull.mjs [--since ISO] [--inbox PATH]\n'); return; }
  const result = await pull({ ...args, ...options });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { process.stderr.write(`feedback-pull: ${error.message}\n`); process.exitCode = 1; });
