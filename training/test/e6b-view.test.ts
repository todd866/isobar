import test from 'node:test';
import assert from 'node:assert/strict';
import { rotatePoint, viewToFace, gestureNumbers } from '../src/instruments/e6b/view.ts';
import { angleOf, valueAt, turn } from '../src/instruments/e6b/slide.ts';
import { polar } from '../src/instruments/e6b/render.ts';

test('all view angles preserve face hit positions and both scale readings', () => {
  for (const view of [-725, -180, -37, 0, 90, 271, 540]) {
    for (const value of [10, 15, 24.5, 60, 90]) {
      for (const theta of [0, 67, 180, 359]) {
        const angle = angleOf(value), [x, y] = polar(angle, 1100);
        const p = viewToFace(rotatePoint({ x, y }, view), view);
        assert.ok(Math.hypot(p.x - x, p.y - y) < 1e-9);
        const hit = Math.atan2(p.x, -p.y) * 180 / Math.PI;
        assert.ok(Math.abs(turn(hit - angle)) < 1e-10);
        assert.ok(Math.abs(valueAt(hit) - valueAt(angle)) < 1e-8);
        assert.ok(Math.abs(valueAt(hit - theta) - valueAt(angle - theta)) < 1e-8);
      }
    }
  }
});

test('Safari-like events need no GestureEvent constructor or Chrome APIs', () => {
  const event = new Event('gesturechange', { cancelable: true });
  Object.assign(event, { rotation: -75, scale: 1.4, altKey: true });
  assert.deepEqual(gestureNumbers(event), { rotation: -75, scale: 1.4, alt: true, x: null, y: null });
  Object.assign(event, { rotation: NaN, scale: 0, clientX: 10, clientY: 20 });
  assert.deepEqual(gestureNumbers(event), { rotation: 0, scale: 1, alt: true, x: 10, y: 20 });
});

// Exercise the actual DOM handlers using standard synthetic Event objects.
// Safari exposes gesture events without a constructible GestureEvent class.
import { FlightComputer } from '../src/instruments/e6b/instrument.ts';
import { E6B } from '../src/instruments/e6b/face.ts';
import { graduationAngles, readoutLine } from '../src/instruments/e6b/coach.ts';

test('real Safari gesture and wheel handlers separate view, disc and pinch', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { clearTimeout, setTimeout } });
  try {
    // Deliberately skip DOM construction: the handlers below are production
    // methods, with only painting and the fixed viewport supplied by the test.
    const h = Object.create(FlightComputer.prototype);
    Object.assign(h, { face: E6B, theta: 65, cursor: 123, viewAngle: 40, autoTurn: true,
      wind: { plate: 90, gs: 150, dot: null }, side: 'computer', view: { x: 0, y: 0, w: 3160 },
      grads: graduationAngles(), paint() {}, renderStrip() {}, hideHint() {},
      frameBox() { return { left: 0, top: 0, size: 600 }; }, el: { classList: { toggle() {} } } });
    const svg = new EventTarget();
    h.bindGestures(svg);
    const gesture = (type: string, data: object) => {
      const e = new Event(type, { cancelable: true }); Object.assign(e, data); svg.dispatchEvent(e);
      assert.equal(e.defaultPrevented, true);
    };
    const before = readoutLine(h.pose(), 'computer');
    // Background rotation, cumulative updates: 20 then 30 means +30, not +50.
    gesture('gesturestart', { clientX: 590, clientY: 300, scale: 1, rotation: 0 });
    gesture('gesturechange', { scale: 1, rotation: 20 });
    gesture('gesturechange', { scale: 1, rotation: 30 });
    gesture('gestureend', {});
    assert.equal(h.viewAngle, 70); assert.equal(h.theta, 65); assert.equal(h.cursor, 123);
    assert.equal(readoutLine(h.pose(), 'computer'), before);
    // On the disc, turn the disc; pinching still zooms.
    gesture('gesturestart', { clientX: 380, clientY: 300 });
    gesture('gesturechange', { scale: 2, rotation: -15 });
    gesture('gestureend', {});
    assert.equal(h.theta, 50); assert.equal(h.viewAngle, 70); assert.equal(h.view.w, 1580);
    // Option overrides the hit region, including missing Safari coordinates.
    gesture('gesturestart', { altKey: true });
    gesture('gesturechange', { scale: 1, rotation: -10 });
    gesture('gestureend', {});
    assert.equal(h.viewAngle, 60); assert.equal(h.theta, 50);
    const wheel = new Event('wheel', { cancelable: true });
    // Owner, 7 Oct: a plain two-finger swipe spins the whole computer; Option turns the disc.
    Object.assign(wheel, { deltaX: -30, deltaY: 0, deltaMode: 0, clientX: 300, clientY: 50 });
    h.onWheel(wheel);
    assert.equal(wheel.defaultPrevented, true); assert.notEqual(h.viewAngle, 60); assert.equal(h.theta, 50);
    const spun = h.viewAngle;
    const optionWheel = new Event('wheel', { cancelable: true });
    Object.assign(optionWheel, { deltaX: -30, deltaY: 0, deltaMode: 0, clientX: 300, clientY: 50, altKey: true });
    h.onWheel(optionWheel);
    assert.equal(h.viewAngle, spun); assert.notEqual(h.theta, 50);
    h.theta = 50;
    // Real hit-testing reverses the view transform, including zoom and pan.
    for (const angle of [0, 45, 135, 270]) {
      h.viewAngle = angle;
      for (const [r, expected] of [[600, 'disc'], [1300, 'base']] as const) {
        const face = { x: r, y: 0 }, p = rotatePoint(face, angle);
        const x = (p.x - h.view.x + h.view.w / 2) * 600 / h.view.w;
        const y = (p.y - h.view.y + h.view.w / 2) * 600 / h.view.w;
        assert.equal(h.hitComputer(h.toFace(x, y)), expected);
      }
    }
    // Stopping playback must happen before creating the bracket-key tween.
    h.kick=()=>{};
    const key=new Event('keydown',{cancelable:true});Object.assign(key,{key:']'});
    h.onKey(key);assert.equal(key.defaultPrevented,true);
    assert.equal(h.viewTween.to,285);assert.equal(h.theta,50);assert.equal(h.cursor,123);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
