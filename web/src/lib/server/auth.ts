import 'server-only';
import { normalEmail } from '@/lib/account/email';
import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { Adapter } from 'next-auth/adapters';
import { randomInt } from 'node:crypto';
import { db } from './prisma';
import { deliverTest, testMailboxEnabled } from './mailbox';
import { landingLink, signInEmail } from '../account/email';

/** Ten minutes: an 8-digit code must not live long. */
export const CODE_MAX_AGE_S = 600;

function adapter(): Adapter {
  const base = PrismaAdapter(db()) as Adapter;
  return {
    ...base,
    // Only the newest code for an address is valid.
    async createVerificationToken(token) {
      await db().verificationToken.deleteMany({ where: { identifier: token.identifier } });
      return base.createVerificationToken!(token);
    },
    // Signing out after the account was deleted finds no session: not an error.
    async deleteSession(sessionToken) {
      await db().session.deleteMany({ where: { sessionToken } });
    },
    // Single use, and a wrong code is a miss rather than a failed delete.
    async useVerificationToken({ identifier, token }) {
      const row = await db().verificationToken.findUnique({ where: { identifier_token: { identifier, token } } });
      if (!row) return null;
      const used = await db().verificationToken.deleteMany({ where: { identifier, token } });
      return used.count === 1 ? row : null;
    },
  };
}

async function send(to: string, code: string, link: string): Promise<void> {
  if (testMailboxEnabled()) {
    deliverTest({ to, code, link, at: Date.now() });
    return;
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error('email is not configured');
  const mail = signInEmail(code, link);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: mail.subject, html: mail.html, text: mail.text }),
  });
  // Status only: the response can echo the address.
  if (!response.ok) throw new Error(`email send failed (${response.status})`);
}

export const { auth, handlers, signOut } = NextAuth(() => ({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  adapter: adapter(),
  session: { strategy: 'database', maxAge: 180 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  providers: [
    Resend({
      id: 'email',
      name: 'Email',
      from: process.env.EMAIL_FROM,
      maxAge: CODE_MAX_AGE_S,
      generateVerificationToken: () => String(randomInt(0, 100_000_000)).padStart(8, '0'),
      normalizeIdentifier: (identifier: string) => {
        const email = normalEmail(identifier);
        if (!email) throw new Error('Invalid email');
        return email;
      },
      async sendVerificationRequest({ identifier, url, token }) {
        const parsed = new URL(url);
        await send(identifier, token, landingLink(parsed.origin, parsed.searchParams.get('callbackUrl'), token, identifier));
      },
    }),
  ],
  // Every outcome returns to the app; the account sheet reads ?signin_error.
  pages: { signIn: '/', verifyRequest: '/', error: '/' },
  callbacks: {
    session({ session, user }) {
      return { expires: session.expires, user: { id: user.id, email: user.email } } as typeof session;
    },
  },
  logger: {
    // Auth.js errors can carry the address or token in `cause`; log the kind only.
    error(error) { console.error(`[auth] ${(error as { type?: string }).type ?? error.name}`); },
    warn(code) { console.warn(`[auth] ${code}`); },
    debug() {},
  },
}));
