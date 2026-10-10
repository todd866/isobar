'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nowMinuteOf, type LoadedChart } from '@/lib/chart-store';
import type { GeoPoint } from '@/lib/chart-teaching';
import { type Lesson, type TourStep } from '@/lib/teaching-content';
import { teachingInput, type TeachingSnapshot } from '@/lib/teaching-snapshot';
import { project, type Camera, type Lambert } from '@/lib/lambert';

interface Props {
  /** The map's projection, so anchors land on a global plate as well as a Lambert one. */
  geo: Lambert;
  chart: LoadedChart;
  minute: number;
  complete: boolean;
  camera: Camera | null;
  width: number;
  height: number;
  onActive: (active: boolean, minute?: number) => void;
  onFocus: (point: GeoPoint) => void;
  onField: (field: 'none' | 'wind' | 'rain') => void;
  /** First slot in the map ⓘ panel. Explain this chart is the only action there. */
  explainHost: HTMLElement | null;
  /** Start Today's tour once, when the page was opened for it. */
  autoTour?: boolean;
  /** Close the ⓘ panel when explanation starts, so the chart is the view. */
  onStarted?: () => void;
}

function Circulation({ kind }: { kind: 'H' | 'L' }) {
  return <svg className={`teach-ring ${kind === 'H' ? 'high' : 'low'}`} viewBox="0 0 100 100" aria-label={`${kind === 'L' ? 'Clockwise' : 'Anticlockwise'} southern hemisphere circulation`}>
    <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.5" />
    <g className="circulation-turn"><path d="M50 12a38 38 0 0 1 38 38" fill="none" stroke="currentColor" strokeWidth="2" /><path d={kind === 'L' ? 'M82 43l6 10 5-10' : 'M58 7l-10 5 10 6'} fill="none" stroke="currentColor" strokeWidth="2.5" /></g>
    <text x="50" y="58" textAnchor="middle" fill="currentColor" fontSize="26" fontWeight="600">{kind}</text>
  </svg>;
}

function LessonBody({ lesson, worked }: { lesson: Lesson; worked: boolean }) {
  const [answer, setAnswer] = useState<number | null>(null);
  const [easier, setEasier] = useState<number | null>(null);
  const [reveal, setReveal] = useState(worked || lesson.kind === 'airport');
  const supportRef = useRef<HTMLDivElement>(null);
  const wrong = answer != null && answer !== lesson.correct;
  useEffect(() => { if (wrong) supportRef.current?.scrollIntoView({ block: 'nearest' }); }, [wrong]);
  return <>
    {(lesson.kind === 'H' || lesson.kind === 'L') && (reveal || answer != null) ? <Circulation kind={lesson.kind} /> : null}
    {lesson.wind && (reveal || answer === lesson.correct || easier === lesson.easier.correct) ? <div className="teach-wind-comparison">
      {[[lesson.wind.idealFrom, lesson.wind.idealKt, 'Ideal'], [lesson.wind.surfaceFrom, lesson.wind.surfaceKt, '10 m']] .map(([from, kt, label]) => <div key={String(label)}>
        <svg viewBox="0 0 48 48" aria-label={`${label} wind from ${from == null ? 'unknown' : `${Math.round(Number(from))} degrees true`}`}>
          <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" opacity=".2" /><text x="24" y="9" textAnchor="middle" fill="currentColor" fontSize="7">N</text>
          {from != null ? <path d="M24 13v22m-5-7 5 8 5-8" fill="none" stroke="currentColor" strokeWidth="2" transform={`rotate(${from} 24 24)`} /> : null}
        </svg><span>{label} {kt == null ? 'unknown' : `${Math.round(Number(kt))} kt`}</span>
      </div>)}
    </div> : null}
    {lesson.kind === 'airport' ? <p className="teach-answer">{lesson.why}</p> : <>
      {!reveal ? <>
        <p className="teach-question">{lesson.question}</p>
        <div className="teach-choices" aria-label="Estimate first">{lesson.choices.map((choice, i) => <button key={choice} type="button" aria-pressed={answer === i} onClick={() => { setAnswer(i); setEasier(null); }} className={answer === i ? i === lesson.correct ? 'correct' : 'retry' : ''}>{choice}</button>)}</div>
      </> : null}
      {answer === lesson.correct || reveal ? <p className="teach-answer" role="status">{answer === lesson.correct ? 'Yes. ' : ''}{lesson.why}</p> : null}
      {wrong ? <div ref={supportRef} className="teach-support" role="status">
        <p>Try a smaller step. {lesson.support}</p>
        <p className="teach-question">{lesson.easier.question}</p>
        <div className="teach-choices">{lesson.easier.choices.map((choice, i) => <button key={choice} type="button" aria-pressed={easier === i} onClick={() => setEasier(i)}>{choice}</button>)}</div>
        {easier != null ? <p>{easier === lesson.easier.correct ? `That’s it. ${lesson.why}` : 'Follow the cue above, then try the other choice.'}</p> : null}
      </div> : null}
      {!reveal && answer == null ? <button className="teach-text-button" type="button" onClick={() => setReveal(true)}>Show a worked example</button> : null}
    </>}
    {lesson.detail && (reveal || answer === lesson.correct || easier === lesson.easier.correct) ? <details className="teach-detail" open={lesson.kind === 'airport'}><summary>{lesson.kind === 'airport' ? 'Forecast in plain words' : 'Why / assumptions'}</summary><p>{lesson.detail}</p></details> : null}
  </>;
}

export function MapTeaching({ geo, chart, minute, complete, camera, width, height, onActive, onFocus, onField, explainHost, autoTour = false, onStarted }: Props) {
  const [snapshot, setSnapshot] = useState<TeachingSnapshot | null>(null);
  const [selected, setSelected] = useState<Lesson | null>(null);
  const [tour, setTour] = useState<TourStep[] | null>(null);
  const [step, setStep] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const returnTo = useRef<'sources' | 'learn'>('sources');
  const tourBoot = useRef(false);
  const card = useRef<HTMLElement | null>(null);
  const active = snapshot != null;
  const lesson = tour?.[step]?.lesson ?? selected;
  const screen = (p: GeoPoint) => {
    const a = project(geo, p.lat, p.lon);
    return a && camera ? { x: width / 2 * (1 + (a.x - camera.centerX) / camera.halfWidth), y: height / 2 * (1 - (a.y - camera.centerY) / camera.halfHeight) } : { x: width / 2, y: height / 2 };
  };
  const anchor = lesson ? screen(lesson.anchor) : null;
  const mobile = width < 650;
  const cardWidth = mobile ? width - 20 : 330;
  const left = mobile ? 10 : anchor && anchor.x + cardWidth + 48 < width ? anchor.x + 42 : Math.max(10, (anchor?.x ?? width) - cardWidth - 42);
  const top = mobile ? undefined : Math.max(60, Math.min(height - 330, (anchor?.y ?? height / 2) - 100));
  function close() {
    requestRef.current += 1; workerRef.current?.terminate(); workerRef.current = null; setPending(false); setPendingLabel(null);
    setSnapshot(null); setSelected(null); setTour(null); setMessage(''); onActive(false);
    const which = returnTo.current;
    requestAnimationFrame(() => {
      const sources = document.querySelector<HTMLButtonElement>('[aria-label="Data sources"]');
      const learn = document.querySelector<HTMLAnchorElement>('[data-learn-link]');
      const menu = document.querySelector<HTMLButtonElement>('.map-menu-button');
      const target = which === 'learn' ? learn : sources;
      if (target && target.getClientRects().length) target.focus();
      else menu?.focus();
    });
  }
  function choose(item: Lesson) { setSelected(item); onFocus(item.anchor); }
  function start(isTour: boolean) {
    returnTo.current = isTour ? 'learn' : 'sources';
    if (!isTour) onStarted?.();
    const at = isTour ? nowMinuteOf(chart.manifest, Date.now()) : minute;
    if (isTour && (Date.now() < Date.parse(chart.manifest.run) + chart.manifest.forecastHours[0] * 3_600_000 || Date.now() > Date.parse(chart.manifest.run) + chart.manifest.forecastHours.at(-1)! * 3_600_000)) {
      setMessage('This run does not cover today. Explore its chart instead.'); return;
    }
    if (!teachingInput(chart, at)) { setPending(false); setPendingLabel(null); setMessage('Pressure unavailable at this time. Choose another time.'); return; }
    setMessage(''); setPendingLabel(isTour ? 'Today’s tour' : 'Explain this chart'); setPending(true); onActive(true, at);
    const request = ++requestRef.current;
    // Wind and rain load on demand; the lessons need them at this time.
    void Promise.all(['wind', 'rain24', 'u10', 'v10'].map((name) => chart.want(name, at))).then(() => {
      if (request !== requestRef.current) return;
      const input = teachingInput(chart, at);
      if (!input) { setPending(false); setPendingLabel(null); onActive(false); setMessage('Pressure unavailable at this time. Choose another time.'); return; }
      explain(input, request, isTour);
    });
  }
  function explain(input: NonNullable<ReturnType<typeof teachingInput>>, request: number, isTour: boolean) {
    try {
      const worker = new Worker(new URL('../workers/teaching.worker.ts', import.meta.url));
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<{ snapshot?: TeachingSnapshot; error?: string }>) => {
        if (request !== requestRef.current) return;
        worker.terminate(); workerRef.current = null; setPending(false); setPendingLabel(null);
        const data = event.data.snapshot;
        if (!data) { onActive(false); setPendingLabel(null); setMessage(event.data.error ?? 'Chart explanation unavailable'); return; }
        setSnapshot(data);
        if (isTour) { setTour(data.tour); setStep(0); onFocus(data.tour[0].lesson.anchor); onField(data.tour[0].field); }
      };
      worker.onerror = () => { worker.terminate(); workerRef.current = null; if (request === requestRef.current) { setPending(false); setPendingLabel(null); onActive(false); setMessage('Chart explanation unavailable. Try again.'); } };
      worker.postMessage(input, [input.mslp, input.wind, input.rain, input.u, input.v].filter((a): a is Float32Array => a != null).map((a) => a.buffer));
    } catch { setPending(false); setPendingLabel(null); onActive(false); setMessage('Chart explanation unavailable in this browser.'); }
  }
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => () => { requestRef.current += 1; workerRef.current?.terminate(); }, []);
  useEffect(() => {
    if (!autoTour || !complete || tourBoot.current) return;
    tourBoot.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    startRef.current(true);
  }, [autoTour, complete]);

  function advance(next: number) {
    if (!tour) return;
    if (next === tour.length) { close(); return; }
    setStep(next); onFocus(tour[next].lesson.anchor); onField(tour[next].field);
  }
  useEffect(() => { if (lesson) card.current?.focus({ preventScroll: true }); }, [lesson]);
  useEffect(() => {
    if (!active && !pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Active session owns Escape; focus returns to its opening button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pending]);
  const visibleLessons = snapshot?.lessons.filter((l) => { const p = screen(l.anchor); return p.x > 20 && p.x < width - 20 && p.y > 65 && p.y < height - 28; }) ?? [];
  return <div className="teach-layer" data-teaching={active ? 'active' : 'closed'}>
    {explainHost && complete && !active && !pending ? createPortal(
      <button type="button" className="map-sources-explain" onClick={() => start(false)}>Explain this chart</button>,
      explainHost,
    ) : null}
    {pending && pendingLabel ? <p className="teach-message" role="status">{pendingLabel}</p> : null}
    {message ? <p className="teach-message" role="status">{message}</p> : null}
    {snapshot ? <svg className="teach-annotations" width={width} height={height} aria-hidden="true">
      {snapshot.lessons.filter((l) => l.axis).map((l) => <path key={l.id} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} onClick={() => { if (!tour) choose(l); }} className={`teach-axis ${l.kind}`} d={l.axis!.points.map((p, i) => { const s = screen(p); return `${i ? 'L' : 'M'}${s.x},${s.y}`; }).join(' ')} />)}
      {lesson?.kind === 'route' ? <path className="teach-route" d={Array.from({ length: 25 }, (_, i) => { const s = screen({ lat: -31.94 - i / 24 * 2, lon: 115.97 + i / 24 * 35.21 }); return `${i ? 'L' : 'M'}${s.x},${s.y}`; }).join(' ')} /> : null}
      {anchor ? <g className={`teach-anchor ${lesson!.kind}`}>
        <circle cx={anchor.x} cy={anchor.y} r={26} /><circle cx={anchor.x} cy={anchor.y} r={31} opacity=".3" />
        <path d={mobile ? `M${anchor.x} ${anchor.y + 31}V${Math.max(anchor.y + 40, height - 290)}` : `M${anchor.x + (left > anchor.x ? 31 : -31)} ${anchor.y}H${left > anchor.x ? left : left + cardWidth}`} />
      </g> : null}
    </svg> : null}
    {active && !lesson ? visibleLessons.map((item) => { const p = screen(item.anchor); return <button key={item.id} type="button" className={`teach-feature ${item.kind}`} aria-label={`Explain ${item.kind === 'gradient' ? 'tight isobars' : item.kind === 'airport' ? item.id : item.kind === 'H' ? 'high pressure' : item.kind === 'L' ? 'low pressure' : item.kind}`} style={{ left: p.x, top: p.y }} onClick={() => choose(item)}>
      {item.kind === 'H' || item.kind === 'L' ? <span className="teach-centre-hit" /> : item.kind === 'gradient' ? '≋' : item.kind === 'airport' ? `✈ ${item.id}` : item.kind === 'trough' ? 'Trough' : 'Ridge'}
    </button>; }) : null}
    {lesson ? <aside key={`${lesson.id}-${step}`} className={`teach-card ${lesson.kind}`} ref={card} tabIndex={-1} style={{ left, top, bottom: mobile ? 24 : undefined, width: cardWidth, maxHeight: top != null ? height - top - 10 : undefined }} aria-label={tour ? 'Chart tour' : 'Chart explanation'} data-teach-card>
      <div className="teach-card-head"><span>{tour ? `${step + 1} / ${tour.length} · ${tour[step].mode}` : 'Explain this chart'} <span className="teach-held" title="Playback resumes when teaching closes">· time held</span></span><button type="button" aria-label={tour ? 'Skip tour' : 'Close explanation'} onClick={close}>×</button></div>
      <div className="teach-card-scroll">
        <h2>{lesson.title}</h2><p className="teach-datum">{lesson.datum}</p>
        <LessonBody lesson={lesson} worked={tour?.[step].mode === 'Worked example'} />
      </div>
      <div className="teach-card-foot">{tour ? <><button type="button" disabled={step === 0} onClick={() => advance(step - 1)}>← Back</button><span className="teach-dots" aria-hidden="true">{tour.map((_, i) => <i key={i} className={i === step ? 'active' : ''} />)}</span><button type="button" onClick={() => advance(step + 1)}>{step === tour.length - 1 ? 'Finish' : 'Next →'}</button></> : <button type="button" onClick={() => setSelected(null)}>← Explore another feature</button>}</div>
    </aside> : null}
  </div>;
}
