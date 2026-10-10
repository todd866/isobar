/** WKWebView entry. The website imports mountTrainer directly. */
import { mountTrainer } from './mount.ts';
import { labPreview } from './instruments/lab.ts';
import type { Snapshot } from './snapshot.ts';
import type { ProgressFile } from './progress.ts';

declare global {
  interface Window {
    isobar?: {
      snapshot?: Snapshot;
      progress?: ProgressFile & { shot?: unknown };
      save?: (progress: ProgressFile) => void;
      close?: () => void;
    };
    __THEME?: 'light' | 'dark';
    __TRAINING_READY?: boolean;
    __TRAINING_STEPS?: () => { id: string; text: string }[];
  }
}

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('missing app root');
const params = new URLSearchParams(location.search);
const requested = params.get('theme');
const theme = requested === 'light' || requested === 'dark' ? requested
  : window.__THEME ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
const shot = window.isobar?.progress?.shot;
const trainer = mountTrainer(host, {
  snapshot: window.isobar?.snapshot,
  storage: { load: () => window.isobar?.progress, save: (progress) => window.isobar?.save?.(progress) },
  close: () => window.isobar?.close?.(),
  theme,
  preview: {
    card: params.get('card') ?? undefined,
    drills: params.get('drills') === '6',
    page: shot === 'live' || shot === 'plan' || shot === 'lab' ? shot : undefined,
    revealed: shot === 'revealed',
    ...labPreview(params),
  },
});
if (params.has('card')) window.__TRAINING_STEPS = trainer.worksheetSteps;
window.__TRAINING_READY = true;
window.addEventListener('pagehide', () => trainer.dispose(), { once: true });
