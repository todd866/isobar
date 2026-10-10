'use client';

import { useEffect, useState } from 'react';
import type { DigestView } from '@/lib/chat/digest';

export default function AdminDigestPage() {
  const [view, setView] = useState<DigestView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancel = false;
    void fetch('/api/chat/digest?view=1').then(async (response) => {
      if (cancel) return;
      if (!response.ok) { setMissing(true); return; }
      setView(await response.json() as DigestView);
    }).catch(() => { if (!cancel) setMissing(true); });
    return () => { cancel = true; };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-3 text-[14px] text-[var(--md-on-surface)]">
      {missing ? <p data-digest-missing>Not found</p> : null}
      {!missing && !view ? <p data-digest-loading>Loading</p> : null}
      {view && view.threads.length === 0 ? <p data-digest-empty>No threads</p> : null}
      {view?.threads.map((thread) => (
        <section key={thread.threadId} data-digest-thread={thread.threadId} className="border-t border-[var(--md-outline-soft)] py-2">
          <div className="grid min-h-10 grid-cols-[4.5rem_1fr_auto] items-baseline gap-3">
            <span className="text-[12px] font-medium text-[var(--md-on-surface-variant)]">User</span>
            <span data-digest-user className="truncate" title={thread.user ?? 'Signed out'}>{thread.user ?? 'Signed out'}</span>
            <span data-digest-cost className="tabular-nums" title="Cost">${thread.costUsd.toFixed(2)}</span>
          </div>
          {thread.turns.map((turn, index) => (
            <div key={`${turn.replyId ?? 'q'}-${index}`}>
              <div className="grid min-h-10 grid-cols-[4.5rem_1fr] items-baseline gap-3">
                <span className="text-[12px] font-medium text-[var(--md-on-surface-variant)]">Q</span>
                <span data-digest-question>{turn.question}</span>
              </div>
              <div className="grid min-h-10 grid-cols-[4.5rem_1fr_auto_auto] items-baseline gap-3">
                <span className="text-[12px] font-medium text-[var(--md-on-surface-variant)]">A</span>
                <span data-digest-reply>{turn.reply || '—'}</span>
                <span data-digest-grade title={turn.gradeReason ?? undefined}>{turn.grade ?? '—'}</span>
                {turn.replyId && !turn.example ? (
                  <form action="/api/admin/chat" method="post">
                    <input type="hidden" name="action" value="example" />
                    <input type="hidden" name="messageId" value={turn.replyId} />
                    <input type="hidden" name="next" value="/admin/chat/digest" />
                    <button type="submit" data-digest-example={turn.replyId} className="h-8 rounded-md px-2 font-medium text-[var(--md-primary)]">Example</button>
                  </form>
                ) : <span data-digest-example={turn.replyId ?? ''} aria-pressed="true" className="text-[12px] font-medium text-[var(--md-primary)]">{turn.example ? 'Example' : ''}</span>}
              </div>
              {turn.toolCalls.map((name) => (
                <div key={name} className="grid min-h-8 grid-cols-[4.5rem_1fr] items-baseline gap-3">
                  <span className="text-[12px] font-medium text-[var(--md-on-surface-variant)]">Tool</span>
                  <span data-digest-tool className="font-mono text-[12px]">{name}</span>
                </div>
              ))}
            </div>
          ))}
          {thread.handoffs.map((handoff, index) => (
            <div key={`${handoff.question}-${index}`} className="grid min-h-10 grid-cols-[4.5rem_1fr_auto] items-baseline gap-3" data-digest-handoff>
              <span className="text-[12px] font-medium text-[var(--md-on-surface-variant)]">Slow</span>
              <span className="truncate" title={handoff.outcome ?? handoff.question}>{handoff.question}</span>
              <span data-digest-outcome>{handoff.status}{handoff.outcome ? ` · ${handoff.outcome}` : ''}</span>
            </div>
          ))}
          {thread.missed ? <p data-digest-missed className="max-w-3xl py-1 text-[15px] leading-snug">{thread.missed}</p> : null}
        </section>
      ))}
    </main>
  );
}
