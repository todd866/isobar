/** This device's copy of what an account syncs: the same localStorage keys the
 * app has always used, plus the time each setting was last changed. Every
 * write here announces itself, so a signed-in session can push it. */
import { SETTING_KEYS, type DocKind, type SettingKey, type SettingsDoc, type SettingsValues } from './merge.ts';

export const LOCAL_CHANGE = 'isobar:local-change';
/** Fired after sync wrote newer account data into this device. detail: { kinds: DocKind[] }. */
export const SYNCED = 'isobar:synced';

export const KEYS = {
  theme: 'isobar-theme',
  place: 'isobar.place',
  speed: 'isobar.speed',
  places: 'isobar.places',
  units: 'isobar.units',
  kiteBand: 'isobar.kite-band',
  settingsAt: 'isobar.settings-at',
  training: 'isobar.training.v1',
  e6b: 'isobar.e6b.record',
} as const;

function get(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function set(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window: the change still holds for this visit */ }
}
function json(key: string): unknown {
  try { return JSON.parse(get(key) ?? 'null'); } catch { return null; }
}

export function announce(kind: DocKind): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOCAL_CHANGE, { detail: { kind } }));
}

function readValue(key: SettingKey): SettingsValues[SettingKey] {
  if (key === 'kiteBand') {
    const v = json(KEYS.kiteBand) as { min?: unknown; max?: unknown } | null;
    return v && typeof v.min === 'number' && typeof v.max === 'number' && Number.isFinite(v.min) && Number.isFinite(v.max) && v.min >= 0 && v.max <= 100 && v.min < v.max ? { min: v.min, max: v.max } : undefined;
  }
  if (key === 'theme') { const v = get(KEYS.theme); return v === 'light' || v === 'dark' ? v : undefined; }
  if (key === 'speed') { const v = Number(get(KEYS.speed)); return get(KEYS.speed) != null && Number.isFinite(v) ? v : undefined; }
  if (key === 'place') return get(KEYS.place) ?? undefined;
  if (key === 'units') {
    const value = get(KEYS.units);
    return value === 'aus' || value === 'us' || value === 'local' ? value : undefined;
  }
  const list = json(KEYS.places);
  return Array.isArray(list) && list.every((item) => typeof item === 'string') ? list : undefined;
}

function writeValue(key: SettingKey, value: SettingsValues[SettingKey]): void {
  if (key === 'places' || key === 'kiteBand') set(KEYS[key], value === undefined ? null : JSON.stringify(value));
  else set(KEYS[key], value === undefined ? null : String(value));
}

export function readSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  return readValue(key) as SettingsValues[K];
}

/** Records a setting on this device, stamped now. */
export function setPref<K extends SettingKey>(key: K, value: SettingsValues[K]): void {
  writeValue(key, value);
  const at = (json(KEYS.settingsAt) ?? {}) as Record<string, string>;
  at[key] = new Date().toISOString();
  set(KEYS.settingsAt, JSON.stringify(at));
  announce('settings');
}

export function readLocal(kind: DocKind): unknown {
  if (kind === 'settings') {
    const doc: SettingsDoc = { values: {}, at: {} };
    const at = (json(KEYS.settingsAt) ?? {}) as Record<string, unknown>;
    for (const key of SETTING_KEYS) {
      const value = readValue(key);
      if (value === undefined) continue;
      (doc.values as Record<string, unknown>)[key] = value;
      if (typeof at[key] === 'string') doc.at[key] = at[key] as string;
    }
    return doc;
  }
  return json(KEYS[kind]);
}

/** Writes merged account data into this device (no announcement: it came from the account). */
export function writeLocal(kind: DocKind, data: unknown): void {
  if (kind !== 'settings') { set(KEYS[kind], JSON.stringify(data)); return; }
  const doc = data as SettingsDoc;
  for (const key of SETTING_KEYS) if (doc.values[key] !== undefined) writeValue(key, doc.values[key]);
  set(KEYS.settingsAt, JSON.stringify(doc.at));
}

/** Storage adapter for the trainer and the E6-B: localStorage, announced. */
export function progressStore(kind: 'training' | 'e6b', onSave?: () => void) {
  return {
    load: () => json(KEYS[kind]),
    save: (value: unknown) => {
      set(KEYS[kind], JSON.stringify(value));
      onSave?.();
      announce(kind);
    },
  };
}
