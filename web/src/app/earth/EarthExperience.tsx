'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { orbitFrame, orbitRecord, parseOrbitSource, MAX_ORBIT_AGE_MS, REFERENCE_ORBIT, type OrbitSource } from '@/lib/earth-orbit';
import type { EarthScene, EarthView } from '@/lib/earth-scene';

export function EarthExperience() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<EarthScene | null>(null);
  const clock = useRef({ utc: 0, base: 0, playing: true, rate: 1, held: false });
  const [source, setSource] = useState<OrbitSource | null>(null);
  const [utc, setUtc] = useState(0), [view, setView] = useState<EarthView>('follow');
  const [playing, setPlaying] = useState(true), [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const [info, setInfo] = useState(false), [attempt, setAttempt] = useState(0);
  const [reference, setReference] = useState(false);
  const [position, setPosition] = useState('');
  const sourceButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let renderer: EarthScene | null = null, raf = 0, previous = 0, lastUi = 0, active = true;
    let resume: ((now: number) => void) | null = null;
    const visibility = () => {
      cancelAnimationFrame(raf); previous = 0; clock.current.held = false;
      if (!document.hidden && resume && active) raf = requestAnimationFrame(resume);
    };
    document.addEventListener('visibilitychange', visibility);
    const surface = canvas.current;
    const contextLost = (event: Event) => {
      event.preventDefault(); cancelAnimationFrame(raf);
      clock.current.playing = false; setPlaying(false); setReady(false); setError('Graphics interrupted');
    };
    surface?.addEventListener('webglcontextlost', contextLost);
    setError(''); setReady(false);
    const start = async () => {
      try {
        const [{ EarthScene }, data] = await Promise.all([
          import('@/lib/earth-scene'), reference ? Promise.resolve(REFERENCE_ORBIT) :
            fetch('/api/earth/orbit', { signal: controller.signal }).then(async response => {
              if (!response.ok) throw new Error('Current ISS elements unavailable');
              return parseOrbitSource(await response.json());
            }),
        ]);
        if (!active || !canvas.current) return;
        const time = data.kind === 'reference' ? Date.parse(data.epoch) : Date.now();
        const record = orbitRecord(data);
        orbitFrame(data, record, time); // Validate before displaying any scene.
        clock.current = { utc: time, base: time, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, rate: 1, held: false };
        setPlaying(clock.current.playing); setRate(1); setUtc(time); setSource(data); setView('follow');
        renderer = new EarthScene(canvas.current, () => setView('explore'));
        scene.current = renderer;
        await renderer.load(controller.signal);
        if (!active) return;
        setReady(true);
        const tick = (now: number) => {
          if (!active) return;
          const dt = previous ? now - previous : 0; previous = now;
          const c = clock.current;
          if (c.playing && !c.held && !document.hidden) c.utc += dt * c.rate;
          if (!document.hidden) {
            if (Math.abs(c.utc - Date.parse(data.epoch)) > MAX_ORBIT_AGE_MS) {
              c.playing = false; setPlaying(false); setReady(false); setError('Orbit outside supported time'); return;
            }
            let frame;
            try { frame = orbitFrame(data, record, c.utc); }
            catch { c.playing = false; setPlaying(false); setReady(false); setError('Orbit unavailable at this time'); return; }
            const rect = canvas.current!.getBoundingClientRect();
            renderer!.render(frame, Math.round(rect.width), Math.round(rect.height));
            if (now - lastUi > 250) {
              setUtc(c.utc); setPosition(frame.latitude.toFixed(1) + '° · ' + frame.longitude.toFixed(1) + '° · ' + Math.round(frame.altitude) + ' km');
              lastUi = now;
            }
          }
          if (!document.hidden) raf = requestAnimationFrame(tick);
        };
        resume = tick;
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : 'Earth unavailable'); setReady(false);
          surface?.removeEventListener('webglcontextlost', contextLost);
          renderer?.dispose(); scene.current = null;
        }
      }
    };
    void start();
    return () => { active = false; controller.abort(); cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', visibility); surface?.removeEventListener('webglcontextlost', contextLost); renderer?.dispose(); scene.current = null; };
  }, [attempt, reference]);

  useEffect(() => {
    if (!info) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setInfo(false); sourceButton.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info]);
  const changeView = (next: EarthView) => { scene.current?.setView(next); setView(next); };
  const togglePlay = () => { clock.current.playing = !clock.current.playing; setPlaying(clock.current.playing); setUtc(clock.current.utc); };
  const resetTime = () => {
    if (!source) return;
    const time = source.kind === 'reference' ? Date.parse(source.epoch) : Date.now();
    clock.current.utc = time; clock.current.base = time; setUtc(time);
  };
  return (
    <section className="earth-experience" data-ready={ready && !error} data-view={view} data-utc={Math.round(utc)}>
      <header className="earth-toolbar">
        <Link href="/" aria-label="Back to weather">←</Link>
        <strong>ISS{reference ? <small>Reference · 2019</small> : null}</strong>
        <select aria-label="View" value={view} disabled={!ready} onChange={e => changeView(e.target.value as EarthView)}>
          <option value="follow">Follow</option><option value="down">Look down</option>
          <option value="globe">Earth</option><option value="explore">Explore</option>
        </select>
        <button aria-label={playing ? 'Pause time' : 'Play time'} onClick={togglePlay} disabled={!ready}>{playing ? 'Ⅱ' : '▶'}</button>
        <select aria-label="Playback speed" value={rate} onChange={e => { const n = Number(e.target.value); clock.current.rate = n; setRate(n); }}>
          <option value="1">1×</option><option value="60">60×</option><option value="240">240×</option>
        </select>
        <button onClick={resetTime} disabled={!ready}>{source?.kind === 'reference' ? 'Epoch' : 'Now'}</button>
        <button ref={sourceButton} aria-expanded={info} onClick={() => setInfo(!info)}>Sources</button>
      </header>
      <div className="earth-stage">
        <canvas key={attempt + ':' + reference} ref={canvas} tabIndex={0} aria-label="ISS and Earth reconstruction" aria-describedby="earth-keyboard"
          onKeyDown={e => {
            if (e.key === ' ') { e.preventDefault(); clock.current.held = true; }
            else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home'].includes(e.key)) {
              e.preventDefault(); scene.current?.key(e.key); setView(e.key === 'Home' ? 'follow' : 'explore');
            }
          }}
          onKeyUp={e => { if (e.key === ' ') { e.preventDefault(); clock.current.held = false; } }}
          onBlur={() => { clock.current.held = false; }}
          onPointerDown={e => { clock.current.held = true; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerUp={() => { clock.current.held = false; }} onPointerCancel={() => { clock.current.held = false; }}
          onLostPointerCapture={() => { clock.current.held = false; }} />
        <div className="earth-caption">Surface only · Prototype</div>
        <span id="earth-keyboard" className="sr-only">Arrow keys explore; plus and minus zoom; Home returns to Follow. Hold Space or the pointer to freeze time; release to resume.</span>
        {!ready || error ? <div className="earth-message" role="status"><span>{error || 'Preparing Earth…'}</span>{error && <><button onClick={() => setAttempt(n => n + 1)}>Retry</button>{!reference && <button onClick={() => setReference(true)}>Preview 2019 reference</button>}</>}</div> : null}
        {info && <aside className="earth-sources" aria-label="Scene sources">
          <button aria-label="Close sources" onClick={() => { setInfo(false); sourceButton.current?.focus(); }}>×</button>
          <p>Reconstructed view. No live clouds or aurora.</p>
          <p><a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/">NASA Blue Marble</a> · October 2004 surface.</p>
          <p><a href="https://science.nasa.gov/resource/international-space-station-3d-model/">NASA VTAD</a> · ISS model. Orientation and configuration are illustrative.</p>
          <p>Orbit: {source?.kind === 'reference' ? 'Satellite.js published 2019 reference' : 'CelesTrak ISS elements'}. Epoch {source?.epoch}. Positions are propagated estimates, supported within 48 hours of the epoch.</p>
          {source?.retrievedAt && <p>Retrieved {source.retrievedAt}.</p>}
          <p>The prototype clock holds while this page is hidden. {reference ? 'Epoch returns to the reference time.' : 'Now returns to current UTC.'}</p>
          <p>Atmosphere is illustrative. Earth rotation uses UTC as an approximation to UT1. No onboard camera feed.</p>
        </aside>}
      </div>
      <footer className="earth-time">
        <time>{utc ? new Date(utc).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '— UTC'}</time>
        <span className="earth-position">{position}</span>
        <input aria-label="Orbit time" type="range" min="-2700" max="2700" step="1" disabled={!ready}
          value={Math.max(-2700, Math.min(2700, (utc - clock.current.base) / 1000))}
          onChange={e => { clock.current.utc = clock.current.base + Number(e.target.value) * 1000; clock.current.playing = false; setPlaying(false); setUtc(clock.current.utc); }} />
      </footer>
    </section>
  );
}
