'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { decree } from '@/lib/od/decrees';
import { act, openShift, sceneView } from '@/lib/od/story/play';
import { casesFor, readStoryPayload, STORY_STORAGE_KEY } from '@/lib/od/story/payload';
import { storyShift } from '@/lib/od/story/shifts';
import { shiftMeters } from '@/lib/od/story/summary';
import type { Meter, StoryPayload, Sitting } from '@/lib/od/story/types';
import './story.css';

function begin(shift: number, payload: StoryPayload, rebel: Sitting['rebel']): Sitting {
  const strands = payload.strands[String(shift)] ?? {};
  return openShift({
    shift,
    cases: casesFor(payload, shift),
    seed: payload.seed,
    rebel,
    strandBefore: strands.before,
    strandAfter: strands.after,
  });
}

function MeterRow({ meter }: { meter: Meter }) {
  return <li className="od-meter" data-meter={meter.id} data-tone={meter.tone} title={meter.title}>
    <span className="od-scene-mark" aria-hidden="true">{meter.symbol}</span>
    <span className="od-gauge" aria-hidden="true"><span style={{ '--g': meter.gauge } as CSSProperties} /></span>
    <strong>{meter.value}</strong>
    <span className="od-datum">{meter.datum}</span>
  </li>;
}

export function StorySitting() {
  const payload = useRef<StoryPayload>({ seed: 1, shifts: {}, strands: {} });
  const [sitting, setSitting] = useState<Sitting | null>(null);
  const [closed, setClosed] = useState(false);
  const [failed, setFailed] = useState(false);
  const choice = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    try {
      payload.current = readStoryPayload(sessionStorage.getItem(STORY_STORAGE_KEY));
      setSitting(begin(1, payload.current, []));
    } catch { setFailed(true); }
  }, []);

  choice.current = id => {
    if (!sitting) return;
    try {
      const next = id === 'listen' || id === 'dismiss' ? act(sitting, { type: id })
        : id === 'help' || id === 'refuse' || id === 'report' ? act(sitting, { type: 'rebel', choice: id })
        : id === 'RELEASE' || id === 'REFUSE' || id === 'AMEND' ? act(sitting, { type: 'stamp', stamp: id })
        : act(sitting, { type: 'continue' });
      if (next.phase === 'advance') {
        const upcoming = next.shift + 1;
        if (upcoming > 12) { setClosed(true); setSitting(null); return; }
        setSitting(begin(upcoming, payload.current, next.rebel));
        return;
      }
      setSitting(next);
    } catch { setFailed(true); }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!sitting || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const view = sceneView(sitting);
      const key = event.key.toLowerCase();
      if (key === 'escape' && view.choices.some(item => item.id === 'continue')) { event.preventDefault(); choice.current('continue'); return; }
      if (view.phase !== 'stamp') return;
      const stamp = key === 'r' ? 'RELEASE' : key === 'f' ? 'REFUSE' : key === 'a' ? 'AMEND' : null;
      if (!stamp) return;
      event.preventDefault();
      choice.current(stamp);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sitting]);

  const view = sitting ? sceneView(sitting) : null;
  const meters = sitting && view?.role === 'summary' ? shiftMeters(sitting) : null;
  const title = sitting ? decree(storyShift(sitting.shift).decreeId).title : '';
  const stamps = view?.choices.every(item => item.id === 'RELEASE' || item.id === 'REFUSE' || item.id === 'AMEND');

  return <div className="od-office od-story" data-phase={view?.phase ?? 'opening'} data-role={view?.role ?? ''}>
    <header className="od-header">
      <Link href="/train" className="od-back">← Learn</Link>
      <div className="od-brand"><h1>Operational Decision</h1></div>
      <span className="od-shift">Shift {String(sitting?.shift ?? 1).padStart(2, '0')}{title ? <span> · {title}</span> : null}</span>
    </header>
    {!view ? <div className="od-empty" role="status"><h2>{closed ? 'The office is closed.' : failed ? 'No dossier available' : 'Opening the office…'}</h2>{closed && <Link href="/train">Return to Learn →</Link>}</div> : <>
      <div className="od-story-body">
        {view.lines.length > 0 && view.role !== 'accident' && view.lines.map(line => <p className="od-scene-line" key={line.text}><span className="od-scene-mark" aria-hidden="true">{line.symbol}</span><span>{line.text}</span></p>)}
        {view.role === 'accident' && <div className="od-paper-lines"><div className="od-letterhead"><span>MINISTRY OF TRANSPORT</span><span>CIRCULAR</span></div>{view.lines.map((line, i) => <p key={line.text} className={i === view.lines.length - 1 ? 'od-source' : i === view.lines.length - 2 ? 'od-lesson' : undefined}>{line.text}</p>)}</div>}
        {view.dossier && <ol className="od-meters" aria-label="Dossier">
          <li className="od-meter is-flight" data-tone="flat" title={view.dossier.fact}>
            <span className="od-scene-mark" aria-hidden="true">F</span>
            <span className="od-gauge" aria-hidden="true"><span style={{ '--g': 1 } as CSSProperties} /></span>
            <strong>{view.dossier.clock}</strong>
            <span className="od-datum">{view.dossier.route}<br />{view.dossier.fact}</span>
          </li>
        </ol>}
        {meters && <ol className="od-meters" aria-label="Shift ledger">{meters.map(meter => <MeterRow key={meter.id} meter={meter} />)}</ol>}
        {view.epilogue && <p className="od-epilogue">{view.epilogue}</p>}
      </div>
      <footer className="od-tray">
        {view.dossier ? <div className="od-ledger"><span>Dossier {view.dossier.index + 1}/{view.dossier.count}</span></div> : <span className="od-ledger" />}
        {stamps ? <div className="od-stamps" aria-label="Decision stamps">{view.choices.map(item => <button key={item.id} className={`od-stamp od-${item.id.toLowerCase()}`} onClick={() => choice.current(item.id)}><span>{item.label}</span></button>)}</div>
          : <div className="od-scene-choices">{view.choices.map(item => <button key={item.id} className={item.id === 'continue' ? 'od-next' : undefined} onClick={() => choice.current(item.id)}>{item.label}</button>)}</div>}
      </footer>
    </>}
  </div>;
}
