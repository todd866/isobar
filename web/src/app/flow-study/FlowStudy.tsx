'use client';

import { useEffect, useRef, useState } from 'react';
import { verticalMotionCue } from '@/lib/vertical-motion';

type Variant = 'trails' | 'ribbons' | 'ticks';
const variants: Array<{ id: Variant; title: string }> = [
  { id: 'trails', title: 'Lifted trails' },
  { id: 'ribbons', title: 'Shallow ribbon arcs' },
  { id: 'ticks', title: 'Directional ticks' },
];

const points = [
  { x: 0.22, y: 0.38, w: 0.8 },
  { x: 0.37, y: 0.56, w: -1.25 },
  { x: 0.53, y: 0.33, w: 0.35 },
  { x: 0.67, y: 0.62, w: -0.65 },
  { x: 0.81, y: 0.43, w: 0 },
];

function drawStudy(canvas: HTMLCanvasElement, variant: Variant, dark: boolean, time: number, reduced: boolean) {
  const box = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = dark ? '#111a20' : '#eef4f4';
  const ink = dark ? '#b9d1d8' : '#335662';
  const coast = dark ? '#46636a' : '#a6c3c6';
  const blue = dark ? '#86c6df' : '#1879a6';
  const amber = dark ? '#e7a66e' : '#b96631';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // A deliberately generic, map-like texture: coast, grid, and flowing wind.
  ctx.strokeStyle = dark ? '#253840' : '#d7e4e4';
  ctx.lineWidth = 1;
  for (let x = 18; x < width; x += 34) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 18; y < height; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.strokeStyle = coast;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(width * .06, height * .74); ctx.bezierCurveTo(width * .18, height * .62, width * .13, height * .38, width * .31, height * .29);
  ctx.bezierCurveTo(width * .45, height * .2, width * .48, height * .38, width * .62, height * .26);
  ctx.bezierCurveTo(width * .79, height * .13, width * .83, height * .34, width * .96, height * .23);
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  for (let row = 0; row < 6; row += 1) {
    const y = height * (0.16 + row * 0.13);
    for (let col = 0; col < 8; col += 1) {
      const driftX = reduced ? 0 : (time * .008 + row * 7) % (width * .12);
      const x = width * (0.02 + col * 0.12) + driftX;
      const drift = Math.sin(row * 1.7 + col) * 5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 9, y + drift); ctx.stroke();
    }
  }

  const phase = reduced ? 0 : time * 0.00045;
  for (const p of points) {
    const x = p.x * width;
    const y = p.y * height;
    const cue = verticalMotionCue(p.w);
    const amplitude = cue.direction === 'neutral' ? 0 : 7 + cue.strength * Math.min(25, height * .14);
    const sign = cue.direction === 'up' ? -1 : cue.direction === 'down' ? 1 : 0;
    const hue = sign < 0 ? blue : sign > 0 ? amber : ink;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.17;
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.ellipse(0, 9, 24, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = hue;
    ctx.fillStyle = hue;
    ctx.lineWidth = 2;
    const bob = reduced ? 0 : Math.sin(phase + x * .02) * 2;
    if (variant === 'trails') {
      const start = sign > 0 ? 6-amplitude : 6, end = sign < 0 ? 6-amplitude : 6;
      ctx.beginPath(); ctx.moveTo(-23,start); ctx.quadraticCurveTo(0,(start+end)/2+2,23,end); ctx.stroke();
      const progress = reduced ? .8 : (phase + p.x) % 1;
      ctx.beginPath(); ctx.arc(-23+46*progress, start+(end-start)*progress, 2, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(23,end); ctx.lineTo(17,end+3); ctx.moveTo(23,end); ctx.lineTo(17,end-3); ctx.stroke();
    } else if (variant === 'ribbons') {
      const start = sign > 0 ? 6-amplitude : 6, end = sign < 0 ? 6-amplitude : 6;
      ctx.globalAlpha = 0.72;
      ctx.beginPath(); ctx.moveTo(-23,start); ctx.bezierCurveTo(-8,start+bob,8,end,23,end);
      ctx.lineTo(20,end+3); ctx.bezierCurveTo(8,end+5,-8,start+5,-23,start+2); ctx.closePath();
      ctx.globalAlpha=.25; ctx.fill(); ctx.globalAlpha=.8; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(23,end); ctx.lineTo(17,end+3); ctx.moveTo(23,end); ctx.lineTo(17,end-3); ctx.stroke();
    } else if (sign !== 0) {
      const len = Math.max(7, amplitude * .72);
      ctx.beginPath(); ctx.moveTo(0, sign > 0 ? -len : len); ctx.lineTo(0, sign > 0 ? len : -len); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, sign > 0 ? len : -len); ctx.lineTo(-4, sign > 0 ? len - 5 : -len + 5); ctx.moveTo(0, sign > 0 ? len : -len); ctx.lineTo(4, sign > 0 ? len - 5 : -len + 5); ctx.stroke();
    }
    ctx.restore();
  }
}

function StudyCanvas({ variant, reduced }: { variant: Variant; reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let frame: number | null = null;
    let stopped = false;
    let hidden = document.visibilityState === 'hidden';
    const render = (time: number) => {
      frame = null;
      if (stopped || hidden) return;
      drawStudy(canvas, variant, document.documentElement.classList.contains('dark'), time, reduced);
      if (!reduced) frame = requestAnimationFrame(render);
    };
    const requestPaint = () => {
      if (!stopped && !hidden && frame === null) frame = requestAnimationFrame(render);
    };
    const visibility = () => { hidden = document.visibilityState === 'hidden'; if (hidden && frame !== null) { cancelAnimationFrame(frame); frame = null; } if (!hidden) requestPaint(); };
    document.addEventListener('visibilitychange', visibility);
    const observer = new MutationObserver(requestPaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const resize = new ResizeObserver(requestPaint);
    resize.observe(canvas);
    if (reduced) drawStudy(canvas, variant, document.documentElement.classList.contains('dark'), 0, true);
    else requestPaint();
    return () => { stopped = true; if (frame !== null) cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); observer.disconnect(); resize.disconnect(); };
  }, [reduced, variant]);
  return <canvas ref={ref} className="flow-study-canvas" aria-label={`${variant} illustrative vertical motion map`} />;
}

export function FlowStudy() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(media.matches);
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return (
    <section className="flow-study" aria-labelledby="flow-study-title">
      <div className="flow-study-controls" aria-label="Study controls">
        <span id="flow-study-title" className="flow-study-kicker">ILLUSTRATIVE · 700 hPa · w m/s</span>
        <span className="flow-study-legend"><span className="legend-up">↑ rise +w</span><span className="legend-down">↓ sink −w</span></span>
        <label className="flow-study-toggle"><input type="checkbox" checked={reduced} onChange={(event) => setReduced(event.target.checked)} /> reduce motion</label>
      </div>
      <div className="flow-study-grid">
        {variants.map((item) => <article className="flow-study-card" key={item.id}><div className="flow-study-card-head"><h2>{item.title}</h2></div><StudyCanvas variant={item.id} reduced={reduced} /></article>)}
      </div>
    </section>
  );
}
