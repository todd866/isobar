/** Short map pictures for Curious, Drone and Defence cards. Words come after. */

import { esc } from './html.ts';

const SCENE: Record<string, string> = {
  isobars: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="iso a" d="M8 36c30-22 50-22 72 0s42 22 72 0"/>
    <path class="iso b" d="M8 36c30-12 50-12 72 0s42 12 72 0"/>
    <path class="iso c" d="M8 36c30-4 50-4 72 0s42 4 72 0"/>
    <circle cx="118" cy="36" r="3" class="mark"/>
  </svg>`,
  wind: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <g class="gust"><path d="M18 46h70M18 36h90M18 26h54" /><path d="M88 46l10-6-10-6M108 36l10-6-10-6M72 26l10-6-10-6"/></g>
  </svg>`,
  cloud: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="puff" d="M30 46h78a16 16 0 0 0 0-32 22 22 0 0 0-42-4 14 14 0 0 0-26 8 12 12 0 0 0-10 28z"/>
    <path class="base" d="M28 50h100"/>
  </svg>`,
  rain: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="puff" d="M36 34h70a14 14 0 0 0 0-28 18 18 0 0 0-36-2 12 12 0 0 0-22 8 10 10 0 0 0-12 22z"/>
    <g class="drops"><path d="M48 44v14M68 46v16M88 44v12M108 48v14"/></g>
  </svg>`,
  storm: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="puff" d="M28 40h84a16 16 0 0 0 2-32 20 20 0 0 0-38-6 16 16 0 0 0-30 10 14 14 0 0 0-18 28z"/>
    <path class="bolt" d="M78 38l-10 16h10l-6 14 18-20h-10z"/>
  </svg>`,
  ice: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path d="M80 10v52M58 22l44 28M102 22L58 50" class="crystal"/>
    <circle cx="80" cy="36" r="4" class="mark"/>
  </svg>`,
  fog: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <g class="haze"><path d="M16 28h128M12 40h136M20 52h120"/></g>
  </svg>`,
  temp: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path d="M78 14v32" /><circle cx="78" cy="52" r="8" class="mark"/>
    <path class="rise" d="M96 54c8-6 14-18 14-28"/>
  </svg>`,
  moon: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="ground" d="M0 58h160"/>
    <g class="moon"><circle cx="112" cy="28" r="12"/><circle cx="118" cy="26" r="10" class="cut"/></g>
  </svg>`,
  soil: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <g class="drops"><path d="M40 8v16M70 6v18M100 10v14"/></g>
    <path class="ground soft" d="M8 48c20 8 40 10 70 2s50 0 74-6v22H8z"/>
  </svg>`,
  sea: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="wave a" d="M0 40c16 8 24 8 40 0s24-8 40 0 24 8 40 0 24-8 40 0"/>
    <path class="wave b" d="M0 52c16 8 24 8 40 0s24-8 40 0 24 8 40 0 24-8 40 0"/>
  </svg>`,
  drift: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path class="line" d="M28 16c30 8 40 20 36 40"/>
    <path class="chute" d="M78 20c16 0 22 10 10 16c-14 0-28-6-10-16z"/>
    <path d="M86 36v16" />
  </svg>`,
  thermal: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <rect x="28" y="40" width="36" height="16" class="hot"/>
    <rect x="96" y="40" width="36" height="16" class="cool"/>
    <path class="cross" d="M70 28h20"/>
  </svg>`,
  hazard: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <circle cx="36" cy="40" r="6" class="mark"/>
    <path class="plume" d="M42 40c24-4 40-2 78 8 8 2 16 8 22 8"/>
  </svg>`,
  alt: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <path d="M20 58l40-36 24 16 36-28"/>
    <circle cx="120" cy="10" r="3" class="mark"/>
  </svg>`,
  map: `<svg viewBox="0 0 160 72" class="scene" aria-hidden="true">
    <rect x="16" y="12" width="128" height="48" rx="4" class="frame"/>
    <path class="iso b" d="M24 36c24-10 40-10 56 0s32 10 56 0"/>
  </svg>`,
};

export function pictureHtml(kind: string, caption: string): string {
  const scene = SCENE[kind] ?? SCENE.map;
  return `<figure class="lead" data-picture="${esc(kind)}"><div class="lead-stage">${scene}</div><figcaption>${esc(caption)}</figcaption></figure>`;
}
