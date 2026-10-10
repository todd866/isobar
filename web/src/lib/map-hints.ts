/**
 * First-visit map hints. One at a time, in order. Dismissing stores that step
 * for this viewer. A later step's action does not skip the one on screen.
 */

export const HINT_KEY = 'isobar.map.hints';

export const HINTS = ['point', 'gesture', 'lens'] as const;
export type HintId = (typeof HINTS)[number];

export type HintState = Record<HintId, boolean>;

const NONE: HintState = { point: false, gesture: false, lens: false };

export function emptyHints(): HintState {
  return { ...NONE };
}

export function hintCopy(id: HintId, phone: boolean): string {
  if (id === 'point') return 'Tap the map for the air above a point';
  if (id === 'gesture') {
    return phone
      ? 'Hold to pause · drag to pan · pinch to zoom · 3D: two fingers to tilt'
      : 'Hold to pause · drag to pan · pinch to zoom · 3D: two fingers to tilt';
  }
  return 'Pick a lens below for rain, wind, temp or flying';
}

export function readHintState(storage: Pick<Storage, 'getItem'> | null): HintState {
  if (!storage) return emptyHints();
  try {
    const raw = JSON.parse(storage.getItem(HINT_KEY) ?? 'null') as Partial<HintState> | null;
    if (!raw || typeof raw !== 'object') return emptyHints();
    return {
      point: raw.point === true,
      gesture: raw.gesture === true,
      lens: raw.lens === true,
    };
  } catch {
    return emptyHints();
  }
}

export function writeHintState(storage: Pick<Storage, 'setItem'> | null, state: HintState) {
  if (!storage) return;
  try {
    storage.setItem(HINT_KEY, JSON.stringify(state));
  } catch { /* private mode, or storage blocked */ }
}

export function currentHint(state: HintState): HintId | null {
  return HINTS.find((id) => !state[id]) ?? null;
}

/** Marks `id` done only when it is the hint on screen. */
export function dismissHint(state: HintState, id: HintId): HintState {
  if (currentHint(state) !== id) return state;
  return { ...state, [id]: true };
}

type Sink = (id: HintId) => void;
let sink: Sink | null = null;

export function bindHintSink(next: Sink | null) {
  sink = next;
}

export function noteHint(id: HintId) {
  sink?.(id);
}
