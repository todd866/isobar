'use client';

/** One queue for the map, chat and Train. At most one request per 10s, and on pagehide. */

import { reduceUsage, type UsageClock, type UsageDraft, type UsageKind } from './events';

const clock: UsageClock = { pending: [], lastSentAt: null };
const hideHooks: (() => void)[] = [];
let timer = 0;
let started = false;

function deliver(events: UsageDraft[], hide: boolean) {
  const body = JSON.stringify({ events });
  if (hide && typeof navigator.sendBeacon === 'function') {
    const ok = navigator.sendBeacon('/api/usage', new Blob([body], { type: 'application/json' }));
    if (ok) return;
  }
  void fetch('/api/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function apply(now: number, reason: 'track' | 'due' | 'hide', event?: UsageDraft) {
  const step = reduceUsage(clock, now, reason, event);
  clock.pending = step.state.pending;
  clock.lastSentAt = step.state.lastSentAt;
  if (step.send?.length) deliver(step.send, reason === 'hide');
  if (step.waitMs != null && reason !== 'hide' && !timer) {
    timer = window.setTimeout(() => {
      timer = 0;
      apply(Date.now(), 'due');
    }, step.waitMs);
  }
}

function ensure() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('pagehide', () => {
    for (const fn of [...hideHooks]) fn();
    if (timer) window.clearTimeout(timer);
    timer = 0;
    apply(Date.now(), 'hide');
  });
}

export function trackUsage(kind: UsageKind, payload: Record<string, unknown> = {}) {
  ensure();
  apply(Date.now(), 'track', { kind, at: new Date().toISOString(), payload });
}

/** Queue without sending. pagehide flushes it with the rest of the batch. */
export function noteUsage(kind: UsageKind, payload: Record<string, unknown> = {}) {
  ensure();
  clock.pending.push({ kind, at: new Date().toISOString(), payload });
}

export function onUsageHide(fn: () => void): () => void {
  ensure();
  hideHooks.push(fn);
  return () => {
    const index = hideHooks.indexOf(fn);
    if (index >= 0) hideHooks.splice(index, 1);
  };
}
