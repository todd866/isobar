/** Place and time names in a reply become links when a tool result named them. */

import type { ChatAnchors } from './types';
import { utcChip } from './types';

export interface LinkPart {
  kind: 'text' | 'place' | 'time';
  text: string;
  lat?: number;
  lon?: number;
  timeUtc?: string;
}

interface Needle {
  text: string;
  part: LinkPart;
}

function needles(anchors: ChatAnchors): Needle[] {
  const list: Needle[] = [];
  for (const place of anchors.places) {
    if (place.text.trim().length < 2) continue;
    list.push({ text: place.text, part: { kind: 'place', text: place.text, lat: place.lat, lon: place.lon } });
  }
  for (const time of anchors.times) {
    const label = utcChip(time.timeUtc);
    if (label !== '—') list.push({ text: label, part: { kind: 'time', text: label, timeUtc: time.timeUtc } });
    list.push({ text: time.timeUtc, part: { kind: 'time', text: time.timeUtc, timeUtc: time.timeUtc } });
  }
  return list.sort((a, b) => b.text.length - a.text.length);
}

function boundary(source: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : source[index - 1];
  const after = source[index + length] ?? '';
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

export function linkify(source: string, anchors: ChatAnchors): LinkPart[] {
  const found: { index: number; length: number; part: LinkPart }[] = [];
  const covered = (index: number, length: number) => found.some((item) => index < item.index + item.length && index + length > item.index);
  for (const needle of needles(anchors)) {
    let from = 0;
    while (from < source.length) {
      const index = source.indexOf(needle.text, from);
      if (index < 0) break;
      if (!covered(index, needle.text.length) && boundary(source, index, needle.text.length)) {
        found.push({ index, length: needle.text.length, part: needle.part });
      }
      from = index + needle.text.length;
    }
  }
  found.sort((a, b) => a.index - b.index);
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const item of found) {
    if (item.index > cursor) parts.push({ kind: 'text', text: source.slice(cursor, item.index) });
    parts.push(item.part);
    cursor = item.index + item.length;
  }
  if (cursor < source.length) parts.push({ kind: 'text', text: source.slice(cursor) });
  return parts.length ? parts : [{ kind: 'text', text: source }];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function placeFrom(value: unknown): { text: string; lat: number; lon: number } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const text = typeof row.name === 'string' ? row.name : typeof row.icao === 'string' ? row.icao : null;
  const lat = numberOrNull(row.lat);
  const lon = numberOrNull(row.lon);
  if (!text || lat == null || lon == null) return null;
  return { text, lat, lon };
}

/** Anchors the reply may link, taken only from tool payloads. */
export function anchorsFromTools(results: readonly unknown[]): ChatAnchors {
  const places: ChatAnchors['places'] = [];
  const times: ChatAnchors['times'] = [];
  const seenPlace = new Set<string>();
  const seenTime = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const place = placeFrom(value);
    if (place && !seenPlace.has(place.text)) { seenPlace.add(place.text); places.push(place); }
    const row = value as Record<string, unknown>;
    if (typeof row.timeUtc === 'string' && !seenTime.has(row.timeUtc)) {
      seenTime.add(row.timeUtc);
      times.push({ text: row.timeUtc, timeUtc: row.timeUtc });
    }
    for (const child of Object.values(row)) walk(child);
  };
  results.forEach(walk);
  return { places, times };
}

/** Pick the place the answer actually names; never choose an arbitrary catalogue anchor. */
export function answerFocus(anchors: ChatAnchors, answer: string): ChatAnchors['places'][number] | null {
  const text = answer.toLocaleLowerCase();
  return anchors.places
    .filter((place) => {
      if (place.text.trim().length < 2 || !Number.isFinite(place.lat) || !Number.isFinite(place.lon) || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) return false;
      const name = place.text.toLocaleLowerCase();
      let start = text.indexOf(name);
      while (start >= 0) { if (boundary(text, start, name.length)) return true; start = text.indexOf(name, start + name.length); }
      return false;
    })
    .sort((a, b) => b.text.length - a.text.length)[0] ?? null;
}
