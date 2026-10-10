import { coverageFraction, coverageSegments, precipitationBands } from '../../../../training/src/sky/cloud-rules.ts';
/**
 * The point column as a sounding: height increases upward, surface at the
 * bottom, sea under that only when a marine field is actually present.
 */
import type { SkyLayer } from '../sky/physics';
import { dewpoint, FT_PER_M } from '../sky/physics';
import type { MarineSample } from './marine';
import { formatGround } from './ground';
import { modelGroundLabel, sectionX, type SectionSample } from './terrain-section';
import { AUS_UNITS, formatTempC, metricFlightLevel, type DisplayUnits } from '../units';
import { flightLevel, isInversion, isaTemperature, levelExact, levelLabel, levelTitle } from './section';
import { directionGroup, pilotWind } from './wind';
import type { SectionRouteProjection } from './section-route';

export const SOUNDING_TOP_FT = 42000;
export const LABEL_W = 68;
export const WIND_W = 62;

export type SoundingEmphasis = 'wind' | 'temp' | 'cloud';

export interface AirRow {
  id: string;
  label: string;
  title: string;
  feet: number | null;
  speed: number | null;
  from: number | null;
  temp: number | null;
  /** Dew point, °C. Missing stays missing; it is not copied from the temperature. */
  dew: number | null;
  wind: string | null;
  inversion: boolean;
}

export interface SeaRow {
  id: 'current' | 'sst' | 'wave' | 'swell';
  text: string;
  title: string;
  /** Bearing the arrow points, degrees clockwise from north. */
  arrowDeg: number | null;
}

interface LevelIn {
  hPa: number;
  zM: number;
  tC: number | null;
  rh: number | null;
  windKt: number | null;
  windFrom: number | null;
}

interface SurfaceIn {
  temperature2mC: number | null;
  dewPoint2mC: number | null;
  windSpeed10mKt: number | null;
  windDirection10m: number | null;
}

function signed(value: number): string {
  const n = Math.round(value);
  return n > 0 ? `+${n}` : String(n);
}

function metres(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${(Math.round(value * 10) / 10).toFixed(1)} m`;
}

/** Phone sheet height. The exposed map is at least 40% of the viewport. */
/**
 * Phone sheet height: the space between the time slider (ceiling) and the lens
 * bar, less a strip of map that keeps the tapped point in view. The old rule
 * subtracted 40% of the viewport from the map panel itself, which on a phone
 * left the sounding a few pixels tall.
 */
export const POINT_MAP_STRIP_PX = 120;
export const POINT_SHEET_MIN_PX = 160;
export function pointSheetHeight(panelTop: number, panelBottom: number, ceiling: number, viewportHeight: number): number {
  void viewportHeight;
  const top = Math.max(ceiling, panelTop);
  const room = Math.max(0, panelBottom - top);
  const height = room - POINT_MAP_STRIP_PX;
  return Math.max(0, Math.floor(Math.min(room, Math.max(POINT_SHEET_MIN_PX, height))));
}

/** 0 at the axis floor, 1 at the top of the sounding. */
export function heightFraction(ft: number, bottomFt: number, topFt = SOUNDING_TOP_FT): number {
  const lo = Math.max(0, bottomFt);
  const hi = Math.max(lo + 1, topFt);
  const span = Math.log1p(hi / 5000) - Math.log1p(lo / 5000);
  const f = (Math.log1p(Math.max(lo, ft) / 5000) - Math.log1p(lo / 5000)) / span;
  return Math.min(1, Math.max(0, f));
}

/** Pixel y in the air plot: high levels toward the top, surface on the bottom pad. */
export function plotY(fraction: number, height: number): number {
  const top = 10;
  const bottom = Math.max(top + 1, height - 12);
  return bottom - fraction * (bottom - top);
}

function flightLevelFromFeet(feet: number): number {
  return Math.round(Math.round(feet / 100) / 10) * 10;
}

function dewC(tC: number | null, rh: number | null): number | null {
  if (tC == null || rh == null || !Number.isFinite(tC) || !Number.isFinite(rh)) return null;
  const dew = dewpoint(tC, rh);
  return Number.isFinite(dew) ? dew : null;
}

/**
 * Axis name for the real ground. A known elevation always carries both
 * heights (`SFC 8,849 m / 29,032 ft`). Unknown ground stays `SFC`.
 */
export function surfaceLabel(elevationM: number | null, units: DisplayUnits = AUS_UNITS): string {
  if (elevationM == null || !Number.isFinite(elevationM) || !units) return 'SFC';
  return `SFC ${formatGround(elevationM)}`;
}

function surfaceTitle(elevationM: number | null, units: DisplayUnits): string {
  if (elevationM == null || !Number.isFinite(elevationM)) return 'Surface';
  const exact = levelExact(elevationM, units);
  const feet = elevationM * FT_PER_M;
  if (feet < units.transitionFt) return `Surface · ${exact}`;
  if (units.flightLevel === 'metric') {
    const fl = metricFlightLevel(elevationM);
    return fl ? `Surface · ${fl.code} · ${exact}` : `Surface · ${exact}`;
  }
  return `Surface · FL${String(flightLevelFromFeet(feet)).padStart(3, '0')} · ${exact}`;
}

/**
 * Sea level is the floor when the ground is known, unless the ground or a
 * shown level is below it. Unknown ground starts at the lowest shown level,
 * not at a sea-level surface that was never measured.
 */
export function soundingFrame(rows: AirRow[], elevationM: number | null): { bottomFt: number; groundFt: number | null } {
  const heights = rows.flatMap((row) => row.feet != null && Number.isFinite(row.feet) ? [row.feet] : []);
  const lowest = heights.length ? Math.min(...heights) : 0;
  if (elevationM == null || !Number.isFinite(elevationM)) return { bottomFt: lowest, groundFt: null };
  const groundFt = elevationM * FT_PER_M;
  return { bottomFt: Math.min(0, groundFt, ...heights), groundFt };
}

/**
 * Highest level first, surface last. Levels below the terrain or above FL400
 * are omitted. Inversions compare adjacent measured levels only.
 */
export function airRows(levels: LevelIn[], surface: SurfaceIn | null, elevationM: number | null, units: DisplayUnits = AUS_UNITS, modelGroundM: number | null = null): AirRow[] {
  const floorM = modelGroundM != null && Number.isFinite(modelGroundM) ? modelGroundM : elevationM;
  const kept = levels.filter((level) => (floorM == null || level.zM >= floorM - 1) && flightLevel(level.hPa) <= 400);
  const ascending = [...kept].sort((a, b) => a.zM - b.zM);
  const rows: AirRow[] = [...kept].sort((a, b) => b.zM - a.zM).map((level) => {
    const index = ascending.findIndex((item) => item.hPa === level.hPa && item.zM === level.zM);
    return {
      id: String(level.hPa),
      label: levelLabel(level.hPa, level.zM, units),
      title: levelTitle(level.hPa, level.zM, units),
      feet: level.zM * FT_PER_M,
      speed: level.windKt,
      from: level.windFrom,
      temp: level.tC,
      dew: dewC(level.tC, level.rh),
      wind: pilotWind(level.windFrom, level.windKt),
      inversion: isInversion(ascending, index),
    };
  });
  const feet = elevationM == null ? null : elevationM * FT_PER_M;
  rows.push({
    id: 'surface',
    label: surfaceLabel(elevationM, units),
    title: surfaceTitle(elevationM, units),
    feet,
    speed: surface?.windSpeed10mKt ?? null,
    from: surface?.windDirection10m ?? null,
    temp: surface?.temperature2mC ?? null,
    dew: surface?.dewPoint2mC != null && Number.isFinite(surface.dewPoint2mC) ? surface.dewPoint2mC : null,
    wind: pilotWind(surface?.windDirection10m ?? null, surface?.windSpeed10mKt ?? null),
    inversion: false,
  });
  return rows;
}

/** One line for the level under the pointer: `FL180 · -19°C (ISA-2) · 280/46`. */
export function soundingReadout(row: AirRow, units: DisplayUnits = AUS_UNITS): string {
  const parts = [row.label];
  if (row.temp != null && Number.isFinite(row.temp)) {
    const temp = formatTempC(row.temp, units, { signed: true, unit: true }) ?? '';
    if (row.feet != null) {
      const deltaC = row.temp - isaTemperature(row.feet / FT_PER_M);
      const delta = units.temp === 'F' ? deltaC * 9 / 5 : deltaC;
      parts.push(`${temp} (ISA${signed(delta)})`);
    } else parts.push(temp);
  }
  if (row.wind) parts.push(row.wind);
  return parts.join(' · ');
}

function currentText(sample: MarineSample): { text: string; arrowDeg: number | null } | null {
  const kt = sample.currentSpeedKt;
  if (kt == null || !Number.isFinite(kt)) return null;
  if (kt < 0.05) return { text: 'Slack', arrowDeg: null };
  if (sample.currentToDeg == null || !Number.isFinite(sample.currentToDeg)) return null;
  const speed = kt < 10 ? (Math.round(kt * 10) / 10).toFixed(1) : String(Math.round(kt));
  return { text: `to ${directionGroup(sample.currentToDeg)}/${speed}`, arrowDeg: sample.currentToDeg };
}

function swellText(sample: MarineSample): string | null {
  const parts: string[] = [];
  const height = metres(sample.swellHeightM);
  if (height) parts.push(height);
  if (sample.swellPeriodS != null && Number.isFinite(sample.swellPeriodS)) parts.push(`${Math.round(sample.swellPeriodS)} s`);
  if (sample.swellFromDeg != null && Number.isFinite(sample.swellFromDeg)) parts.push(`${directionGroup(sample.swellFromDeg)}°`);
  return parts.length ? parts.join(' · ') : null;
}

/** Sea rows under the surface. An all-null sample (land) contributes nothing. */
export function seaRows(sample: MarineSample | null, units: DisplayUnits = AUS_UNITS): SeaRow[] {
  if (!sample) return [];
  const rows: SeaRow[] = [];
  const current = currentText(sample);
  if (current) rows.push({ id: 'current', text: current.text, title: 'Surface current, flows to', arrowDeg: current.arrowDeg });
  if (sample.sstC != null && Number.isFinite(sample.sstC)) rows.push({ id: 'sst', text: formatTempC(sample.sstC, units, { unit: true }) ?? '', title: 'Sea-surface temperature', arrowDeg: null });
  const wave = metres(sample.waveHeightM);
  if (wave) rows.push({ id: 'wave', text: wave, title: 'Significant wave height', arrowDeg: null });
  const swell = swellText(sample);
  if (swell) rows.push({ id: 'swell', text: swell, title: 'Swell height, period, direction', arrowDeg: null });
  return rows;
}

export function columnOrder(air: AirRow[], sea: SeaRow[]): string[] {
  return [...air.map((row) => row.id), ...sea.map((row) => row.id)];
}

export interface SoundingDraw {
  width: number;
  height: number;
  rows: AirRow[];
  /** Full layer metadata is retained so painted sprites can choose a genus. */
  layers: SkyLayer[];
  icing?: { baseFt: number; topFt: number }[];
  freezingFt: number | null;
  bottomFt: number;
  /** Real elevation of the tapped spot, ft AMSL. Null when the DEM has no sample. */
  groundFt: number | null;
  /** East–west DEM samples. Null until the tiles arrive; the spot then stays a flat band. */
  section?: SectionSample[] | null;
  /** Approximate projected route, drawn over the cut face. */
  sectionRoute?: SectionRouteProjection;
  sectionHalfKm?: number;
  /** Model orography, metres. Levels below it are already omitted from `rows`. */
  modelGroundM?: number | null;
  emphasis: SoundingEmphasis;
  dark: boolean;
  ink: string;
  muted: string;
  /** Freezing-line label. Defaults to Celsius. */
  temp?: DisplayUnits['temp'];
  /** Optional shared painted-cloud renderer. Omitted while its atlas is loading. */
  cloudPainter?: CloudSpritePainter;
}

export interface CloudSpritePainter {
  canvas?: HTMLCanvasElement;
  dpr?: number;
  paintCloudSprite(
    ctx: CanvasRenderingContext2D,
    type: SkyLayer['type'],
    x: number,
    y: number,
    width: number,
    height: number,
    dark: boolean,
    night?: number,
    flip?: boolean,
  ): boolean;
}

/** The DEM track on the profile's altitude scale. Null samples are gaps, not zeros. */
export function sectionLine(
  samples: readonly SectionSample[],
  width: number,
  height: number,
  bottomFt: number,
): { x: number; y: number; metres: number; distanceKm: number }[] {
  const known = samples.flatMap((sample) => (
    sample.metres != null && Number.isFinite(sample.metres) ? [{ distanceKm: sample.distanceKm, metres: sample.metres }] : []
  ));
  if (known.length < 2) return [];
  const half = Math.max(...samples.map((sample) => Math.abs(sample.distanceKm)), .001);
  return known.map((sample) => ({
    x: sectionX(sample.distanceKm, width, half),
    y: plotY(heightFraction(sample.metres * FT_PER_M, bottomFt), height),
    metres: sample.metres,
    distanceKm: sample.distanceKm,
  }));
}

function terrainRuns(samples: readonly SectionSample[]): { distanceKm: number; metres: number }[][] {
  const runs: { distanceKm: number; metres: number }[][] = [];
  let run: { distanceKm: number; metres: number }[] = [];
  for (const sample of samples) {
    if (sample.metres == null || !Number.isFinite(sample.metres)) {
      if (run.length >= 2) runs.push(run);
      run = [];
      continue;
    }
    run.push({ distanceKm: sample.distanceKm, metres: sample.metres });
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** Sky field, cloud at true height, model temperature against dashed ISA, barbs. */
export function drawSounding(ctx: CanvasRenderingContext2D, draw: SoundingDraw, barb: (x: number, y: number, kt: number, from: number, length: number) => void) {
  const { width, height, rows, bottomFt, emphasis, dark, cloudPainter } = draw;
  const groundFt = draw.groundFt;
  const modelFt = draw.modelGroundM != null && Number.isFinite(draw.modelGroundM) ? draw.modelGroundM * FT_PER_M : null;
  const traceFloor = modelFt ?? groundFt ?? bottomFt;
  const floorFt = groundFt ?? bottomFt;
  ctx.clearRect(0, 0, width, height);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  if (dark) {
    sky.addColorStop(0, '#1a2734');
    sky.addColorStop(1, '#243246');
  } else {
    sky.addColorStop(0, '#d7e6f2');
    sky.addColorStop(1, '#e8f0f6');
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const yOf = (ft: number) => plotY(heightFraction(ft, bottomFt), height);
  const plotLeft = LABEL_W;
  const barbX = width - WIND_W - 28;
  const plotRight = Math.max(plotLeft + 24, barbX - 18);
  const yTrace = yOf(traceFloor);
  const yGround = yOf(floorFt);
  const ySummit = groundFt == null ? yTrace : yOf(groundFt);
  const runs = terrainRuns(draw.section ?? []);
  const halfKm = draw.sectionHalfKm != null && draw.sectionHalfKm > 0 ? draw.sectionHalfKm : Math.max(...(draw.section??[]).map(sample=>Math.abs(sample.distanceKm)),.001);
  const fillRun = () => {
    for (const run of runs) {
      ctx.beginPath();
      ctx.moveTo(sectionX(run[0].distanceKm, width, halfKm), height);
      for (const sample of run) ctx.lineTo(sectionX(sample.distanceKm, width, halfKm), yOf(sample.metres * FT_PER_M));
      ctx.lineTo(sectionX(run[run.length - 1].distanceKm, width, halfKm), height);
      ctx.closePath();
      ctx.fill();
    }
  };

  const cloudCanvas = cloudPainter?.canvas;
  const dpr = cloudPainter?.dpr ?? 1;
  if (cloudCanvas) { cloudCanvas.width = Math.round(width * dpr); cloudCanvas.height = Math.round(height * dpr); }
  const cctx = cloudCanvas?.getContext('2d') ?? ctx;
  if (cloudCanvas) cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Keep painted volumes, rain and icing above the measured ground. Draw at
  // their real heights and crop; squeezing a sprite changes its cloud shape.
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, yGround); ctx.clip();
  if (cctx !== ctx) { cctx.save(); cctx.beginPath(); cctx.rect(0, 0, width, yGround); cctx.clip(); }
  for (const [index, layer] of draw.layers.entries()) {
    const fraction = coverageFraction(layer.cover);
    if (fraction == null || !(layer.oktas > 0) || !Number.isFinite(layer.baseFtAmsl)) continue;
    if (layer.topFtAmsl != null && (!Number.isFinite(layer.topFtAmsl) || layer.topFtAmsl <= layer.baseFtAmsl)) continue;
    if ((layer.topFtAmsl ?? layer.baseFtAmsl) < floorFt) continue;
    const baseY = yOf(layer.baseFtAmsl);
    const coherent = ['cumulonimbus', 'towering', 'nimbostratus'].includes(layer.type);
    const segments = coherent ? [{ start: (1 - fraction) / 2, end: (1 + fraction) / 2 }] : coverageSegments(layer.cover, index + 5);
    for (const segment of segments) {
      const x = 8 + segment.start * (width - 16), cw = (segment.end - segment.start) * (width - 16);
      const topY = layer.topFtAmsl == null ? baseY : yOf(layer.topFtAmsl);
      cctx.save();
      cctx.globalAlpha = layer.secondary ? 0.5 : emphasis === 'cloud' ? 1 : 0.65;
      const painted = layer.topFtAmsl != null && layer.type !== 'unknown' && cloudPainter?.paintCloudSprite(cctx, layer.type, x, topY, cw, baseY - topY, dark);
      if (!painted) {
        cctx.strokeStyle = dark ? '#b6d4e6' : '#567b91'; cctx.lineWidth = 1; cctx.setLineDash([4, 3]);
        cctx.beginPath(); cctx.moveTo(x, baseY); cctx.lineTo(x + cw, baseY); cctx.stroke();
      }
      cctx.restore();
      // Shafts use the same phase boundary; model virga ends above the ground.
      const bands = precipitationBands({ baseFt: layer.baseFtAmsl, topFt: layer.topFtAmsl, precipitating: layer.precip !== 'none' }, draw.freezingFt, Math.max(floorFt, layer.precipBottomFtAmsl ?? floorFt));
      for (const band of bands) {
        const y0 = yOf(band.topFt), y1 = yOf(band.baseFt);
        ctx.save(); ctx.strokeStyle = dark ? '#8dbfda' : '#397fa9'; ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = layer.secondary ? 0.22 : 0.45; ctx.lineWidth = layer.heavy ? 1.2 : 0.8;
        const inset = layer.type === 'cumulonimbus' ? 0.3 : 0.15;
        for (let dx = cw * inset; dx < cw * (1 - inset); dx += layer.heavy ? 5 : 9) {
          if (band.phase === 'snow' || band.phase === 'unknown' || layer.precip === 'snow') {
            for (let y = y0; y < y1; y += 7) ctx.fillRect(x + dx, y, 1, 1);
          } else { ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x + dx, y0); ctx.lineTo(x + dx, y1); ctx.stroke(); }
        }
        ctx.restore();
      }
    }
  }
  if (cloudCanvas) {
    cctx.save(); cctx.globalCompositeOperation = 'source-atop';
    for (const band of draw.icing ?? []) {
      const top = yOf(band.topFt), bottom = yOf(band.baseFt);
      cctx.fillStyle = 'rgba(90,190,255,0.13)'; cctx.fillRect(0, top, width, bottom - top);
      cctx.strokeStyle = 'rgba(40,140,220,0.25)'; cctx.lineWidth = 0.8; cctx.beginPath();
      for (let x = -height; x < width; x += 6) { cctx.moveTo(x, bottom); cctx.lineTo(x + bottom - top, top); }
      cctx.stroke();
    }
    cctx.restore(); ctx.drawImage(cloudCanvas, 0, 0, width, height);
  }

  if (cctx !== ctx) cctx.restore();
  ctx.restore();

  const earthTop = runs.length ? Math.min(...runs.flat().map((sample) => yOf(sample.metres * FT_PER_M))) : ySummit;
  if (runs.length) {
    const earth = ctx.createLinearGradient(0, earthTop, 0, height);
    if (dark) {
      earth.addColorStop(0, '#6e6248');
      earth.addColorStop(1, '#3e3424');
    } else {
      earth.addColorStop(0, '#e4d3a4');
      earth.addColorStop(1, '#c4b07a');
    }
    ctx.fillStyle = earth;
    fillRun();
    if (modelFt != null) {
      const yModel = yOf(modelFt);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, Math.max(0, yModel));
      ctx.clip();
      ctx.fillStyle = dark ? '#8d7344' : '#d2b072';
      fillRun();
      ctx.restore();
    }
  } else if (groundFt != null && groundFt > bottomFt + 1) {
    const earth = ctx.createLinearGradient(0, ySummit, 0, height);
    if (dark) {
      earth.addColorStop(0, '#6e6248');
      earth.addColorStop(1, '#3e3424');
    } else {
      earth.addColorStop(0, '#e4d3a4');
      earth.addColorStop(1, '#c4b07a');
    }
    ctx.fillStyle = earth;
    ctx.fillRect(0, ySummit, width, Math.max(0, height - ySummit));
  }

  // Geographic projection only; keep it above the terrain fill for legibility.
  if (draw.sectionRoute?.runs.length) {
    ctx.save();
    ctx.strokeStyle = dark ? '#f3a24d' : '#d66f18';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.lineJoin = 'round';
    for (const routeRun of draw.sectionRoute.runs) {
      if (!routeRun.length) continue;
      ctx.beginPath();
      routeRun.forEach((item, index) => {
        const x = sectionX(item.acrossM / 1000, width, halfKm);
        const y = yOf(item.heightM * FT_PER_M);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const marker = draw.sectionRoute.marker;
    if (marker) {
      const x = sectionX(marker.acrossM / 1000, width, halfKm);
      const y = yOf(marker.heightM * FT_PER_M);
      ctx.fillStyle = dark ? '#ffd08a' : '#a84a0e';
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  const inAir = (feet: number) => feet >= traceFloor - 1;
  const temps = rows.filter((row) => row.temp != null && row.feet != null && inAir(row.feet)) as (AirRow & { temp: number; feet: number })[];
  const dews = rows.filter((row) => row.dew != null && row.feet != null && inAir(row.feet)) as (AirRow & { dew: number; feet: number })[];
  const isaAt = (ft: number) => isaTemperature(ft / FT_PER_M);
  const sampleTemps = [...temps.flatMap((row) => [row.temp, isaAt(row.feet)]), ...dews.map((row) => row.dew)];
  const lo = Math.min(-60, ...sampleTemps) - 4;
  const hi = Math.max(30, ...sampleTemps) + 4;
  const span = hi - lo || 1;
  const xOf = (temp: number) => plotLeft + (plotRight - plotLeft) * ((temp - lo) / span);

  ctx.save();
  ctx.strokeStyle = draw.muted;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  const isaTop = SOUNDING_TOP_FT;
  ctx.moveTo(xOf(isaAt(traceFloor)), yOf(traceFloor));
  for (let ft = traceFloor; ft <= isaTop; ft += 2000) ctx.lineTo(xOf(isaAt(ft)), yOf(ft));
  ctx.lineTo(xOf(isaAt(isaTop)), yOf(isaTop));
  ctx.stroke();
  ctx.restore();

  if (temps.length) {
    const ordered = [...temps].sort((a, b) => a.feet - b.feet);
    ctx.strokeStyle = dark ? '#e8925a' : '#c45c26';
    ctx.lineWidth = emphasis === 'temp' ? 2.6 : 1.7;
    ctx.beginPath();
    ordered.forEach((row, index) => {
      const x = xOf(row.temp);
      const y = yOf(row.feet);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineJoin = 'round';
    ctx.stroke();
    for (const row of ordered) {
      if (!row.inversion) continue;
      const x = xOf(row.temp);
      const y = yOf(row.feet);
      ctx.fillStyle = dark ? '#e8925a' : '#c45c26';
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x - 3.5, y + 2);
      ctx.lineTo(x + 3.5, y + 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  if (dews.length) {
    const ordered = [...dews].sort((a, b) => a.feet - b.feet);
    ctx.strokeStyle = dark ? '#8fd0b0' : '#1f7a4d';
    ctx.lineWidth = emphasis === 'temp' ? 2.2 : 1.35;
    ctx.beginPath();
    ordered.forEach((row, index) => {
      const x = xOf(row.dew);
      const y = yOf(row.feet);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  if (draw.freezingFt != null && draw.freezingFt >= traceFloor && draw.freezingFt <= SOUNDING_TOP_FT) {
    const y = yOf(draw.freezingFt);
    ctx.save();
    ctx.strokeStyle = dark ? '#7ec8d6' : '#1a7f9a';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = dark ? '#7ec8d6' : '#1a7f9a';
    ctx.font = '600 11px sans-serif';
    ctx.textAlign = 'left';
    // Raised ground puts the surface name on this line. Lift the word into the air above it.
    const labelY = y - (ySummit - y < 18 ? 14 : 3);
    ctx.fillText(draw.temp === 'F' ? '32°F' : '0°C', plotLeft + 2, labelY);
  }

  if (modelFt != null && draw.modelGroundM != null) {
    const yModel = yOf(modelFt);
    ctx.save();
    ctx.strokeStyle = draw.muted;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(8, yModel);
    ctx.lineTo(width - 8, yModel);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = draw.muted;
    ctx.font = '600 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(modelGroundLabel(draw.modelGroundM), width - 10, Math.max(12, yModel - 4));
    ctx.restore();
  }

  if (!runs.length) {
    ctx.strokeStyle = draw.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, ySummit);
    ctx.lineTo(width - 8, ySummit);
    ctx.stroke();
  } else {
    const tapped = runs.flat().reduce((best, sample) => Math.abs(sample.distanceKm) < Math.abs(best.distanceKm) ? sample : best);
    const x = sectionX(tapped.distanceKm, width, halfKm);
    const y = yOf(tapped.metres * FT_PER_M);
    ctx.fillStyle = dark ? '#f4e7c5' : '#3f3422';
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x - 4.5, y + 3);
    ctx.lineTo(x + 4.5, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  const barbLength = Math.max(18, Math.min(emphasis === 'wind' ? 32 : 24, height / 11));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, Math.max(1, yTrace));
  ctx.clip();
  for (const row of rows) {
    if (row.feet == null || row.speed == null || !inAir(row.feet)) continue;
    if (row.wind === 'Calm') barb(barbX, yOf(row.feet), 0, 0, barbLength);
    else if (row.from != null) barb(barbX, yOf(row.feet), row.speed, row.from, barbLength);
  }
  ctx.restore();
}
