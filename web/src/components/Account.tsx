'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CODE_PARAM, EMAIL_PARAM, ERROR_PARAM, isCode } from '@/lib/account/email';
import { deleteAccount, getSessionUser, requestCode, signOutHere, type SessionUser } from '@/lib/account/client';
import { UsageNotice } from './UsageNotice';
import { AccountSync } from '@/lib/account/sync';
import { KEYS, SYNCED } from '@/lib/account/local';
import { BillingRow } from './BillingRow';
import { Reports } from './Reports';

/** Accounts: one person control in the rail (desktop) and the tab bar (phone).
 * Signed out it opens one compact sheet: email, then the 8-digit code from the
 * same email. The emailed link also works, but on an iPhone it opens Safari,
 * not the home-screen app, so the code is how the installed app signs in. */

type Step = 'email' | 'code';
type Notice = '' | 'sent' | 'limited' | 'failed' | 'invalid' | 'code' | 'locked' | 'deleteFailed';

const PENDING = 'isobar.account.pending';
const PENDING_MS = 10 * 60_000;

const NOTICE: Record<Exclude<Notice, ''>, string> = {
  sent: 'Code sent',
  limited: 'Too many requests. Try again later.',
  failed: "Couldn't send. Try again.",
  invalid: 'Check the address',
  code: 'Wrong or expired code',
  locked: 'Too many tries. Send a new code.',
  deleteFailed: "Couldn't delete the account. Try again.",
};

interface AccountState {
  user: SessionUser | null;
  ready: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<AccountState>({ user: null, ready: false, open: false, setOpen: () => {} });
export const useAccount = () => useContext(Ctx);

let prefillCode = '';

function readPending(): string {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING) ?? 'null') as { email?: string; at?: number } | null;
    return value?.email && value.at && Date.now() - value.at < PENDING_MS ? value.email : '';
  } catch { return ''; }
}
function writePending(email: string | null) {
  try {
    if (email) localStorage.setItem(PENDING, JSON.stringify({ email, at: Date.now() }));
    else localStorage.removeItem(PENDING);
  } catch { /* private window */ }
}

/** The page to come back to, without sign-in parameters. */
function here(): string {
  const url = new URL(location.href);
  for (const key of [CODE_PARAM, EMAIL_PARAM, ERROR_PARAM]) url.searchParams.delete(key);
  url.hash = '';
  return url.toString();
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>('');
  const [billingSuccess, setBillingSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get(CODE_PARAM);
    const email = params.get(EMAIL_PARAM);
    const error = params.get(ERROR_PARAM);
    const accountRequested = params.get('account') === '1';
    const billingSuccess = params.get('billing') === 'success';
    setBillingSuccess(billingSuccess);
    if (accountRequested) setOpen(true);
    if (code || email || error || accountRequested) {
      const cleaned = new URL(location.href);
      for (const key of [CODE_PARAM, EMAIL_PARAM, ERROR_PARAM, 'account', 'billing']) cleaned.searchParams.delete(key);
      history.replaceState(history.state, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
    }
    // The emailed link opens the code step with the code filled in and the
    // address shown; sign-in waits for a tap. A link alone never signs a browser
    // in, so nobody can sign you into their account (and claim your guest
    // progress) by sending you a link. A mail scanner's fetch spends nothing.
    if (code && email && isCode(code)) {
      writePending(email.trim().toLowerCase());
      prefillCode = code;
      setOpen(true);
    }
    if (error === 'code' || error === 'locked') { setNotice(error); setOpen(true); }
    let sync: AccountSync | null = null;
    let cancelled = false;
    void getSessionUser().then((found) => {
      if (cancelled) return;
      setUser(found);
      setReady(true);
      if (!found) return;
      writePending(null);
      sync = new AccountSync();
      (window as unknown as { isobarSync?: AccountSync }).isobarSync = sync;
    });
    const onSynced = (event: Event) => {
      const kinds = (event as CustomEvent<{ kinds: string[] }>).detail?.kinds ?? [];
      if (!kinds.includes('settings')) return;
      try {
        const theme = localStorage.getItem(KEYS.theme);
        if (theme === 'light' || theme === 'dark') document.documentElement.classList.toggle('dark', theme === 'dark');
      } catch { /* storage blocked */ }
    };
    window.addEventListener(SYNCED, onSynced);
    return () => { cancelled = true; sync?.stop(); window.removeEventListener(SYNCED, onSynced); };
  }, []);

  return (
    <Ctx.Provider value={{ user, ready, open, setOpen }}>
      {children}
      {open ? <AccountSheet user={user} notice={notice} setNotice={setNotice} billingSuccess={billingSuccess} onClose={() => { setOpen(false); setNotice(''); setBillingSuccess(false); }} onSignedOut={() => setUser(null)} /> : null}
    </Ctx.Provider>
  );
}

/** Height the on-screen keyboard takes from the bottom of the layout viewport. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, []);
  return inset;
}

function AccountSheet({ user, notice, setNotice, billingSuccess, onClose, onSignedOut }: {
  user: SessionUser | null;
  notice: Notice;
  setNotice: (notice: Notice) => void;
  billingSuccess: boolean;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const pending = readPending();
  const [step, setStep] = useState<Step>(pending ? 'code' : 'email');
  const [email, setEmail] = useState(pending);
  const [code, setCode] = useState(() => { const c = prefillCode; prefillCode = ''; return c; });
  const [busy, setBusy] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset();

  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('input, button[data-primary]')?.focus({ preventScroll: true });
  }, [step, user]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = useCallback(async () => {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    const result = await requestCode(address, here());
    setBusy(false);
    setNotice(result === 'sent' ? '' : result);
    if (result === 'sent') { writePending(address.toLowerCase()); setStep('code'); setCode(''); }
  }, [email, setNotice]);

  const submit = useCallback(() => {
    const digits = code.replace(/\D/g, '');
    if (!isCode(digits)) { setNotice('code'); return; }
    setBusy(true);
    // A same-origin form post: the server refuses a sign-in it did not see posted
    // from this site, so a link from someone else cannot sign this browser in.
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/auth/verify';
    for (const [name, value] of Object.entries({ code: digits, email: email.trim().toLowerCase(), callbackUrl: here() })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }, [code, email, setNotice]);

  async function signOut() {
    setBusy(true);
    const sync = (window as unknown as { isobarSync?: AccountSync }).isobarSync;
    await sync?.flush();
    sync?.stop();
    await signOutHere();
    setBusy(false);
    onSignedOut();
    onClose();
  }

  async function remove() {
    if (!window.confirm('Delete your Isobar account and cancel its subscription? Progress on this device stays.')) return;
    setBusy(true);
    const sync = (window as unknown as { isobarSync?: AccountSync }).isobarSync;
    sync?.stop();
    const ok = await deleteAccount();
    if (ok) await signOutHere();
    setBusy(false);
    if (ok) { onSignedOut(); onClose(); }
    else setNotice('deleteFailed');
  }

  const field = 'h-10 min-w-0 flex-1 rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-3 text-[15px] text-[var(--md-on-surface)] outline-none focus:border-[var(--md-primary)] focus:ring-2 focus:ring-[var(--md-primary)]/25';
  const primary = 'h-10 shrink-0 rounded-md bg-[var(--md-primary)] px-4 text-[14px] font-semibold text-[var(--md-on-primary)] disabled:opacity-60';
  const tonal = 'h-10 shrink-0 rounded-md bg-[var(--md-secondary-container)] px-4 text-[14px] font-semibold text-[var(--md-on-secondary-container)] disabled:opacity-60';
  const quiet = 'rounded px-1 text-[13px] font-medium text-[var(--md-primary)] hover:underline';
  const message = notice && notice !== 'sent' ? NOTICE[notice] : '';

  let body: ReactNode;
  if (user) {
    body = (
      <>
        <div className="flex items-center gap-3">
          <PersonGlyph filled className="h-6 w-6 shrink-0 text-[var(--md-primary)]" />
          <span data-account-email className="min-w-0 flex-1 truncate text-[15px] font-medium" title={user.email ?? ''}>{user.email}</span>
          <button type="button" data-primary className={tonal} disabled={busy} onClick={signOut}>Sign out</button>
        </div>
        <BillingRow successReturn={billingSuccess} />
        <div className="flex justify-end">
          <button type="button" className="rounded px-1 text-[12px] text-[var(--md-on-surface-variant)] hover:text-[var(--md-error)] hover:underline" disabled={busy} onClick={remove}>Delete account</button>
        </div>
        <Reports />
      </>
    );
  } else if (step === 'email') {
    body = (
      <>
      <p data-account-hint className="text-[13px] font-semibold leading-5">Save places · more Ask Isobar</p>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <input
          type="email" name="email" required autoComplete="email" inputMode="email" enterKeyHint="send"
          aria-label="Email" placeholder="Email" className={field}
          value={email} onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className={primary} disabled={busy}>Email me a link</button>
      </form>
      </>
    );
  } else {
    body = (
      <>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <input
            name="code" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={9} enterKeyHint="go"
            aria-label="8-digit code" placeholder="8-digit code" className={`${field} font-mono tracking-[0.2em] tabular-nums placeholder:font-sans placeholder:tracking-normal`}
            value={code} onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit" className={primary} disabled={busy}>Sign in</button>
        </form>
        <div className="flex items-center gap-1 text-[12px] text-[var(--md-on-surface-variant)]">
          <span className="min-w-0 truncate">Sent to {email}</span>
          <button type="button" className={quiet} onClick={() => { setStep('email'); setNotice(''); writePending(null); }}>Change</button>
          <button type="button" className={`${quiet} ml-auto`} disabled={busy} onClick={() => void send()}>Resend</button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/25 md:bg-transparent" aria-hidden="true" onClick={onClose} data-account-scrim />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        data-account-sheet
        className="account-sheet fixed z-[60] flex max-h-[calc(100dvh-1rem)] flex-col gap-2 overflow-y-auto border-[var(--md-outline-soft)] bg-[var(--md-surface)] px-4 pb-3 text-[var(--md-on-surface)] shadow-[0_-6px_18px_rgba(0,0,0,0.12)]
          max-md:inset-x-0 max-md:rounded-t-[14px] max-md:border-t
          md:w-[340px] md:rounded-lg md:border md:pt-3 md:shadow-[0_6px_24px_rgba(0,0,0,0.16)]"
        style={keyboard > 0 ? { ['--kb' as string]: `${keyboard}px` } : undefined}
      >
        <button type="button" aria-label="Close" onClick={onClose} className="relative -mb-1 flex h-[13px] w-full shrink-0 items-start justify-center pt-[5px] md:hidden">
          <span className="h-[4px] w-9 rounded-full bg-[var(--md-outline)]" />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="mb-1 hidden h-8 w-8 shrink-0 place-items-center self-end rounded-md text-[20px] leading-none hover:bg-[var(--md-surface-container-high)] md:grid">×</button>
        {body}
        {user ? null : <UsageNotice />}
        {message ? <p role="alert" className="text-[12px] font-medium text-[var(--md-error)]">{message}</p> : null}
      </div>
    </>
  );
}

export function PersonGlyph({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill={filled ? 'currentColor' : 'none'} />
    </svg>
  );
}
