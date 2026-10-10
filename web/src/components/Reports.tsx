'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ReportSubscription {
  id: string; kind?: 'once' | 'recurring'; schedule?: string | null; timezone?: string | null;
  places?: { name?: string }[]; instructions?: string | null;
  status: 'active' | 'paused' | 'cancelled' | string; nextRunAt?: string | null;
}

function placeLabel(row: ReportSubscription): string { return (row.places ?? []).map((place) => place.name).filter(Boolean).join(', ') || 'Configured places'; }
function timeLabel(row: ReportSubscription): string {
  if (row.kind === 'once') return 'Once';
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(row.schedule ?? '');
  if (!match) return 'Scheduled';
  const time = `${String(Number(match[2])).padStart(2, '0')}:${String(Number(match[1])).padStart(2, '0')}`;
  const days = match[3] === '*' ? '' : ` · ${match[3].split(',').map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(day)]).join('/')}`;
  return `${time}${row.timezone ? ` ${row.timezone.split('/').pop()?.replaceAll('_', ' ') ?? ''}` : ''}${days}`;
}
function nextTitle(row: ReportSubscription): string {
  const next = row.nextRunAt ? new Date(row.nextRunAt) : null;
  if (!next || !Number.isFinite(next.getTime())) return row.instructions ?? '';
  return [new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: row.timezone ?? undefined }).format(next), row.instructions].filter(Boolean).join(' · ');
}
const button = 'inline-flex min-h-8 items-center rounded-md border border-[var(--md-outline-variant)] px-2.5 text-[12px] font-semibold text-[var(--md-primary)] hover:bg-[var(--md-secondary-container)] disabled:opacity-50';

export function Reports() {
  const [open, setOpen] = useState(false); const [rows, setRows] = useState<ReportSubscription[]>([]);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState(''); const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null); const feedback = useRef<number | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if(!signal){request.current?.abort();const controller=new AbortController();request.current=controller;signal=controller.signal;}
    setError(false);
    const response = await fetch('/api/reports', { credentials: 'same-origin', cache: 'no-store', signal }).catch(() => null);
    if(signal?.aborted)return;
    if (!response) {setError(true);return;}
    if (!response.ok) { setError(true); return; }
    const body = await response.json().catch(()=>null) as { enabled?: boolean; subscriptions?: ReportSubscription[] } | null;
    if(!body){if(!signal?.aborted)setError(true);return;}
    if (!signal?.aborted) { setError(body.enabled === false); setRows(Array.isArray(body.subscriptions) ? body.subscriptions : []); }
  }, []);
  useEffect(() => { if (!open) return; const controller = new AbortController(); request.current = controller; void load(controller.signal); return () => { controller.abort(); if (request.current === controller) request.current = null; }; }, [load, open]);
  const act = async (action: 'pause' | 'resume' | 'cancel', id: string) => {
    setBusy(true); setStatus('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const response = await fetch('/api/reports', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id }) }).catch(() => null);
    if (controller.signal.aborted) return;
    if (!response) { setBusy(false); setStatus('Could not update report'); return; }
    const body = response.ok ? await response.json().catch(()=>null) as { line?: string } | null : null;
    if(controller.signal.aborted)return;
    setBusy(false); setStatus(body?.line ?? (response.ok ? 'Updated' : 'Could not update report'));
    if (response.ok) await load(controller.signal);
    if(controller.signal.aborted)return;
    if (feedback.current) window.clearTimeout(feedback.current);
    feedback.current = window.setTimeout(() => setStatus(''), 3500);
  };
  useEffect(() => () => { request.current?.abort(); if (feedback.current) window.clearTimeout(feedback.current); }, []);
  return <section className="border-t border-[var(--md-outline-soft)] pt-2" data-reports="compact">
    <button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-1 text-left text-[14px] font-medium hover:bg-[var(--md-surface-container-high)]" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span aria-hidden="true" className="w-4 text-center text-[var(--md-primary)]">◷</span><span className="flex-1">Reports</span><span className="font-mono text-[12px] tabular-nums text-[var(--md-on-surface-variant)]">{rows.length || ''}</span><span aria-hidden="true" className="text-[var(--md-on-surface-variant)]">{open ? '⌃' : '⌄'}</span></button>
    {open ? <div className="mt-1 space-y-1" data-reports-list>
      {error ? <div className="flex items-center gap-2 px-1 py-2 text-[12px] text-[var(--md-error)]"><span>Reports unavailable</span><button type="button" className={button} onClick={() => void load()}>Retry</button></div> : null}
      {!error && rows.length === 0 ? <p className="px-1 py-2 text-[12px] text-[var(--md-on-surface-variant)]">No reports yet</p> : null}
      {rows.map((row) => <div key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-[var(--md-surface-container-low)] px-2 py-2" data-report-id={row.id} title={nextTitle(row)}><span aria-label={row.status} className={`w-4 text-center ${row.status === 'active' ? 'text-[var(--md-primary)]' : 'text-[var(--md-on-surface-variant)]'}`}>{row.status === 'active' ? '●' : row.status === 'paused' ? 'Ⅱ' : '○'}</span><span className="min-w-[7rem] flex-1 text-[13px] font-medium">{placeLabel(row)}</span><span className="text-[12px] tabular-nums text-[var(--md-on-surface-variant)]">{timeLabel(row)}</span>{row.status === 'active' ? <button type="button" className={button} disabled={busy} onClick={() => void act('pause', row.id)}>Pause</button> : null}{row.status === 'paused' ? <button type="button" className={button} disabled={busy} onClick={() => void act('resume', row.id)}>Resume</button> : null}{row.status !== 'cancelled' ? <button type="button" className={`${button} text-[var(--md-error)]`} disabled={busy} onClick={() => void act('cancel', row.id)}>Cancel</button> : null}</div>)}
      <p className="min-h-4 px-1 text-[12px] text-[var(--md-primary)]" role="status" aria-live="polite">{status}</p>
    </div> : null}
  </section>;
}
