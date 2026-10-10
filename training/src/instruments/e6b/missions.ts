/** Chained missions: a short flight where each answer feeds the next, building
 * a nav log, and the last link is a decision with stakes. The learner's own
 * answer carries forward when it is within the reading precision; a wrong one
 * is replaced by the exact value (and the log says so), so one slip does not
 * poison the rest of the flight. Pure. */
import { fuelDemo, machDemo, tasDemo, tsdDemo, windHeadingDemo } from './demos.ts';
import { E6B, type Face } from './face.ts';
import { fuelSlips, pad, tsdSlips, type LiveContext, type Problem, type Verdict } from './practice.ts';
import { B727, route } from './routes.ts';
import { hmm } from './slide.ts';
import { solveHeading } from './wind.ts';

export interface MissionLink {
  /** Nav-log column. */
  log: string;
  build: (carried: number[], face: Face, live?: LiveContext) => Problem;
}

export interface Mission {
  id: string;
  title: string;
  brief: string;
  links: MissionLink[];
  /** The closing decision, from the carried answers. */
  decision: (carried: number[]) => { question: string; answer: boolean; why: string };
}

const n = (v: number) => Math.round(v).toLocaleString('en-AU');
const outer = (value: number) => ({ kind: 'scale' as const, scale: 'outer', value });
const inner = (value: number) => ({ kind: 'scale' as const, scale: 'middle', value });

function liveWind(live: LiveContext | undefined, icao: string, fallback: [number, number]): { from: number; kt: number; today: boolean } {
  const item = live?.airports.find((a) => a.icao === icao && a.windFrom != null && a.windKt != null && a.windKt >= 5 && a.windKt <= 40);
  return item ? { from: Math.round(item.windFrom! / 10) * 10 % 360, kt: Math.round(item.windKt!), today: true } : { from: fallback[0], kt: fallback[1], today: false };
}

const GA_LEG = route('YSBK', 'YSCB');
const GA_FLOW = 55; // L/h, Cessna 182 at 65 % power
const GA_FOB = 190; // L usable at start-up
const GA_RESERVE = 45 * GA_FLOW / 60; // 45 min fixed reserve

const JET_LEG = route('YPPH', 'YSSY');
const JET_FLOW = 4300; // kg/h, B727 M0.80 FL330 at about 66 t (Isobar model, Table 3.1)
const JET_FOB = 18_900; // kg at top of climb
const JET_WIND = { from: 260, kt: 65 }; // illustrative upper wind, degrees true
const JET_ALT_KG = 2_000; // YSCB alternate fuel

export const MISSIONS: Mission[] = [
  {
    id: 'ga-canberra',
    title: 'Bankstown to Canberra, Cessna 182',
    brief: `YSBK→YSCB, ${Math.round(GA_LEG.nm)} NM on ${pad(Math.round(GA_LEG.track))}T. ${GA_FOB} L usable on board. Work the nav log leg by leg.`,
    links: [
      {
        log: 'TAS',
        build: (_c, face) => {
          const p = { pa: 7500, oat: 2, cas: 125 };
          const demo = tasDemo(p, face);
          return mission('tas', `Level at pressure altitude 7,500 ft, OAT +2 °C, CAS 125 kt. What TAS goes on the log?`, demo, demo.results[0], 'kt', [
            { label: 'PA', value: '7,500 ft', highlight: { kind: 'scale', scale: 'pa-as', value: p.pa } },
            { label: 'OAT', value: '+2 °C', highlight: { kind: 'scale', scale: 'temp-as', value: p.oat } },
            { label: 'CAS', value: '125 kt', highlight: inner(p.cas) }]);
        },
      },
      {
        log: 'GS',
        build: ([tas], _face, live) => {
          const tc = Math.round(GA_LEG.track);
          const wind = liveWind(live, 'YSCB', [270, 25]);
          const t = Math.round(tas);
          const demo = windHeadingDemo({ windFrom: wind.from, windKt: wind.kt, tc, tas: t });
          const exact = solveHeading(tc, t, wind.from, wind.kt);
          const p = mission('windhdg', `Track ${pad(tc)}T at your TAS of ${t} kt, wind ${pad(wind.from)}/${wind.kt} kt${wind.today ? " (today's model wind at YSCB)" : ''}. What ground speed will you make good?`,
            demo, demo.results[0], 'kt', [
              { label: 'Course', value: `${pad(tc)}T`, highlight: { kind: 'wind', id: 'index' } },
              { label: 'TAS', value: `${t} kt`, highlight: { kind: 'arc', value: t } },
              { label: 'Wind', value: `${pad(wind.from)}/${wind.kt}`, highlight: { kind: 'wind', id: 'dot' } }]);
          p.outcome = `Heading ${pad(exact.th)}T.`;
          return p;
        },
      },
      {
        log: 'Time',
        build: ([, gs], face) => {
          const g = Math.round(gs);
          const dist = Math.round(GA_LEG.nm);
          const demo = tsdDemo({ gs: g, dist }, face);
          const p = mission('tsd', `${dist} NM at your ground speed of ${g} kt. How long to Canberra?`, demo, demo.results[0], 'min or h:mm', [
            { label: 'GS', value: `${g} kt`, highlight: outer(g) }, { label: 'Distance', value: `${dist} NM`, highlight: outer(dist) }]);
          p.time = true;
          p.slips = tsdSlips(g, dist);
          return p;
        },
      },
      {
        log: 'Fuel',
        build: ([, , minutes], face) => {
          const m = Math.round(minutes);
          const demo = fuelDemo({ rate: GA_FLOW, minutes: m, unit: 'L' }, face);
          const p = mission('fuel', `${hmm(m)} at ${GA_FLOW} L/h. How much fuel will the leg burn?`, demo, demo.results[0], 'L', [
            { label: 'Flow', value: `${GA_FLOW} L/h`, highlight: outer(GA_FLOW) }, { label: 'Time', value: hmm(m), highlight: inner(m) }]);
          p.slips = fuelSlips(GA_FLOW, m);
          return p;
        },
      },
    ],
    decision: ([, , , burn]) => {
      const left = GA_FOB - 5 - burn;
      return {
        question: `After 5 L taxi and your ${n(burn)} L burn, do you land at Canberra with at least the 45-minute fixed reserve (${n(GA_RESERVE)} L) plus 15 % of the trip?`,
        answer: left >= GA_RESERVE + 0.15 * burn,
        why: `${n(left)} L on landing against ${n(GA_RESERVE + 0.15 * burn)} L required.`,
      };
    },
  },
  {
    id: 'jet-sydney',
    title: 'Perth to Sydney, B727',
    brief: `YPPH→YSSY, ${n(JET_LEG.nm)} NM at M0.80, FL330. ${n(JET_FOB)} kg at top of climb; alternate Canberra.`,
    links: [
      {
        log: 'TAS',
        build: (_c, face) => {
          const p = { oat: -46, mach: 0.8 };
          const demo = machDemo(p, face);
          return mission('mach', `Top of climb, FL330: M0.80 with OAT −46 °C. What TAS goes on the log?`, demo, demo.results[0], 'kt', [
            { label: 'Mach', value: '0.80', highlight: inner(8) }, { label: 'OAT', value: '−46 °C', highlight: { kind: 'scale', scale: 'temp-as', value: p.oat } }]);
        },
      },
      {
        log: 'GS',
        build: ([tas]) => {
          const tc=Math.round(JET_LEG.track), t=Math.round(tas);
          const demo=windHeadingDemo({tc,tas:t,windFrom:JET_WIND.from,windKt:JET_WIND.kt});
          return mission('windhdg', `Turn to the high-speed wind slide. True course ${pad(tc)}T, your TAS ${t} kt, wind ${JET_WIND.from}T/${JET_WIND.kt} kt. Find ground speed for the log.`, demo, demo.results[0], 'kt', [
            {label:'TC',value:`${pad(tc)}T`,highlight:{kind:'wind',id:'index'}},
            {label:'TAS',value:`${t} kt`,highlight:{kind:'arc',value:t}},
            {label:'Wind',value:`${JET_WIND.from}/${JET_WIND.kt}`,highlight:{kind:'wind',id:'dot'}}]);
        },
      },
      {
        log: 'Time',
        build: ([, carriedGs], face) => {
          const gs = Math.round(carriedGs);
          const dist = Math.round(JET_LEG.nm / 5) * 5;
          const demo = tsdDemo({ gs, dist }, face);
          const p = mission('tsd', `Your wind-side ground speed is ${gs} kt. ${n(dist)} NM to run: how long to Sydney?`,
            demo, demo.results[0], 'min or h:mm', [{ label: 'GS', value: `${gs} kt`, highlight: outer(gs) }, { label: 'Distance', value: `${n(dist)} NM`, highlight: outer(dist) }]);
          p.time = true;
          p.slips = tsdSlips(gs, dist);
          return p;
        },
      },
      {
        log: 'Fuel',
        build: ([, , minutes], face) => {
          const m = Math.round(minutes);
          const demo = fuelDemo({ rate: JET_FLOW, minutes: m, unit: 'kg' }, face);
          const p = mission('fuel', `${hmm(m)} at ${n(JET_FLOW)} kg/h. How much fuel to Sydney?`, demo, demo.results[0], 'kg', [
            { label: 'Flow', value: `${n(JET_FLOW)} kg/h`, highlight: outer(JET_FLOW) }, { label: 'Time', value: hmm(m), highlight: inner(m) }]);
          p.slips = fuelSlips(JET_FLOW, m);
          return p;
        },
      },
    ],
    decision: (carried) => {
      const burn=carried[carried.length-1];
      const left = JET_FOB - burn;
      const need = JET_ALT_KG + B727.finalReserveKg;
      return {
        question: `${n(JET_FOB)} kg less your ${n(burn)} kg burn. Canberra needs ${n(JET_ALT_KG)} kg plus the ${n(B727.finalReserveKg)} kg final reserve. Continue to Sydney with Canberra as the alternate?`,
        answer: left >= need,
        why: `${n(left)} kg over Sydney against ${n(need)} kg needed.`,
      };
    },
  },
];

function mission(shape: Problem['shape'], stem: string, demo: Problem['demo'], key: Problem['key'], unit: string, givens: Problem['givens']): Problem {
  return { shape, easy: false, stem, givens, unit, demo, key, time: false, slips: [] };
}

/** The value a link passes on: the learner's reading when it was right, else the exact answer. */
export function carry(problem: Problem, verdict: Verdict): { value: number; own: boolean } {
  return verdict.ok && verdict.value != null ? { value: verdict.value, own: true } : { value: problem.key.exact, own: false };
}

/** Build link `index` from the values carried so far. */
export function missionProblem(mission: Mission, index: number, carried: number[], face: Face = E6B, live?: LiveContext): Problem {
  if (carried.length < index) throw new Error(`link ${index} needs ${index} carried values`);
  return mission.links[index].build(carried, face, live);
}
