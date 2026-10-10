import { useEffect, useRef, useState } from 'react';
import type { Decision, Dossier } from '@/lib/od/model';
import { forecastGroups, forecastWindow, metarConditions } from '@/lib/od/weather';
import { FLEET } from '@/lib/od/manual';
import { utc, windReading } from '@/lib/od/desk';

export function Slip({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="od-slip" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button type="button" aria-label={`Close ${title}`} onClick={close}>×</button></header>
    <div className="od-slip-body">{children}</div>
  </dialog>;
}

export function Amendment({ dossier: d, submit }: { dossier: Dossier; submit: (decision: Decision) => void }) {
  const [alternate, setAlternate] = useState('');
  const [fuel, setFuel] = useState('');
  const [delay, setDelay] = useState('');
  const extra = Number(fuel), minutes = Number(delay);
  const valid = (alternate || extra > 0 || minutes > 0) && Number.isFinite(extra) && extra >= 0 && extra + d.plan.fuelKg <= FLEET[d.aircraft].maxFuelKg && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440;
  return <form onSubmit={event => { event.preventDefault(); if (!valid) return; submit({ stamp: 'AMEND', ...(alternate ? { alternate } : {}), ...(extra > 0 ? { fuel: d.plan.fuelKg + extra } : {}), ...(minutes > 0 ? { delay: minutes } : {}) }); }}>
    <div className="od-letterhead"><span>DISPATCH AMENDMENT</span><span>OD / A</span></div>
    <label>Alternate<select aria-label="Alternate" value={alternate} onChange={event => setAlternate(event.target.value)}><option value="">Keep nominated alternate</option>{d.alternatives.filter(a => a.aerodrome.id !== d.plan.alternateId).map(a => <option key={a.aerodrome.id} value={a.aerodrome.id}>{a.aerodrome.name} · {a.distanceNm} NM</option>)}</select></label>
    <label>Extra fuel · kg<input type="number" inputMode="numeric" min="0" max={FLEET[d.aircraft].maxFuelKg - d.plan.fuelKg} step="1" value={fuel} onChange={e => setFuel(e.target.value)} placeholder="0" /></label>
    <label>Delay · min<input type="number" inputMode="numeric" min="0" max="1440" step="1" value={delay} onChange={e => setDelay(e.target.value)} placeholder="0" /></label>
    <p className="od-footnote">Fuel after amendment: {Number.isFinite(extra) ? (d.plan.fuelKg + extra).toLocaleString() : '—'} kg. All active decrees are checked again.</p>
    <button className="od-primary" disabled={!valid} type="submit">Stamp amendment</button>
  </form>;
}

export function WindCard({ dossier: d }: { dossier: Dossier }) {
  const report = metarConditions(d.departureWeather);
  const [heading, setHeading] = useState(String(d.plan.departureRunway.headingTrueDeg));
  const [direction, setDirection] = useState(report?.windFromTrueDeg == null ? '' : String(report.windFromTrueDeg));
  const [speed, setSpeed] = useState(report ? String(report.windKt) : '');
  const reading = heading && direction && speed ? windReading(Number(heading), Number(direction), Number(speed)) : null;
  return <>
    <p>Departure · gust speed · directions true</p>
    <div className="od-wind-inputs">{[['Runway °T', heading, setHeading, 360], ['Wind from °T', direction, setDirection, 360], ['Wind kt', speed, setSpeed, 200]].map(([label, value, set, max]) => <label key={String(label)}>{String(label)}<input type="number" min="0" max={Number(max)} step="1" inputMode="numeric" value={String(value)} onChange={e => (set as (v: string) => void)(e.target.value)} /></label>)}</div>
    <svg className="od-wind-diagram" viewBox="0 0 220 150" aria-hidden="true"><path d="M110 130V20m-10 15 10-15 10 15M30 100h160" stroke="currentColor" fill="none" strokeWidth="2" /><rect x="98" y="35" width="24" height="94" fill="none" stroke="currentColor" />{reading && <path data-testid="wind-arrow" d="M110 45v80m-8-10 8 10 8-10" stroke="#873829" strokeWidth="4" fill="none" transform={`rotate(${Number(direction) - Number(heading)} 110 85)`} />}</svg>
    <dl className="od-wind-results"><div><dt>Crosswind</dt><dd data-testid="crosswind">{reading ? `${reading.crosswind.toFixed(1)} kt` : '—'}</dd></div><div><dt>{reading && reading.headwind < 0 ? 'Tailwind' : 'Headwind'}</dt><dd data-testid="headwind">{reading ? `${Math.abs(reading.headwind).toFixed(1)} kt` : '—'}</dd></div></dl>
    {!reading && <p role="status">Enter a known direction and speed; variable wind has no single component.</p>}
    <p className="od-footnote">Crosswind = wind × |sin(wind direction − runway heading)|. {d.plan.departureRunway.state} limit: {FLEET[d.aircraft].crosswindLimitsKt[d.plan.departureRunway.state]} kt.</p>
  </>;
}

export function Ruler({ dossier: d }: { dossier: Dossier }) {
  const taf = d.destinationWeather.taf;
  const eta = Date.parse(d.plan.arrivalUtc);
  const [offset, setOffset] = useState(0);
  if (!taf) return <p>TAF unavailable.</p>;
  const from = Math.min(Date.parse(taf.from), eta - 3_600_000), to = Math.max(Date.parse(taf.to), eta + 3_600_000);
  const at = eta + offset * 60_000;
  const groups = forecastGroups(d.destinationWeather) ?? [];
  const current = forecastWindow(d.destinationWeather, at, at);
  const pc = (t: number) => 100 * (t - from) / (to - from);
  return <>
    <div className="od-ruler-readout"><strong data-testid="ruler-time">{utc(at)}</strong><button onClick={() => setOffset(0)}>Align ETA</button></div>
    <label>Ruler offset · minutes<input aria-label="Ruler offset minutes" type="range" min={Math.ceil((from - eta) / 60_000)} max={Math.floor((to - eta) / 60_000)} step="1" value={offset} onChange={e => setOffset(Number(e.target.value))} /></label>
    <div className="od-ruler" aria-label="TAF periods and arrival marker">
      <div className="od-ruler-ticks"><span>{utc(from)}</span><span>{utc(to)}</span></div>
      {groups.map((g, i) => <div className="od-ruler-lane" key={i}><div style={{ left: `${pc(g.start)}%`, width: `${pc(g.end) - pc(g.start)}%` }} title={`${g.marker || 'BASE'} ${utc(g.start)} – ${utc(g.end)}`}>{g.kind === 'base' ? 'BASE' : g.marker}</div></div>)}
      <div className="od-ruler-hairline" style={{ left: `${pc(at)}%` }} />
    </div>
    <p data-testid="ruler-reading">{current ? current.map(g => g.marker || 'BASE').join(' + ') : 'Outside TAF validity'}</p>
    <p className="od-footnote">The red line is the selected instant. Planning also needs the Code window: ETA −{d.edition === 'aus' ? 30 : 60} / +60 min. Sliding this ruler does not amend the flight.</p>
    {current?.map((g, i) => <pre key={i}>{g.body}</pre>)}
  </>;
}
