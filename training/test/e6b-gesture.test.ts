import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightComputer } from '../src/instruments/e6b/instrument.ts';

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function harness() {
  const h = Object.create(FlightComputer.prototype);
  const el = new EventTarget();
  Object.assign(el, { classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  Object.assign(h, {
    pointers: new Map(), drag: null, loupeDrag: null, viewKnob: null, pinch: null, twistOwned: false,
    theta: 20, cursor: 5, viewAngle: 0, autoTurn: false, view: { x: 0, y: 0, w: 3160 }, side: 'computer',
    wind: { plate: 0, gs: 150, dot: null, slide: 'low' }, slideEnd: 'low', zoomFrame: 0,
    el, wsvg: new EventTarget(),
    frameBox: () => ({ left: 0, top: 0, size: 632 }),
    hideHint() {}, paint() {}, renderStrip() {}, checkAlignment() {},
  });
  return h;
}

function fire(target: EventTarget, type: string, id: number, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 });
  target.dispatchEvent(event);
}

test('a second pointer anywhere becomes a whole-unit twist and cancels a disc or loupe drag', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { clearTimeout, setTimeout } });
  try {
    const h = harness();
    h.bindInstrumentPointers();
    fire(h.el, 'pointerdown', 1, 300, 100);
    assert.equal(h.twistOwned, false, 'one finger is still a drag');
    Object.assign(h, {
      drag: { kind: 'disc', moved: true, last: 0, raw: 0, samples: [], x: 0, y: 0, start: { x: 300, y: 100 } },
      loupeDrag: { id: 1, dx: 0, dy: 0 },
      viewKnob: { last: 1, moved: false, x: 300, y: 100 },
    });
    fire(h.el, 'pointerdown', 2, 300, 500);
    assert.equal(h.drag, null);
    assert.equal(h.loupeDrag, null);
    assert.equal(h.viewKnob, null);
    assert.equal(h.twistOwned, true);
    assert.equal(h.pinch?.whole, true);
    assert.equal(h.theta, 20);
    // Same spread, a quarter turn the other way: the view follows, the disc setting does not.
    fire(h.el, 'pointermove', 2, 700, 100);
    assert.ok(Math.abs(h.viewAngle - 270) < 0.05, `view ${h.viewAngle}`);
    assert.equal(h.theta, 20);
    assert.equal(h.cursor, 5);
    assert.equal(h.view.w, 3160);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a wind-slide drag ends on the pointerup position, including a move that stopped short', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { clearTimeout, setTimeout } });
  try {
    const h = harness();
    h.side = 'wind';
    let released = 0;
    h.checkAlignment = () => { released = h.wind.gs; };
    h.bindWindPointer();
    // Face (0, 1440) is the lower grip. 5 face units per px; 1 kt is 17 units, so 3.4 px.
    fire(h.wsvg, 'pointerdown', 1, 316, 604);
    fire(h.wsvg, 'pointermove', 1, 316, 621); // +5 kt, short of the mark
    assert.ok(Math.abs(h.wind.gs - 155) < 1e-6, `mid-drag ${h.wind.gs}`);
    fire(h.wsvg, 'pointerup', 1, 316, 638); // +10 kt, where the finger actually let go
    assert.ok(Math.abs(h.wind.gs - 160) < 1e-6, `released at ${h.wind.gs}`);
    assert.equal(released, h.wind.gs);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
