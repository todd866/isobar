'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import Link from 'next/link';
import type { Decision, Dossier, WeatherReport } from '@/lib/od/model';
import { DECREES, decree, editionVariant } from '@/lib/od/decrees';
import { judge, type Judgement } from '@/lib/od/judge';
import { scoreShift, shiftPlan } from '@/lib/od/shifts';
import { DESK_ART, loadDeskWeather, nextDossier, windowWeather } from '@/lib/od/desk';
import { readDeskLearn, recordDeskDecision } from '@/lib/od/desk-learning';
import { rebelOutcome, rebelPrompt } from '@/lib/od/story/lines';
import { DOCUMENTS, DocumentContent, type DocumentId } from './Documents';
import { Amendment, Ruler, Slip, WindCard } from './DeskTools';

type Tool = 'amend' | 'wind' | 'ruler' | 'citation' | 'keys' | 'scene' | null;
type Outcome = { judgement: Judgement; released: boolean; delayMinutes: number };
type Point = { x: number; y: number };
const initialPositions: [Point, Point] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
const deskKey = (edition: string) => `isobar.od.desk.${edition}.v1`;
function savedShift(edition: string) {
  try { const row = JSON.parse(localStorage.getItem(deskKey(edition)) ?? 'null');
    if (Number.isInteger(row?.shift) && row.shift >= 1 && row.shift <= DECREES.length && Number.isInteger(row.seed)) return { shift: row.shift as number, seed: row.seed as number, finished: row.finished === true };
  } catch { /* A new sitting remains available without storage. */ }
  return { shift: 1, seed: Date.now() >>> 0, finished: false };
}
function rememberShift(edition: string, shift: number, seed: number, finished = false) {
  try { localStorage.setItem(deskKey(edition), JSON.stringify({ shift, seed, finished })); } catch { /* evidence saving has its own visible status */ }
}
async function prepareArt(signal: AbortSignal, urls: string[]) {
  const prepared: Record<string, string> = {};
  // Own the decoded bytes for this visit, independent of HTTP cache/network.
  for (let i = 0; i < DESK_ART.length; i += 3) {
    await Promise.all(DESK_ART.slice(i, i + 3).map(async src => {
      const response = await fetch(src, { signal });
      if (!response.ok) throw new Error('Office artwork unavailable');
      const blob = await response.blob();
      if (signal.aborted) throw new Error('Office closed');
      const url = URL.createObjectURL(blob); urls.push(url);
      const image = new Image(); image.src = url; await image.decode();
      prepared[src.split('/').at(-1)!.replace('.webp', '')] = url;
    }));
  }
  return prepared;
}

export function DecisionDesk() {
  const [status, setStatus] = useState<'preparing' | 'ready' | 'unavailable' | 'finished'>('preparing');
  const [retry, setRetry] = useState(0);
  const [art, setArt] = useState<Record<string, string>>({});
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [shift, setShift] = useState(1);
  const [position, setPosition] = useState(0);
  const [seed, setSeed] = useState(1);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [result, setResult] = useState<Judgement | null>(null);
  const [stamped, setStamped] = useState<Decision['stamp'] | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tool, setTool] = useState<Tool>(null);
  const [sheets, setSheets] = useState<[DocumentId, DocumentId]>(['plan', 'taf']);
  const [active, setActive] = useState<0 | 1>(0);
  const [positions, setPositions] = useState<[Point, Point]>(initialPositions);
  const [scene, setScene] = useState<string | null>(null);
  const reports = useRef<WeatherReport[]>([]);
  const openedAt = useRef(0);
  const submitted = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const stampRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ slot: 0 | 1; startX: number; startY: number; point: Point; minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const install = (next: Dossier | null) => {
    setDossier(next); setStatus(next ? 'ready' : 'unavailable'); setResult(null); setStamped(null);
    setSaveFailed(false); setTool(null); setScene(null); setSheets(['plan', 'taf']); setActive(0); setPositions(initialPositions);
    openedAt.current = performance.now(); submitted.current = false;
  };
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setStatus('preparing'); setArt({});
    const deadline = window.setTimeout(() => { controller.abort(); setStatus('unavailable'); }, 15000);
    void Promise.all([loadDeskWeather(controller.signal), prepareArt(controller.signal, urls)]).then(([loaded, prepared]) => {
      if (controller.signal.aborted) return;
      setArt(prepared); reports.current = loaded;
      const record = readDeskLearn(), saved = savedShift(record.rules ?? 'aus');
      setShift(saved.shift); setSeed(saved.seed); setPosition(0); setOutcomes([]);
      if (saved.finished) { setStatus('finished'); setDossier(null); return; }
      rememberShift(record.rules ?? 'aus', saved.shift, saved.seed);
      install(nextDossier(loaded, record.person!, saved.shift, 0, saved.seed));
    }).catch(() => { if (!controller.signal.aborted) setStatus('unavailable'); }).finally(() => window.clearTimeout(deadline));
    return () => { window.clearTimeout(deadline); controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [retry]);

  useEffect(() => {
    const reset = () => setPositions(initialPositions);
    window.addEventListener('resize', reset);
    return () => window.removeEventListener('resize', reset);
  }, []);

  function selectDocument(id: DocumentId) {
    const existing = sheets.indexOf(id);
    if (existing >= 0) setActive(existing as 0 | 1);
    else setSheets(old => old.map((current, i) => i === active ? id : current) as [DocumentId, DocumentId]);
  }
  function stepDocument(delta: number) {
    const index = DOCUMENTS.findIndex(doc => doc[0] === sheets[active]);
    selectDocument(DOCUMENTS[(index + delta + DOCUMENTS.length) % DOCUMENTS.length][0]);
  }
  function submit(decision: Decision) {
    if (!dossier || status !== 'ready' || submitted.current) return;
    submitted.current = true;
    const judged = judge(dossier, decision, { edition: dossier.edition, responseMs: Math.max(0, performance.now() - openedAt.current) });
    const saved = recordDeskDecision(dossier, decision, judged, Date.now());
    setSaveFailed(!saved.saved && !saved.duplicate);
    setResult(judged); setStamped(decision.stamp);
    setOutcomes(old => [...old, { judgement: judged, released: decision.stamp !== 'REFUSE', delayMinutes: decision.stamp === 'AMEND' ? decision.delay ?? 0 : 0 }]);
    setTool(judged.assessable && !judged.correct ? 'citation' : null);
  }
  function next() {
    if (!dossier || !result) return;
    const plan = shiftPlan(shift, dossier.edition);
    const complete = position + 1 === plan.dossierCount;
    if (complete && shift === DECREES.length) { rememberShift(dossier.edition, shift, seed, true); setStatus('finished'); setTool(null); return; }
    const nextShift = complete ? Math.min(DECREES.length, shift + 1) : shift;
    const nextPosition = complete ? 0 : position + 1;
    const nextSeed = complete ? seed + plan.dossierCount : seed;
    if (complete) { setOutcomes([]); setSeed(nextSeed); setShift(nextShift); rememberShift(dossier.edition, nextShift, nextSeed); }
    setPosition(nextPosition);
    install(nextDossier(reports.current, { ...readDeskLearn().person!, rules: dossier.edition }, nextShift, nextPosition, nextSeed + nextPosition));
    stampRef.current?.focus();
  }
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcuts.current = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || tool || (event.target instanceof Element && event.target.closest('input,select,textarea,[contenteditable="true"]'))) return;
    const key = event.key.toLowerCase();
    if (status !== 'ready' && key !== '?' && key !== 'h') return;
    if (key === 'r') submit({ stamp: 'RELEASE' });
    else if (key === 'f') submit({ stamp: 'REFUSE' });
    else if (key === 'a' && !result && dossier) setTool('amend');
    else if (key === 'w') setTool('wind');
    else if (key === 't') setTool('ruler');
    else if (key === '?' || key === 'h') setTool('keys');
    else if (key === 'arrowleft' || key === 'arrowright') stepDocument(key === 'arrowleft' ? -1 : 1);
    else if (/^[1-6]$/.test(key)) selectDocument(DOCUMENTS[Number(key) - 1][0]);
    else if (key === 'n' && result) next();
    else return;
    event.preventDefault();
  };
  useEffect(() => { const key = (event: KeyboardEvent) => shortcuts.current(event); window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);

  function startDrag(event: PointerEvent<HTMLElement>, slot: 0 | 1) {
    if (window.matchMedia('(max-width: 700px), (max-height: 500px)').matches || event.button !== 0) return;
    const node = event.currentTarget.closest<HTMLElement>('.od-document')!;
    const rect = node.getBoundingClientRect(), bounds = surface.current!.getBoundingClientRect();
    const point = positions[slot];
    setActive(slot);
    drag.current = { slot, startX: event.clientX, startY: event.clientY, point,
      minX: point.x + bounds.left - rect.left, maxX: point.x + bounds.right - rect.right,
      minY: point.y + bounds.top - rect.top, maxY: point.y + bounds.bottom - rect.bottom };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const point = { x: Math.min(d.maxX, Math.max(d.minX, d.point.x + event.clientX - d.startX)), y: Math.min(d.maxY, Math.max(d.minY, d.point.y + event.clientY - d.startY)) };
    setPositions(old => old.map((p, i) => i === d.slot ? point : p) as [Point, Point]);
  }
  const close = () => setTool(null);
  const weather = windowWeather(dossier?.departureWeather.metar?.raw);
  const plan = dossier ? shiftPlan(shift, dossier.edition) : null;
  const score = dossier ? scoreShift(shift, dossier.edition, outcomes) : null;
  const portrait = dossier?.pressure.kind === 'ministry' ? 'inspector' : dossier?.pressure.kind === 'captain' ? 'captain' : 'firstofficer';
  const currentDoc = DOCUMENTS.find(doc => doc[0] === sheets[active])!;

  return <div className="od-office" data-weather={weather} style={{ '--desk-art': art.desk ? `url(${art.desk})` : 'none', '--paper-art': art.paper ? `url(${art.paper})` : 'none', '--stamps-art': art.stamps ? `url(${art.stamps})` : 'none' } as CSSProperties}>
    <header className="od-header"><Link href="/train" className="od-back">← Learn</Link><div className="od-brand"><img src={art.emblem} alt="" width="32" height="32" /><h1>Operational Decision</h1></div><span className="od-shift">Shift {String(shift).padStart(2, '0')}<span> · {dossier?.edition.toUpperCase() ?? 'AUS'}</span></span><button onClick={() => setTool('keys')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button></header>
    <div className="od-room">
      <div className="od-plaque"><span>MINISTRY OF TRANSPORT</span><strong>Dispatch office</strong><span>{plan ? `§${shift} · ${decree(plan.introduces).title}` : 'AIR NAVIGATION CODE'}</span></div>
      <div className="od-window" aria-label={`Departure weather: ${weather}`} style={weather !== 'unknown' && art[`window-${weather}`] ? { backgroundImage: `url(${art[`window-${weather}`]})` } : undefined}><div /><div /><div /><div /></div>
      {dossier && <div className="od-crew"><img src={art[portrait]} alt={portrait === 'inspector' ? 'Ministry inspector' : portrait === 'captain' ? 'Captain' : 'First officer'} width="112" height="112" /><div><p>{dossier.pressure.line}</p>{dossier.pressure.rebelHook && <button onClick={() => setTool('scene')}>{scene ? 'Folded note' : 'A folded note…'}</button>}</div></div>}
    </div>
    {status !== 'ready' || !dossier ? <div className="od-empty" role="status"><h2>{status === 'preparing' ? 'Opening the office…' : status === 'finished' ? 'The office is closed.' : 'No dossier available'}</h2>{status === 'finished' && <><p>All {DECREES.length} shifts complete. The ledger is filed.</p><Link href="/train">Return to Learn →</Link></>}{status === 'unavailable' && <><p>The supplied weather cannot support this shift, or an office file could not be loaded.</p><button onClick={() => setRetry(n => n + 1)}>Retry</button><Link href="/train">Return to Learn</Link></>}</div> : <>
      <div className="od-files" aria-label="Desk documents"><div className="od-file-tabs">{DOCUMENTS.map(([id, title, number]) => <button key={id} aria-pressed={sheets[active] === id} onClick={() => selectDocument(id)} title={`${number} · ${title}`}><span>{number}</span>{title}</button>)}</div><div className="od-tool-buttons"><button onClick={() => setTool('ruler')}>Ruler</button><button onClick={() => setTool('wind')}>Wind card</button><button className="od-tidy" onClick={() => { setPositions(initialPositions); setSheets(['plan', 'taf']); setActive(0); }} title="Arrange flight plan and TAF side by side">Arrange</button></div></div>
      <nav className="od-mobile-nav" aria-label="Document stack"><button aria-label="Previous document" onClick={() => stepDocument(-1)}>←</button><select aria-label="Document" value={sheets[active]} onChange={e => selectDocument(e.target.value as DocumentId)}>{DOCUMENTS.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select><span>{currentDoc[2]}/06</span><button aria-label="Next document" onClick={() => stepDocument(1)}>→</button></nav>
      <div className="od-workspace" ref={surface}>
        {sheets.map((id, i) => { const slot = i as 0 | 1; const doc = DOCUMENTS.find(d => d[0] === id)!; return <article className={`od-document ${active === slot ? 'is-active' : ''}`} data-testid={`document-${slot}`} key={slot} style={{ '--sheet-x': `${positions[slot].x}px`, '--sheet-y': `${positions[slot].y}px` } as CSSProperties} onPointerDown={() => setActive(slot)} aria-label={doc[1]}>
          <div className="od-paper-handle" onPointerDown={e => startDrag(e, slot)} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><span aria-hidden="true">⠿</span><button onClick={() => setActive(slot)} aria-label={`Select ${doc[1]} sheet`} title="Drag the top edge to move this sheet">{doc[1]}</button><span>{doc[2]}</span></div>
          <div className="od-paper-content" tabIndex={0} onTouchStart={e => { swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }} onTouchEnd={e => { const start = swipe.current; swipe.current = null; if (!start || e.changedTouches.length !== 1) return; const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) stepDocument(dx < 0 ? 1 : -1); }}><DocumentContent key={`${dossier.id}-${id}`} id={id} dossier={dossier} emblemSrc={art.emblem} /></div>
        </article>; })}
      </div>
      <footer className="od-tray">
        <div className="od-ledger"><span>Dossier {position + 1}/{plan?.dossierCount}</span><span title="Correct decisions / Ministry citations">✓ {score?.correct} · § {score?.citations}</span></div>
        {!result ? <div className="od-stamps" aria-label="Decision stamps"><button ref={stampRef} className="od-stamp od-release" onClick={() => submit({ stamp: 'RELEASE' })} aria-keyshortcuts="R"><span>RELEASE</span><kbd>R</kbd></button><button className="od-stamp od-refuse" onClick={() => submit({ stamp: 'REFUSE' })} aria-keyshortcuts="F"><span>REFUSE</span><kbd>F</kbd></button><button className="od-stamp od-amend" onClick={() => setTool('amend')} aria-keyshortcuts="A"><span>AMEND</span><kbd>A</kbd></button></div> : <div className="od-outcome" role="status"><span aria-hidden="true" className="od-seal" data-stamp={stamped} /><span className={`od-ink od-${stamped?.toLowerCase()}`}><span aria-hidden="true">{result.correct ? '✓' : '§'}</span> {stamped}</span><span>{!result.assessable ? 'Unassessed' : result.correct ? 'Filed' : <button onClick={() => setTool('citation')}>Ministry citation</button>}</span>{saveFailed && <span className="od-save-error">Learn progress not saved</span>}<button className="od-next" onClick={next}>{score?.complete ? 'Close shift →' : 'Next dossier →'}</button></div>}
        <span className="od-scope" title="Teaching simulation with fictional operations data">Teaching desk</span>
      </footer>
    </>}
    {tool && (dossier || tool === 'keys') && <Slip title={{ amend: 'Amendment slip', wind: 'Wind component card', ruler: 'ETA ruler', citation: 'Ministry citation', keys: 'Desk controls', scene: 'Folded note' }[tool]} close={close}>
      {tool === 'amend' && dossier && <Amendment dossier={dossier} submit={submit} />}
      {tool === 'wind' && dossier && <WindCard dossier={dossier} />}
      {tool === 'ruler' && dossier && <Ruler dossier={dossier} />}
      {tool === 'citation' && dossier && result && <div className="od-citation" data-testid="citation"><div className="od-letterhead"><span>MINISTRY OF TRANSPORT</span><span>NON-COMPLIANCE</span></div>{result.error && <p>{result.error}</p>}{result.rules.map(id => { const rule = decree(id), variant = editionVariant(rule, dossier.edition); return <section key={id}><h3>§{rule.shiftIntroduced} · {rule.title}</h3><p>{variant.citation} {variant.reason}</p>{result.after.filter(a => a.decreeId === id).map(a => <p key={a.decreeId}>{a.result.detail}</p>)}{variant.realRule.map((source, i) => <p key={i}><a href={source.url} target="_blank" rel="noreferrer">{source.document} · {source.section} ↗</a><small>{source.scope}</small></p>)}<Link href={`/train?concept=${encodeURIComponent(rule.conceptId)}`}>Learn this rule →</Link></section>; })}<button className="od-primary" onClick={close}>Acknowledge</button></div>}
      {tool === 'keys' && <><dl className="od-shortcuts">{[['R', 'Release'], ['F', 'Refuse'], ['A', 'Amend'], ['1–6 / ← →', 'Choose document'], ['T / W', 'Ruler / wind card'], ['N', 'Next dossier'], ['Esc', 'Close slip']].map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl><p>Drag a sheet by its top edge. Select a sheet, then choose its document. Arrange restores two sheets side by side. On a phone, swipe the paper or use the arrows.</p><p className="od-footnote">Fictional operations and teaching values. Published weather is frozen for this sitting.</p></>}
      {tool === 'scene' && dossier?.pressure.rebelHook && <><p>{scene ?? rebelPrompt(dossier.pressure.rebelHook)}</p>{!scene && <div className="od-scene-choices"><button onClick={() => setScene(rebelOutcome(dossier.pressure.rebelHook!, 'help'))}>Help</button><button onClick={() => setScene(rebelOutcome(dossier.pressure.rebelHook!, 'refuse'))}>Refuse</button><button onClick={() => setScene(rebelOutcome(dossier.pressure.rebelHook!, 'report'))}>Report</button></div>}</>}
    </Slip>}
  </div>;
}
