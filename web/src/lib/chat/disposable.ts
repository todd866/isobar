/** Disposable mailbox domains. A local list: no lookup, no network. */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'yopmail.com', 'yopmail.fr',
  'tempmail.com', 'temp-mail.org', 'tempmailo.com', '10minutemail.com', '10minutemail.net', 'trashmail.com',
  'trash-mail.com', 'getnada.com', 'dispostable.com', 'mailnesia.com', 'maildrop.cc', 'fakeinbox.com',
  'throwawaymail.com', 'mohmal.com', 'emailondeck.com', 'spam4.me', 'mintemail.com', 'mytemp.email',
  'tempail.com', 'burnermail.io', 'pokemail.net', 'spamgourmet.com', 'mailcatch.com', 'inboxkitten.com',
  'tmpmail.net', 'tmpmail.org', 'discard.email', 'discardmail.com', 'mailnull.com', 'getairmail.com',
  'moakt.com', 'emailfake.com', 'generator.email', 'tempinbox.com', 'guerrillamail.info', 'mailpoof.com',
];

const SET = new Set(DISPOSABLE_DOMAINS);

export function disposableDomain(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && SET.has(domain);
}
