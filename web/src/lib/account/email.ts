/** The sign-in email: an 8-digit code (typed into the app, which is how a
 * home-screen install signs in, since the link opens Safari) and a link that
 * carries the same code back to the page the user was on. Pure. */

export const CODE_PARAM = 'signin_code';
export const EMAIL_PARAM = 'signin_email';
export const ERROR_PARAM = 'signin_error';

/** The page to return to, kept only when it is on this site. */
export function safeReturn(origin: string, callbackUrl: string | null | undefined): URL {
  const base = new URL('/', origin);
  if (!callbackUrl) return base;
  try {
    const url = new URL(callbackUrl, origin);
    if (url.origin !== base.origin || url.pathname.startsWith('/api/')) return base;
    for (const key of [CODE_PARAM, EMAIL_PARAM, ERROR_PARAM]) url.searchParams.delete(key);
    url.hash = '';
    return url;
  } catch {
    return base;
  }
}

/** Link in the email: the return page plus the code; the page completes sign-in in script,
 * so a mail scanner fetching the link does not spend the code. */
export function landingLink(origin: string, callbackUrl: string | null | undefined, code: string, email: string): string {
  const url = safeReturn(origin, callbackUrl);
  url.searchParams.set(CODE_PARAM, code);
  url.searchParams.set(EMAIL_PARAM, email);
  return url.toString();
}

/** NextAuth's email callback for a code, returning to `back`. */
export function callbackHref(code: string, email: string, back: string): string {
  return `/api/auth/callback/email?${new URLSearchParams({ token: code, email, callbackUrl: back })}`;
}

export const CODE_DIGITS = 8;

export function isCode(value: string): boolean {
  return /^\d{8}$/.test(value);
}

/** The one address normaliser for sign-in, rate limits and the adapter: NFKC,
 * trimmed, lower case, a plain mailbox only. Anything else (commas, spaces,
 * brackets, display names) is refused rather than reinterpreted, so no two
 * spellings can share an account while counting against different limits. */
export function normalEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').normalize('NFKC').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@,;:<>()\[\]"\\]+@[^\s@,;:<>()\[\]"\\]+\.[^\s@,;:<>()\[\]"\\]+$/.test(value)) return null;
  return value;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInEmail(code: string, link: string): { subject: string; html: string; text: string } {
  const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
  return {
    subject: `Isobar sign-in code ${spaced}`,
    text: `Your Isobar sign-in code: ${spaced}\n\nOr open: ${link}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:420px;margin:0 auto;padding:20px;color:#171d22">
<p style="margin:0 0 6px;font-size:13px;color:#4d5860">Isobar sign-in code</p>
<p style="margin:0 0 18px;font:600 32px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px">${spaced}</p>
<a href="${escape(link)}" style="display:inline-block;background:#1c5888;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Sign in</a>
<p style="margin:18px 0 0;font-size:12px;color:#73777f">Expires in 10 minutes. If you didn't ask for it, ignore this email.</p>
</div>`,
  };
}
