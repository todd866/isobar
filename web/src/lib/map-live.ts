/** Live observations and model time share a clock, never a timestamp. */
export function mapTimeState(validMs: number, nowMs: number): { live: boolean; label: string } {
  const minutes = (validMs - nowMs) / 60000;
  if (Math.abs(minutes) < 1.5) return { live: true, label: 'NOW' };
  const hours = Math.abs(minutes) / 60;
  const offset = hours < 1 ? `${Math.max(1, Math.round(Math.abs(minutes)))} min` : `${Number(hours.toFixed(1))} h`;
  return { live: false, label: `${minutes > 0 ? 'FORECAST +' : 'PAST −'}${offset}` };
}
export type OptionalOverlay = 'satellite' | 'barbs' | 'tracks' | 'section';
export function enableOverlay(current: readonly OptionalOverlay[], next: OptionalOverlay): { overlays: OptionalOverlay[]; replaced?: OptionalOverlay } {
  if (current.includes(next)) return { overlays: [...current] };
  const overlays = [...current, next];
  const replaced = overlays.length > 2 ? overlays.shift() : undefined;
  return { overlays, replaced };
}
