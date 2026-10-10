import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, retestCard, worksheet } from '../src/adaptive.ts';
import { SKILLS, drillCards } from '../src/skills/index.ts';
import { markStep, solved } from '../src/worksheet.ts';
import type { Card } from '../src/model.ts';

const cards = drillCards();
const find = (id: string): Card => {
  const card = cards.find((item) => item.id === id);
  assert.ok(card, id);
  return card;
};

test('ISA, TAS, wind and groundspeed expose natural checked substeps at every rung', () => {
  for (const skill of ['isa-dev', 'tas-mach', 'wind-component', 'groundspeed']) {
    for (const rung of [1, 2, 3, 4] as const) {
      const card = find(`drill.${skill}.r${rung}`);
      const steps = worksheet(card);
      assert.ok(steps.length >= 2, `${skill} rung ${rung} has no real worksheet`);
      assert.equal(Math.abs(steps.at(-1)!.value - card.numeric!.value) <= Math.max(steps.at(-1)!.tolerance, card.numeric!.tolerance), true, `${skill} rung ${rung} final step`);
      const drafts = Object.fromEntries(steps.map((step) => [step.id, String(step.value)]));
      assert.equal(solved(steps, drafts), true, `${skill} rung ${rung} solves`);
      for (const step of steps) assert.equal(markStep(step, String(step.value)), 'ok', `${skill} ${step.id}`);
    }
  }
});

test('live worksheet checking accepts usable rounding and rejects a wrong intermediate', () => {
  const tas = worksheet(find('drill.tas-mach.r2'));
  const correction = tas.find((step) => step.id === 'correction')!;
  assert.equal(markStep(correction, correction.value.toFixed(0)), 'ok');
  assert.equal(markStep(correction, String(correction.value + 2)), 'bad');

  const wind = worksheet(find('drill.wind-component.r4'));
  const angle = wind.find((step) => step.id === 'angle')!;
  assert.equal(markStep(angle, String(angle.value)), 'ok');
  assert.equal(markStep(angle, String(angle.value + 20)), 'bad');
});

test('a wrong answer leads to the same supported worksheet and preserves all steps', () => {
  const original = find('drill.groundspeed.r3');
  const wrong = original.numeric!.diagnoses[0]!;
  const retest = retestCard(original, judge(original, String(wrong.value), 1_000))!;
  assert.equal(retest.drill!.stage, 'retest');
  assert.equal(retest.drill!.support, 2);
  assert.deepEqual(worksheet(retest).map((step) => step.id), worksheet(original).map((step) => step.id));
  assert.deepEqual(worksheet(retest).map((step) => step.value), worksheet(original).map((step) => step.value));
});

test('worksheet intermediates agree with independent calculations across seeds', () => {
  const seeds = [7, 101, 2026];
  for (const seed of seeds) {
    for (const id of ['isa-dev', 'tas-mach', 'wind-component', 'groundspeed']) {
      const skill = SKILLS.find((item) => item.id === id)!;
      for (const rung of [1, 2, 3, 4] as const) {
        const drill = skill.generate(seed, rung);
        const byId = new Map(worksheet({ numeric: { value: drill.answer, tolerance: drill.tolerance, unit: drill.unit, decimals: drill.decimals, steps: drill.steps }, figure: drill.figure } as Card).map((step) => [step.id, step.value]));
        const g = drill.given;
        if (id === 'isa-dev') {
          const isa = g.oatC! - Math.max(15 - 0.19812 * g.fl!, -56.5);
          assert.ok(Math.abs(byId.get('deviation')! - isa) < 1e-9);
        }
        if (id === 'tas-mach' && byId.has('kelvin')) {
          const kelvin = g.oatC! + 273.15;
          const sound = 38.94 * Math.sqrt(kelvin);
          assert.ok(Math.abs(byId.get('kelvin')! - kelvin) < 1e-9);
          assert.ok(Math.abs(byId.get('sound')! - sound) <= 0.6);
          assert.ok(Math.abs(byId.get('tas')! - g.mach! * sound) <= 1);
          if (byId.has('hours')) assert.ok(Math.abs(byId.get('distance')! - g.mach! * sound * byId.get('hours')!) <= 1);
        }
        if (id === 'wind-component') {
          const track = g.trackDeg! + (g.variationEast ?? 0);
          const angle = ((g.windFromDeg! - track + 540) % 360) - 180;
          assert.ok(Math.abs(byId.get('angle')! - angle) < 1e-9);
          assert.ok(Math.abs(byId.get('sin')! - Math.sin(angle * Math.PI / 180)) < 0.001);
          assert.ok(Math.abs(byId.get('cos')! - Math.cos(angle * Math.PI / 180)) < 0.001);
        }
        if (id === 'groundspeed' && byId.has('cross')) {
          const track = g.trackDeg!;
          const angle = ((g.windFromDeg! - track + 540) % 360) - 180;
          const cross = g.windKt! * Math.sin(angle * Math.PI / 180);
          assert.ok(Math.abs(byId.get('cross')! - cross) < 1e-9);
          if (byId.has('kelvin')) {
            const kelvin = g.oatC! + 273.15;
            const sound = 38.94 * Math.sqrt(kelvin);
            assert.ok(Math.abs(byId.get('kelvin')! - kelvin) < 1e-9);
            assert.ok(Math.abs(byId.get('sound')! - sound) <= 0.6);
            assert.ok(Math.abs(byId.get('tas')! - g.mach! * sound) <= 1);
            const air = Math.sqrt((g.mach! * sound) ** 2 - byId.get('cross')! ** 2);
            assert.ok(Math.abs(byId.get('air')! - air) <= 1);
          }
        }
      }
    }
  }
});
