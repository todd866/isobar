import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, retestCard, worksheet } from '../src/adaptive.ts';
import { drillCards } from '../src/skills/index.ts';
import { specificRange } from '../src/skills/estimate.ts';
import { midZoneWeight } from '../src/skills/mid-zone.ts';
import { zoneFuel } from '../src/skills/zone-fuel.ts';
import { zoneTime } from '../src/skills/zone-time.ts';
import { triangle } from '../src/skills/lib.ts';
import { activeStep, markStep, solved } from '../src/worksheet.ts';
import type { WorkStep } from '../src/figure.ts';

const skills = ['zone-time', 'zone-fuel', 'mid-zone-weight', 'specific-range'];
const bank = drillCards();
const generators = { 'zone-time': zoneTime, 'zone-fuel': zoneFuel, 'mid-zone-weight': midZoneWeight, 'specific-range': specificRange };

function card(skill: string, rung: number) {
  const found = bank.find((item) => item.id === `drill.${skill}.r${rung}`);
  assert.ok(found, `missing ${skill} rung ${rung}`);
  return found;
}

function drafts(steps: WorkStep[]): Record<string, string> {
  return Object.fromEntries(steps.map((step) => [step.id, String(step.value)]));
}

test('every zone and estimate rung has natural sub-steps ending at the answer', () => {
  for (const skill of skills) {
    for (let rung = 1; rung <= 4; rung++) {
      const item = card(skill, rung);
      const steps = worksheet(item);
      assert.ok(steps.length >= 2, `${item.id} needs a real worksheet`);
      assert.equal(steps.at(-1)!.value, item.numeric!.value, `${item.id} ends at answer`);
      assert.equal(solved(steps, drafts(steps)), true, `${item.id} solves`);
      assert.equal(activeStep(steps, { ...drafts(steps), [steps[0]!.id]: '' }), 0, `${item.id} gates step one`);
      for (const step of steps) {
        assert.equal(markStep(step, String(step.value)), 'ok', `${item.id} accepts ${step.id}`);
        assert.equal(markStep(step, String(step.value + Math.max(step.tolerance * 4, 1)), true), 'bad', `${item.id} rejects ${step.id}`);
      }
    }
  }
});

test('wrong answer follow-up retains the complete worksheet', () => {
  for (const skill of skills) {
    const start = card(skill, 4);
    const diagnosis = start.numeric!.diagnoses[0]!;
    const retest = retestCard(start, judge(start, String(diagnosis.value), 1_000));
    assert.ok(retest, `${start.id} retest`);
    assert.equal(retest!.drill!.support, 2);
    assert.equal(worksheet(retest!).length, worksheet(start).length, `${start.id} keeps steps`);
    assert.equal(worksheet(retest!).at(-1)!.value, start.numeric!.value, `${start.id} keeps answer`);
  }
});

function rounded(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

test('worksheet values agree with carried rounded arithmetic over fresh seeds', () => {
  for (const skill of skills) for (let rung = 1; rung <= 4; rung++) for (const seed of [11, 29, 47]) {
    const drill = generators[skill as keyof typeof generators].generate(seed, rung as 1 | 2 | 3 | 4);
    const g = drill.given;
    const expected: Record<string, number> = {};
    if (skill === 'zone-time') {
      const gs = rung === 1 ? g.gsKt! : rung === 4 ? g.tasKt! + g.tailKt! : rung === 2 ? g.tasKt! + g.tailKt! : triangle(g.trackDeg!, g.windFromDeg!, g.windKt!, g.tasKt!).gs;
      const distance = rung === 4 ? g.legNm! - g.climbNm! : g.distNm!;
      if (rung === 3) {
        const angle = g.windFromDeg! - g.trackDeg!; const radians = angle * Math.PI / 180;
        expected.angle = angle; expected.sin = Math.sin(radians); expected.cross = g.windKt! * expected.sin;
        expected.cos = Math.cos(radians); expected.tail = -g.windKt! * expected.cos;
        expected.air = Math.sqrt(g.tasKt! ** 2 - rounded(expected.cross, 1) ** 2);
        expected.gs = triangle(g.trackDeg!, g.windFromDeg!, g.windKt!, g.tasKt!).gs;
      } else expected.gs = gs;
      if (rung === 4) expected['cruise-distance'] = distance; expected.hours = distance / (rung === 4 ? gs! : expected.gs!); expected.minutes = expected.hours * 60;
    } else if (skill === 'zone-fuel') {
      const gs = rung === 1 ? undefined : rung === 4 ? g.gsKt : rung === 2 ? g.tasKt! + g.tailKt! : triangle(g.trackDeg!, g.windFromDeg!, g.windKt!, g.tasKt!).gs;
      const distance = rung === 4 ? g.legNm! - g.climbNm! : g.distNm!;
      if (rung === 3) {
        const angle = g.windFromDeg! - g.trackDeg!; const radians = angle * Math.PI / 180;
        expected.angle = angle; expected.sin = Math.sin(radians); expected.cross = g.windKt! * expected.sin;
        expected.cos = Math.cos(radians); expected.tail = -g.windKt! * expected.cos;
        expected.air = Math.sqrt(g.tasKt! ** 2 - rounded(expected.cross, 1) ** 2);
        expected.gs = triangle(g.trackDeg!, g.windFromDeg!, g.windKt!, g.tasKt!).gs;
      } else if (rung === 2 || rung === 3) expected.gs = gs!;
      const hours = rung === 1 ? g.timeMin! / 60 : distance / (rung === 4 ? gs! : expected.gs!);
      if (rung === 4) expected['cruise-distance'] = distance;
      expected.hours = hours;
      if (rung !== 1) expected.minutes = hours * 60;
      expected.fuel = g.flowKgH! * (rung === 1 ? hours : rounded(expected.minutes, 3) / 60);
    } else if (skill === 'mid-zone-weight') {
      if (rung === 3) { expected.hours = g.timeMin! / 60; expected['zone-fuel'] = g.flowKgH! * rounded(expected.hours, 3); }
      if (rung === 4) expected['top-climb'] = g.brakeReleaseKg! - g.climbFuelKg!;
      const start = rung === 4 ? expected['top-climb'] : g.startKg!;
      const fuel = rung === 3 ? expected['zone-fuel'] : g.fuelKg ?? g.zoneFuelKg!;
      expected['half-fuel'] = fuel / 2;
      if (rung === 1) expected['mid-weight'] = start - fuel / 2;
      else { expected['raw-weight'] = start - fuel / 2; expected['table-weight'] = Math.floor(expected['raw-weight'] / 1000 + 0.5) * 1000; }
    } else {
      if (rung === 1) { expected.distance = g.distNm!; expected['specific-range'] = g.fuelKg! / expected.distance; }
      if (rung === 2) { expected.minutes = g.timeMin!; expected['kg-per-min'] = g.fuelKg! / expected.minutes; }
      if (rung === 3) { expected['hour-distance'] = g.gsKt!; expected['kg-per-nm'] = g.flowKgH! / expected['hour-distance']; }
      if (rung === 4) { expected['cruise-fuel'] = g.distNm! * 10; expected['trip-fuel'] = expected['cruise-fuel'] + 1600; }
    }
    for (const item of drill.steps ?? []) {
      assert.ok(Object.hasOwn(expected, item.id), `${skill} r${rung} missing independent expectation for ${item.id}`);
      assert.ok(Math.abs(item.value - expected[item.id]!) <= item.tolerance + 1e-9, `${skill} r${rung} ${item.id}`);
    }
    assert.equal(Object.keys(expected).length, drill.steps?.length ?? 0, `${skill} r${rung} expectation count`);
    if (skill === 'specific-range' && (rung === 1 || rung === 2)) {
      const distractor = rung === 1 ? g.timeMin! : g.distNm!;
      const first = drill.steps![0]!;
      if (Math.abs(distractor - first.value) > first.tolerance) {
        assert.equal(markStep(first, String(distractor), true), 'bad', `${skill} r${rung} rejects divisor distractor`);
      }
    }
  }
});
