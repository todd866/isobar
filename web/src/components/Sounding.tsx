'use client';

import { useEffect, useRef, useState } from 'react';
import { drawBarb } from '@/lib/sky/render';
import type { SkyLayer } from '@/lib/sky/physics';
import { paintCloudSprite, prepareCloudSprites } from '@/lib/sky/painted';
import {
  drawSounding, heightFraction, plotY,
  type AirRow, type SeaRow, type SoundingEmphasis,
} from '@/lib/point/sounding';
import type { SectionSample } from '@/lib/point/terrain-section';
import styles from './PointPanel.module.css';

export function Sounding({
  rows, sea, layers, icing, freezingFt, bottomFt, groundFt, section, modelGroundM, emphasis, activeId, onActive, temp = 'C',
}: {
  rows: AirRow[];
  sea: SeaRow[];
  layers: SkyLayer[];
  icing: { baseFt: number; topFt: number }[];
  freezingFt: number | null;
  bottomFt: number;
  groundFt: number | null;
  section?: SectionSample[] | null;
  modelGroundM?: number | null;
  emphasis: SoundingEmphasis;
  activeId: string;
  onActive: (id: string) => void;
  temp?: 'C' | 'F';
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cloudCanvas = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dark, setDark] = useState(false);
  const [spritesReady, setSpritesReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    prepareCloudSprites()
      .then(() => { if (mounted) setSpritesReady(true); })
      .catch(() => { if (mounted) setSpritesReady(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((old) => Math.abs(old.w - rect.width) < 0.5 && Math.abs(old.h - rect.height) < 0.5 ? old : { w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || size.w < 2 || size.h < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(canvas);
    const ink = dark ? '#9fd0e4' : '#174e66';
    const scale = 1.55;
    cloudCanvas.current ??= document.createElement('canvas');
    drawSounding(ctx, {
      width: size.w, height: size.h, rows, layers, icing, freezingFt, bottomFt, groundFt, section, modelGroundM, emphasis, dark, temp,
      ink, muted: style.getPropertyValue('--md-on-surface-variant').trim() || style.color,
      cloudPainter: { paintCloudSprite, canvas: cloudCanvas.current, dpr },
    }, (x, y, kt, from, length) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      drawBarb(ctx, 0, 0, kt, from, ink, length / scale);
      ctx.restore();
    });
  }, [size, rows, layers, icing, freezingFt, bottomFt, groundFt, section, modelGroundM, emphasis, dark, temp, spritesReady]);

  const pick = (clientY: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || !rows.length) return;
    let best = rows[rows.length - 1];
    let bestDistance = Infinity;
    for (const row of rows) {
      const y = plotY(heightFraction(row.feet ?? bottomFt, bottomFt), rect.height);
      const distance = Math.abs(y - (clientY - rect.top));
      if (distance < bestDistance) { best = row; bestDistance = distance; }
    }
    onActive(best.id);
  };

  const yOf = (feet: number | null) => plotY(heightFraction(feet ?? bottomFt, bottomFt), size.h);
  const known = (section ?? []).filter((sample) => sample.metres != null && Number.isFinite(sample.metres));
  const mid = known.length ? known.reduce((best, sample) => Math.abs(sample.distanceKm) < Math.abs(best.distanceKm) ? sample : best) : null;
  const edge = known.length >= 2 ? ((known[0].metres ?? 0) + (known[known.length - 1].metres ?? 0)) / 2 : null;
  const shown = new Set<string>();
  if (size.h > 0) {
    const placed = rows.map((row) => ({ id: row.id, y: yOf(row.feet) })).sort((a, b) => a.y - b.y);
    const pinned = new Set<string>();
    if (placed.some((item) => item.id === 'surface')) pinned.add('surface');
    if (placed.some((item) => item.id === activeId)) pinned.add(activeId);
    const pinY = placed.filter((item) => pinned.has(item.id)).map((item) => item.y);
    let last = -1e9;
    for (const item of placed) {
      if (pinned.has(item.id)) { shown.add(item.id); last = item.y; continue; }
      if (pinY.some((y) => Math.abs(item.y - y) < 15)) continue;
      if (item.y - last < 15) continue;
      shown.add(item.id);
      last = item.y;
    }
  }
  return (
    <div className={styles.graphic} data-sounding data-point-primary={emphasis} data-point-scroll data-ground-ft={groundFt == null ? undefined : String(Math.round(groundFt))} data-model-ground-m={modelGroundM == null || !Number.isFinite(modelGroundM) ? undefined : String(Math.round(modelGroundM))} data-section-mid={mid?.metres == null ? undefined : String(Math.round(mid.metres))} data-section-edge={edge == null ? undefined : String(Math.round(edge))}>
      <div
        ref={plotRef}
        className={styles.plot}
        onPointerMove={(event) => pick(event.clientY)}
        onPointerLeave={() => onActive('surface')}
      >
        <canvas ref={canvasRef} className={styles.field} aria-hidden="true" />
        {rows.map((row) => {
          const top = size.h > 0 ? yOf(row.feet) : 0;
          const crowded = size.h > 0 && !shown.has(row.id);
          return (
            <div key={row.id} className={styles.level} data-wind-row data-level={row.id} data-active={row.id === activeId ? 'true' : 'false'} data-crowded={crowded ? 'true' : 'false'} title={row.title} style={{ top }} aria-hidden={crowded || undefined}>
              <span className={styles.levelLabel} data-level-label>{row.label}</span>
              <span className={styles.levelTrack} />
              <span className={styles.windText} data-wind-text>{row.wind ?? ''}</span>
            </div>
          );
        })}
      </div>
      {sea.length ? (
        <div className={styles.sea}>
          {sea.map((row) => (
            <div key={row.id} className={styles.seaRow} data-sea-row={row.id} title={row.title}>
              {row.arrowDeg == null ? <span className={styles.seaMark} aria-hidden="true" /> : (
                <svg className={styles.seaArrow} viewBox="0 0 16 16" style={{ transform: `rotate(${row.arrowDeg}deg)` }} aria-hidden="true">
                  <path d="M8 2.2v9.2M8 2.2 5.1 5.4M8 2.2l2.9 3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              )}
              <span>{row.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
