import type { ReportPlace } from './policy';
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
export function reportLink(place: ReportPlace, dueAt: Date): string {
  const url = new URL('https://isobar.md/');
  url.searchParams.set('lat', String(place.lat)); url.searchParams.set('lon', String(place.lon)); url.searchParams.set('time', dueAt.toISOString());
  return url.toString();
}
/** No model-generated markup, remote images, CSS, attachments or arbitrary links. */
export function renderReport(answer: string, places: ReportPlace[], dueAt: Date) {
  const link = reportLink(places[0], dueAt);
  const paragraphs = answer.trim().split(/\n\s*\n/).map(p => `<p style="margin:0 0 12px;white-space:pre-line">${escapeHtml(p)}</p>`).join('');
  return { text: `${answer.trim()}\n\nOpen in isobar.md: ${link}`,
    html: `<article style="font:16px/1.5 -apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#182c36;max-width:620px;margin:auto;padding:20px">${paragraphs}<p><a href="${escapeHtml(link)}">Open in isobar.md</a></p></article>` };
}
export interface Mail { to: string; subject: string; html: string; text: string; headers?: Record<string,string>; replyTo?: string }
export type Deliver = (mail: Mail, key: string) => Promise<string>;
export function resendDelivery(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Deliver {
  return async (mail, key) => {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('mail-unconfigured');
    const response = await fetchImpl('https://api.resend.com/emails', { method:'POST', redirect:'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization:`Bearer ${env.RESEND_API_KEY}`, 'content-type':'application/json', 'Idempotency-Key':key },
      body:JSON.stringify({ from:env.EMAIL_FROM, to:[mail.to], subject:mail.subject, html:mail.html, text:mail.text, reply_to:mail.replyTo, headers:mail.headers }) });
    if (!response.ok) throw new Error('mail-delivery-failed');
    const body = await response.json() as {id?:unknown};
    if (typeof body.id !== 'string') throw new Error('mail-delivery-unconfirmed');
    return body.id;
  };
}
