import 'server-only';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Node before 22 has no global WebSocket; Vercel's runtime and local Node 24 do.
if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { isobarPrisma?: PrismaClient };

/** Accounts are optional. A local or preview run with no database stays signed out. */
export function databaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function create(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString }), log: ['error'] });
}

/** One client per server instance, created on first use (never at build time). */
export function db(): PrismaClient {
  globalForPrisma.isobarPrisma ??= create();
  return globalForPrisma.isobarPrisma;
}
