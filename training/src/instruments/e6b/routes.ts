/** Australian aerodromes and routes for the E6-B situations. Positions are the
 * published aerodrome reference points (AIP ERSA), rounded to 0.001°; elevations
 * in feet. Distances are great circles and tracks initial true tracks, so the
 * numbers a learner meets are the real ones for the route. */

export interface Aerodrome { icao: string; name: string; lat: number; lon: number; elevation: number }

export const AERODROMES: Record<string, Aerodrome> = {
  YPPH: { icao: 'YPPH', name: 'Perth', lat: -31.940, lon: 115.967, elevation: 67 },
  YSSY: { icao: 'YSSY', name: 'Sydney', lat: -33.946, lon: 151.177, elevation: 21 },
  YMML: { icao: 'YMML', name: 'Melbourne', lat: -37.673, lon: 144.843, elevation: 434 },
  YBBN: { icao: 'YBBN', name: 'Brisbane', lat: -27.384, lon: 153.118, elevation: 13 },
  YPAD: { icao: 'YPAD', name: 'Adelaide', lat: -34.945, lon: 138.531, elevation: 20 },
  YSCB: { icao: 'YSCB', name: 'Canberra', lat: -35.307, lon: 149.195, elevation: 1886 },
  YBCS: { icao: 'YBCS', name: 'Cairns', lat: -16.886, lon: 145.755, elevation: 10 },
  YPDN: { icao: 'YPDN', name: 'Darwin', lat: -12.415, lon: 130.877, elevation: 103 },
  YBAS: { icao: 'YBAS', name: 'Alice Springs', lat: -23.807, lon: 133.902, elevation: 1789 },
  YMHB: { icao: 'YMHB', name: 'Hobart', lat: -42.836, lon: 147.510, elevation: 13 },
  YPKG: { icao: 'YPKG', name: 'Kalgoorlie', lat: -30.789, lon: 121.462, elevation: 1203 },
  YSWG: { icao: 'YSWG', name: 'Wagga Wagga', lat: -35.165, lon: 147.466, elevation: 724 },
  YSDU: { icao: 'YSDU', name: 'Dubbo', lat: -32.217, lon: 148.575, elevation: 935 },
  YCFS: { icao: 'YCFS', name: 'Coffs Harbour', lat: -30.321, lon: 153.116, elevation: 18 },
  YSBK: { icao: 'YSBK', name: 'Bankstown', lat: -33.924, lon: 150.988, elevation: 29 },
  YMMB: { icao: 'YMMB', name: 'Moorabbin', lat: -37.976, lon: 145.102, elevation: 50 },
  YPJT: { icao: 'YPJT', name: 'Jandakot', lat: -32.098, lon: 115.881, elevation: 99 },
  YBAF: { icao: 'YBAF', name: 'Archerfield', lat: -27.570, lon: 153.008, elevation: 63 },
  YMAY: { icao: 'YMAY', name: 'Albury', lat: -36.068, lon: 146.958, elevation: 539 },
  YBTL: { icao: 'YBTL', name: 'Townsville', lat: -19.253, lon: 146.765, elevation: 18 },
};

const EARTH_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;

export interface Route { from: Aerodrome; to: Aerodrome; nm: number; track: number }

export function route(from: string, to: string): Route {
  const a = AERODROMES[from];
  const b = AERODROMES[to];
  if (!a || !b) throw new Error(`unknown aerodrome ${from} or ${to}`);
  const [p1, p2, dl] = [rad(a.lat), rad(b.lat), rad(b.lon - a.lon)];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const nm = 2 * EARTH_NM * Math.asin(Math.sqrt(h));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const track = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { from: a, to: b, nm, track };
}

/** Jet routes (B727) and light-aircraft legs, with a nearby alternate for the destination. */
export const JET_ROUTES: [string, string, string][] = [
  ['YPPH', 'YSSY', 'YSCB'], ['YSSY', 'YPPH', 'YPKG'], ['YMML', 'YBBN', 'YBAF'], ['YBBN', 'YMML', 'YMAY'],
  ['YPAD', 'YBBN', 'YCFS'], ['YSSY', 'YPDN', 'YBAS'], ['YMML', 'YPPH', 'YPKG'], ['YBCS', 'YSSY', 'YSCB'],
  ['YPPH', 'YPDN', 'YBAS'], ['YSSY', 'YMHB', 'YMML'],
];

export const GA_ROUTES: [string, string][] = [
  ['YSBK', 'YSCB'], ['YSBK', 'YSDU'], ['YSCB', 'YSWG'], ['YMMB', 'YMAY'], ['YPJT', 'YPKG'],
  ['YBAF', 'YCFS'], ['YSSY', 'YSCB'], ['YSWG', 'YSDU'], ['YMAY', 'YSCB'], ['YBTL', 'YBCS'],
];

/** "0215Z" from minutes after 0000Z. */
export function zulu(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}Z`;
}

/** Isobar's B727-200 model (b727 branch, training/src/b727/data): M0.80 cruise at
 * FL330 is TAS 465 kt ISA with three-engine fuel flow 3,570–5,310 kg/h from 50 to
 * 80 t (Table 3.1); holding at 1,500 ft is about 2,600 kg/h (Table 4.2); final
 * reserve 30 min holding, 1,600 kg for planning (fuel policy). */
export const B727 = { tasM080Fl330: 465, flowKgH: [3600, 5300] as const, holdKgH: 2600, finalReserveKg: 1600 };
