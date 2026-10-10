/** Practice: a generated problem in one of the demo shapes, set as a pilot's
 * situation on a real Australian route with a reason to want the number. The
 * learner estimates, sets the computer and types the reading; the answer is
 * accepted within the slide rule's reading precision. A miss replays the demo
 * for the same numbers, then the next problem of that shape is an easier one
 * with the marks highlighted (owner's rule: wrong answer → easier follow-up
 * with more help).
 */
import { CONVERSIONS, conversionDemo, difference, fuelDemo, machDemo, offCourseDemo, tasDemo, trueAltDemo, tsdDemo, windFindDemo, windHeadingDemo, type ConversionKind, type Demo, type Highlight, type Result } from './demos.ts';
import { E6B, type Face } from './face.ts';
import { AERODROMES, B727, GA_ROUTES, JET_ROUTES, route, zulu } from './routes.ts';
import { hmm } from './slide.ts';
import { solveHeading, wrap360 } from './wind.ts';

export type Shape = 'tsd' | 'fuel' | 'convert' | 'tas' | 'mach' | 'offcourse' | 'truealt' | 'windhdg' | 'windfind';
export const SHAPES: Shape[] = ['tsd', 'fuel', 'convert', 'tas', 'mach', 'offcourse', 'truealt', 'windhdg', 'windfind'];

export const SHAPE_NAMES: Record<Shape, string> = {
  tsd: 'Time en route', fuel: 'Fuel used', convert: 'Unit conversion', tas: 'TAS and density altitude',
  mach: 'Mach number to TAS', offcourse: 'Off-course correction', truealt: 'True altitude',
  windhdg: 'Heading and ground speed', windfind: 'Find the wind',
};

/** A given of the problem, shown as a chip; hovering it lights its place on the instrument. */
export interface Given { label: string; value: string; highlight: Highlight | null }

/** A known wrong answer and what causes it. */
export interface Slip { id: string; value: number; text: string }

/** The decision the number feeds, asked after the reading. */
export interface Decision { question: string; answer: boolean; why: string }

export interface Problem {
  shape: Shape;
  easy: boolean;
  stem: string;
  givens: Given[];
  /** Unit shown beside the answer box. */
  unit: string;
  /** The demo for these exact numbers: replayed on a miss. */
  demo: Demo;
  /** The result the answer is checked against. */
  key: Result;
  /** Accept h:mm as well as minutes. */
  time: boolean;
  slips: Slip[];
  /** What the number means for the flight, shown with the verdict. */
  outcome?: string;
  decision?: Decision;
}

/** Today's data from the trainer's live snapshot, where it has it. */
export interface LiveContext {
  airports: { icao: string; windFrom: number | null; windKt: number | null; tempC: number | null }[];
}

/** Mulberry32: small, seedable, the same sequence in the app and the tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const between = (rand: () => number, lo: number, hi: number, step: number): number =>
  lo + step * Math.floor(rand() * (Math.floor((hi - lo) / step) + 1));
const n = (v: number) => v.toLocaleString('en-AU');
const sign = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');
export const pad = (v: number) => `${String(Math.round(wrap360(v)) || 360).padStart(3, '0')}°`;
const outer = (value: number): Highlight => ({ kind: 'scale', scale: 'outer', value });
const inner = (value: number): Highlight => ({ kind: 'scale', scale: 'middle', value });

export function makeProblem(shape: Shape, rand: () => number, easy = false, face: Face = E6B, live?: LiveContext): Problem {
  const done = (p: Omit<Problem, 'shape' | 'easy' | 'key' | 'time' | 'slips'> & { key?: Result; time?: boolean; slips?: Slip[] }): Problem =>
    ({ shape, easy, key: p.key ?? p.demo.results[p.demo.results.length - 1], time: p.time ?? false, slips: p.slips ?? [], ...p });
  switch (shape) {
    case 'tsd': {
      if (easy) {
        const [a, b] = pick(rand, GA_ROUTES);
        const gs = pick(rand, [120, 150, 180]);
        const dist = gs * pick(rand, [0.5, 1, 1.5, 2]);
        const demo = tsdDemo({ gs, dist }, face);
        return done({
          stem: `${a}→${b} in the club Cessna: call it ${n(dist)} NM at ${gs} kt ground speed. How long en route?`,
          givens: [{ label: 'GS', value: `${gs} kt`, highlight: outer(gs) }, { label: 'Distance', value: `${n(dist)} NM`, highlight: outer(dist) }],
          unit: 'min or h:mm', demo, time: true, slips: tsdSlips(gs, dist),
        });
      }
      const [a, b] = pick(rand, JET_ROUTES);
      const leg = route(a, b);
      const dist = Math.round(leg.nm / 5) * 5;
      const gs = between(rand, 400, 520, 5);
      const off = between(rand, 0, 23 * 60 - 1, 5);
      const demo = tsdDemo({ gs, dist }, face);
      return done({
        stem: `You're ${a}→${b} in the B727, airborne ${zulu(off)}: ${n(dist)} NM to run at ${gs} kt ground speed. How long until you're overhead ${b}?`,
        givens: [{ label: 'GS', value: `${gs} kt`, highlight: outer(gs) }, { label: 'Distance', value: `${n(dist)} NM`, highlight: outer(dist) }],
        unit: 'min or h:mm', demo, time: true, slips: tsdSlips(gs, dist),
        outcome: `Overhead ${b} at ${zulu(off + (dist / gs) * 60)}.`,
      });
    }
    case 'fuel': {
      if (easy) {
        const rate = pick(rand, [600, 1200, 1800, 2400, 3000]);
        const minutes = pick(rand, [30, 90, 120, 150]);
        const demo = fuelDemo({ rate, minutes, unit: 'kg' }, face);
        return done({
          stem: `Holding over the field at ${n(rate)} kg/h for ${minutes} min. How much fuel do you burn?`,
          givens: [{ label: 'Flow', value: `${n(rate)} kg/h`, highlight: outer(rate) }, { label: 'Time', value: `${minutes} min`, highlight: inner(minutes) }],
          unit: 'kg', demo, slips: fuelSlips(rate, minutes),
        });
      }
      const [a, b, alt] = pick(rand, JET_ROUTES);
      const rate = between(rand, B727.flowKgH[0], B727.flowKgH[1], 50);
      const minutes = between(rand, 25, 300, 1);
      const burn = (rate * minutes) / 60;
      const toAlt = Math.round(route(b, alt).nm);
      // Diversion at about 380 kt and 3,500 kg/h, plus 900 kg for the missed approach and climb.
      const altFuel = Math.round((toAlt / 380) * 3500 / 100) * 100 + 900;
      const need = burn + B727.finalReserveKg + altFuel;
      const margin = between(rand, 6, 25, 1) * 100 * (rand() < 0.5 ? -1 : 1);
      const fob = Math.round((need + margin) / 100) * 100;
      const demo = fuelDemo({ rate, minutes, unit: 'kg' }, face);
      const left = fob - burn;
      return done({
        stem: `${a}→${b} in the B727: ${hmm(minutes)} to run at ${n(rate)} kg/h with ${n(fob)} kg on board. How much fuel will you burn?`,
        givens: [{ label: 'Flow', value: `${n(rate)} kg/h`, highlight: outer(rate) }, { label: 'Time', value: `${hmm(minutes)}`, highlight: inner(minutes) },
          { label: 'On board', value: `${n(fob)} kg`, highlight: null }],
        unit: 'kg', demo, slips: fuelSlips(rate, minutes),
        outcome: `${n(Math.round(left / 10) * 10)} kg left at ${b}.`,
        decision: {
          question: `Alternate ${alt} (${toAlt} NM) needs ${n(altFuel)} kg, plus the ${n(B727.finalReserveKg)} kg final reserve. Can you still go to ${b} with ${alt} as the alternate?`,
          answer: left >= B727.finalReserveKg + altFuel,
          why: `${n(Math.round(left / 10) * 10)} kg at ${b} against ${n(B727.finalReserveKg + altFuel)} kg needed.`,
        },
      });
    }
    case 'convert': {
      const kinds: ConversionKind[] = easy ? ['nm-sm', 'kg-lb'] : Object.keys(CONVERSIONS) as ConversionKind[];
      const kind = pick(rand, kinds);
      const spec = CONVERSIONS[kind];
      const value = easy ? pick(rand, [20, 50, 100, 200]) : between(rand, 12, 950, 1) * pick(rand, [1, 10]);
      const demo = conversionDemo([{ kind, value }], face);
      const why: Record<ConversionKind, string> = {
        'nm-sm': `The tour operator's brochure wants the ${n(value)} NM leg in statute miles.`,
        'sm-km': `An old road map gives ${n(value)} statute miles to the strip; the briefing wants kilometres.`,
        'kg-lb': `The load sheet shows ${n(value)} kg of freight; the cargo net is placarded in pounds.`,
        'usgal-fuel': `You uplift ${n(value)} US gal of avgas. What does it weigh?`,
        'usgal-imp': `The ferry tank holds ${n(value)} US gal; the old flight manual quotes imperial gallons.`,
        'm-ft': `A NOTAM gives a crane ${n(value)} m high near the circuit.`,
        'l-usgal': `The bowser at YBAS delivered ${n(value)} L; the flight manual is in US gallons.`,
      };
      return done({
        stem: `${why[kind]} Convert ${n(value)} ${spec.fromUnit} to ${spec.toUnit}.`,
        givens: [{ label: spec.fromUnit, value: n(value), highlight: inner(value) }],
        unit: spec.toUnit, demo,
        slips: [{ id: 'inverted', value: value / spec.factor, text: 'Converted the wrong way: you divided where the arrows multiply. Check which arrow is the "from" unit.' }],
      });
    }
    case 'tas': {
      const pa = easy ? pick(rand, [5000, 10000, 15000]) : between(rand, 2000, 24000, 500);
      const isa = Math.round(15 - 1.98 * pa / 1000);
      const liveTemp = live?.airports.find((item) => item.tempC != null);
      const oat = easy ? isa : isa + between(rand, -15, 20, 1);
      const cas = easy ? pick(rand, [100, 150, 200]) : between(rand, 90, 250, 5);
      const where = pick(rand, ['YSCB', 'YBAS', 'YPKG', 'YSWG']);
      const demo = tasDemo({ pa, oat, cas }, face);
      const today = liveTemp && !easy ? ` (It's ${liveTemp.tempC} °C on the ground at ${liveTemp.icao} today.)` : '';
      return done({
        stem: `Climbing out of ${where} in the King Air, level at pressure altitude ${n(pa)} ft, OAT ${sign(oat)} °C, CAS ${cas} kt. What is your TAS for the flight plan?${today}`,
        givens: [{ label: 'PA', value: `${n(pa)} ft`, highlight: { kind: 'scale', scale: 'pa-as', value: pa } },
          { label: 'OAT', value: `${sign(oat)} °C`, highlight: { kind: 'scale', scale: 'temp-as', value: oat } },
          { label: 'CAS', value: `${cas} kt`, highlight: inner(cas) }],
        unit: 'kt', demo, key: demo.results[0],
        slips: [{ id: 'unchanged', value: cas, text: 'That is the CAS you started with: read the TAS on the outer (black) scale above it.' }],
      });
    }
    case 'mach': {
      const oat = easy ? pick(rand, [-55, -45, -35, 15]) : between(rand, -60, -30, 1);
      const mach = easy ? pick(rand, [0.5, 0.8, 1]) : between(rand, 70, 84, 1) / 100;
      const demo = machDemo({ oat, mach }, face);
      return done({
        stem: easy ? `Mach ${mach.toFixed(2)} at an outside air temperature of ${sign(oat)} °C. What is the TAS?`
          : `Cruising in the B727 at M${mach.toFixed(2)}, OAT ${sign(oat)} °C. What TAS goes on the nav log?`,
        givens: [{ label: 'Mach', value: mach.toFixed(2), highlight: inner(mach * 10) }, { label: 'OAT', value: `${sign(oat)} °C`, highlight: { kind: 'scale', scale: 'temp-as', value: oat } }],
        unit: 'kt', demo, slips: [],
        outcome: easy ? undefined : `Isobar's B727 model plans M0.80 at FL330 as ${B727.tasM080Fl330} kt at ISA.`,
      });
    }
    case 'offcourse': {
      const off = easy ? pick(rand, [5, 6, 10]) : between(rand, 3, 14, 1);
      const flown = easy ? pick(rand, [60, 100, 120]) : between(rand, 40, 200, 5);
      const remaining = easy ? pick(rand, [60, 100, 120]) : between(rand, 50, 300, 5);
      const [a, b] = pick(rand, GA_ROUTES);
      const demo = offCourseDemo({ off, flown, remaining }, face);
      return done({
        stem: `${a}→${b}, map and stopwatch: a pinpoint shows you ${off} NM off track after ${flown} NM, ${remaining} NM to go. How many degrees do you turn to reach ${b}?`,
        givens: [{ label: 'Off track', value: `${off} NM`, highlight: outer(off) }, { label: 'Flown', value: `${flown} NM`, highlight: inner(flown) },
          { label: 'To go', value: `${remaining} NM`, highlight: inner(remaining) }],
        unit: '°', demo,
        slips: [{ id: 'partial', value: (60 * off) / flown, text: 'That is only the turn to parallel the track. Add the angle to converge on the destination.' }],
      });
    }
    case 'truealt': {
      const pa = easy ? 10000 : between(rand, 4000, 16000, 500);
      const isa = Math.round(15 - 1.98 * pa / 1000);
      const oat = easy ? isa - 15 : isa + between(rand, -25, 15, 1);
      const field = easy ? null : pick(rand, ['YSCB', 'YBAS', 'YPKG', 'YSWG', 'YSDU']);
      const station = field ? AERODROMES[field].elevation : 0;
      const indicated = easy ? pa : pa + between(rand, -1000, 1000, 100);
      const where = field ? `, altimeter set to ${field} QNH (elevation ${n(station)} ft)` : ', station at sea level';
      const demo = trueAltDemo({ pa, oat, indicated, station }, face);
      const height = indicated - station;
      return done({
        stem: `Cold day over the ranges: indicated ${n(indicated)} ft, pressure altitude ${n(pa)} ft, OAT ${sign(oat)} °C${where}. What is your true altitude above the terrain's datum?`,
        givens: [{ label: 'PA', value: `${n(pa)} ft`, highlight: { kind: 'scale', scale: 'pa-alt', value: pa } },
          { label: 'OAT', value: `${sign(oat)} °C`, highlight: { kind: 'scale', scale: 'temp-alt', value: oat } },
          { label: 'Above station', value: `${n(height)} ft`, highlight: inner(height) }],
        unit: 'ft', demo,
        slips: [
          ...(station ? [{ id: 'station', value: demo.results[0].exact - station, text: `That is height above ${field}: add the station elevation, ${n(station)} ft.` }] : []),
          { id: 'unchanged', value: indicated, text: 'That is the indicated altitude: the correction is the whole point on a cold day.' },
        ],
      });
    }
    case 'windhdg': {
      const ga = easy ? null : pick(rand, GA_ROUTES);
      const leg = ga ? route(ga[0], ga[1]) : null;
      const tc = leg ? Math.round(leg.track) : pick(rand, [0, 90, 180, 270]);
      const tas = easy ? pick(rand, [100, 120, 150]) : between(rand, 95, 160, 5);
      const today = ga ? live?.airports.find((item) => item.icao === ga[1] && item.windFrom != null && item.windKt != null && item.windKt >= 5 && item.windKt <= 50) : undefined;
      const windKt = today ? Math.round(today.windKt!) : easy ? pick(rand, [10, 20]) : between(rand, 8, 40, 1);
      const windFrom = today ? Math.round(today.windFrom! / 10) * 10 % 360 : easy ? (tc + pick(rand, [90, 270])) % 360 : between(rand, 0, 350, 10);
      const demo = windHeadingDemo({ windFrom, windKt, tc, tas });
      const exact = solveHeading(tc, tas, windFrom, windKt);
      const source = today ? ` (today's model wind at ${ga![1]})` : '';
      return done({
        stem: ga ? `${ga[0]}→${ga[1]} in the Cessna 182: track ${pad(tc)}T, TAS ${tas} kt, wind ${pad(windFrom)}/${windKt} kt${source}. What true heading do you fly?`
          : `True course ${pad(tc)}, TAS ${tas} kt, wind ${pad(windFrom)}/${windKt} kt. What true heading do you fly?`,
        givens: [{ label: 'Course', value: `${pad(tc)}T`, highlight: { kind: 'wind', id: 'index' } }, { label: 'TAS', value: `${tas} kt`, highlight: { kind: 'arc', value: tas } },
          { label: 'Wind', value: `${pad(windFrom)}/${windKt}`, highlight: { kind: 'wind', id: 'dot' } }],
        unit: '°T', demo, key: demo.results[1],
        slips: [{ id: 'side', value: wrap360(tc - exact.wca), text: 'Correction applied the wrong way: turn into the wind, toward the side the dot is on.' }],
        outcome: leg ? `Ground speed ${Math.round(exact.gs)} kt: ${hmm((leg.nm / exact.gs) * 60)} for the ${Math.round(leg.nm)} NM.` : `Ground speed ${Math.round(exact.gs)} kt.`,
      });
    }
    case 'windfind': {
      const tc = easy ? pick(rand, [0, 90, 180, 270]) : between(rand, 5, 355, 5);
      const wca = easy ? pick(rand, [-10, 10]) : between(rand, -18, 18, 1) || 6;
      const tas = easy ? pick(rand, [100, 120, 150]) : between(rand, 100, 240, 5);
      const gs = tas + (easy ? pick(rand, [-20, 20]) : between(rand, -40, 30, 1));
      const th = (tc + wca + 360) % 360;
      const demo = windFindDemo({ th, tc, tas, gs });
      return done({
        stem: `Holding heading ${pad(th)}T at TAS ${tas} kt, the GPS shows track ${pad(tc)}T and ground speed ${gs} kt. Which way is the wind blowing from?`,
        givens: [{ label: 'Heading', value: `${pad(th)}T`, highlight: { kind: 'wind', id: 'dot' } }, { label: 'Track', value: `${pad(tc)}T`, highlight: { kind: 'wind', id: 'index' } },
          { label: 'TAS', value: `${tas} kt`, highlight: { kind: 'arc', value: tas } }, { label: 'GS', value: `${gs} kt`, highlight: { kind: 'wind', id: 'grommet' } }],
        unit: '°T', demo, key: demo.results[0],
        slips: [{ id: 'reciprocal', value: wrap360(demo.results[0].exact + 180), text: 'That is where the wind is blowing to. Winds are named for where they come from.' }],
        outcome: `Wind speed ${Math.round(demo.results[1].exact)} kt.`,
      });
    }
  }
}

export function tsdSlips(gs: number, dist: number): Slip[] {
  return [
    { id: 'index', value: (dist / gs) * 10, text: 'Wrong index: you used the 10 at the top instead of the 60 RATE arrow, so the answer is six times too small.' },
    { id: 'inverted', value: (gs / dist) * 60, text: 'Inverted ratio: speed goes over the 60 RATE arrow, distance is found on the outer scale.' },
  ];
}

export function fuelSlips(rate: number, minutes: number): Slip[] {
  return [
    { id: 'index', value: (rate * minutes) / 10, text: 'Wrong index: the flow goes over the 60 RATE arrow (60 minutes), not the 10.' },
    { id: 'inverted', value: (minutes / rate) * 60, text: 'Inverted ratio: put the flow over the 60 RATE arrow and read fuel above the time.' },
  ];
}

/** Parse a typed answer: plain numbers with commas or spaces, or h:mm. */
export function parseAnswer(text: string, time: boolean): number | null {
  const clean = text.trim().replace(/[,\s]/g, '').replace(/[°a-z]+$/i, '');
  if (!clean) return null;
  const clock = /^(\d+):([0-5]\d)$/.exec(clean);
  if (clock) return time ? Number(clock[1]) * 60 + Number(clock[2]) : null;
  const value = Number(clean.replace(/^\+/, ''));
  return Number.isFinite(value) ? value : null;
}

export interface Verdict { ok: boolean; value: number | null; exact: number; tolerance: number; error: number | null }

export function check(problem: Problem, text: string): Verdict {
  const value = parseAnswer(text, problem.time);
  const { exact, tolerance } = problem.key;
  if (value == null) return { ok: false, value: null, exact, tolerance, error: null };
  const error = difference(problem.key, value);
  return { ok: Math.abs(error) <= tolerance, value, exact, tolerance, error };
}
