'use client';

import { useEffect, useRef, useState } from 'react';
import { mountE6B, type E6BStore } from '../../../../training/src/instruments/e6b/index.ts';
import { SYNCED, progressStore } from '@/lib/account/local';

/** The ASA E6-B flight computer, both sides, with Learn, Practice and Free.
 * The instrument sizes itself to this box, so the box has a definite height. */
export function E6BMount() {
  const host = useRef<HTMLDivElement>(null);
  // E6-B progress synced from the account remounts the instrument until this visit saves its own.
  const [generation, setGeneration] = useState(0);
  const saved = useRef(false);
  useEffect(() => {
    const onSynced = (event: Event) => {
      if ((event as CustomEvent<{ kinds: string[] }>).detail?.kinds.includes('e6b') && !saved.current) setGeneration((n) => n + 1);
    };
    window.addEventListener(SYNCED, onSynced);
    return () => window.removeEventListener(SYNCED, onSynced);
  }, []);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const store = progressStore('e6b', () => { saved.current = true; }) as E6BStore;
    const computer = mountE6B(node, { variant: 'lab', store });
    // Headless QA drives lesson states through the instrument's own API.
    (window as unknown as { e6b?: unknown }).e6b = computer;
    return () => {
      // destroy() arrives with the crp-computer merge; until then, just clear the host.
      (computer as unknown as { destroy?: () => void }).destroy?.();
      node.innerHTML = '';
    };
  }, [generation]);
  return <div ref={host} className="e6b-host w-full" />;
}
