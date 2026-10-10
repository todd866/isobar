#!/usr/bin/env node
/** Operator-only CLI; never expose this as a route. Does not load env files itself. */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { exactOwner, mintAgentToken, type AgentScope } from '../src/lib/agent/token';

export function tokenOptions(args: string[], ownerEmail: string | undefined) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--email', '--label', '--scope'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('usage');
    values.set(args[i], args[i + 1]);
  }
  const email = values.get('--email')?.trim().toLowerCase();
  const label = values.get('--label')?.trim();
  const scope = values.get('--scope') ?? 'user';
  if (!ownerEmail?.trim() || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !label || label.length > 80 ||
      (scope !== 'owner' && scope !== 'user') || (scope === 'owner' && !exactOwner(email, ownerEmail))) throw new Error('usage');
  return { email, label, scope: scope as AgentScope };
}

async function main(): Promise<void> {
  let database: PrismaClient | undefined;
  try {
    const options = tokenOptions(process.argv.slice(2), process.env.ISOBAR_OWNER_EMAIL);
    const secret = process.env.AUTH_SECRET, connectionString = process.env.DATABASE_URL;
    if (!secret || !connectionString) throw new Error('configuration');
    database = new PrismaClient({ adapter: new PrismaNeon({ connectionString }), log: [] });
    const user = await database.user.findUnique({ where: { email: options.email }, select: { id: true } });
    if (!user) throw new Error('account');
    const minted = mintAgentToken(secret);
    await database.agentToken.create({ data: { userId: user.id, hashedToken: minted.hashedToken, label: options.label, scope: options.scope } });
    process.stdout.write(`${minted.token}\n`);
  } catch {
    // Errors from a DB provider may contain credentials or row data.
    process.stderr.write('Token not minted. Check operator env and existing account. Usage: agent-token.ts --email EMAIL --label LABEL [--scope user|owner]\n');
    process.exitCode = 1;
  } finally { await database?.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
