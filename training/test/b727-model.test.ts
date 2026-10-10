import assert from 'node:assert/strict';
import test from 'node:test';
import * as m from '../src/b727/model.ts';
import { referencePoints } from '../src/b727/references.ts';

const increasing = (xs: number[], what: string): void => {
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `${what}: ${xs[i - 1]} then ${xs[i]} at step ${i}`);
};
const decreasing = (xs: number[], what: string): void => increasing(xs.map((x) => -x), what);
const near = (actual: number, expected: number, rel: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) <= rel * Math.abs(expected), `${what}: ${actual} vs ${expected} (±${rel * 100}%)`);
};

test('ISA atmosphere and speed conversions', () => {
  const sl = m.air(0);
  near(sl.p, 101325, 1e-6, 'sea-level pressure');
  near(sl.t, 288.15, 1e-6, 'sea-level temperature');
  near(m.air(36089).tIsa, 216.65, 1e-3, 'tropopause temperature');
  near(m.air(10000).p, 69682, 1e-3, '10,000 ft pressure');
  // 250 KIAS at sea level is 250 KTAS; at FL300 about M 0.65
  near(m.tasFromKias(250, sl) / m.KT, 250, 1e-3, 'KIAS = KTAS at sea level');
  const fl300 = m.air(30000);
  near(m.machFromCas(250 * m.KT, fl300.p), 0.65, 0.03, 'M for 250 KIAS at FL300');
  // round trip Mach ↔ CAS
  for (const mach of [0.5, 0.7, 0.8]) near(m.machFromCas(m.casFromMach(mach, fl300.p), fl300.p), mach, 1e-6, 'Mach ↔ CAS');
  // ISA+10 is warmer, less dense
  assert.ok(m.air(30000, 10).rho < fl300.rho, 'warm air is less dense');
  near(m.pressureAltitudeFt(0, 1013.25), 0, 1e-6, 'PA at standard QNH');
  near(m.pressureAltitudeFt(0, 1003), 280, 0.05, 'PA 10 hPa low');
});

test('drag and fuel flow rise with weight; LRC is slower than M 0.80 and more economical', () => {
  const a = m.air(33000);
  increasing([60000, 66000, 72000, 78000].map((w) => m.dragN(w, 0.8, a)), 'drag with weight');
  increasing([60000, 66000, 72000, 78000].map((w) => m.cruise(w, 0.8, a).fuelFlowKgPerHour), 'M 0.80 fuel flow with weight');
  const lrc = m.longRangeCruise(70000, a);
  const m80 = m.cruise(70000, 0.8, a);
  assert.ok(lrc.mach < 0.8 && lrc.mach > 0.7, `LRC Mach ${lrc.mach}`);
  assert.ok(lrc.narPerKg >= m80.narPerKg, 'LRC specific range is not below M 0.80');
  assert.ok(lrc.fuelFlowKgPerHour < m80.fuelFlowKgPerHour, 'LRC burns less per hour');
  // warmer air: more fuel per hour at the same Mach (TSFC ∝ √θ), faster TAS
  const warm = m.cruise(70000, 0.8, m.air(33000, 15));
  assert.ok(warm.fuelFlowKgPerHour > m80.fuelFlowKgPerHour, 'ISA+15 fuel flow higher');
  assert.ok(warm.tasKt > m80.tasKt, 'ISA+15 TAS higher');
});

test('thrust lapses with altitude and heat; the engine is flat-rated', () => {
  decreasing([0, 10000, 20000, 30000, 39000].map((h) => m.maxClimbThrustN(m.air(h))), 'max climb thrust with altitude');
  const sl = m.air(0);
  const cold = m.takeoffThrustN(m.air(0, -10), 0);
  const std = m.takeoffThrustN(sl, 0);
  const warm = m.takeoffThrustN(m.air(0, 10), 0);
  const hot = m.takeoffThrustN(m.air(0, 30), 0);
  near(cold, std, 1e-9, 'flat-rated below the corner point');
  near(warm, std, 1e-9, 'flat-rated to ISA+14');
  assert.ok(hot < std * 0.95, `hot-day thrust lapses: ${hot / std}`);
  assert.ok(m.maxCruiseThrustN(sl) < m.maxClimbThrustN(sl), 'max cruise below max climb');
  assert.ok(m.idleThrustN(sl) < 0.15 * m.maxClimbThrustN(sl), 'idle is a small fraction of climb thrust');
});

test('climb: heavier, higher and hotter cost more; the ladder stops where 300 ft/min is lost', () => {
  const byWeight = [60000, 66000, 72000, 78000, 84000].map((w) => m.climb(w, 310, 0)!);
  increasing(byWeight.map((c) => c.timeMin), 'climb time with weight');
  increasing(byWeight.map((c) => c.fuelKg), 'climb fuel with weight');
  increasing(byWeight.map((c) => c.distNm), 'climb distance with weight');
  const byLevel = [210, 250, 290, 330].map((fl) => m.climb(70000, fl, 0)!);
  increasing(byLevel.map((c) => c.fuelKg), 'climb fuel with level');
  increasing(byLevel.map((c) => c.distNm), 'climb distance with level');
  assert.ok(m.climb(70000, 330, 15)!.fuelKg > m.climb(70000, 330, 0)!.fuelKg, 'hot climb costs more fuel');
  assert.equal(m.climb(86000, 390, 20), null, 'a heavy aeroplane cannot reach FL390 on a hot day');
  assert.ok(m.climb(56000, 390, 0) !== null, 'a light aeroplane reaches FL390');
});

test('descent: higher means longer; heavier means slightly longer at the same schedule', () => {
  const byLevel = [150, 250, 330, 390].map((fl) => m.descent(60000, fl, 0));
  increasing(byLevel.map((d) => d.distNm), 'descent distance with level');
  increasing(byLevel.map((d) => d.timeMin), 'descent time with level');
  increasing(byLevel.map((d) => d.fuelKg), 'descent fuel with level');
  assert.ok(m.descent(70000, 330, 0).distNm >= m.descent(50000, 330, 0).distNm, 'heavier descends further at idle');
});

test('holding: fuel flow rises with weight; the speed floor is 210 KIAS', () => {
  const a = m.air(1500);
  increasing([50000, 60000, 70000, 80000].map((w) => m.holding(w, a).fuelFlowKgPerHour), 'holding fuel flow with weight');
  assert.ok(m.holding(50000, a).kias >= 209.5, `holding speed floor: ${m.holding(50000, a).kias}`);
  // Known gap: with no part-power TSFC effect, two engines at higher thrust do not show the
  // real aeroplane's lower holding fuel flow; the model stays within 25% of the three-engine figure.
  const oneInop = m.holding(80000, a, m.CLEAN_1INOP).fuelFlowKgPerHour;
  near(oneInop, m.holding(80000, a).fuelFlowKgPerHour, 0.25, '1-INOP holding fuel flow');
});

test('one engine inoperative: ceiling falls with weight and heat; drift-down levels off below the ceiling', () => {
  decreasing([56000, 64000, 72000, 80000, 86000].map((w) => m.oneInopCeilingFt(w, 0)), '1-INOP ceiling with weight');
  assert.ok(m.oneInopCeilingFt(70000, 10) < m.oneInopCeilingFt(70000, 0), 'hot day lowers the ceiling');
  const dd = m.driftdown(76000, 330, 0);
  assert.ok(dd.levelOffFt < 33000 && dd.levelOffFt <= dd.ceilingFt - 1999, `level-off ${dd.levelOffFt} below ceiling ${dd.ceilingFt}`);
  assert.ok(dd.timeMin > 3 && dd.timeMin < 40, `drift-down time ${dd.timeMin}`);
  increasing([64000, 70000, 76000, 82000].map((w) => m.driftdown(w, 330, 0).distNm), 'drift-down distance with weight');
});

test('speeds: stall falls with flap and rises with weight; V2 and VREF are factored', () => {
  decreasing([0, 5, 15, 25, 30, 40].map((f) => m.stallKias(70000, f)), 'stall speed with flap');
  increasing([50000, 60000, 70000, 80000].map((w) => m.stallKias(w, 15)), 'stall speed with weight');
  for (const flap of m.TAKEOFF_FLAPS) {
    const s = m.takeoffSpeeds(76000, flap);
    near(s.v2, 1.23 * m.stallKias(76000, flap), 0.01, `V2 flaps ${flap}`);
    assert.ok(s.v1 <= s.vr && s.vr < s.v2, `V1 ≤ VR < V2 flaps ${flap}`);
  }
  for (const flap of m.LANDING_FLAPS) near(m.vrefKias(66000, flap), 1.3 * m.stallKias(66000, flap), 0.01, `VREF flaps ${flap}`);
});

test('take-off and landing field lengths grow with weight, altitude, temperature and a wet runway', () => {
  increasing([60000, 70000, 80000, 86000].map((w) => m.takeoffFieldLengthM(w, 15, 0, 15)), 'take-off length with weight');
  increasing([0, 2000, 4000, 8000].map((pa) => m.takeoffFieldLengthM(76000, 15, pa, 15)), 'take-off length with PA');
  increasing([15, 30, 40, 50].map((t) => m.takeoffFieldLengthM(76000, 15, 0, t)), 'take-off length with OAT');
  assert.ok(m.takeoffFieldLengthM(66000, 25, 0, 15) < m.takeoffFieldLengthM(66000, 5, 0, 15), 'more flap, shorter field at light weight');
  increasing([50000, 60000, 70000].map((w) => m.landingFieldLengthM(w, 30, 0)), 'landing length with weight');
  assert.ok(m.landingFieldLengthM(66000, 30, 0, true) > m.landingFieldLengthM(66000, 30, 0, false), 'wet is longer');
  assert.ok(m.landingFieldLengthM(66000, 40, 0) < m.landingFieldLengthM(66000, 30, 0), 'flaps 40 lands shorter');
  // inverse: field-limited weight round-trips the length
  const len = m.takeoffFieldLengthM(74000, 15, 2000, 30);
  near(m.fieldLimitedWeightKg(len, 15, 2000, 30), 74000, 0.002, 'field-limited weight inverse');
});

test('climb-limited weights fall with altitude and heat and with more flap', () => {
  decreasing([0, 2000, 4000, 8000].map((pa) => m.climbLimitedWeightKg(15, pa, 30)), 'climb limit with PA');
  decreasing([30, 40, 50].map((t) => m.climbLimitedWeightKg(15, 0, t)), 'climb limit with OAT');
  assert.ok(m.climbLimitedWeightKg(5, 0, 40) > m.climbLimitedWeightKg(15, 0, 40), 'less flap, higher climb limit');
  assert.ok(m.climbLimitedWeightKg(15, 0, 40) > m.climbLimitedWeightKg(25, 0, 40), 'flaps 25 lowest climb limit');
  decreasing([0, 4000, 8000].map((pa) => m.approachClimbLimitedWeightKg(30, pa, 35)), 'approach climb with PA');
});

test('altitude capability: thrust-limited weight falls with level and heat', () => {
  decreasing([250, 290, 330, 370].map((fl) => m.thrustLimitedWeightKg(0.8, m.air(fl * 100))!), 'capability with level');
  assert.ok(m.thrustLimitedWeightKg(0.8, m.air(33000, 15))! < m.thrustLimitedWeightKg(0.8, m.air(33000, 0))!, 'hot day lowers capability');
});

test('weight and balance arithmetic', () => {
  const B = m.BALANCE;
  assert.equal(m.indexUnits(1000, B.referenceArmM), 0, 'no index change at the reference arm');
  assert.ok(m.indexUnits(1000, B.referenceArmM + 1) > m.indexUnits(1000, B.referenceArmM), 'aft arm raises the index');
  near(m.percentMac(m.armFromPercentMac(25)), 25, 1e-9, '%MAC round trip');
  near(m.armFromIndex(60000, B.indexOffset + m.indexUnits(60000, 22.0)), 22.0, 1e-9, 'arm from total index round trip');
  // fuel distribution fills wing and centre together, then centre, then auxiliaries, never over capacity
  const F = m.AIRCRAFT.fuel;
  for (const kg of [5000, 16500, 24600, 30000, 32140]) {
    const d = m.fuelDistribution(kg);
    near(d.wingKg + d.centreKg + d.aftAuxKg + d.fwdAuxKg, kg, 1e-9, `fuel distribution sums at ${kg}`);
    assert.ok(d.wingKg <= 2 * F.tank1Kg + 1e-6 && d.centreKg <= F.tank2Kg + 1e-6 && d.aftAuxKg <= F.aftAuxKg + 1e-6 && d.fwdAuxKg <= F.fwdAuxKg + 1e-6, `tank capacities at ${kg}`);
  }
  const lim = m.cgLimits(60000);
  assert.ok(lim.forwardMac < lim.aftMac, 'envelope has width');
  assert.ok(m.cgLimits(86000).forwardMac >= m.cgLimits(60000).forwardMac, 'forward limit moves aft at high weight');
});

test('calibration: every reference point is within its tolerance', () => {
  const points = referencePoints();
  assert.ok(points.length >= 40, `reference points: ${points.length}`);
  const failures = points
    .map((r) => ({ r, err: (r.model - r.reference) / r.reference }))
    .filter(({ r, err }) => Math.abs(err) > r.tolerance)
    .map(({ r, err }) => `${r.group} — ${r.description}: model ${r.model.toFixed(1)} vs ${r.reference} ${r.unit} (${(err * 100).toFixed(1)}%, tol ${r.tolerance * 100}%)`);
  assert.deepEqual(failures, []);
  // the spread: typical absolute error under 5%
  const mean = points.reduce((s, r) => s + Math.abs((r.model - r.reference) / r.reference), 0) / points.length;
  assert.ok(mean < 0.05, `mean absolute error ${(mean * 100).toFixed(1)}%`);
});
