import { mountE6B, type E6BOptions, type E6BStore } from './e6b/index.ts';
import type { LiveContext } from './e6b/practice.ts';
import { mount as mountInstrument } from './index.ts';
import { INSTRUMENTS } from './registry.ts';
import type { InstrumentId, InstrumentMode } from './types.ts';

export type LabInstrumentId = 'e6b' | InstrumentId;

export interface LabOptions {
  instrument?: LabInstrumentId;
  mode?: InstrumentMode;
  store?: E6BStore;
  live?: LiveContext;
  theme?: 'light' | 'dark';
  onChange?: (instrument: LabInstrumentId, mode: InstrumentMode) => void;
}

export interface LabMount {
  destroy(): void;
  setTheme(theme: 'light' | 'dark'): void;
  setLive(live: LiveContext | undefined): void;
}

const validInstrument = (value: string | null | undefined): LabInstrumentId =>
  value === 'e6b' || INSTRUMENTS.some((instrument) => instrument.id === value)
    ? value as LabInstrumentId
    : 'e6b';

export function parseLabInstrument(value: string | null | undefined): LabInstrumentId {
  return validInstrument(value);
}

export function parseInstrumentMode(value: string | null | undefined): InstrumentMode {
  return value === 'practice' || value === 'free' || value === 'how' ? value : 'learn';
}

/** Normalize the legacy query shape used by the native/web trainer adapters. */
export function labPreview(params: URLSearchParams): {
  page?: 'lab'; labInstrument?: LabInstrumentId; labMode?: InstrumentMode;
} {
  if (!params.has('lab')) return {};
  return { page: 'lab', labInstrument: parseLabInstrument(params.get('lab')), labMode: parseInstrumentMode(params.get('mode')) };
}

/** One compact index for the E6-B and the five teaching instruments.
 * The child owns its listeners; this wrapper owns only the index listener and
 * destroys the child before replacing it, so detached trainer shells leak no work. */
export function mountLab(host: HTMLElement, options: LabOptions = {}): LabMount {
  let selected = validInstrument(options.instrument);
  let mode = options.mode ?? 'learn';
  let theme = options.theme ?? 'light';
  let live = options.live;
  let destroyed = false;
  let child: ReturnType<typeof mountInstrument> | ReturnType<typeof mountE6B> | null = null;

  host.classList.add('instrument-lab-host');
  host.innerHTML = `<div class="instrument-lab-shell" data-theme="${theme}">
    <label class="instrument-lab-picker"><span>Instrument</span><select data-lab-select aria-label="Instrument">${[
      { id: 'e6b', title: 'E6-B flight computer' },
      ...INSTRUMENTS.map((instrument) => ({ id: instrument.id, title: instrument.title })),
    ].map((instrument) => `<option value="${instrument.id}"${instrument.id === selected ? ' selected' : ''}>${instrument.title}</option>`).join('')}</select></label>
    <div class="instrument-lab-stage" data-lab-stage></div>
  </div>`;
  const shell = host.querySelector<HTMLElement>('.instrument-lab-shell')!;
  const stage = host.querySelector<HTMLElement>('[data-lab-stage]')!;
  const picker = host.querySelector<HTMLElement>('.instrument-lab-picker');
  const abort = new AbortController();

  function applyTheme(): void {
    shell.dataset.theme = theme;
    host.dataset.theme = theme;
    const element = (child as { el?: HTMLElement } | null)?.el;
    if (element) element.dataset.theme = theme;
  }

  function mountSelected(): void {
    child?.destroy();
    stage.classList.remove('instrument-host');
    stage.replaceChildren();
    if (selected === 'e6b') {
      const e6bOptions: E6BOptions = { variant: 'lab', store: options.store, live };
      const computer = mountE6B(stage, e6bOptions);
      if (mode === 'free' || mode === 'practice') computer.setMode(mode);
      child = computer;
    } else {
      child = mountInstrument(stage, { instrument: selected, mode, picker: picker ?? undefined });
    }
    if (picker) {
      if (selected === 'e6b') shell.insertBefore(picker, stage);
    }
    applyTheme();
  }

  host.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    if (!select.matches('[data-lab-select]')) return;
    selected = validInstrument(select.value);
    options.onChange?.(selected, mode);
    mountSelected();
  }, { signal: abort.signal });
  host.addEventListener('click', (event) => {
    const modeButton = (event.target as HTMLElement).closest<HTMLElement>('[data-i-mode], .e6b [data-mode]');
    if (!modeButton) return;
    const next = modeButton.dataset.iMode ?? modeButton.dataset.mode;
    if (next === 'learn' || next === 'practice' || next === 'free' || next === 'how') {
      mode = next;
      options.onChange?.(selected, mode);
    }
  }, { signal: abort.signal });

  mountSelected();
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      child?.destroy();
      child = null;
      host.replaceChildren();
      host.classList.remove('instrument-lab-host');
    },
    setTheme(nextTheme): void {
      if (destroyed) return;
      theme = nextTheme;
      applyTheme();
    },
    setLive(nextLive): void {
      if (destroyed) return;
      live = nextLive;
      const e6b = child as { setLive?: (value: LiveContext | undefined) => void } | null;
      e6b?.setLive?.(nextLive);
    },
  };
}
