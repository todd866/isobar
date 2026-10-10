/**
 * Summit marks on the map. The fourteen 8,000 m peaks, the Seven Summits
 * (Messner and Bass), notable volcanoes, and the continental high points
 * Natural Earth draws as geography-region elevation points. Elevations are
 * published survey metres; prominence decides which names survive a zoom.
 * A tap near a drawn mark snaps to that summit.
 */
import type { Camera, Lambert } from './lambert';
import { mapProject } from './lambert';
import type { DrawnLabel, LabelBox } from './overlay';
import { FT_PER_M } from './sky/physics';
import { AUS_UNITS, type DisplayUnits } from './units';

export interface Summit {
  name: string;
  lat: number;
  lon: number;
  elevationM: number;
  prominenceM: number;
  source: string;
}

export interface PlacedSummit {
  peak: Summit;
  x: number;
  y: number;
  label: LabelBox;
}

/** [name, lat, lon, elevation m, prominence m, source]. Prominence ranks the label. */
const ROWS: [string, number, number, number, number, string][] = [
  ['Everest', 27.9881, 86.9250, 8849, 8849, 'China–Nepal 2020, 8848.86 m'],
  ['K2', 35.8825, 76.5133, 8611, 4020, 'Survey of Pakistan'],
  ['Kangchenjunga', 27.7025, 88.1475, 8586, 3922, 'Survey of India'],
  ['Lhotse', 27.9617, 86.9333, 8516, 610, 'Survey of Nepal'],
  ['Makalu', 27.8897, 87.0889, 8485, 2378, 'Survey of Nepal'],
  ['Cho Oyu', 28.0960, 86.6608, 8188, 2340, 'Survey of Nepal'],
  ['Dhaulagiri', 28.6967, 83.4875, 8167, 3357, 'Survey of India'],
  ['Manaslu', 28.5494, 84.5614, 8163, 3092, 'Survey of Nepal'],
  ['Nanga Parbat', 35.2375, 74.5892, 8126, 4608, 'Survey of Pakistan'],
  ['Annapurna', 28.5956, 83.8203, 8091, 2984, 'Survey of India'],
  ['Gasherbrum I', 35.7244, 76.6964, 8080, 2155, 'Survey of Pakistan'],
  ['Broad Peak', 35.8108, 76.5683, 8051, 1701, 'Survey of Pakistan'],
  ['Gasherbrum II', 35.7583, 76.6533, 8035, 1524, 'Survey of Pakistan'],
  ['Shishapangma', 28.3522, 85.7792, 8027, 2897, 'Chinese survey'],
  ['Aconcagua', -32.6532, -70.0109, 6961, 6961, 'Instituto Geográfico Nacional'],
  ['Ojos del Salado', -27.1092, -68.5419, 6893, 3688, 'Instituto Geográfico Nacional'],
  ['Chimborazo', -1.4692, -78.8175, 6263, 4122, 'Instituto Geográfico Militar'],
  ['Denali', 63.0695, -151.0074, 6190, 6144, 'USGS'],
  ['Logan', 60.5671, -140.4053, 5959, 5250, 'Natural Resources Canada'],
  ['Kilimanjaro', -3.0674, 37.3556, 5895, 5885, 'Survey of Tanzania'],
  ['Cotopaxi', -0.6806, -78.4378, 5897, 2404, 'Instituto Geográfico Militar'],
  ['Elbrus', 43.3550, 42.4392, 5642, 4741, 'Soviet survey'],
  ['Damavand', 35.9558, 52.1094, 5609, 4667, 'National Cartographic Center'],
  ['Popocatépetl', 19.0225, -98.6278, 5426, 3020, 'INEGI'],
  ['Kenya', -0.1521, 37.3084, 5199, 3825, 'Survey of Kenya'],
  ['Ararat', 39.7019, 44.2983, 5137, 3611, 'Turkish survey'],
  ['Vinson', -78.5254, -85.6171, 4892, 4892, 'USGS Antarctic survey'],
  ['Puncak Jaya', -4.0789, 137.1583, 4884, 4884, 'Bakosurtanal'],
  ['Mont Blanc', 45.8326, 6.8652, 4808, 4695, 'IGN survey'],
  ['Wilhelm', -5.7796, 145.0297, 4509, 2969, 'Royal Australian Survey'],
  ['Matterhorn', 45.9764, 7.6586, 4478, 1042, 'Swiss Federal Office of Topography'],
  ['Ras Dashen', 13.2361, 38.3714, 4550, 3997, 'Ethiopian Mapping Agency'],
  ['Rainier', 46.8523, -121.7603, 4392, 4023, 'USGS'],
  ['Mauna Kea', 19.8207, -155.4681, 4207, 4207, 'USGS'],
  ['Toubkal', 31.0594, -7.9153, 4167, 3755, 'Agence Nationale de la Conservation Foncière'],
  ['Fuji', 35.3606, 138.7274, 3776, 3776, 'Geospatial Information Authority of Japan'],
  ['Erebus', -77.5300, 167.1550, 3794, 3794, 'USGS Antarctic survey'],
  ['Aoraki', -43.5950, 170.1410, 3724, 3724, 'LINZ'],
  ['Teide', 28.2724, -16.6425, 3715, 3715, 'Instituto Geográfico Nacional'],
  ['Gunnbjørn', 68.9194, -29.8986, 3694, 3694, 'Agency for Data Supply and Efficiency'],
  ['Kosciuszko', -36.4559, 148.2635, 2228, 2228, 'Geoscience Australia'],
  ['Etna', 37.7510, 14.9934, 3357, 3357, 'Istituto Geografico Militare'],
  ['Mulhacén', 37.0536, -3.3103, 3479, 3285, 'Instituto Geográfico Nacional'],
  ['Aneto', 42.6314, 0.6583, 3404, 2812, 'Instituto Geográfico Nacional'],
  ['Olympus', 40.0856, 22.3586, 2918, 2355, 'Hellenic Military Geographical Service'],
  ['Ruapehu', -39.2810, 175.5640, 2797, 2797, 'LINZ'],
  ['Galdhøpiggen', 61.6365, 8.3075, 2469, 2372, 'Kartverket'],
  ['St Helens', 46.1914, -122.1956, 2549, 1404, 'USGS'],
  ['Ben Nevis', 56.7969, -5.0036, 1345, 1345, 'Ordnance Survey'],
];

export const SUMMITS: Summit[] = ROWS.map(([name, lat, lon, elevationM, prominenceM, source]) => ({
  name, lat, lon, elevationM, prominenceM, source,
}));

/** Prominence required before a name is even a candidate. Closer views lower the floor. */
export function prominenceFloorM(spanDeg: number): number {
  if (!(spanDeg > 0)) return Infinity;
  if (spanDeg >= 120) return 4000;
  if (spanDeg >= 40) return 2500;
  if (spanDeg >= 12) return 1500;
  if (spanDeg >= 4) return 700;
  return 0;
}

/** Most prominent first. The draw pass still drops anything that would overlap. */
export function selectPeaks(peaks: readonly Summit[], spanDeg: number): Summit[] {
  const floor = prominenceFloorM(spanDeg);
  return peaks.filter((peak) => peak.prominenceM >= floor)
    .slice()
    .sort((a, b) => b.prominenceM - a.prominenceM || b.elevationM - a.elevationM || a.name.localeCompare(b.name));
}

/** `Everest 8,849 m` or `Everest 29,032 ft`, in the active height unit. */
export function peakText(peak: Summit, units: DisplayUnits = AUS_UNITS): string {
  const height = units.height === 'm'
    ? `${Math.round(peak.elevationM).toLocaleString('en-AU')} m`
    : `${Math.round(peak.elevationM * FT_PER_M).toLocaleString('en-AU')} ft`;
  return `${peak.name} ${height}`;
}

function viewSpan(geo: Lambert, camera: Camera): number {
  return geo.projection === 'equirectangular'
    ? (camera.halfWidth * 2) / geo.F
    : (camera.halfWidth * 2 * 180) / Math.PI;
}

function toScreen(geo: Lambert, camera: Camera, width: number, height: number, lat: number, lon: number): { x: number; y: number } | null {
  const p = mapProject(geo, camera, lat, lon);
  if (!p) return null;
  return { x: (1 + p.x) * width / 2, y: (1 - p.y) * height / 2 };
}

const MAX_PEAKS = 24;

/**
 * ▲ and the name, prominence order, clear of `avoid` (isobar labels first).
 * Returns the marks actually drawn so a tap can snap to one.
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: readonly Summit[],
  geo: Lambert,
  camera: Camera,
  width: number,
  height: number,
  avoid: LabelBox[],
  ink: { ink: string; halo: string },
  units: DisplayUnits = AUS_UNITS,
  maxLabels = MAX_PEAKS,
): { names: string[]; labels: DrawnLabel[]; placed: PlacedSummit[] } {
  const span = viewSpan(geo, camera);
  if (!(span > 0) || !Number.isFinite(span)) return { names: [], labels: [], placed: [] };
  const taken = avoid.slice();
  const names: string[] = [];
  const labels: DrawnLabel[] = [];
  const placed: PlacedSummit[] = [];
  const intersects = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const peak of selectPeaks(peaks, span)) {
    if (names.length >= maxLabels) break;
    const point = toScreen(geo, camera, width, height, peak.lat, peak.lon);
    if (!point || point.x < 4 || point.y < 4 || point.x > width - 4 || point.y > height - 4) continue;
    const big = peak.prominenceM >= 4000;
    ctx.font = big ? '600 12px ui-sans-serif, system-ui, sans-serif' : '400 11px ui-sans-serif, system-ui, sans-serif';
    const text = peakText(peak, units);
    const w = ctx.measureText(text).width;
    const h = big ? 14 : 13;
    const r = big ? 2.2 : 1.7;
    let label: LabelBox | null = null;
    for (let side = 0; side < 4 && !label; side += 1) {
      const lx = side === 1 ? point.x - r - 3 - w : side === 0 ? point.x + r + 3 : point.x - w / 2;
      const ly = side === 2 ? point.y - r - 2 - h : side === 3 ? point.y + r + 2 : point.y - h / 2;
      if (ly < 2 || ly + h > height - 2 || lx < 2 || lx + w > width - 2) continue;
      const box = { x: lx - 4, y: ly - 2, w: w + 8, h: h + 4 };
      if (taken.some((other) => intersects(box, other))) continue;
      label = { x: lx, y: ly, w, h };
      taken.push(box, { x: point.x - r - 2, y: point.y - r - 4, w: (r + 2) * 2, h: (r + 4) * 2 });
    }
    if (!label) continue;
    ctx.fillStyle = ink.halo;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y - r - 4);
    ctx.lineTo(point.x - r - 2.4, point.y + r);
    ctx.lineTo(point.x + r + 2.4, point.y + r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ink.ink;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y - r - 2.6);
    ctx.lineTo(point.x - r - 1.2, point.y + r * 0.7);
    ctx.lineTo(point.x + r + 1.2, point.y + r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ink.halo;
    ctx.lineWidth = 3.5;
    ctx.strokeText(text, label.x, label.y + label.h / 2);
    ctx.fillStyle = ink.ink;
    ctx.fillText(text, label.x, label.y + label.h / 2);
    names.push(text);
    labels.push({ text, x: label.x - 2, y: label.y - 1, w: label.w + 4, h: label.h + 2 });
    placed.push({ peak, x: point.x, y: point.y, label });
  }
  ctx.restore();
  return { names, labels, placed };
}

/** The drawn summit under the tap, or the one whose name was tapped. */
export function snapToSummit(tapX: number, tapY: number, placed: readonly PlacedSummit[], slopPx = 18): Summit | null {
  let best: { peak: Summit; score: number } | null = null;
  for (const item of placed) {
    const onLabel = tapX >= item.label.x && tapX <= item.label.x + item.label.w
      && tapY >= item.label.y && tapY <= item.label.y + item.label.h;
    const distance = Math.hypot(tapX - item.x, tapY - item.y);
    if (!onLabel && distance > slopPx) continue;
    const score = onLabel ? 0 : distance;
    if (!best || score < best.score) best = { peak: item.peak, score };
  }
  return best?.peak ?? null;
}
