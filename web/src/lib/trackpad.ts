/** Safari exposes trackpad pinch as cumulative GestureEvents rather than
 * ctrl-wheel. Keep these listeners on the map only; page zoom elsewhere stays
 * with the browser. https://developer.apple.com/documentation/webkitjs/gestureevent
 */
type PinchEvent = Event & { scale?: number; clientX?: number; clientY?: number };

export function bindTrackpadPinch(target: EventTarget, zoom: (factor: number, x: number, y: number) => void) {
  let active = false;
  let previous = 1;
  const start = (event: Event) => {
    event.preventDefault();
    active = true;
    previous = 1;
  };
  const change = (raw: Event) => {
    if (!active) return;
    raw.preventDefault();
    const event = raw as PinchEvent;
    const { scale, clientX, clientY } = event;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 ||
        typeof clientX !== 'number' || !Number.isFinite(clientX) ||
        typeof clientY !== 'number' || !Number.isFinite(clientY)) return;
    // Camera half-width is inverse zoom. Safari's scale is cumulative from
    // gesturestart, so applying scale directly on each change would compound.
    const factor = previous / scale;
    previous = scale;
    if (Number.isFinite(factor) && factor > 0) zoom(factor, clientX, clientY);
  };
  const end = (event: Event) => {
    if (active) event.preventDefault();
    active = false;
    previous = 1;
  };
  target.addEventListener('gesturestart', start, { passive: false });
  target.addEventListener('gesturechange', change, { passive: false });
  target.addEventListener('gestureend', end, { passive: false });
  return {
    active: () => active,
    dispose() {
      active = false;
      target.removeEventListener('gesturestart', start);
      target.removeEventListener('gesturechange', change);
      target.removeEventListener('gestureend', end);
    },
  };
}
