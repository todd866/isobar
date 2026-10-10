import assert from 'node:assert/strict';
import test from 'node:test';
import * as e from '../src/b727/engine.ts';
import { planAll, problems, FLIGHTS, buildLegs } from '../src/b727/examples.ts';
import { renderHandbook } from '../src/b727/handbook.ts';

const near = (actual: number, expected: number, tol: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`);
};

test('rounding rules follow the CASA information book', () => {
  // gross weight to the nearest 1,000 kg
  assert.equal(e.weightEntry(72500), 73000);
  assert.equal(e.weightEntry(72499), 72000);
  assert.equal(e.weightEntry(71000), 71000);
  // ISA deviation: nearest 3 °C for cruise fuel flow, nearest 5 °C for climb, holding and capability
  assert.equal(e.isaDevForCruise(10), 9);
  assert.equal(e.isaDevForCruise(14), 15);
  assert.equal(e.isaDevForCruise(-7), -6);
  assert.equal(e.isaDevForClimb(7), 5);
  assert.equal(e.isaDevForClimb(8), 10);
  assert.equal(e.isaDevForClimb(-12), -10);
  // landing weight column: nearest 10,000 kg, no interpolation
  assert.equal(e.landingWeightColumn(64999), 60000);
  assert.equal(e.landingWeightColumn(65000), 70000);
  // fuel to the nearest kg, .5 up
  assert.equal(e.roundFuel(1234.5), 1235);
  assert.equal(e.roundFuel(1234.49), 1234);
  // wind to the nearest 10° and 5 kt
  assert.deepEqual(e.roundWind(264, 42), { dir: 260, kt: 40 });
  assert.deepEqual(e.roundWind(265, 47.5), { dir: 270, kt: 50 });
  assert.deepEqual(e.roundWind(3, 12), { dir: 360, kt: 10 });
});

test('table interpolation is linear between the 2,000 kg columns and the weight is rounded first', () => {
  const lo = e.cruiseLookup('M0.80', 330, 70000, 0)!;
  const hi = e.cruiseLookup('M0.80', 330, 72000, 0)!;
  const mid = e.cruiseLookup('M0.80', 330, 71000, 0)!;
  near(mid.fuelFlowKgPerHour, (lo.fuelFlowKgPerHour + hi.fuelFlowKgPerHour) / 2, 0.5, 'midpoint fuel flow');
  assert.equal(e.cruiseLookup('M0.80', 330, 71400, 0)!.fuelFlowKgPerHour, mid.fuelFlowKgPerHour, '71,400 enters as 71,000');
  assert.equal(e.cruiseLookup('M0.80', 330, 71000, 10)!.isaDevUsed, 9, 'ISA+10 enters as +9');
  // temperature correction direction
  assert.ok(e.cruiseLookup('M0.80', 330, 70000, 9)!.fuelFlowKgPerHour > lo.fuelFlowKgPerHour, 'warm costs more');
  assert.ok(e.cruiseLookup('M0.80', 330, 70000, 9)!.tasKt > lo.tasKt, 'warm is faster');
  assert.equal(e.cruiseLookup('M0.80', 390, 86000, 20), null, 'no data where the aeroplane cannot cruise');
  // climb lookup: unrounded time and distance, fuel to the kg, ISA to 5 °C
  const c = e.climbLookup(74500, 310, 13)!;
  assert.equal(c.isaDevUsed, 15);
  assert.equal(c.fuelKg, Math.floor(c.fuelKg), 'climb fuel is a whole number of kg');
  assert.ok(c.fuelKg > 2000 && c.fuelKg < 3500, `climb fuel ${c.fuelKg}`);
  const c2 = e.climbLookup(75000, 310, 15)!;
  const c1 = e.climbLookup(74000, 310, 15)!;
  near(c.fuelKg, (c1.fuelKg + c2.fuelKg) / 2, 1, '74,500 interpolates between 74,000 and 75,000 (which themselves interpolate the 2,000 kg columns)');
});

test('met levels: nearest forecast level, 2/3 for climb, 1/2 for descent, FL185 below FL185', () => {
  const grid: e.MetGrid = { levels: e.RSWT_LEVELS, columns: [] };
  assert.equal(e.metLevelFor(grid, 290), 300);
  assert.equal(e.metLevelFor(grid, 250), 235);
  assert.equal(e.metLevelFor(grid, 170), 185);
  assert.equal(e.metLevelFor(grid, 100), 185);
  assert.equal(e.climbMetLevel(grid, 330), 235, '2/3 of FL330 is FL220 → FL235');
  assert.equal(e.climbMetLevel(grid, 390), 235, '2/3 of FL390 is FL260 → FL235');
  assert.equal(e.descentMetLevel(grid, 330), 185, '1/2 of FL330 is FL165 → FL185');
  assert.equal(e.descentMetLevel(grid, 390), 185, '1/2 of FL390 is FL195 → FL185');
});

test('ground speed from the exact wind triangle', () => {
  near(e.groundSpeed(450, 90, 270, 50).gsKt, 500, 1e-6, 'tailwind');
  near(e.groundSpeed(450, 90, 90, 50).gsKt, 400, 1e-6, 'headwind');
  near(e.groundSpeed(450, 90, 360, 50).gsKt, Math.sqrt(450 * 450 - 50 * 50), 1e-6, 'pure crosswind');
  const x = e.groundSpeed(450, 90, 360, 50);
  assert.ok(x.headingDeg < 90 && x.headingDeg > 80, `drift into wind: heading ${x.headingDeg}`);
  assert.equal(e.trueFromMagnetic(350, 12), 2);
  assert.equal(e.trueFromMagnetic(5, -10), 355);
});

test('critical point and PNR formulas', () => {
  near(e.etpDistanceNm(1000, 500, 400), 1000 * 400 / 900, 1e-9, 'single-zone ETP');
  const multi = e.etpMultiZone([{ distNm: 500, gsOnKt: 500, gsBackKt: 400 }, { distNm: 500, gsOnKt: 500, gsBackKt: 400 }]);
  near(multi.distNm, 1000 * 400 / 900, 1e-6, 'uniform multi-zone equals single-zone');
  // time on from the ETP equals time home to departure
  const zones = [{ distNm: 600, gsOnKt: 520, gsBackKt: 380 }, { distNm: 900, gsOnKt: 480, gsBackKt: 420 }];
  const etp = e.etpMultiZone(zones);
  const timeHome = Math.min(etp.distNm, 600) / 380 + Math.max(0, etp.distNm - 600) / 420;
  const timeOn = Math.max(0, 600 - etp.distNm) / 520 + (900 - Math.max(0, etp.distNm - 600)) / 480;
  near(timeHome, timeOn, 1e-6, 'ETP balances time home and time on');
  // PNR: fuel out + fuel back = fuel available
  const pnr = e.pnrDistanceNm(10000, [{ distNm: 2000, sgrOutKgPerNm: 10, sgrBackKgPerNm: 12.5 }]);
  near(pnr.distNm, 10000 / 22.5, 1e-9, 'single-zone PNR');
  assert.ok(pnr.limited);
  const far = e.pnrDistanceNm(100000, [{ distNm: 500, sgrOutKgPerNm: 10, sgrBackKgPerNm: 12 }]);
  assert.ok(!far.limited && far.distNm === 500, 'PNR beyond the route');
});

test('fuel plan: components and sums', () => {
  const fp = e.fuelPlan({ tripKg: 12000, landingKg: 64000, alternateBurnKg: 2000, holdingMin: 30 });
  near(fp.contingencyKg, 600, 1e-9, '5% of trip');
  assert.equal(fp.alternateKg, 2350, 'alternate burn plus 350 kg approach allowance');
  assert.ok(fp.holdingKg > 1500 && fp.holdingKg < 2200, `30 min holding ${fp.holdingKg}`);
  assert.ok(fp.finalReserveKg > 1400 && fp.finalReserveKg < 2000, `final reserve ${fp.finalReserveKg}`);
  near(fp.takeoffFuelKg, fp.tripKg + fp.contingencyKg + fp.alternateKg + fp.holdingKg + fp.finalReserveKg, 1e-9, 'take-off fuel sum');
  assert.equal(fp.rampFuelKg, fp.takeoffFuelKg + 200);
  const tiny = e.fuelPlan({ tripKg: 1000, landingKg: 60000 });
  assert.ok(tiny.contingencyKg > 50, 'contingency floor is five minutes holding');
  assert.ok(tiny.lines.some((l) => l.name.startsWith('No alternate')), 'no alternate: 15 minutes holding');
  assert.equal(e.fuelPlan({ tripKg: 1000, landingKg: 60000, fixedFinalReserve: true }).finalReserveKg, 1600);
  assert.ok(fp.lines.every((l) => l.basis.length > 0), 'every line has a basis');
  assert.ok(fp.lines.find((l) => l.name.startsWith('Contingency'))!.basis.includes('Part 121 MOS'), 'contingency cites the MOS');
});

test('load sheet: index arithmetic, CG movement and limits', () => {
  const B = e.TABLES.balance;
  const empty = e.loadSheet({ basicWeightKg: 46400, basicIndex: B.typicalBasicIndex, zones: {}, freightKg: {}, fuelKg: 0 });
  near(empty.zeroFuelMac, 31, 0.3, 'empty CG about 31% MAC');
  const fwd = e.loadSheet({ basicWeightKg: 46400, basicIndex: B.typicalBasicIndex, zones: { A: { adult: 36 } }, freightKg: {}, fuelKg: 0 });
  assert.ok(fwd.zeroFuelMac < empty.zeroFuelMac, 'zone A moves the CG forward');
  const aft = e.loadSheet({ basicWeightKg: 46400, basicIndex: B.typicalBasicIndex, zones: {}, freightKg: { 5: 1500 }, fuelKg: 0 });
  assert.ok(aft.zeroFuelMac > empty.zeroFuelMac, 'compartment 5 moves the CG aft');
  assert.ok(aft.violations.some((v) => v.includes('aft of')), 'aft limit flagged');
  const full = e.loadSheet({ basicWeightKg: 46400, basicIndex: B.typicalBasicIndex, zones: { A: { adult: 36 }, B: { adult: 36 }, C: { adult: 30 }, D: { adult: 30 }, E: { adult: 30 } }, freightKg: { 1: 1500, 2: 1200, 4: 1500, 5: 1200 }, fuelKg: 18000, tripBurnKg: 11000 });
  assert.equal(full.payloadKg, 162 * 82 + 5400);
  assert.ok(full.violations.some((v) => v.includes('MZFW')), 'MZFW exceeded is flagged');
  assert.ok(full.zeroFuelMac > 12 && full.zeroFuelMac < 25, `full-load CG ${full.zeroFuelMac}`);
  near(e.macFromIndex(60000, B.indexUnit.offset), 25, 1e-9, 'offset index is 25% MAC');
});

test('take-off and landing limits pick the lowest of field, climb and structure', () => {
  const long = e.takeoffLimit({ flap: 15, toraM: 3900, slopePercent: 0, windKt: 0, elevationFt: 20, qnhHpa: 1013, oatC: 15 });
  assert.equal(long.limitedBy, 'structural');
  assert.equal(long.performanceLimitKg, 86500);
  const short = e.takeoffLimit({ flap: 15, toraM: 1800, slopePercent: 0, windKt: 0, elevationFt: 20, qnhHpa: 1013, oatC: 15 });
  assert.equal(short.limitedBy, 'field');
  assert.ok(short.performanceLimitKg < 75000, `short runway ${short.performanceLimitKg}`);
  const hot = e.takeoffLimit({ flap: 25, toraM: 3900, slopePercent: 0, windKt: 0, elevationFt: 20, qnhHpa: 1013, oatC: 45 });
  assert.equal(hot.limitedBy, 'climb');
  const tail = e.takeoffLimit({ flap: 25, toraM: 3900, slopePercent: 0, windKt: -10, elevationFt: 20, qnhHpa: 1013, oatC: 45 });
  near(tail.climbLimitKg, hot.climbLimitKg - 3000, 1e-6, '300 kg per knot of tailwind');
  assert.ok(e.pressureAltitude(100, 1003) === 400, '30 ft per hPa');
  const high = e.takeoffLimit({ flap: 15, toraM: 3900, slopePercent: 0, windKt: 0, elevationFt: 4000, qnhHpa: 1013, oatC: 15 });
  assert.ok(high.structuralKg < 86500, 'structural limit lapses above 2,000 ft');
  assert.ok(long.speeds!.v2 > long.speeds!.vr && long.speeds!.vr >= long.speeds!.v1, 'speed order');
  const ldg = e.landingLimit({ flap: 40, ldaM: 3000, slopePercent: 0, windKt: 0, elevationFt: 20, qnhHpa: 1013, oatC: 15, wet: false });
  assert.equal(ldg.performanceLimitKg, 66000);
  const dry = e.landingLimit({ flap: 30, ldaM: 1400, slopePercent: 0, windKt: 0, elevationFt: 0, qnhHpa: 1013, oatC: 15, wet: false });
  const wet = e.landingLimit({ flap: 30, ldaM: 1400, slopePercent: 0, windKt: 0, elevationFt: 0, qnhHpa: 1013, oatC: 15, wet: true });
  assert.equal(dry.limitedBy, 'field');
  assert.ok(wet.fieldLimitKg < dry.fieldLimitKg, 'wet lowers the field limit');
});

test('IFR levels and the highest appropriate level', () => {
  assert.deepEqual(e.ifrLevels(90, 250, 390), [250, 270, 290, 330, 370]);
  assert.deepEqual(e.ifrLevels(270, 250, 390), [260, 280, 310, 350, 390]);
  const light = e.highestLevel('M0.80', 90, 60000, () => 0);
  const heavy = e.highestLevel('M0.80', 90, 84000, () => 0);
  assert.ok(light! > heavy!, `light ${light} above heavy ${heavy}`);
  assert.ok(e.highestLevel('M0.80', 90, 84000, () => 15)! <= heavy!, 'hot day no higher');
});

test('route geometry: great-circle distance and track', () => {
  const legs = buildLegs('YPPH', 'YSSY', [{ to: 'YSSY', metColumn: 0 }]);
  near(legs[0].distNm, 1768, 5, 'Perth–Sydney great circle');
  near(legs[0].trackM, 104 - 5.4, 3, 'initial track, magnetic');
  near(e.greatCircleNm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 60, 0.01, 'one degree of longitude at the equator');
});

test('worked flight plans round-trip through the engine', () => {
  const flights = planAll();
  assert.equal(flights.length, 5);
  const ids = flights.map((f) => f.spec.id);
  assert.deepEqual(ids, ['F1', 'F2', 'F3', 'F4', 'F5']);
  for (const x of flights) {
    const id = x.spec.id;
    const L = e.TABLES.limitations.weights;
    // weights close
    near(x.plan.landingKg, x.brakeReleaseKg - x.plan.burnKg, 1e-6, `${id} landing weight`);
    near(x.brakeReleaseKg, x.zeroFuelKg + x.fuel.takeoffFuelKg, 10, `${id} BRW = ZFW + take-off fuel`);
    assert.ok(x.brakeReleaseKg <= L.maxTakeoffKg, `${id} BRW ${x.brakeReleaseKg}`);
    assert.ok(x.brakeReleaseKg <= x.takeoff.performanceLimitKg, `${id} within take-off performance`);
    assert.ok(x.plan.landingKg <= x.landing.performanceLimitKg, `${id} within landing limit`);
    assert.ok(x.zeroFuelKg <= L.maxZeroFuelKg, `${id} ZFW`);
    // zone log consistency
    const dist = x.plan.rows.reduce((s, r) => s + r.distNm, 0);
    near(dist, x.plan.totalDistNm, 1e-6, `${id} zone distances sum to the route`);
    for (let i = 1; i < x.plan.rows.length; i++) near(x.plan.rows[i].startZoneKg, x.plan.rows[i - 1].endZoneKg, 1e-6, `${id} zone ${i} chains`);
    for (const r of x.plan.rows) {
      near(r.endZoneKg, r.startZoneKg - r.zoneFuelKg, 1e-6, `${id} ${r.segment} end weight`);
      if (typeof r.fl === 'number') {
        assert.equal(r.emzwKg, e.weightEntry(r.startZoneKg - r.zoneFuelKg / 2), `${id} ${r.segment} EMZW is the rounded mid-zone weight`);
        near(r.zoneFuelKg, (r.fuelFlowKgPerHour! * r.etiMin) / 60, 1e-6, `${id} ${r.segment} zone fuel = FF × time`);
        near(r.distNm, (r.gsKt * r.etiMin) / 60, 1e-6, `${id} ${r.segment} distance = GS × time`);
      }
    }
    // capability
    const cap = e.altitudeCapabilityKg(x.spec.technique === '280KIAS' ? 'LRC' : x.spec.technique, x.cruiseFl, e.isaDevForClimb(x.plan.rows[1].isaDev));
    assert.ok(cap !== null && x.plan.tocKg <= cap, `${id} TOC ${x.plan.tocKg} within FL${x.cruiseFl} capability ${cap}`);
    // ETPs lie on the route and the normal ETP sits where time home equals time on
    for (const t of x.etps) assert.ok(t.distNm > 0 && t.distNm < x.plan.totalDistNm, `${id} ${t.label} ETP on the route`);
    assert.ok(x.pnr.distNm > x.etps[0].distNm * 0.8, `${id} PNR ${x.pnr.distNm} is not far short of the ETP ${x.etps[0].distNm}`);
    // rule of thumb within 15%
    assert.ok(Math.abs(x.ruleOfThumb.differencePercent) < 15, `${id} rule of thumb ${x.ruleOfThumb.differencePercent}%`);
    assert.ok(x.checks.every((c) => c.includes('≤')), `${id} checks: ${x.checks.join('; ')}`);
  }
  // the long westbound sector burns more per ground mile than the eastbound one
  const f1 = flights[0], f3 = flights[2];
  assert.ok(f3.ruleOfThumb.kgPerGroundNm > f1.ruleOfThumb.kgPerGroundNm, 'headwind sector costs more per nm');
  assert.equal(FLIGHTS.length, 5);
});

test('APLA-style problems are internally consistent', () => {
  const ps = problems();
  assert.equal(ps.length, 10);
  assert.deepEqual(ps.map((p) => p.topic).filter((t) => t === 'take-off').length, 4);
  assert.deepEqual(ps.map((p) => p.topic).filter((t) => t === 'landing').length, 3);
  assert.deepEqual(ps.map((p) => p.topic).filter((t) => t === 'weight and balance').length, 3);
  const by = Object.fromEntries(ps.map((p) => [p.id, p]));
  near(by.P1.values.performanceLimitKg, Math.min(by.P1.values.fieldLimitKg, by.P1.values.climbLimitKg, 86500), 1e-6, 'P1 lowest limit');
  assert.ok(by.P2.values.performanceLimitKg < 86500, 'P2 is performance limited on a hot day');
  assert.equal(by.P3.values.performanceLimitKg, Math.max(by.P3.values.f5, by.P3.values.f15, by.P3.values.f25), 'P3 picks the best flap');
  assert.ok(by.P4.values.climbLimitKg < 90000, 'P4 anti-ice decrement applied');
  assert.equal(by.P5.values.performanceLimitKg, 70100, 'P5 structural at Gold Coast wet');
  assert.equal(by.P6.values.f40, 66000);
  assert.ok(by.P7.values.fieldLimitKg >= 62000, 'P7 LDA satisfies the field limit');
  assert.ok(by.P8.values.brakeReleaseMac > 12 && by.P8.values.brakeReleaseMac < 36, 'P8 within envelope');
  near(by.P9.values.payloadKg, Math.min(by.P9.values.byTow, by.P9.values.byLw, by.P9.values.byZfw), 1e-9, 'P9 payload');
  assert.ok(by.P10.values.beforeMac < 12 && by.P10.values.afterMac >= 12.9 && by.P10.values.afterMac <= 13.2, `P10 ${by.P10.values.beforeMac} → ${by.P10.values.afterMac}`);
  assert.ok(by.P10.values.moveKg <= e.TABLES.balance.compartments['5'].maxKg, 'P10 respects the compartment limit');
  for (const p of ps) assert.ok(p.question.length > 40 && p.working.length >= 2 && p.answer.length > 5, `${p.id} has a question, working and answer`);
});

test('the handbook renders with its sections, notices and attribution', () => {
  const md = renderHandbook();
  assert.ok(md.startsWith('# Isobar B727 Handbook'));
  assert.ok(md.includes('For training, not for operational use'));
  assert.ok(md.includes('CC BY 4.0'));
  for (const h of ['## 1 Limitations', '## 2 Climb', '## 3 Cruise', '## 4 Descent', '## 5 Abnormal', '## 6 Take-off', '## 7 Weight and balance', '## 8 Fuel policy', '## 9 Worked examples', '## 10 Calibration']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('### 9.5 Perth to Adelaide'));
  assert.ok(md.includes('**P10 (weight and balance).**'));
  assert.ok(md.length > 100000, `handbook length ${md.length}`);
});
