'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Plan = 'monthly' | 'yearly';
type BillingState = {
  enabled: boolean;
  paid?: boolean;
  plan?: Plan | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

function formatPeriodEnd(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}
function isEntitled(value: BillingState | null): boolean {
  const status = value?.status?.toLowerCase() ?? '';
  return value?.paid === true || ['active', 'past_due', 'unpaid', 'incomplete'].includes(status);
}
function billingResolved(value: BillingState | null): boolean {
  return value?.enabled === false || isEntitled(value);
}

/** One quiet account row. Stripe is deliberately absent from the UI when disabled. */
export function BillingRow({ successReturn = false }: { successReturn?: boolean }) {
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [plan, setPlan] = useState<Plan>('monthly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryAction, setRetryAction] = useState<'checkout' | 'portal' | null>(null);
  const [confirming, setConfirming] = useState(successReturn);
  const [paymentPending, setPaymentPending] = useState(false);
  const alive = useRef(true);
  const actionController = useRef<AbortController | null>(null);
  const billingRef = useRef<BillingState | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    setRetryAction(null);
    try {
      const response = await fetch('/api/billing', { cache: 'no-store', credentials: 'same-origin', signal });
      if (!response.ok) throw new Error(`billing ${response.status}`);
      const body = await response.json() as BillingState;
      if (!body || typeof body.enabled !== 'boolean') throw new Error('invalid billing response');
      if (alive.current && !signal?.aborted) { billingRef.current = body; setBilling(body); setLoadFailed(false); }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (alive.current) { setLoadFailed(true); setError('Billing unavailable'); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
      if (!successReturn || controller.signal.aborted || !alive.current) return;
      if (billingResolved(billingRef.current)) {
        setConfirming(false);
        return;
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 2_000);
          controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
        });
        if (controller.signal.aborted || !alive.current) return;
        await load(controller.signal);
        if (billingResolved(billingRef.current)) {
          if (alive.current) setConfirming(false);
          return;
        }
      }
      if (alive.current) { setConfirming(false); setPaymentPending(true); }
    })();
    return () => { alive.current = false; controller.abort(); actionController.current?.abort(); actionController.current = null; };
  }, [load, successReturn]);

  const action = async (kind: 'checkout' | 'portal') => {
    setBusy(true);
    setError('');
    setRetryAction(null);
    const controller = new AbortController();
    actionController.current?.abort();
    actionController.current = controller;
    try {
      const response = await fetch(`/api/billing/${kind}`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        ...(kind === 'checkout' ? { body: JSON.stringify({ plan }) } : {}),
      });
      const body = await response.json().catch(() => null) as { url?: string } | null;
      if (!response.ok || !body?.url) throw new Error('billing action failed');
      if (alive.current && !controller.signal.aborted) window.location.assign(body.url);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (alive.current) { setBusy(false); setError('Try again'); setRetryAction(kind); }
    } finally {
      if (actionController.current === controller) actionController.current = null;
    }
  };

  if (billing?.enabled === false) return null;
  if (confirming) return (
    <div data-billing-row className="min-w-0 truncate border-t border-[var(--md-outline-soft)] pt-2 text-[12px] text-[var(--md-on-surface-variant)]">Confirming payment…</div>
  );
  if (paymentPending) return (
    <div data-billing-row className="min-w-0 truncate border-t border-[var(--md-outline-soft)] pt-2 text-[12px] text-[var(--md-on-surface-variant)]">
      <span>Payment pending</span>{' · '}
      <button type="button" className="font-semibold text-[var(--md-primary)] hover:underline" onClick={() => { setPaymentPending(false); void load(); }}>Refresh</button>
    </div>
  );
  if (loadFailed && !billing) return (
    <div data-billing-row className="min-w-0 truncate border-t border-[var(--md-outline-soft)] pt-2 text-[12px] text-[var(--md-on-surface-variant)]">
      <span>Billing unavailable</span>{' · '}
      <button type="button" className="font-semibold text-[var(--md-primary)] hover:underline" onClick={() => void load()}>Retry</button>
    </div>
  );
  if (!billing?.enabled) return null;
  const status = billing.status?.toLowerCase() ?? '';
  const manage = billing.paid === true || ['active', 'past_due', 'unpaid', 'incomplete'].includes(status);
  const canceled = status === 'canceled';
  const periodLabel = billing.plan === 'yearly' ? 'Yearly' : 'Monthly';
  const end = formatPeriodEnd(billing.currentPeriodEnd);
  const detail = manage
    ? (billing.cancelAtPeriodEnd && end ? `Cancels ${end}` : periodLabel)
    : 'More AI · priority archive checks';
  const title = `Isobar AI · ${detail}`;

  return (
    <div data-billing-row className="min-w-0 border-t border-[var(--md-outline-soft)] pt-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-[13px]" title={title}>
          <span className="font-semibold">Isobar AI</span>
          <span className="text-[var(--md-on-surface-variant)]"> · {detail}</span>
        </span>
        {manage ? (
          <button type="button" className="min-h-8 min-w-11 shrink-0 rounded px-2 text-[12px] font-semibold text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)]" disabled={busy} onClick={() => void action('portal')}>
            Manage
          </button>
        ) : (
          <>
            <select aria-label="Billing period" className="min-h-8 min-w-[70px] max-w-full shrink-0 rounded border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-1 text-[12px] text-[var(--md-on-surface)]" value={plan} onChange={(event) => setPlan(event.target.value as Plan)} disabled={busy}>
              <option value="monthly">US$5 / mo</option>
              <option value="yearly">US$50 / yr</option>
            </select>
            <button type="button" className="min-h-8 min-w-11 shrink-0 rounded bg-[var(--md-primary)] px-2 text-[12px] font-semibold text-[var(--md-on-primary)] disabled:opacity-60" disabled={busy} onClick={() => void action('checkout')}>
              Upgrade
            </button>
            {canceled ? <button type="button" className="min-h-8 min-w-11 shrink-0 rounded px-1 text-[11px] font-semibold text-[var(--md-primary)] hover:underline" disabled={busy} onClick={() => void action('portal')}>Invoices</button> : null}
          </>
        )}
        {error ? <button type="button" className="min-h-8 min-w-11 shrink-0 rounded px-1 text-[12px] font-semibold text-[var(--md-primary)] hover:underline" onClick={() => void (retryAction ? action(retryAction) : load())}>Retry</button> : null}
      </div>
      {error ? <p role="alert" className="text-[11px] text-[var(--md-error)]">{error}</p> : null}
    </div>
  );
}
