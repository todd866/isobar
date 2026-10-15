'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAccount } from './Account';
import { enableFeedback, feedbackEvent, feedbackSource, history, holdFeedback } from '@/lib/feedback/runtime';
import { makeSnapshot, type AppIdentity } from '@/lib/feedback/snapshot';
import styles from './FeedbackCapture.module.css';

type Draft = { record: ReturnType<typeof makeSnapshot>; screenshot: string | null };
const unknownApp: AppIdentity = { version: null, build: null, commit: null };

export function FeedbackCapture() {
  const { user } = useAccount();
  const route = usePathname();
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const owner = !!user && ownerId === user.id;
  const [app, setApp] = useState(unknownApp);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const draftRef = useRef<Draft | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef(0);
  const appRef = useRef(app); appRef.current = app;
  const close = () => {
    draftRef.current = null; setDraft(null); holdFeedback(false); setNote('');
    focus.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const controller = new AbortController();
    setOwnerId(null);
    if (user) void fetch('/api/feedback?access=1', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (response.ok && (await response.json()).owner === true && !controller.signal.aborted) setOwnerId(user.id);
    }).catch(() => {});
    return () => controller.abort();
  }, [user?.id]);
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    void fetch('/isobar-release.json', { cache: 'no-store', signal: controller.signal }).then(r => r.ok ? r.json() : null).then(stamp => {
      if (!controller.signal.aborted && stamp) setApp({ version: typeof stamp.version === 'string' ? stamp.version : null, build: typeof stamp.generated === 'string' ? stamp.generated : null, commit: typeof stamp.source_commit === 'string' ? stamp.source_commit : null });
    }).catch(() => {});
    return () => controller.abort();
  }, [owner]);
  useEffect(() => {
    if (!owner) return;
    const cleanup = enableFeedback();
    return () => { session.current++; cleanup(); holdFeedback(false); draftRef.current = null; setDraft(null); setNote(''); setStatus(''); setSaving(false); if (press.current) clearTimeout(press.current); };
  }, [owner]);
  useEffect(() => { if (owner) feedbackEvent('route', { route }); }, [owner, route]);
  const capture = () => {
    if (!owner || draftRef.current) return;
    const now = Date.now();
    const source = feedbackSource();
    const state = source?.state() ?? {};
    const zone = typeof state.zone === 'string' ? state.zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const record = makeSnapshot({ now, zone, app: appRef.current, recent: history.snapshot(), state: {
      place: null, zone: null, lens: null, field: null, overlays: null, camera: null, mode: null, playhead: null, playing: null, rate: null, run_id: null, data_age_seconds: null, stale: null,
      ...state, url: location.href, route: location.pathname, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, colour_scheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', user_agent: navigator.userAgent, layout: matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop', screenshot_scope: 'map-canvases',
    } });
    // Both state and pixels are copied synchronously, before any note UI mounts.
    let screenshot: string | null = null;
    try { screenshot = source?.capture() ?? null; } catch { /* State-only report. */ }
    record.files = screenshot ? ['screen.jpg'] : [];
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    holdFeedback(true);
    const next = { record, screenshot };
    draftRef.current = next; setDraft(next); setNote(''); setStatus('');
  };
  const captureRef = useRef(capture); captureRef.current = capture;
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!owner) return;
    const key = (event: KeyboardEvent) => {
      if (draftRef.current) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
        // Note editing must never reach the map's window keyboard handlers.
        else {
          if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); if (!event.repeat && !event.isComposing) void saveRef.current(); }
          if (event.key === 'Tab') {
            event.preventDefault();
            const controls = [...(input.current?.form?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
            const index = controls.indexOf(document.activeElement as HTMLElement);
            controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
          }
          event.stopPropagation();
        }
        return;
      }
      if (event.code === 'KeyF' && event.ctrlKey && event.altKey && (event.metaKey || event.shiftKey)) {
        event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) captureRef.current();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [owner]);
  useEffect(() => { if (draft) input.current?.focus({ preventScroll: true }); }, [draft]);
  useEffect(() => {
    if (status !== 'Feedback saved') return;
    const timer = setTimeout(() => setStatus(''), 1400); return () => clearTimeout(timer);
  }, [status]);
  async function save() {
    if (!draftRef.current || saving) return;
    const epoch = session.current;
    const submitted = draftRef.current;
    setSaving(true); setStatus('');
    const payload = { ...draftRef.current, record: { ...draftRef.current.record, note: note === '' ? null : note } };
    try {
      const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (epoch !== session.current) return;
      if (!response.ok) { setStatus(response.status === 429 ? 'Try again shortly' : 'Save failed'); return; }
      if (draftRef.current === submitted) close();
      if (!draftRef.current) setStatus('Feedback saved');
    } catch { if (epoch === session.current) setStatus('Save failed'); }
    finally { if (epoch === session.current) setSaving(false); }
  }
  const saveRef = useRef(save); saveRef.current = save;
  if (!owner) return null;
  const cancelPress = () => { if (press.current) clearTimeout(press.current); press.current = null; };
  return <>
    <button className={styles.stamp} data-feedback-stamp aria-label="Capture feedback" onContextMenu={e => e.preventDefault()} onClick={e => { if (e.detail === 0) capture(); }} onPointerDown={e => { if (e.pointerType !== 'mouse') { cancelPress(); press.current = setTimeout(() => captureRef.current(), 800); } }} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}>{app.commit?.slice(0, 7) ?? 'Isobar'}</button>
    {draft ? <div className={styles.shield}>
      <form className={styles.row} role="dialog" aria-modal="true" aria-label="Feedback" onSubmit={e => { e.preventDefault(); void save(); }}>
        {draft.screenshot ? <img src={`data:image/jpeg;base64,${draft.screenshot}`} alt="Captured map" className={styles.thumb} /> : null}
        <input ref={input} value={note} onChange={e => setNote(e.target.value)} maxLength={20000} placeholder="Feedback" aria-label="Feedback note" disabled={saving} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
        <button type="submit" disabled={saving} aria-label="Save feedback">↵</button><button type="button" onClick={close} aria-label="Discard feedback">×</button>
        {status ? <span role="status">{status}</span> : null}
      </form>
    </div> : status ? <div className={styles.saved} role="status">{status}</div> : null}
  </>;
}
