import 'server-only';

/** Test-only mail transport. Enabled only with AUTH_TEST_MAILBOX=1 on a
 * non-Vercel server (local `next start` under Playwright); never in a deployment. */
export function testMailboxEnabled(): boolean {
  return process.env.AUTH_TEST_MAILBOX === '1' && !process.env.VERCEL && !process.env.VERCEL_ENV;
}

export interface TestMail { to: string; code: string; link: string; at: number }

const store = globalThis as unknown as { isobarTestMailbox?: Map<string, TestMail> };

export function deliverTest(mail: TestMail): void {
  if (!testMailboxEnabled()) throw new Error('test mailbox disabled');
  (store.isobarTestMailbox ??= new Map()).set(mail.to, mail);
}

export function readTest(to: string): TestMail | null {
  if (!testMailboxEnabled()) return null;
  return store.isobarTestMailbox?.get(to.trim().toLowerCase()) ?? null;
}
