import assert from 'node:assert/strict';
import test from 'node:test';
import { delta, densityAltitude, isaTemp, sigma, speedOfSound, tasCompressible, tasIncompressible } from '../src/instruments/e6b/atmosphere.ts';
import { E6B, MACH_INDEX, UNITS, altitudeAltAt, altitudeTempAt, airspeedAltAt, airspeedTempAt, celsiusAt, fahrenheitAt, mark, scale } from '../src/instruments/e6b/face.ts';
import { altTheta, densityAtIndex, machTheta, manualDemos, tasTheta, withinTolerance } from '../src/instruments/e6b/demos.ts';
import { SHAPES, check, makeProblem, parseAnswer, rng } from '../src/instruments/e6b/practice.ts';
import { renderFace } from '../src/instruments/e6b/render.ts';
import { computeHeading, computeWind, readDot, solveHeading, solveWind, windDot, toScreen, gsForArc, U } from '../src/instruments/e6b/wind.ts';
import { windDemos } from '../src/instruments/e6b/demos.ts';
import { angleOf, graduation, hmm, mantissa, middleOpposite, norm, outerOpposite, rotationFor, valueAt } from '../src/instruments/e6b/slide.ts';

const near = (actual: number, expected: number, tolerance: number, message: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} ± ${tolerance}`);
const rel = (actual: number, expected: number, fraction: number, message: string) =>
  near(actual, expected, Math.abs(expected) * fraction, message);
const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test('the log scale maps value to angle and back at any disc rotation (within 0.3 %)', () => {
  const rand = rng(7);
  for (let i = 0; i < 5000; i++) {
    const theta = rand() * 360;
    const middle = 10 * 10 ** rand();
    const outer = outerOpposite(middle, theta);
    rel(outer, mantissa(middle * 10 ** (theta / 360)), 0.003, 'outer opposite');
    rel(middleOpposite(outer, theta), middle, 0.003, 'middle opposite');
    rel(valueAt(angleOf(middle)), middle, 1e-12, 'round trip');
    near(angleGap(rotationFor(outer, middle), theta), 0, 1e-6, 'rotation');
  }
  // 1:1 with the 60 rate arrow under 12 makes every outer number twice the middle (manual p. 6).
  const theta = rotationFor(12, 60);
  for (const [m, o] of [[90, 18], [15, 30], [35, 70]]) rel(outerOpposite(m, theta), o, 1e-9, `${m} → ${o}`);
});

test('graduations follow the manual: 0.1 to 15, 0.2 to 30, 0.5 to 60, 1 to 100', () => {
  assert.deepEqual([10, 14.9, 15, 29.8, 30, 59.5, 60, 99].map(graduation), [0.1, 0.1, 0.2, 0.2, 0.5, 0.5, 1, 1]);
  const outer = scale(E6B, 'outer');
  assert.equal(outer.ticks.length, 50 + 75 + 60 + 40);
  assert.equal(hmm(98), '1:38');
  assert.equal(hmm(457.14), '7:37');
});

test('every conversion arrow sits at the angle its unit constants give, and where ASA Figure 1 shows it', () => {
  const at = (id: string) => mark(E6B, id).value;
  rel(at('stat') / at('naut'), UNITS.NM_KM / UNITS.SM_KM, 1e-12, 'NAUT:STAT');
  rel(at('km') * 10 / at('naut'), 1.852, 1e-12, 'NAUT:KM');
  rel(at('liters') / at('us-gal'), 3.785411784, 1e-12, 'L:US gal');
  rel(at('us-gal') / at('imp-gal'), 4.54609 / 3.785411784, 1e-12, 'IMP:US');
  rel(at('fuel-lbs') / at('us-gal'), 6, 1e-12, 'avgas 6 lb/US gal');
  rel(at('oil-lbs') / at('us-gal'), 7.5, 1e-12, 'oil 7.5 lb/US gal');
  rel(at('lbs') * 0.45359237, at('kg'), 1e-12, 'LBS:KG');
  rel(at('meters') / 10, at('ft') * 0.3048, 1e-12, 'FT:M');
  assert.equal(at('seconds'), 36);
  for (const item of E6B.marks) {
    const angle = 360 * Math.log10(item.value / 10);
    near(angleGap(angleOf(item.value), angle), 0, 1e-9, `${item.id} angle`);
    if (item.measured != null) near(angleGap(angle, item.measured), 0, 0.75, `${item.id} against Figure 1`);
  }
  // Disc copies of an arrow are at the same position as the outer one.
  for (const [disc, base] of [['statute', 'stat'], ['km-mid', 'km'], ['imp-gal-mid', 'imp-gal'], ['us-gal-mid', 'us-gal'], ['liters-mid', 'liters']]) {
    assert.equal(at(disc), at(base), disc);
  }
  // Manual conversions read on the simulated scales.
  const naut = rotationFor(at('naut'), 90);
  rel(middleOpposite(at('stat'), naut), 10.357, 0.002, '90 kt → 103.6 mph (p. 13)');
  const stat = rotationFor(at('stat'), 11.5);
  rel(middleOpposite(at('km'), stat), 18.5, 0.003, '115 SM → 185 km (p. 14)');
  const imp = rotationFor(at('imp-gal'), at('us-gal-mid'));
  rel(outerOpposite(64, imp), 53.29, 0.002, '64 US gal → 53.2 imp gal (p. 15)');
  const fuel = rotationFor(at('fuel-lbs'), at('us-gal-mid'));
  rel(outerOpposite(32, fuel), 19.2, 1e-9, '32 US gal avgas → 192 lb (p. 16)');
  const oil = rotationFor(at('oil-lbs'), at('us-gal-mid'));
  rel(outerOpposite(20, oil), 15, 1e-9, '2 US gal oil → 15 lb (p. 17)');
});

test('the airspeed window reproduces the manual and the ISA density relation', () => {
  // Figure 13 and the sample problems (answers p. 37).
  const cases: [number, number, number, number, number][] = [
    [15000, -15, 145, 183, 15000],
    [14000, 5, 160, 204, 16000],
    [20000, -20, 200, 273, 20500],
    [8000, 15, 150, 174, 9800],
  ];
  for (const [pa, oat, cas, tas, da] of cases) {
    const theta = tasTheta({ pa, oat });
    // Read the outer scale opposite CAS: decade placed near CAS.
    const reading = outerOpposite(cas, theta) * (cas >= 100 ? 10 : 1);
    // Sample 2's printed 273 kt is the compressible answer (an air data computer's);
    // a density slide rule cannot model compressibility and reads 276.5 kt.
    const printed = pa === 20000 ? tasCompressible(cas, pa, oat) : reading;
    near(printed, tas, 2.5, `TAS ${pa}/${oat}/${cas}`);
    rel(reading, tasIncompressible(cas, pa, oat), 1e-9, 'window = CAS/√σ');
    near(densityAtIndex(theta), da, 350, `DA ${pa}/${oat}`);
    near(densityAtIndex(theta), densityAltitude(sigma(pa, oat)), 1e-6, 'DA = ISA altitude of σ');
  }
  // At 1:1 the window pairs each ISA pressure altitude with its ISA temperature... only at sea level (TAS = CAS).
  near(angleGap(airspeedAltAt(0), airspeedTempAt(15)), 0, 1e-9, 'PA 0 opposite +15 °C at 1:1');
  // Figure 1: PA 5 and 10 measured at 51.5° and 67.1°, 0 °C and −50 °C at 41.6° and 57.2° (label centres, ±1°).
  near(airspeedAltAt(5000), 51.5, 1.2, 'PA 5'); near(airspeedAltAt(10000), 67.1, 1.2, 'PA 10');
  near(airspeedTempAt(0), 41.6, 1.2, '0 °C'); near(airspeedTempAt(-50), 57.2, 1.2, '−50 °C');
});

test('the instrument ignores compressibility: its TAS error against an air data computer is stated', () => {
  // E6-B treats CAS as EAS. The error grows with speed and height.
  const err = (cas: number, pa: number) => {
    const oat = isaTemp(pa);
    return tasIncompressible(cas, pa, oat) / tasCompressible(cas, pa, oat) - 1;
  };
  near(err(145, 15000), 0.0045, 0.001, '145 kt at 15 000 ft');
  assert.ok(err(120, 5000) < 0.001);
  near(err(250, 25000), 0.028, 0.002, '250 kt at 25 000 ft');
  near(err(300, 30000), 0.053, 0.002, '300 kt at 30 000 ft');
  rel(tasCompressible(661.4788, 0, 15), 661.4788, 1e-6, 'sea level CAS = TAS');
});

test('the Mach index gives the speed of sound at the set temperature', () => {
  for (const oat of [-60, -45, -20, 0, 15, 30]) {
    const theta = machTheta(oat);
    rel(outerOpposite(10, theta) * 10 ** Math.round(Math.log10(speedOfSound(oat) / outerOpposite(10, theta))), speedOfSound(oat), 1e-9, `M1 at ${oat}`);
  }
  near(outerOpposite(10, machTheta(15)) * 10, 661, 1, 'Figure 14: M1 at +15 °C is 661 kt');
  // The index lies on the base under the disc at 1:1, 64.6° anticlockwise of PA 0.
  near(angleGap(MACH_INDEX, airspeedAltAt(0) - 64.6), 0, 0.1, 'Mach index position');
});

test('the altitude window reproduces the manual true-altitude examples', () => {
  // Figure 15 and the sample problems (answers p. 38): [PA, indicated, OAT, station, true].
  const cases: [number, number, number, number, number][] = [
    [10000, 12000, -19, 5000, 11600],
    [10500, 10000, -20, 5000, 9750],
    [12000, 11000, -30, 3000, 10350],
    [8000, 7600, -15, 0, 7200],
  ];
  for (const [pa, indicated, oat, station, answer] of cases) {
    const theta = altTheta({ pa, oat });
    const height = indicated - station;
    const m = outerOpposite(height, theta);
    const read = m * 10 ** Math.round(Math.log10(height / m)) + station;
    near(read, answer, 60, `true altitude ${pa}/${oat}`);
  }
  near(angleGap(altitudeAltAt(0), altitudeTempAt(15)), 0, 1e-9, 'PA 0 opposite +15 °C at 1:1');
  near(altitudeTempAt(0), -36.3, 1.2, 'Figure 1: 0 °C'); near(altitudeTempAt(-40), -61.5, 1.2, 'Figure 1: −40 °C');
  near(altitudeAltAt(30000), -64.2, 1.2, 'Figure 1: PA 30');
});

test('the temperature conversion arc is linear and agrees with °F = 1.8 °C + 32', () => {
  near(celsiusAt(50), 142.9, 0.2, '+50 °C end'); near(celsiusAt(-50), 217.06, 0.2, '−50 °C end');
  for (const c of [-40, -10, 0, 37, 50]) near(fahrenheitAt(c * 1.8 + 32), celsiusAt(c), 1e-9, `${c} °C`);
});

test('the seven guided demos reproduce the manual within the reading tolerance', () => {
  const demos = manualDemos();
  assert.deepEqual(demos.map((demo) => demo.id), ['tsd', 'fuel', 'convert', 'tas', 'mach', 'offcourse', 'truealt']);
  for (const demo of demos) {
    assert.ok(demo.steps.length >= 2, demo.id);
    for (const step of demo.steps) assert.ok(step.say.length > 10 && Number.isFinite(step.theta), `${demo.id}: ${step.say}`);
    for (const result of demo.results) {
      assert.ok(withinTolerance(result), `${demo.id} ${result.label}: read ${result.read}, exact ${result.exact} ± ${result.tolerance}`);
      if (!result.manual) continue;
      const agrees = Math.abs(result.manual.value - result.read) <= result.tolerance;
      // Where the manual disagrees with its own arithmetic, the demo says so.
      assert.ok(agrees || !!result.manual.note, `${demo.id} ${result.label}: manual ${result.manual.value} vs read ${result.read}`);
    }
  }
  const tsd = demos[0].results[0];
  assert.equal(hmm(tsd.read), '1:38');
  const off = demos[5].results;
  near(off[1].read, 2.04, 0.02, 'the scale shows 2.04°, not the 2.4° printed');
});

test('practice problems are generated, checked within tolerance and replay their demo', () => {
  for (const shape of SHAPES) {
    const rand = rng(42);
    for (let i = 0; i < 60; i++) {
      const problem = makeProblem(shape, rand, i % 3 === 0);
      assert.ok(problem.stem.endsWith('?') || problem.stem.endsWith('.'), problem.stem);
      assert.ok(Number.isFinite(problem.key.exact) && problem.key.tolerance > 0, problem.stem);
      assert.ok(withinTolerance(problem.key), `${shape}: the computer itself reads ${problem.key.read} for ${problem.key.exact}`);
      assert.equal(check(problem, String(problem.key.exact)).ok, true);
      assert.equal(check(problem, String(problem.key.read)).ok, true);
      assert.equal(check(problem, String(problem.key.exact + problem.key.tolerance * 3)).ok, false);
      assert.ok(problem.demo.steps.length >= 2);
    }
  }
  const a = makeProblem('tsd', rng(1));
  const b = makeProblem('tsd', rng(1));
  assert.equal(a.stem, b.stem);
  assert.equal(parseAnswer('1:38', true), 98);
  assert.equal(parseAnswer('1,050', false), 1050);
  assert.equal(parseAnswer('5.9°', false), 5.9);
  assert.equal(parseAnswer('', false), null);
  assert.equal(parseAnswer('1:38', false), null);
  assert.equal(check(a, '').ok, false);
});

test('the face renders every arrow and scale with finite coordinates', () => {
  const svg = renderFace(E6B, 't');
  const all = svg.base + svg.disc + svg.defs;
  for (const item of E6B.marks) assert.ok(all.includes(`data-mark="${item.id}"`), item.id);
  for (const item of E6B.scales) assert.ok(all.includes(`data-scale="${item.id}"`), item.id);
  assert.ok(!/NaN|Infinity|undefined/.test(all));
  assert.ok(all.includes('data-mark="mach"'));
  near(norm(E6B.index.density), 47.3, 1e-9, 'density index');
  near(delta(0), 1, 1e-12, 'ISA');
});

test('the trainer lists the flight computer as a Lab page', async () => {
  const { chipFor, sitting } = await import('../src/chrome.ts');
  assert.deepEqual(chipFor(null, 'lab'), { id: 'lab', label: 'Flight computer' });
  assert.equal(sitting('lab'), false);
});

test('the wind side reproduces the manual heading and wind problems', () => {
  // p. 30 example and p. 31 samples (answers p. 38): [wind from, kt, TC, TAS, TH, GS].
  const heading: number[][] = [[230, 18, 90, 125, 95, 138], [240, 38, 300, 165, 288, 143], [40, 43, 150, 140, 133, 149], [330, 25, 20, 180, 14, 163], [110, 18, 260, 225, 258, 240]];
  for (const [from, kt, tc, tas, th, gs] of heading) {
    const set = computeHeading(tc, tas, from, kt);
    const exact = solveHeading(tc, tas, from, kt);
    near(set.gs, exact.gs, 1e-9, 'slide GS is the exact wind triangle');
    near(set.wca, exact.wca, 1e-9, 'drift line is the exact WCA');
    near(set.gs, gs, 1, `GS for ${from}/${kt} on ${tc}`);
    near(((tc + set.wca - th + 540) % 360) - 180, 0, 1, `TH for ${from}/${kt} on ${tc}`);
    const dot = readDot(set.state)!;
    near(dot.tas, tas, 1e-9, 'the dot sits on the TAS arc');
  }
  // p. 32–35 example and p. 33 samples: [TH, TC, TAS, GS, from, kt].
  const find: number[][] = [[160, 180, 140, 120, 104, 50], [320, 315, 140, 128, 2, 17], [175, 160, 150, 115, 212, 49]];
  for (const [th, tc, tas, gs, from, kt] of find) {
    const set = computeWind(th, tc, tas, gs);
    const exact = solveWind(th, tc, tas, gs);
    near(((set.from - exact.from + 540) % 360) - 180, 0, 1e-9, 'plate reading is the exact wind direction');
    near(set.kt, exact.kt, 1e-9, 'mark distance is the exact wind speed');
    near(((set.from - from + 540) % 360) - 180, 0, 2, `wind direction for ${th}/${tc}`);
    near(set.kt, kt, 1.5, `wind speed for ${th}/${tc}`);
  }
  // A headwind on the nose: GS = TAS − wind; the dot is drawn upwind of the grommet.
  const [x, y] = toScreen(windDot(90, 20), 90);
  near(x, 0, 1e-9, 'dot on the centre line'); near(y, -20 * U, 1e-9, 'dot 20 kt up');
  near(gsForArc(x, y, 150), 130, 1e-9, 'GS 130');
  for (const demo of windDemos()) for (const result of demo.results) {
    assert.ok(withinTolerance(result), `${demo.id} ${result.label}`);
    assert.ok(result.manual && Math.abs(((result.manual.value - result.read + 540) % 360) - 180) <= result.tolerance, `${demo.id} ${result.label} vs manual`);
  }
});
