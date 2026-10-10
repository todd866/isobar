'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildAtmosphereProfile } from '@/lib/atmosphere-profile';
import { syntheticAtmosphereProfile, syntheticAtmosphereVectors, drawAtmosphereFlow } from '@/lib/atmosphere-flow';
import type { Camera, Lambert } from '@/lib/lambert';
import styles from './AtmosphereMap.module.css';

export function AtmosphereMap({ camera, geo, lat, lon, validMs, width, height, active }: {
  camera: Camera; geo: Lambert; lat: number; lon: number; validMs: number; width: number; height: number; active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sectionButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState(false);
  const [aircraftFt, setAircraftFt] = useState(5000);
  const selectedLat = Math.round(lat * 10) / 10, selectedLon = Math.round(lon * 10) / 10;
  const vectorTime = Math.floor(validMs / 300000) * 300000;
  const vectors = useMemo(() => syntheticAtmosphereVectors(lat, lon, camera.halfHeight, width / Math.max(1, height), vectorTime), [lat, lon, camera.halfHeight, width, height, vectorTime]);
  const model = useMemo(() => syntheticAtmosphereProfile(selectedLat, selectedLon, validMs), [selectedLat, selectedLon, validMs]);
  const profile = useMemo(() => buildAtmosphereProfile(model, validMs), [model, validMs]);
  const ground = profile?.terrainM ?? null;
  const aircraftM = Math.max(aircraftFt * .3048, ground == null ? 0 : ground + 100);
  const ceiling = Math.max(12000, aircraftM + 500, ...(profile?.layers.map(l => l.topM + 500) ?? []));
  useEffect(() => {
    if (!section) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSection(false); sectionButton.current?.focus(); e.preventDefault(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [section]);
  useLayoutEffect(() => {
    const node = canvas.current, ctx = node?.getContext('2d');
    if (!node || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (node.width !== Math.round(width * dpr)) node.width = Math.round(width * dpr);
    if (node.height !== Math.round(height * dpr)) node.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let request = 0, last = -Infinity;
    const draw = (now: number) => {
      if (now - last >= 32) {
        last = now; ctx.clearRect(0, 0, width, height);
        const drawn = active ? drawAtmosphereFlow(ctx, vectors, geo, camera, width, height, now / 1000, document.documentElement.classList.contains('dark')) : {layers: 0, flows: 0};
        node.dataset.layers = String(drawn.layers); node.dataset.flows = String(drawn.flows);
      }
      if (active && vectors.length) request = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(request);
  }, [active, vectors, camera, geo, width, height]);
  if (!active) return null;
  const y = (m: number) => 180 - m / ceiling * 168;
  const knownCloud = !!profile?.levels.some(l => l.cloudFractionPct != null);
  const verticalKnown = !!profile?.levels.some(l => l.verticalVelocityMs != null);
  const status = camera.halfHeight >= 6 ? 'distant' : 'ready';
  return <>
    <canvas ref={canvas} data-atmosphere-layer data-source="synthetic" data-profile-state={status} className={styles.canvas} aria-hidden="true" />
    <div className={styles.instrument} data-atmosphere-instrument>
      <div className={styles.row}>
        <button ref={sectionButton} aria-expanded={section} aria-label="Atmospheric section" onClick={() => setSection(v => !v)}>▱ <span>Atmosphere</span></button>
        <span className={styles.state} title="Synthetic atmospheric data; vertical separation adapts to map scale" aria-label="Synthetic atmospheric data; vertical separation adapts to map scale">≈</span>
      </div>
      {section ? <div className={styles.section} data-atmosphere-section>
        <div className={styles.row}><span>Illustrative profile</span><button aria-label="Close atmospheric section" onClick={() => { setSection(false); sectionButton.current?.focus(); }}>×</button></div>
        <svg viewBox="0 0 260 205" role="img" aria-label={profile ? `Synthetic column at ${selectedLat}, ${selectedLon}. Heights in feet above mean sea level. Horizontal shape is illustrative.` : 'Atmospheric profile unavailable'}>
          {[0, 3000, 6000, 9000, 12000].filter(m => m <= ceiling).map(m => <g key={m}><path d={`M42 ${y(m)}H246`} className={styles.grid} /><text x="36" y={y(m) + 4} textAnchor="end">{Math.round(m / .3048 / 1000)}k</text></g>)}
          {profile?.layers.map(l => <g key={l.id}><rect x="80" width="130" y={y(l.topM)} height={Math.max(2, y(l.baseM) - y(l.topM))} rx="7" className={styles.cloud}/><text x="145" y={(y(l.baseM) + y(l.topM)) / 2 + 4} textAnchor="middle">{Math.round(l.cloudFractionPct)}%</text></g>)}
          {ground != null ? <path d={`M42 ${y(ground)}H246V180H42Z`} className={styles.ground}/> : null}
          {profile?.levels.filter((_, i) => i % 2 === 0).map((l, i) => <g key={i}>
            {l.windKt != null && l.windFromDeg != null ? <text x="240" y={y(l.heightM) + 4} textAnchor="end">{Math.round(l.windKt)}</text> : null}
            {l.verticalVelocityMs != null ? <text x="50" y={y(l.heightM) + 4} fill={l.verticalVelocityMs > 0 ? '#ad6726' : '#287b9e'}>{l.verticalVelocityMs > .001 ? '↑' : l.verticalVelocityMs < -.001 ? '↓' : '·'}</text> : null}
          </g>)}
          <path d={`M42 ${y(aircraftM)}H246`} className={styles.aircraftLine}/><text x="65" y={y(aircraftM) - 4}>✈</text>
          <text x="8" y="201">ft AMSL</text><text x="244" y="201" textAnchor="end">wind kt</text>
          {!profile || !knownCloud ? <text x="145" y="95" textAnchor="middle">{status === 'distant' ? 'Zoom in for atmosphere' : 'Cloud profile unavailable'}</text> : profile.layers.length === 0 ? <text x="145" y="95" textAnchor="middle">No sampled cloud layer</text> : null}
        </svg>
        <label className={styles.altitude}><span>✈</span><input type="range" aria-label="Reference aircraft altitude" min={Math.ceil(((ground ?? 0) + 100) / .3048 / 500) * 500} max="40000" step="500" value={Math.round(aircraftM / .3048)} onChange={e => setAircraftFt(Number(e.target.value))}/><output>{Math.round(aircraftM / .3048 / 100) * 100} ft</output></label>
        <div className={styles.meta} title={profile ? `${profile.source.source} · ${profile.source.model} · ${profile.source.cycleKnown ? 'Run' : 'Retrieved'} ${profile.source.run}. ${verticalKnown ? 'Geometric vertical velocity, m/s positive up.' : 'Vertical velocity unavailable; horizontal wind is not an inferred updraft.'} Aircraft icon is an altitude marker at distant scale.` : 'Missing data is not clear sky.'}>
          <span>{profile?.source.model ?? 'Profile —'}</span><span>{verticalKnown ? '↕ m/s' : 'w —'}</span>
        </div>
        <div className={styles.meta}><span>{selectedLat.toFixed(1)}°, {selectedLon.toFixed(1)}°</span><time dateTime={new Date(validMs).toISOString()}>{new Date(validMs).toISOString().slice(11,16)}Z</time></div>
      </div> : null}
    </div>
  </>;
}
