'use client';

import { useEffect, useState } from 'react';
function iconOnly(button: HTMLButtonElement): boolean {
  return button.innerText.trim() === '' && !!button.getAttribute('aria-label');
}

/**
 * Phones have no hover. A long press on an icon-only control names it beside
 * the control and does not activate it.
 */
export function PhoneHoldNames({ active }: { active: boolean }) {
  const [label, setLabel] = useState<{ text: string; top: number; left: number; right: boolean } | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = document.querySelector<HTMLElement>('[data-map-page]');
    if (!root) return;
    let timer = 0;
    let shown = false;
    let suppress: HTMLButtonElement | null = null;
    let originX = 0;
    let originY = 0;
    let hideTimer = 0;
    const clearTimer = () => { window.clearTimeout(timer); timer = 0; };
    const down = (event: Event) => {
      const pointer = event as PointerEvent;
      const button = (pointer.target as Element | null)?.closest?.('button');
      if (!(button instanceof HTMLButtonElement) || !root.contains(button) || !iconOnly(button)) return;
      const name = button.getAttribute('aria-label');
      if (!name) return;
      clearTimer();
      shown = false;
      originX = pointer.clientX;
      originY = pointer.clientY;
      timer = window.setTimeout(() => {
        shown = true;
        const rect = button.getBoundingClientRect();
        const right = rect.left < 140;
        setLabel({ text: name, top: rect.top + rect.height / 2, left: right ? rect.right + 8 : rect.left - 8, right });
        hideTimer = window.setTimeout(() => setLabel(null), 1400);
      }, 480);
    };
    const move = (event: Event) => {
      if (!timer) return;
      const pointer = event as PointerEvent;
      if (Math.hypot(pointer.clientX - originX, pointer.clientY - originY) > 10) clearTimer();
    };
    const up = (event: Event) => {
      const button = (event.target as Element | null)?.closest?.('button');
      if (shown && button instanceof HTMLButtonElement) suppress = button;
      shown = false;
      clearTimer();
      window.setTimeout(() => { suppress = null; }, 0);
    };
    const click = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest?.('button');
      if (!suppress || button !== suppress) return;
      suppress = null;
      event.preventDefault();
      event.stopPropagation();
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('click', click, true);
    return () => {
      clearTimer();
      window.clearTimeout(hideTimer);
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      root.removeEventListener('click', click, true);
    };
  }, [active]);
  if (!active || !label) return null;
  return (
    <span
      className="hold-name"
      role="status"
      data-hold-label
      style={{ top: label.top, left: label.left, transform: label.right ? 'translateY(-50%)' : 'translate(-100%, -50%)' }}
    >{label.text}</span>
  );
}
