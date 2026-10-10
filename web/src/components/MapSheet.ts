'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Side panel on a desktop-width viewport, and on a short landscape phone wide enough to keep the map beside it. */
export const POINT_SIDE_QUERY = '(min-width: 768px), (min-width: 560px) and (max-height: 500px) and (orientation: landscape)';

/** Fly uses the same side-panel rule as a point, including short landscape. */
export const DESKTOP_MQ = POINT_SIDE_QUERY;

/** Shared Fly/point sheet geometry: above the lens bar, below the time slider. */
export function useMapSheet(anchorRef: RefObject<HTMLElement | null>, sideQuery = DESKTOP_MQ) {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(sideQuery).matches);
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number; top: number; ceiling: number } | null>(null);
  useEffect(() => {
    const query = window.matchMedia(sideQuery);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [sideQuery]);
  useEffect(() => {
    if (desktop) return;
    const node = anchorRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const slider = document.querySelector('[data-timeline]')?.getBoundingClientRect();
      const ceiling = slider ? slider.bottom + 6 : 52;
      setAnchor((old) => old && old.left === rect.left && old.width === rect.width && old.bottom === rect.bottom && old.top === rect.top && old.ceiling === ceiling
        ? old : { left: rect.left, width: rect.width, bottom: rect.bottom, top: rect.top, ceiling });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [anchorRef, desktop]);
  return { desktop, anchor };
}
