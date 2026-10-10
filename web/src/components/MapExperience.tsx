'use client';
import {cyclonePoint} from '@/lib/cyclone-point';
import {cycloneAt} from '@/lib/historical-cyclone';
import {cycloneContours} from '@/lib/cyclone-contours';
import {sampleFrame} from '@/lib/point/ground';

import { CameraRecovery } from '@/lib/camera-recovery';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { terrainSliceBase, offsetAtmosphereSlice, slicePoint, type AtmosphereSlice } from '@/lib/atmosphere-slice';
import { reportPoint } from '../lib/reports/deep-link';
import { EVEREST_IMAGERY, loadEverestImagery } from '@/lib/terrain/imagery-loader';
import { MAP_TRANSIT_KEY, parseMapTransit, type MapTransit } from '@/lib/map-transit';
import { loadHistoricalChart } from '@/lib/history-chart';
import type { HistoricalCatalog } from '@/lib/history';
import { ATTRIBUTION } from '@/components/Attribution';
import { australiaAspects, clampToData, frameData, insetBox, panBy, zoomWithinData, type DataFrame } from '@/lib/camera';
import { EVEREST_DETAILS, EVEREST_EVENTS, EVEREST_ROUTE, EVEREST_SOURCE, everestAtmosphere } from '@/lib/everest';
import { drawHistoricalScene } from '@/lib/historical-scene-renderer';
import type { HistoryLayer } from '@/lib/historical-scenes';
import { HistoricalSceneControls } from './HistoricalSceneControls';
import { drawEverestRoute } from '@/lib/everest-route';
import { AtmosphereMap } from './AtmosphereMap';
import { withTilt, terrainEye, zoomMountain, frameTerrainPin, anchorTilt, panTilt, MAX_TILT, TiltFraming, liftCamera } from '@/lib/tilt-navigation';
import { mapUnproject, mapProject } from '@/lib/lambert';
import { bindTrackpadPinch } from '@/lib/trackpad';
import {
  blendFrame,
  blendReady,
  FRAME_READY,
  chartFrame,
  loadChart,
  nowMinuteOf,
  type AviationAirport,
  type LoadedChart,
} from '@/lib/chart-store';
import { FIELD_LABEL, FIELD_VARIABLE, legendScale, legendState } from '@/lib/legend';
import { smoothGrid, contourPressure, type Polyline, type PressureCentre } from '@/lib/contour';
import { createGlChart, type GlChart } from '@/lib/gl-chart';
import { createCanvasChart, type CanvasChart } from '@/lib/canvas-chart';
import { createFlowLayer, type FlowLayer } from '@/lib/flow-layer';
import { createWindSampler, flowWindLegend, type WindDisplaySource } from '@/lib/flow-wind';
import { createSatelliteLayer, type SatelliteLayer } from '@/lib/satellite-layer';
import { australiaLambert, globalEquirectangular, type Camera } from '@/lib/lambert';
import { DAY_INK, drawOverlay, EDGE_FADE_DEG, NIGHT_INK, type DrawnLabel } from '@/lib/overlay';
import { frameBlend } from '@/lib/interpolate';
import { advancePlayback, DEFAULT_SPEED, REAL_TIME, isSpeed, type Playback, type Speed } from '@/lib/playback';
import { chartTitle, clockZone, formatClock, localDayKey, localMidnight } from '@/lib/time-label';
import { fieldBase, type FieldId } from '@/lib/field-color';
import { distanceBearing } from '@/lib/metar-view';
import { daySummaries, readingAt } from '@/lib/points';
import { MapTeaching } from './MapTeaching';
import { drawWindBarbs, windComponent } from '@/lib/wind-barbs';
import { chartScalarAt, orographyMetresAt, orographyVariable } from '@/lib/point/ground';
import { loadTerrainSection, elevationsAlong, type SectionSample } from '@/lib/point/terrain-section';
import { drawPeaks, snapToSummit, SUMMITS, type PlacedSummit } from '@/lib/peaks';
import { createElevationCoverage } from '@/lib/terrain/elevation';
import type { ElevationAt } from '@/lib/map-generalise';
import { createTerrainLayer, viewGeoBox, type TerrainLayer } from '@/lib/terrain/terrain-layer';
import { createWaterLayer, type WaterLayer } from '@/lib/water-layer';
import { lakeContains, withLakes } from '@/lib/water';
import { boxesOverlap, TEACHING_AU } from '@/lib/teaching-snapshot';
import { compassFrom, DAY_PLACES, drawPlaces, loadPlaces, NIGHT_PLACES, PLACES_MAX_LABELS, PLACES_MAX_SPAN, readingText, type PlaceReading, type PlaceRow } from '@/lib/places';
import type { LabelBox } from '@/lib/overlay';
import { cameraProject, project, unproject } from '@/lib/lambert';
import {
  bindTrafficPoll,
  layoutTraffic,
  paintTraffic,
  trafficHit,
  trafficInPicture,
  trafficResponse,
  trafficTile,
  viewRadiusNm,
  type TrafficAircraft,
  type TrafficGlyph,
  type TrafficSnapshot,
  type TrafficTrail,
} from '@/lib/traffic';
import { accumulateTracks, liveTrafficAtTime, trafficAtTime, mergeTrackPoints, parseFlightRoute, toggleTrafficSelection, type TrafficSelection, type FlightRoute } from '@/lib/traffic-paths';
import { paintTrafficPaths, trackColor } from '@/lib/traffic-path-render';
import { TrafficCards } from './TrafficCards';
import { mapTimeState, enableOverlay, type OptionalOverlay } from '@/lib/map-live';
import type { MapPoint } from '@/lib/point/section';
import { coastContains } from '@/lib/coast';
import { describePoint } from '@/lib/place-name';
import type { CoarseGeo } from '@/lib/request-geo';
import { PointPanel } from './PointPanel';
import { CoastalPanel } from './CoastalPanel';
import { DEFAULT_KITE_BAND, kiteBandColor, validKiteBand, type KiteBand } from '@/lib/coastal';
import pointStyles from './PointPanel.module.css';
import { cameraDuringMove, exposedMap, pointCamera, projectPoint, reframeCamera, type CameraMove } from '@/lib/point/camera';
import { DESKTOP_MQ } from './MapSheet';
import type { GeoPoint } from '@/lib/chart-teaching';
import { forecastDaySummaries, forecastReading, forecastUv, loadPlaceForecast, overlayUv, peekPointModel, pointSurfaceAt, type PlaceForecast } from '@/lib/point/openmeteo';
import { ChromeToggle, CompactForecast, DayTiles, LensBar, MapHeader, PressNote, SatelliteIcon, Timeline, TrafficIcon, Transport, usePressNote, type Lens } from './MapChrome';
import { useTimes } from './TimesControl';
import { PhoneHoldNames } from './MapHints';
import { ScaleBar } from './ScaleBar';
import { readGraticule, writeGraticule } from '@/lib/graticule';
import { drawAdminNames, parseBorders, type AdminName, type Borders } from '@/lib/borders';
import { useUnits } from './UnitsControl';
import { cToF, formatRainAmount, unitKey } from '@/lib/units';
import { PlaceField } from './PlaceField';
import { FlyPanel } from './FlyPanel';
import { ChatButton, ChatPanel } from './ChatPanel';
import { MapPointChip } from './MapPointChip';
import type { ChatContext } from '@/lib/chat/types';
import { SYNCED, readSetting, setPref } from '@/lib/account/local';
import { loadAirports, type AirportRow } from '@/lib/airports';
import { loadAerodromeReport } from '@/lib/aviation-report';
import { isPlaceId, manifestCatalog, nearestAirports, nearestCatalogPlace, nearestReported, placeForPoint, resolvePlace, type CatalogPlace } from '@/lib/place-catalog';
import { noteUsage, onUsageHide, trackUsage } from '@/lib/usage/browser';

const AU_GEO = australiaLambert();
interface Contours {
  lines: Polyline[];
  centres: PressureCentre[];
}

function readStoredSpeed(): Speed {
  try {
    const stored = localStorage.getItem('isobar.speed');
    const value = stored === null ? DEFAULT_SPEED : Number(stored);
    return isSpeed(value) ? value : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

function readStoredPlace(chart: LoadedChart): string {
  try {
    const value = localStorage.getItem('isobar.place');
    if (value && isPlaceId(value)) return value;
  } catch {
    /* keep the default place */
  }
  return chart.manifest.places[0]?.id ?? 'sydney';
}

function readSavedIds(): string[] {
  const saved = readSetting('places');
  return Array.isArray(saved) ? saved.filter(isPlaceId).slice(0, 32) : [];
}

const HINT_KEY = 'isobar.place.hint';
type PlacePick = 'user' | 'point' | 'geo' | 'restore';

function readHint(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}

function pointAtSea(chart: LoadedChart | null | undefined, lat: number, lon: number): boolean {
  return !!chart && !coastContains(chart.coast, lon, lat);
}

interface LandRaster {
  pixels: Uint8Array;
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Land mask over the whole coastline extent, not just the data grid, so the plate fills the panel. */
function rasterLand(chart: LoadedChart): LandRaster {
  let west = chart.manifest.west;
  let east = chart.manifest.east;
  let south = chart.manifest.south;
  let north = chart.manifest.north;
  for (const ring of chart.coast.rings) {
    for (let i = 0; i < ring.lon.length; i += 1) {
      west = Math.min(west, ring.lon[i]);
      east = Math.max(east, ring.lon[i]);
      south = Math.min(south, ring.lat[i]);
      north = Math.max(north, ring.lat[i]);
    }
  }
  if (chart.manifest.wrapsLongitude) {
    west = -180; east = 180; south = -90; north = 90;
  } else {
    west = Math.floor(west) - 1;
    east = Math.ceil(east) + 1;
    south = Math.floor(south) - 1;
    north = Math.ceil(north) + 1;
  }
  // 16 px per degree, capped at 4096 px a side: many phones cannot hold a
  // larger texture, and a failed upload silently shows the world as sea.
  const scale = Math.min(16, 4096 / Math.max(east - west, north - south));
  const width = Math.round((east - west) * scale);
  const height = Math.round((north - south) * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pixels = new Uint8Array(width * height);
  const raster = { pixels, width, height, west, south, east, north };
  if (!ctx) return raster;
  ctx.fillStyle = '#fff';
  // Close each ring before appending it to the compound mask. Closing a growing
  // Path2D repeatedly makes Chromium revisit the accumulated coastline (~740 ms
  // in the global startup profile). addPath preserves the same even-odd geometry.
  const landPath = new Path2D();
  for (const ring of chart.coast.rings) {
    const ringPath = new Path2D();
    let previousLon: number | null = null;
    for (let i = 0; i < ring.lon.length; i += 1) {
      const lon = ring.lon[i];
      const x = ((lon - west) / (east - west)) * width;
      const y = ((north - ring.lat[i]) / (north - south)) * height;
      // Natural Earth rings can cross the antimeridian. Starting a new
      // subpath avoids a full-width chord through the world mask.
      if (i === 0 || (previousLon !== null && Math.abs(lon - previousLon) > 180)) ringPath.moveTo(x, y);
      else ringPath.lineTo(x, y);
      previousLon = lon;
    }
    ringPath.closePath();
    landPath.addPath(ringPath);
  }
  for (const ring of chart.water?.rings ?? []) {
    if (ring.minZoom > 2.5) continue;
    if (Math.min((ring.east - ring.west) * scale, (ring.north - ring.south) * scale) < 2) continue;
    const ringPath = new Path2D();
    let previousLon: number | null = null;
    for (let i = 0; i < ring.lon.length; i += 1) {
      const lon = ring.lon[i];
      const x = ((lon - west) / (east - west)) * width;
      const y = ((north - ring.lat[i]) / (north - south)) * height;
      if (i === 0 || (previousLon !== null && Math.abs(lon - previousLon) > 180)) ringPath.moveTo(x, y);
      else ringPath.lineTo(x, y);
      previousLon = lon;
    }
    ringPath.closePath();
    landPath.addPath(ringPath);
  }
  ctx.fill(landPath, 'evenodd');
  const image = ctx.getImageData(0, 0, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = image.data[((height - 1 - y) * width + x) * 4];
    }
  }
  return raster;
}

/** Camera controls and the legend, padded, in stage CSS pixels. */
function chromeAvoid(stage: Element): { x: number; y: number; w: number; h: number }[] {
  const host = stage.getBoundingClientRect();
  return ['.map-tools', '.map-legend', '.map-sources', '.traffic-selection', '.traffic-replay-status'].flatMap((selector) => {
    const node = stage.querySelector(selector);
    if (!(node instanceof HTMLElement)) return [];
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return [];
    return [{ x: rect.left - host.left - 8, y: rect.top - host.top - 8, w: rect.width + 16, h: rect.height + 16 }];
  });
}

export function MapExperience({ initialGeo = null, historical=false }: { initialGeo?: CoarseGeo | null; historical?:boolean }) {
  const historicalStartRef=useRef<number|null>(null);
  const [historyRequest,setHistoryRequest]=useState<{event?:string;date?:string;hour?:number;version:number}|null>(null);
  const historySelectionVersion=useRef(0);
  const [historyCatalog,setHistoryCatalog]=useState<HistoricalCatalog|null>(null);
  const [historyEvent,setHistoryEvent]=useState('');
  const [historyError,setHistoryError]=useState('');
  const transitRef=useRef<MapTransit|null>(null);
  const transitAppliedRef=useRef(false);
  const transitReadRef=useRef<boolean|null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const windCanvasRef = useRef<HTMLCanvasElement>(null);
  const flowCanvasRef = useRef<HTMLCanvasElement>(null);
  const satCanvasRef = useRef<HTMLCanvasElement>(null);
  const trafficCanvasRef = useRef<HTMLCanvasElement>(null);
  const windRef = useRef(false);
  const satelliteRef = useRef(false);
  const trafficRef = useRef(false);
  const teachingRef = useRef(false);
  const heldPlayingRef = useRef(true);
  const heldFieldRef = useRef<FieldId>('none');
  const [windBarbs, setWindBarbs] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [trafficOn, setTrafficOn] = useState(false);
  const [selectedTraffic, setSelectedTraffic] = useState<TrafficSelection[]>([]);
  const selectedTrafficRef = useRef<TrafficSelection[]>([]);
  const routesRef = useRef(new Map<string, FlightRoute | null>());
  const trafficSessionRef = useRef('');
  const trafficRequestsRef = useRef(new Map<string, AbortController>());
  const [, refreshTraffic] = useState(0);
  const optionalRef = useRef<OptionalOverlay[]>([]);
  const [mapNotice, setMapNotice] = useState('');
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trafficReplay, setTrafficReplay] = useState<'replay' | 'missing' | null>(null);
  const trafficSnapRef = useRef<TrafficSnapshot | null>(null);
  type TrafficPicture = { selectedMs: number; epoch: number; aircraft: TrafficAircraft[]; trails: Map<string, TrafficTrail>; routes: Map<string, FlightRoute | null> };
  const lastLiveTrafficRef = useRef<TrafficPicture | null>(null);
  const heldTrafficRef = useRef<TrafficPicture | null>(null);
  const trailsRef = useRef<Map<string, TrafficTrail>>(new Map());
  const glyphsRef = useRef<TrafficGlyph[]>([]);
  const trafficDirtyRef = useRef(false);
  const lastTileRef = useRef<string | null>(null);
  const pollKickRef = useRef<(() => void) | null>(null);
  const [cloudLegend, setCloudLegend] = useState<string | null>(null);
  const [teaching, setTeaching] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [historyLayers, setHistoryLayers] = useState<Record<HistoryLayer,boolean>>({political:true,military:true,ships:true});
  const historyLayersRef=useRef(historyLayers);historyLayersRef.current=historyLayers;
  const [showSources, setShowSources] = useState(false);
  const [photoTerrain,setPhotoTerrain]=useState(false);
  const [photoStatus,setPhotoStatus]=useState('off');
  useEffect(()=>{try{const query=new URLSearchParams(location.search).get('terrain');const enabled=query?query==='photo':sessionStorage.getItem('isobar.terrain-photo')==='1';setPhotoTerrain(enabled);sessionStorage.setItem('isobar.terrain-photo',enabled?'1':'0');}catch{}},[]);
  function togglePhotoTerrain(){setPhotoTerrain(value=>{const next=!value;try{sessionStorage.setItem('isobar.terrain-photo',next?'1':'0');}catch{}return next;});}
  const [flowSource, setFlowSource] = useState<WindDisplaySource>('unavailable');
  const [, refreshCamera] = useState(0);
  const glRef = useRef<GlChart | null>(null);
  const canvasChartRef = useRef<CanvasChart | null>(null);
  const canvasFallbackRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<LoadedChart | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const threeDRef = useRef(false);
  const [threeD, setThreeD] = useState(false);
  const savedTiltRef = useRef(Math.PI / 4);
  const tiltRef = useRef(0);
  const savedBearingRef = useRef(0);
  const mapKeysRef = useRef(new Set<string>());
  const keyboardStepRef = useRef<(dt:number)=>boolean>(()=>false);
  useEffect(()=>{const clear=()=>mapKeysRef.current.clear();window.addEventListener("blur",clear);document.addEventListener("visibilitychange",clear);return()=>{clear();window.removeEventListener("blur",clear);document.removeEventListener("visibilitychange",clear);};},[]);
  const tiltFramingRef = useRef(new TiltFraming());
  const [tilt, setTilt] = useState(0);
  const atmosphereInspectionRef=useRef(0);
  const sliceRef=useRef<AtmosphereSlice | undefined>(undefined);
  const [sliced,setSliced]=useState(false);
  const sliceOriginRef=useRef<AtmosphereSlice | undefined>(undefined);
  const displayedSliceRef=useRef<AtmosphereSlice | undefined>(undefined);
  const [sliceOffset,setSliceOffset]=useState(0);
  const sliceOffsetRef=useRef(0);
  const sliceReadyRef=useRef(false);
  const [sliceReady,setSliceReady]=useState(false);
  const touchGestureRef = useRef<{ mode: 'pending' | 'pinch' | 'tilt'; distance: number; x: number; y: number; lastDistance: number; lastX: number; lastY: number; updated: number; batchStarted: number } | null>(null);
  const cameraMoveRef = useRef<(CameraMove & { restore?: { camera: Camera; frame: DataFrame } }) | null>(null);
  const lastFrameRef = useRef<{ width: number; height: number } | null>(null);
  /** True for the whole header-height animation, so a resize keeps the map centre. */
  const holdMapCentreRef = useRef(false);
  const chromeRef = useRef<HTMLDivElement>(null);
  const chromeBodyRef = useRef<HTMLDivElement>(null);
  const chromeHeightRef = useRef<number | null>(null);
  const pointViewRef = useRef<{ camera: Camera; frame: DataFrame } | null>(null);
  const pointRef = useRef<MapPoint | null>(null);
  const pointSeenCamRef = useRef('');
  const pointSeenSizeRef = useRef('');
  const pointPanelRef = useRef<HTMLElement | null>(null);
  const [graticule, setGraticule] = useState(false);
  const graticuleRef = useRef(false);
  const bordersRegionalRef = useRef<Borders | null>(null);
  const bordersCloseRef = useRef<Borders | null>(null);
  const adminNamesRef = useRef<AdminName[]>([]);
  const borderEpochRef = useRef(0);
  useEffect(() => {
    const on = readGraticule(window.localStorage);
    graticuleRef.current = on;
    setGraticule(on);
  }, []);
  useEffect(() => { redrawRef.current?.(); }, [graticule]);
  useEffect(() => {
    let dead = false;
    const bins = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) return null;
      return parseBorders(new Uint8Array(await response.arrayBuffer()));
    };
    void Promise.all([
      bins('/borders/regional.bin'),
      bins('/borders/close.bin'),
      fetch('/borders/names.json').then((response) => (response.ok ? response.json() : [])),
    ]).then(([regional, close, names]) => {
      if (dead) return;
      bordersRegionalRef.current = regional;
      bordersCloseRef.current = close;
      adminNamesRef.current = Array.isArray(names) ? names as AdminName[] : [];
      borderEpochRef.current += 1;
      redrawRef.current?.();
    }).catch(() => {});
    return () => { dead = true; };
  }, []);
  const [pointPlaces, setPointPlaces] = useState<PlaceRow[]>([]);
  // The data frame: home view, widest view and the box the view stays inside.
  const homeRef = useRef<DataFrame | null>(null);
  const clockRef = useRef<Playback>({ minute: 0, playing: true, direction: 1 });
  const speedRef = useRef<Speed>(DEFAULT_SPEED);
  // A lens never persists as the default: the map opens on the pressure plate.
  const fieldRef = useRef<FieldId>('none');
  const darkRef = useRef(false);
  const { units, noteView } = useUnits();
  const unitsRef = useRef(units);
  const noteViewRef = useRef(noteView);
  const redrawRef = useRef<(() => void) | null>(null);
  unitsRef.current = units;
  noteViewRef.current = noteView;
  useEffect(() => { redrawRef.current?.(); }, [unitKey(units)]);
  const placeRef = useRef('sydney');
  const focusRef = useRef<{ lat: number; lon: number } | null>(null);
  const framedId = useRef<string | null>(null);
  const townsRef = useRef<PlaceRow[]>([]);
  const airportsRef = useRef<AirportRow[]>([]);
  const holdingRef = useRef(false);
  const hoverHoldRef = useRef(false);
  const hoverArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverArmGenerationRef = useRef(0);
  const hoverLatestXRef = useRef(0);
  const hoverRestorePlayingRef = useRef(true);
  const scrubRestorePlayingRef = useRef(true);
  const recoveryRef = useRef(new CameraRecovery());
  const panStartRef = useRef<{ camera: Camera; last: Camera; pitch: number; x: number; y: number; moving: boolean } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef(0);
  const dragRef = useRef({ moved: 0, multi: false, started: 0, x: 0, y: 0, kind: 'mouse', armed: false });
  const longTimerRef = useRef(0);
  const swallowRef = useRef(false);
  const mapHeldPlayingRef = useRef<boolean | null>(null);
  const mapHeldNowRef = useRef(false);
  const mapHeldAtRef = useRef(0);
  const contoursRef = useRef<Contours>({ lines: [], centres: [] });
  const [chart, setChart] = useState<LoadedChart | null | undefined>(undefined);
  const GEO = useMemo(() => chart?.manifest.wrapsLongitude ? globalEquirectangular() : AU_GEO, [chart?.manifest.wrapsLongitude]);
  const renderCamera = (camera: Camera) => ({...withTilt(GEO, camera, tiltRef.current, elevationAtRef.current, true), slice: threeDRef.current && displayedSliceRef.current && glRef.current?.sliceReady(displayedSliceRef.current) ? displayedSliceRef.current : undefined});
  function clearSlice() { sliceRef.current=undefined;sliceOriginRef.current=undefined;displayedSliceRef.current=undefined;sliceOffsetRef.current=0;setSliceOffset(0);setSliced(false);sliceReadyRef.current=false;setSliceReady(false); }
  function toggleSlice() {
    if(sliceRef.current){clearSlice();redrawRef.current?.();return;}
    const camera=cameraRef.current;
    if(!camera||!threeDRef.current)return;
    const centre=unproject(GEO,camera.centerX,camera.centerY);
    if(!centre)return;
    const pin=pointRef.current;
    const projected=pin?mapProject(GEO,renderCamera(camera),pin.lat,pin.lon):null;
    const focus=pin&&projected&&Math.abs(projected.x)<1&&Math.abs(projected.y)<1?pin:centre;
    const halfWidthM=Math.max(500,Math.min(100000,camera.halfWidth/GEO.F*111320*Math.cos(focus.lat*Math.PI/180)*.8));
    const slice:AtmosphereSlice={lat:focus.lat,lon:focus.lon,bearingRadians:camera.bearingRadians??0,halfWidthM,halfDepthM:halfWidthM*.16,baseM:-500};
    slice.baseM=elevationAtRef.current?terrainSliceBase(slice,elevationAtRef.current)??-500:-500;
    sliceRef.current=slice;sliceOriginRef.current=slice;sliceOffsetRef.current=0;setSliceOffset(0);setSliced(true);redrawRef.current?.();
  }
  function moveSlice(value:number) {
    const origin=sliceOriginRef.current;
    if(!origin||!Number.isFinite(value))return;
    const offset=Math.max(-100,Math.min(100,value));
    const next=offsetAtmosphereSlice(origin,offset/100*origin.halfWidthM*.6);
    if(!next)return;
    sliceRef.current=next;sliceOffsetRef.current=offset;setSliceOffset(offset);redrawRef.current?.();
  }
  function orientSlice(camera:Camera) {
    const origin=sliceOriginRef.current,bearing=camera.bearingRadians??0;
    if(!origin||origin.bearingRadians===bearing)return;
    const rotated={...origin,bearingRadians:bearing};
    const next=offsetAtmosphereSlice(rotated,sliceOffsetRef.current/100*rotated.halfWidthM*.6);
    if(next){sliceOriginRef.current=rotated;sliceRef.current=next;}
  }
  const inspectAtmosphere=useCallback((strength:number)=>{atmosphereInspectionRef.current=strength;redrawRef.current?.();},[]);
  function pointCameraForView(camera:Camera,frame:DataFrame,pin:MapPoint,map:Parameters<typeof pointCamera>[4],visible:Parameters<typeof pointCamera>[5]) {
    const next=pointCamera(GEO,camera,frame,pin,map,visible);
    if(!threeDRef.current)return next;
    const x=((visible.left+visible.width/2-map.left)/map.width)*2-1,y=1-((visible.top+visible.height/2-map.top)/map.height)*2;
    return frameTerrainPin(GEO,next,tiltRef.current,pin,x,y,frame,elevationAtRef.current);
  }
  function zoomShared(camera: Camera, x:number, y:number, factor:number, frame:DataFrame) {
    const pin=pointRef.current??sliceOriginRef.current;
    const anchor=pin?mapProject(GEO,withTilt(GEO,camera,tiltRef.current,elevationAtRef.current,true),pin.lat,pin.lon):null;
    // A visible inspected pin is the pivot; panning it away releases the assist.
    const onScreen=anchor&&Math.abs(anchor.x)<1&&Math.abs(anchor.y)<1;
    const next=zoomMountain(GEO,camera,tiltRef.current,onScreen?anchor.x:x,onScreen?anchor.y:y,factor,frame,elevationAtRef.current,onScreen&&pin?pin:undefined);
    tiltRef.current=next.pitch;setTilt(next.pitch);
    recoveryRef.current.travel(performance.now(), next.camera.bearingRadians ?? 0);
    return next.camera;
  }
  function changeOrientation(value: number, turn = 0) {
    recoveryRef.current.cancel();
    if (!threeDRef.current || !glRef.current || GEO.projection !== 'equirectangular') return;
    cameraMoveRef.current=null;
    const next = Math.max(0, Math.min(MAX_TILT, value));
    const pitch = next < .001 ? 0 : next;
    const pin=pointRef.current??sliceOriginRef.current;
    const anchor=pin&&cameraRef.current?mapProject(GEO,withTilt(GEO,cameraRef.current,tiltRef.current,elevationAtRef.current,true),pin.lat,pin.lon):null;
    if (cameraRef.current) {
      cameraRef.current = tiltFramingRef.current.apply(cameraRef.current, tiltRef.current, pitch);
      if(turn){const bearing=(cameraRef.current.bearingRadians??0)+turn;cameraRef.current={...cameraRef.current,bearingRadians:Math.atan2(Math.sin(bearing),Math.cos(bearing))};}
      if(pin&&anchor&&Math.abs(anchor.x)<1&&Math.abs(anchor.y)<1&&homeRef.current)cameraRef.current=frameTerrainPin(GEO,cameraRef.current,pitch,pin,anchor.x,anchor.y,homeRef.current,elevationAtRef.current);
    }
    tiltRef.current = pitch;
    setTilt(tiltRef.current);
    redrawRef.current?.();
  }
  function recenterMap() {
    const home = homeRef.current;
    if (!home) return;
    recoveryRef.current.cancel();
    mapKeysRef.current.clear(); panStartRef.current = null; cameraMoveRef.current = null;
    clearSlice(); forgetPoint(); closeChat(false);
    chipRef.current = null; setChip(null);
    savedBearingRef.current = 0; savedTiltRef.current = Math.PI / 4;
    const pitch = threeDRef.current ? Math.PI / 4 : 0;
    tiltRef.current = pitch; setTilt(pitch);
    tiltFramingRef.current = new TiltFraming();
    cameraRef.current = tiltFramingRef.current.apply({ ...home.home, bearingRadians: 0 }, 0, pitch);
    redrawCamera();
    recenterNote.show(place?.name ? `Back to ${place.name}` : 'Recentered');
  }
  function northUp() {
    recoveryRef.current.cancel();
    if (!cameraRef.current || !threeDRef.current) return;
    mapKeysRef.current.clear(); cameraMoveRef.current = null; panStartRef.current = null;
    cameraRef.current = { ...cameraRef.current, bearingRadians: 0 };
    savedBearingRef.current = 0;
    redrawCamera();
  }
  function changeTilt(value:number) { changeOrientation(value); }
  function changeMapMode(enabled: boolean) {
    recoveryRef.current.cancel();
    if (!glRef.current || GEO.projection !== 'equirectangular' || threeDRef.current === enabled) return;
    mapKeysRef.current.clear();
    cameraMoveRef.current=null;
    if (!enabled) { savedTiltRef.current = tiltRef.current; savedBearingRef.current = cameraRef.current?.bearingRadians ?? 0; }
    if (!enabled) clearSlice();
    threeDRef.current = enabled;
    setThreeD(enabled);
    const pitch = enabled ? savedTiltRef.current : 0;
    if(cameraRef.current)cameraRef.current={...cameraRef.current,bearingRadians:enabled?savedBearingRef.current:0};
    if (cameraRef.current) cameraRef.current = tiltFramingRef.current.apply(cameraRef.current, tiltRef.current, pitch);
    tiltRef.current = pitch;
    setTilt(tiltRef.current);
    touchGestureRef.current = null;
    redrawRef.current?.();
  }
  keyboardStepRef.current = (dt:number) => {
    const keys=mapKeysRef.current,camera=cameraRef.current,frame=homeRef.current;
    if(!threeDRef.current||!camera||!frame||!keys.size)return false;
    const axis=(positive:string,negative:string)=>Number(keys.has(positive))-Number(keys.has(negative));
    const yaw=axis('ArrowRight','ArrowLeft'),look=axis('ArrowUp','ArrowDown'),rise=axis('e','q');
    const right=axis('d','a'),forward=axis('w','s');
    if(!(yaw||look||rise||right||forward))return false;
    cameraMoveRef.current=null;
    const pin=pointRef.current??sliceOriginRef.current,anchor=pin?mapProject(GEO,withTilt(GEO,camera,tiltRef.current,elevationAtRef.current,true),pin.lat,pin.lon):null;
    let next={...camera},pitch=tiltRef.current;
    next.bearingRadians=Math.atan2(Math.sin((next.bearingRadians??0)+yaw*dt*.7),Math.cos((next.bearingRadians??0)+yaw*dt*.7));
    if(look){const p=Math.max(0,Math.min(MAX_TILT,pitch+look*dt*.7));next=tiltFramingRef.current.apply(next,pitch,p);pitch=p;}
    if(rise){const lifted=liftCamera(next,pitch,rise*dt*next.halfHeight*Math.PI/180*6371000*.6);next=lifted.camera;pitch=lifted.pitch;tiltFramingRef.current.synchronize(next,pitch);}
    if((yaw||look||rise)&&pin&&anchor&&Math.abs(anchor.x)<1&&Math.abs(anchor.y)<1)next=frameTerrainPin(GEO,next,pitch,pin,anchor.x,anchor.y,frame,elevationAtRef.current);
    if(right||forward){
      const n=Math.max(1,Math.hypot(right,forward));
      next=panTilt(GEO,next,pitch,-right*dt*.7/n,-forward*dt*.7/n,frame);
    }
    if(yaw||look||rise) recoveryRef.current.cancel();
    else recoveryRef.current.travel(performance.now(), next.bearingRadians ?? 0);
    cameraRef.current=next;
    if(pitch!==tiltRef.current){tiltRef.current=pitch;setTilt(pitch);}
    return true;
  };
  const shoreCoast = useMemo(() => (chart ? withLakes(chart.coast, chart.water) : null), [chart]);
  const [minute, setMinute] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(DEFAULT_SPEED);
  const [field, setField] = useState<FieldId>('none');
  const [fly, setFly] = useState(false);
  const [flyDetail, setFlyDetail] = useState(false);
  /** Remembered per browser. Absent means expanded, including for a new visitor. */
  const [userCollapsed, setUserCollapsed] = useState(false);
  /** Temporary expand while a sheet is holding the bar closed. Not persisted. */
  const [chromeLifted, setChromeLifted] = useState(false);
  const [coastalLens, setCoastalLens] = useState<'kite' | 'surf' | null>(null);
  const [kiteBand, setKiteBand] = useState<KiteBand>(DEFAULT_KITE_BAND);
  const kiteTintRef = useRef<KiteBand | null>(null);
  kiteTintRef.current = coastalLens === 'kite' ? kiteBand : null;
  useEffect(() => {
    const saved = readSetting('kiteBand');
    if (validKiteBand(saved)) setKiteBand(saved);
  }, []);
  useEffect(() => { redrawRef.current?.(); }, [coastalLens, kiteBand]);
  const [point, setPoint] = useState<(MapPoint & { name?: string }) | null>(null);
  const elevationAtRef = useRef<ElevationAt | null>(null);
  const sectionAtRef = useRef<((lat: number, lon: number, signal: AbortSignal) => Promise<SectionSample[]>) | null>(null);
  const labelledPeaksRef = useRef<PlacedSummit[]>([]);
  const [terrainEpoch, setTerrainEpoch] = useState(0);
  pointRef.current = point;
  const [chatOpen, setChatOpen] = useState(false);
  const [placeId, setPlaceId] = useState('sydney');
  const [placeHint, setPlaceHint] = useState(false);
  const [locatedTick, setLocatedTick] = useState(0);
  const [placesReady, setPlacesReady] = useState(false);
  const placeSourceRef = useRef<'stored' | 'default' | 'geo' | 'user'>('default');
  const previousPlaceRef = useRef<CatalogPlace | null>(null);
  const [chip, setChip] = useState<{ lat: number; lon: number; left: number; top: number; note: string } | null>(null);
  const chipRef = useRef(chip);
  chipRef.current = chip;
  const [ghost, setGhost] = useState<{ left: number; top: number; note: string } | null>(null);
  const ghostTimerRef = useRef(0);
  const [airportRows, setAirportRows] = useState<AirportRow[]>([]);
  const [airportsReady, setAirportsReady] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [forecast, setForecast] = useState<{ id: string; data: PlaceForecast } | null>(null);
  const [flyReport, setFlyReport] = useState<AviationAirport | null>(null);
  const [flyKnown, setFlyKnown] = useState(false);
  const [locateDenied, setLocateDenied] = useState(false);
  const [ready, setReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isobars, setIsobars] = useState(false);
  const [renderer, setRenderer] = useState<'webgl2' | 'canvas'>('canvas');
  const [dataVersion, setDataVersion] = useState(0);
  const [complete, setComplete] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const fieldCoverRef = useRef(1);
  const shownFieldRef = useRef<FieldId>('none');
  const [phone, setPhone] = useState(false);
  const [explainHost, setExplainHost] = useState<HTMLElement | null>(null);
  const [autoTour, setAutoTour] = useState(false);
  const recenterNote = usePressNote();
  const chromeNote = usePressNote();
  const { mode: clockMode } = useTimes();
  const satelliteNote = usePressNote();
  const trafficNote = usePressNote();
  const chatPanelRef = useRef<HTMLElement>(null);
  const chatFocusRef = useRef<{ lat: number; lon: number } | null>(null);
  const chatViewRef = useRef<{ camera: Camera; frame: DataFrame } | null>(null);
  const [panel, setPanel] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setPhone(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const autoChrome = (fly && flyDetail) || selectedTraffic.length > 0 || (!!point && !fly && !teaching);
  const chromeCollapsed = autoChrome ? !chromeLifted : userCollapsed;
  const focusToggleRef = useRef(false);
  const collapseToRef = useRef<(next: boolean) => void>(() => {});
  collapseToRef.current = (next: boolean) => {
    focusToggleRef.current = true;
    setUserCollapsed(next);
    setChromeLifted(!next);
    try {
      if (next) localStorage.setItem('isobar.header-collapsed', '1');
      else localStorage.removeItem('isobar.header-collapsed');
    } catch { /* this visit still holds the choice */ }
    chromeNote.show(next ? 'Days hidden' : 'Days shown');
  };
  const autoChromeRef = useRef(autoChrome);
  useEffect(() => {
    try {
      if (localStorage.getItem('isobar.header-collapsed') === '1') setUserCollapsed(true);
    } catch { /* stay expanded */ }
  }, []);
  useEffect(() => {
    if (autoChromeRef.current !== autoChrome) setChromeLifted(false);
    autoChromeRef.current = autoChrome;
  }, [autoChrome]);
  useLayoutEffect(() => {
    const node = chromeBodyRef.current;
    if (!node) return;
    const next = node.scrollHeight;
    const previous = chromeHeightRef.current;
    chromeHeightRef.current = next;
    if (previous == null || Math.abs(previous - next) < 1) {
      node.style.height = '';
      node.style.transition = '';
      delete node.dataset.anim;
      holdMapCentreRef.current = false;
      return;
    }
    holdMapCentreRef.current = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      node.style.height = '';
      node.style.transition = '';
      delete node.dataset.anim;
      // The height clear lays out once more. Keep the centre until that pass.
      requestAnimationFrame(() => { holdMapCentreRef.current = false; });
    };
    node.dataset.anim = '1';
    node.style.transition = 'none';
    node.style.height = `${previous}px`;
    const start = requestAnimationFrame(() => {
      if (reduced) {
        node.style.height = `${next}px`;
        requestAnimationFrame(() => requestAnimationFrame(release));
        return;
      }
      node.style.transition = 'height 220ms ease';
      node.style.height = `${next}px`;
    });
    const timer = window.setTimeout(release, 400);
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName === 'height') release();
    };
    node.addEventListener('transitionend', onEnd);
    return () => {
      cancelAnimationFrame(start);
      window.clearTimeout(timer);
      node.removeEventListener('transitionend', onEnd);
      if (!released) {
        node.style.height = '';
        node.style.transition = '';
        delete node.dataset.anim;
        holdMapCentreRef.current = false;
      }
    };
  }, [chromeCollapsed]);
  useLayoutEffect(() => {
    if (!focusToggleRef.current) return;
    focusToggleRef.current = false;
    chromeRef.current?.querySelector<HTMLElement>('[data-chrome-toggle]')?.focus();
  }, [chromeCollapsed]);
  useEffect(() => {
    const node = chromeRef.current;
    if (!node) return;
    let start: { x: number; y: number; id: number } | null = null;
    const ignore = (event: Event) => (event.target as Element | null)?.closest('input, select, a, [data-timeline], [data-chrome-toggle]');
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || ignore(event)) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      try { node.setPointerCapture(event.pointerId); } catch { /* a synthetic swipe has no capture */ }
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dy) < 36 || Math.abs(dy) < Math.abs(dx)) return;
      const stopClick = (click: Event) => {
        click.preventDefault();
        click.stopPropagation();
        node.removeEventListener('click', stopClick, true);
      };
      node.addEventListener('click', stopClick, true);
      window.setTimeout(() => node.removeEventListener('click', stopClick, true), 400);
      collapseToRef.current(dy < 0);
    };
    const cancel = () => { start = null; };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
    };
  }, []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tour') === '1') setAutoTour(true);
  }, []);
  useEffect(() => {
    if (!showSources) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[data-teach-card], [data-chat-panel], [data-point-panel], [data-fly-panel], [data-coastal-panel], [data-account-sheet], [data-map-menu]:not([hidden]), [data-place-open="true"], [data-map-chip]')) return;
      event.preventDefault();
      setShowSources(false);
      document.querySelector<HTMLButtonElement>('[aria-label="Data sources"]')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSources]);

  useEffect(() => {
    trackUsage('session-start', {});
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      noteUsage('session-end', {});
    };
    const off = onUsageHide(end);
    return () => {
      off();
      if (!ended) trackUsage('session-end', {});
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    // An in-range seek can supersede a pending fetch without changing this effect.
    const selectionVersion=historyRequest?.version??historySelectionVersion.current;
    const obsolete=()=>cancel||(historical&&selectionVersion!==historySelectionVersion.current);
    // Pressure streams up front; a colour field loads when its lens is chosen.
    const preserveHistoryView = historical && !!historyRequest?.date && historyRequest.event === historyEvent && !!chartRef.current;
    if(historical){if(!preserveHistoryView)setChart(undefined);setHistoryError('');}
    if(transitReadRef.current!==historical){transitReadRef.current=historical;transitAppliedRef.current=false;try {transitRef.current=parseMapTransit(sessionStorage.getItem(MAP_TRANSIT_KEY),historical?'/history':'/');}catch{}}
    const load = historical ? (async()=>{
      const query=new URLSearchParams(window.location.search);
      const result=await loadHistoricalChart(historyRequest??{event:query.get('event')??transitRef.current?.event,date:query.get('date')??transitRef.current?.date,hour:query.has('hour')?Number(query.get('hour')):transitRef.current?.hour});
      if(obsolete())return null;
      const variables = result.chart.manifest.variables;
      if ((fieldRef.current === 'rain' && !variables.rain24) || (fieldRef.current === 'temp' && !variables.t2m) || (fieldRef.current === 'wind' && (!variables.u10 || !variables.v10))) {
        fieldRef.current = 'none'; setField('none');
      }
      setFly(false); setCoastalLens(null);
      historicalStartRef.current=result.initialMs;
      setHistoryCatalog(result.catalog);setHistoryEvent(result.collection.id);
      return result.chart;
    })() : loadChart({ field:'none',fields:'opened' });
    load.then((loaded) => {
      if (obsolete()) return;
      // The first painted frame is the wall clock. Minute 0 is the model run
      // (8:00 am AWST on a 00Z run) and must not flash as "now".
      if (loaded) {
        const minuteNow = nowMinuteOf(loaded.manifest, historicalStartRef.current??Date.now());
        clockRef.current = { ...clockRef.current, minute: minuteNow, playing: preserveHistoryView ? clockRef.current.playing : true };
        setMinute(minuteNow);
        setPlaying(clockRef.current.playing);
      }
      setChart(loaded);
      if (!loaded) return;
      chartRef.current = loaded;
      let storedId: string | null = null;
      try {
        const value = localStorage.getItem('isobar.place');
        if (value && isPlaceId(value)) storedId = value;
      } catch { /* first visit */ }
      if (!preserveHistoryView) {
      const transfer=transitAppliedRef.current?null:transitRef.current;
      if(transfer?.pin)setPoint(transfer.pin);
      const storedPlace = transfer ? `g.${Math.round(transfer.lat*1000)}.${Math.round(transfer.lon*1000)}` : (historical?null:storedId) ?? loaded.manifest.places[0]?.id ?? 'sydney';
      placeSourceRef.current = transfer || storedId ? 'stored' : 'default';
      setPlaceHint(storedId ? readHint() : true);
      const storedSpeed = readStoredSpeed();
      placeRef.current = storedPlace;
      speedRef.current = storedSpeed;
      setPlaceId(storedPlace);
      setSpeed(storedSpeed);
      }
    }).catch((reason:unknown) => {
      if (!obsolete()) {const message=reason instanceof Error?reason.message:'Archive unavailable';if(preserveHistoryView)notifyMap(message);else setChart(null);setHistoryError(message);}
    });
    return () => { cancel = true; };
  }, [historical,historyRequest]);

  // Subscriptions belong to the displayed chart, not to a pending selection.
  // Cancelling a day fetch must leave the retained chart usable.
  useEffect(() => {
      if (!chart) return;
      const loaded = chart;
      let cancel = false;
      // Frames keep streaming after the first paint; re-read them a few times a second.
      let timer = 0;
      const listener = () => {
        if (timer) return;
        timer = window.setTimeout(() => {
          timer = 0;
          if (!cancel) setDataVersion((value) => value + 1);
        }, 250);
      };
      loaded.listeners.add(listener);
      loaded.complete.then(() => {
        if (!cancel) {
          setComplete(true);
          setDataVersion((value) => value + 1);
        }
      });
      return () => {
        cancel = true;
        loaded.listeners.delete(listener);
        window.clearTimeout(timer);
      };
  }, [chart]);

  useEffect(() => {
    setSavedIds(readSavedIds());
    let live = true;
    void loadAirports().then((rows) => {
      if (!live) return;
      setAirportRows(rows);
      setAirportsReady(true);
    }).catch(() => { if (live) setAirportsReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!chart) return;
    let cancelled = false;
    void loadPlaces().then((rows) => { if (!cancelled) { setPointPlaces(rows); setPlacesReady(true); } }).catch(() => { if (!cancelled) setPlacesReady(true); });
    return () => { cancelled = true; };
  }, [chart]);
  const pointDescribed = useMemo(() => {
    if (!point || !chart) return null;
    return describePoint(point, {
      towns: pointPlaces,
      airports: airportRows,
      manifest: chart.manifest.places,
      atSea: pointAtSea(chart, point.lat, point.lon),
    });
  }, [point, chart, pointPlaces, airportRows]);
  const pointTitle = point?.name ?? pointDescribed?.title ?? '';
  const pointDetail = pointDescribed?.detail ?? '';
  const [groundSection, setGroundSection] = useState<{ key: string; samples: SectionSample[] } | null>(null);
  const sectionCamera=cameraRef.current;
  const sectionGeometry:AtmosphereSlice|null=threeD&&point&&sectionCamera ? displayedSliceRef.current??{
    lat:point.lat,lon:point.lon,bearingRadians:sectionCamera.bearingRadians??0,
    halfWidthM:Math.max(200,Math.min(25000,sectionCamera.halfWidth/GEO.F*111320*Math.cos(point.lat*Math.PI/180)*.8)),
    halfDepthM:1,baseM:0,
  }:null;
  const sectionGeometryKey=sectionGeometry?JSON.stringify(sectionGeometry):'';
  const orientedSection=useMemo(()=>{
    if(!sectionGeometry)return null;
    const track=Array.from({length:101},(_,i)=>{
      const across=(i/50-1)*sectionGeometry.halfWidthM;
      const p=slicePoint(sectionGeometry,across,0);
      return {lat:p?.lat??NaN,lon:p?.lon??NaN,distanceKm:across/1000};
    });
    return elevationsAlong(track,(lon,lat)=>Number.isFinite(lat)&&Number.isFinite(lon)?elevationAtRef.current?.(lon,lat)??null:null);
  // Geometry identity changes with the shared camera or displayed slice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sectionGeometryKey,terrainEpoch]);
  const pointKey = point ? `${point.lat.toFixed(5)},${point.lon.toFixed(5)}` : '';
  useEffect(() => {
    if (!point || threeD) return;
    const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    const controller = new AbortController();
    let timer = 0;
    let tries = 0;
    const apply = (samples: SectionSample[]) => {
      if (!controller.signal.aborted) setGroundSection({ key, samples });
    };
    const run = () => {
      if (controller.signal.aborted) return;
      const load = sectionAtRef.current;
      // The relief worker absorbs a 404. A page fetch would print it on the console.
      if (!load && tries < 40) {
        tries += 1;
        timer = window.setTimeout(run, 50);
        return;
      }
      const request = load
        ? load(point.lat, point.lon, controller.signal)
        : loadTerrainSection(point.lat, point.lon, { signal: controller.signal });
      void request.then(apply).catch(() => apply([]));
    };
    run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [point,threeD]);
  const sectionSamples = orientedSection ?? (groundSection && groundSection.key === pointKey ? groundSection.samples : null);
  const terrainM = useMemo(() => {
    if (!point) return null;
    const centre = sectionSamples?.find((sample) => Math.abs(sample.distanceKm) < 1e-6);
    if (!threeD && centre?.metres != null) return centre.metres;
    return elevationAtRef.current?.(point.lon, point.lat) ?? null;
  }, [point, sectionSamples, terrainEpoch,threeD]);
  const cycloneReading=useMemo(()=>point&&chart?.cyclone?cyclonePoint(chart,Date.parse(chart.manifest.run)+(chart.manifest.forecastHours[0]*60+minute)*60000,point.lat,point.lon):null,[point,chart,minute]);
  const reconstructedPoint = useMemo(() => historical&&historyEvent==='everest-1953'&&chart&&point?everestAtmosphere(chart,Date.parse(chart.manifest.run)+minute*60000,elevationAtRef.current).profile(point.lat,point.lon):null,[historical,historyEvent,chart,point,minute,terrainEpoch]);
  const orographyM = useMemo(() => (point && chart ? orographyMetresAt(chart, point.lon, point.lat) : null), [point, chart, terrainEpoch]);
  const mslpHpa = useMemo(() => cycloneReading?.pressure ?? (point && chart ? chartScalarAt(chart, 'mslp', point.lon, point.lat) : null), [cycloneReading,point,chart,terrainEpoch]);
  useEffect(() => {
    if (!chart) return;
    const name = orographyVariable(Object.keys(chart.manifest.variables));
    if (name) void chart.want(name, 0);
    let ready = false;
    const onFrame = () => {
      const now = !!name && (chart.state[name]?.some((cell) => cell === FRAME_READY) ?? false);
      if (now === ready) return;
      ready = now;
      setTerrainEpoch((n) => n + 1);
    };
    chart.listeners.add(onFrame);
    onFrame();
    return () => { chart.listeners.delete(onFrame); };
  }, [chart]);

  useEffect(() => {
    const loaded = chart;
    if (!loaded) return;
    const stage = stageRef.current;
    const glCanvas = glCanvasRef.current;
    const canvasFallback = canvasFallbackRef.current;
    const overlay = overlayRef.current;
    if (!stage || !glCanvas || !canvasFallback || !overlay) return;

    const { manifest } = loaded;
    const span = (manifest.forecastHours[manifest.forecastHours.length - 1] - manifest.forecastHours[0]) * 60;
    const dlon = (manifest.east - manifest.west) / (manifest.nx - 1);
    const dlat = (manifest.south - manifest.north) / (manifest.ny - 1);

    const land = rasterLand(loaded);
    let gl = glRef.current;
    if (!gl) {
      try {
        gl = createGlChart(glCanvas);
        glRef.current = gl;
        if (gl) {
          gl.setLand(land.pixels, land.width, land.height, land);
          glCanvas.style.display = '';
          canvasFallback.style.display = 'none';
          setRenderer('webgl2');
        }
      } catch {
        gl = null;
        setRenderer('canvas');
      }
    }
    if(gl&&!transitAppliedRef.current&&transitRef.current){threeDRef.current=transitRef.current.threeD;setThreeD(threeDRef.current);tiltRef.current=threeDRef.current?transitRef.current.pitch:0;setTilt(tiltRef.current);}
    else if(gl&&!transitRef.current&&!homeRef.current&&manifest.places[0]?.id==='h.everest'){threeDRef.current=true;setThreeD(true);tiltRef.current=Math.PI/4;setTilt(Math.PI/4);}
    // The DEM also generalises pressure ink in both renderers; relief stays WebGL-only.
    let terrain: TerrainLayer | null = null;
    let elevationAt: ElevationAt | undefined;
    const acceptElevation = createElevationCoverage();
    elevationAtRef.current = null;
    setTerrainEpoch((n) => n + 1);
    let terrainRevision = 0;
    let overlayTerrainRevision = -1;
    let settledEpoch = 0;
    let paintedEpoch = 0;
    // Uploads already finished when the latest settled mosaic was handed over.
    let settleMark = -1;
    {
      const plate = gl;
      sectionAtRef.current = null;
      terrain = createTerrainLayer((mosaic) => {
        if (dead) return;
        // A small mosaic can finish uploading inside setTerrain. Mark the epoch
        // from before that upload, so painted waits until this mosaic is on the plate.
        elevationAt = acceptElevation(mosaic);
        elevationAtRef.current = elevationAt;
        if (!dead) setTerrainEpoch((n) => n + 1);
        terrainRevision++;
        const before = plate?.terrainEpoch() ?? 0;
        plate?.setTerrain({ data: mosaic.data, width: mosaic.width, height: mosaic.height, box: mosaic.box });
        const next = terrain?.stats();
        if (next && next.needed > 0 && next.loaded + next.missing >= next.needed && next.mosaics > 0) {
          settleMark = before;
          settledEpoch += 1;
        }
      });
      if (terrain) sectionAtRef.current = (lat, lon, signal) => terrain!.sampleSection(lat, lon, signal);
    }
    let placeRows: PlaceRow[] | null = null;
    let placeNames: string[] = [];
    let placesToken = 0;
    let placesDrawn = -1;
    let cssWidth = 1;
    let cssHeight = 1;
    // The map's own controls, in stage pixels: town names keep clear of them.
    let toolsBox: LabelBox | null = null;
    let canvasChart = canvasChartRef.current;
    if (!gl && !canvasChart) {
      canvasChart = createCanvasChart(canvasFallback);
      canvasChart.setLand(land);
      canvasChartRef.current = canvasChart;
      glCanvas.style.display = 'none';
      canvasFallback.style.display = 'block';
      setRenderer('canvas');
    }

    const nowMinute = () => nowMinuteOf(manifest, historicalStartRef.current??Date.now());
    clockRef.current = { ...clockRef.current, minute: nowMinute() };
    setMinute(clockRef.current.minute);
    setPlaying(clockRef.current.playing);

    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../workers/contour.worker.ts', import.meta.url));
    } catch {
      worker = null;
    }
    let contourId = 0;
    let busy = false;
    let queued = false;
    let lastKey = '';
    let pairKey = '';
    let overlayKey = '';
    let cameraUiDirty = false;
    let lastUi = 0;
    let lastStamp = performance.now();
    let dead = false;
    let firstChart = false;
    // Pointer and wheel events can outpace the display: they move the camera,
    // and the next frame draws it once (plate, overlay, barbs, React state).
    let cameraMoved = false;
    darkRef.current = document.documentElement.classList.contains('dark');
    const themeObserver = new MutationObserver(() => {
      const next = document.documentElement.classList.contains('dark');
      if (next === darkRef.current) return;
      darkRef.current = next;
      overlayKey = '';
      trafficDirtyRef.current = true;
      paintOverlay();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const size = () => {
      const rect = stage.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // The plate fills the whole panel; the camera frames Australia inside it.
      const frameW = width;
      const frameH = height;
      setStageSize({ width: frameW, height: frameH });
      cssWidth = frameW;
      cssHeight = frameH;
      const tools = stage.querySelector('.map-tools')?.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      toolsBox = tools && tools.width > 0 ? { x: tools.left - stageRect.left - 6, y: tools.top - stageRect.top - 6, w: tools.width + 12, h: tools.height + 12 } : null;
      for (const node of [glCanvas, canvasFallback, overlay, windCanvasRef.current, flowCanvasRef.current, satCanvasRef.current, trafficCanvasRef.current].filter((node): node is HTMLCanvasElement => !!node)) {
        node.style.left = '0px';
        node.style.top = '0px';
        node.style.width = `${frameW}px`;
        node.style.height = `${frameH}px`;
      }
      // The view never shows past the data grid or its faded edge: no blank margins, no line tails.
      const box = manifest.wrapsLongitude ? manifest : insetBox(manifest, EDGE_FADE_DEG + 0.25);
      const focus = manifest.wrapsLongitude ? focusRef.current ?? undefined : undefined;
      const frame = frameData(GEO, frameW, frameH, box, focus);
      if(manifest.places[0]?.id==='h.normandy'&&focus&&Math.abs(focus.lat-49.35)<.01&&Math.abs(focus.lon+.85)<.01){frame.home.halfHeight=.32;frame.home.halfWidth=.32*frameW/frameH;}
      if(loaded.cyclone&&focus&&Math.abs(focus.lat+12.46)<.01&&Math.abs(focus.lon-130.84)<.01){frame.home.halfHeight=1.3;frame.home.halfWidth=1.3*frameW/frameH;}
      if(manifest.places[0]?.id==='h.everest'&&focus&&Math.abs(focus.lat-27.9881)<.001&&Math.abs(focus.lon-86.925)<.001){frame.home.halfHeight=.04;frame.home.halfWidth=.04*frameW/frameH;}
      if (!transitAppliedRef.current && transitRef.current && manifest.wrapsLongitude) {
        const t=transitRef.current;const p=project(GEO,t.lat,t.lon)!;
        cameraRef.current={centerX:p.x,centerY:p.y,bearingRadians:t.threeD?(t.bearingRadians??0):0,halfHeight:t.degreesPerPixel?t.degreesPerPixel*frameH/2:t.halfHeight,halfWidth:t.degreesPerPixel?t.degreesPerPixel*frameW/2:t.halfHeight*frameW/frameH};transitAppliedRef.current=true;framedId.current=placeRef.current;
        try{sessionStorage.removeItem(MAP_TRANSIT_KEY);}catch{}
      } else if (!homeRef.current || !cameraRef.current) {
        cameraRef.current = frame.home;
      } else {
        const oldHome = homeRef.current.home;
        const camera = cameraRef.current;
        const prev = lastFrameRef.current;
        const untouched = Math.abs(camera.centerX - oldHome.centerX) < 1e-9 && Math.abs(camera.centerY - oldHome.centerY) < 1e-9
          && Math.abs(camera.halfWidth - oldHome.halfWidth) < 1e-9;
        const move = cameraMoveRef.current;
        // Same degrees per pixel and the same centre, for the camera on screen
        // and for both ends of a pan that has not landed yet. An untouched view
        // with nothing in flight adopts the new home.
        const preserveScale = (view: Camera): Camera => {
          const sized = prev ?? { width: frameW, height: frameH };
          const xPerPx = (view.halfWidth * 2) / Math.max(1, sized.width);
          const yPerPx = (view.halfHeight * 2) / Math.max(1, sized.height);
          const raw = {
            ...view,
            centerX: view.centerX,
            centerY: view.centerY,
            halfWidth: (xPerPx * frameW) / 2,
            halfHeight: (yPerPx * frameH) / 2,
          };
          const fitted = clampToData(GEO, raw, frame);
          // A collapsing bar must not slide or zoom the chart. Preserve the
          // geographic centre and horizontal scale throughout its animation;
          // intermediate layouts must not accumulate a width drift.
          return holdMapCentreRef.current ? raw : fitted;
        };
        if ((!move && untouched && !holdMapCentreRef.current) || !prev) {
          cameraRef.current = frame.home;
          if (!prev) cameraMoveRef.current = null;
        } else {
          cameraRef.current = preserveScale(camera);
          if (move) cameraMoveRef.current = {
            ...move, from: preserveScale(move.from),
            // Restore from the original view at every header-animation frame.
            // Resizing an already rebased target accumulates zoom and centre drift.
            to: move.restore ? reframeCamera(GEO, move.restore.camera, move.restore.frame, frame) : preserveScale(move.to),
          };
        }
      }
      homeRef.current = frame;
      lastFrameRef.current = { width: frameW, height: frameH };
      gl?.resize(frameW, frameH);
      canvasChart?.resize(frameW, frameH);
      overlay.width = Math.round(frameW * dpr);
      overlay.height = Math.round(frameH * dpr);
      if (windCanvasRef.current) { windCanvasRef.current.width = overlay.width; windCanvasRef.current.height = overlay.height; }
      if (trafficCanvasRef.current) { trafficCanvasRef.current.width = overlay.width; trafficCanvasRef.current.height = overlay.height; }
      if (flowCanvasRef.current) { flowCanvasRef.current.width = overlay.width; flowCanvasRef.current.height = overlay.height; }
      if (satCanvasRef.current) { satCanvasRef.current.width = overlay.width; satCanvasRef.current.height = overlay.height; }
      overlayKey = '';
      const centre = cameraRef.current ? unproject(GEO, cameraRef.current.centerX, cameraRef.current.centerY) : null;
      noteViewRef.current(centre?.lat ?? null, centre?.lon ?? null);
      return { width: frameW, height: frameH, dpr };
    };

    const paintOverlay = () => {
      const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
      const ctx = overlay.getContext('2d');
      if (camera) {
        const centre = unproject(GEO, camera.centerX, camera.centerY);
        noteViewRef.current(centre?.lat ?? null, centre?.lon ?? null);
      }
      if (!camera || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = overlay.width / dpr;
      const height = overlay.height / dpr;
      const stageRect = stage.getBoundingClientRect();
      const uiBox = (selector: string, pad: number): LabelBox | null => {
        const node = stage.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;
        return { x: rect.left - stageRect.left - pad, y: rect.top - stageRect.top - pad, w: rect.width + pad * 2, h: rect.height + pad * 2 };
      };
      const uiAvoid = [uiBox('.map-tools', 8), uiBox('.map-legend', 8), uiBox('.map-chat-float', 6), uiBox('.map-sources', 8), uiBox('.traffic-replay-status', 8), uiBox('[data-atmosphere-instrument]', 8)].filter((box): box is LabelBox => !!box);
      // Positions matter: a control that mounts or moves (the chat float follows
      // the exposed map) must re-run label placement, not just a size change.
      const lonSpan = GEO.projection === 'equirectangular' ? (camera.halfWidth * 2) / GEO.F : (camera.halfWidth * 2 * 180) / Math.PI;
      const latSpan = GEO.projection === 'equirectangular' ? Math.abs(camera.halfHeight * 2) : Math.abs(camera.halfHeight * 2 * 180 / Math.PI);
      const borderSet = historical ? null : Math.min(lonSpan, latSpan) <= 12 && bordersCloseRef.current ? bordersCloseRef.current : bordersRegionalRef.current;
      const sceneTime=Date.parse(manifest.run)+(manifest.forecastHours[0]*60+clockRef.current.minute)*60000;
      const sceneKey=manifest.places[0]?.id==='h.normandy'?`${Math.floor(sceneTime/1000)}:${Object.values(historyLayersRef.current).join(',')}`:'';
      const key = `${sceneKey}:${width.toFixed(1)}:${height.toFixed(1)}:${camera.centerX.toFixed(4)}:${camera.centerY.toFixed(4)}:${camera.halfWidth.toFixed(4)}:${camera.halfHeight.toFixed(4)}:${tiltRef.current}:${camera.bearingRadians??0}:${contoursRef.current.lines.length}:${contourId}:${terrainRevision}:${darkRef.current}:${fieldRef.current}:${placeRows ? placeRows.length : -1}:${uiAvoid.map((box) => `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}`).join(';')}:${unitKey(unitsRef.current)}:${graticuleRef.current ? 1 : 0}:${borderEpochRef.current}:${atmosphereInspectionRef.current}:${sliced}:${sliceRef.current?JSON.stringify(sliceRef.current):""}:${borderSet === bordersCloseRef.current ? 1 : 0}:${manifest.places[0]?.id==='h.everest'?Math.floor(clockRef.current.minute):''}`;
      if (key === overlayKey) return;
      overlayKey = key;
      const degPerPixel = (camera.halfWidth * 2) / Math.max(1, width);
      // World projection units are degrees; regional Lambert units are radians.
      const lod = manifest.wrapsLongitude
        ? (degPerPixel > 0.15 ? 2 : degPerPixel > 0.045 ? 1 : 0)
        : (degPerPixel > 0.0018 ? 2 : degPerPixel > 0.0008 ? 1 : 0);
      // Reserve the highest-ranked visible town before contour labels. Otherwise
      // an animated pressure number can repeatedly displace the city's name.
      const storm=cycloneAt(loaded.cyclone,Date.parse(manifest.run)+(manifest.forecastHours[0]*60+clockRef.current.minute)*60000);
      const centre=storm?mapProject(GEO,camera,storm.lat,storm.lon):null;
      const stormBox=centre?[{x:(centre.x+1)*width/2-28,y:(1-centre.y)*height/2-30,w:56,h:64}]:[];
      const anchor = paintPlaces(ctx, width, height, camera, [...uiAvoid,...stormBox], true).slice(0, 1);
      const avoid = drawOverlay(ctx, width, height, dpr, GEO, camera, loaded.coastLod[lod] ?? loaded.coast, contoursRef.current.lines, contoursRef.current.centres, !gl && !canvasChart?.usable(), manifest, darkRef.current ? NIGHT_INK : DAY_INK, [...uiAvoid, ...anchor], unitsRef.current, elevationAt, graticuleRef.current, borderSet, loaded.water,loaded.cyclone?10:0);
      // Town names keep clear of the map's own controls too, not just the
      // chart labels: drawOverlay returns only what it drew, so the UI boxes
      // must be carried into the place pass explicitly.
      const peaks = paintPeaks(ctx, width, height, camera, [...uiAvoid, ...avoid, ...anchor]);
      const camps = manifest.places[0]?.id==='h.everest' ? drawEverestRoute(ctx, GEO, camera, elevationAt ?? null, width, height, [...uiAvoid, ...avoid, ...peaks, ...anchor, toolsBox ?? {x:width-56,y:0,w:56,h:168}, {x:0,y:height-36,w:width,h:36}], darkRef.current ? NIGHT_PLACES : DAY_PLACES, {timeMs:Date.parse(manifest.run)+(manifest.forecastHours[0]*60+clockRef.current.minute)*60000,chart:loaded}) : [];
      const scene=manifest.places[0]?.id==='h.normandy'?drawHistoricalScene(ctx,GEO,camera,elevationAt??null,width,height,sceneTime,historyLayersRef.current,[...uiAvoid,...avoid,...peaks,...camps],darkRef.current?NIGHT_PLACES:DAY_PLACES):{labels:[],markers:[]};
      const places = paintPlaces(ctx, width, height, camera, [...uiAvoid, ...avoid, ...peaks, ...camps,...scene.labels,...scene.markers]);
      labelRecords = [...avoid, ...peaks, ...camps,...scene.labels, ...places];
      drawAdminNames(ctx, historical ? [] : adminNamesRef.current, GEO, camera, width, height, labelRecords, darkRef.current ? NIGHT_PLACES : DAY_PLACES);
      if(atmosphereInspectionRef.current>0&&tiltRef.current>0){
        ctx.save();ctx.globalCompositeOperation='destination-out';
        const fade=ctx.createLinearGradient(0,height*.4,0,height);fade.addColorStop(0,'rgba(0,0,0,0)');fade.addColorStop(1,`rgba(0,0,0,${atmosphereInspectionRef.current*.9})`);
        ctx.fillStyle=fade;ctx.fillRect(0,0,width,height);ctx.restore();
      }
    };

    // The active lens's value at a town, at the playhead: nearest grid cell, as on the Mac.
    const placeReading = (): PlaceReading | null => {
      const field = fieldRef.current;
      if (field === 'none') return null;
      const minute = clockRef.current.minute;
      const name = FIELD_VARIABLE[field];
      const cycloneSample=loaded.cyclone?createWindSampler(loaded,minute):null;
      return (lat, lon) => {
        if(field==='wind'&&cycloneSample){const w=cycloneSample(lon,lat);return w?readingText(field,Math.hypot(w.u,w.v),compassFrom(w.u,w.v),unitsRef.current):null;}
        const column = Math.round((lon - manifest.west) / manifest.step);
        const i = manifest.wrapsLongitude ? ((column % manifest.nx) + manifest.nx) % manifest.nx : column;
        const j = Math.round((manifest.north - lat) / manifest.step);
        if (i < 0 || j < 0 || i >= manifest.nx || j >= manifest.ny) return null;
        const cell = j * manifest.nx + i;
        const value = windComponent(loaded, name, cell, minute);
        if (value == null) return null;
        let direction: string | null = null;
        if (field === 'wind') {
          const u = windComponent(loaded, 'u10', cell, minute), v = windComponent(loaded, 'v10', cell, minute);
          direction = u != null && v != null ? compassFrom(u, v) : null;
        }
        return readingText(field, value, direction, unitsRef.current);
      };
    };

    let labelRecords: DrawnLabel[] = [];
    let peakNames: string[] = [];
    const paintPeaks = (ctx: CanvasRenderingContext2D, width: number, height: number, camera: Camera, avoid: LabelBox[]): DrawnLabel[] => {
      const placed = drawPeaks(ctx, SUMMITS, GEO, camera, width, height, avoid, darkRef.current ? NIGHT_PLACES : DAY_PLACES, unitsRef.current, Math.min(width, height) < 500 ? 12 : 24);
      labelledPeaksRef.current = placed.placed;
      peakNames = placed.names;
      return placed.labels;
    };
    const placeWater = new Map<string, boolean>();
    const placeOnWater = loaded.water.rings.length ? (lat: number, lon: number) => {
      const key = `${lat}:${lon}`;
      let water = placeWater.get(key);
      if (water === undefined) { water = lakeContains(loaded.water, lon, lat); placeWater.set(key, water); }
      return water;
    } : undefined;
    const paintPlaces = (ctx: CanvasRenderingContext2D, width: number, height: number, camera: Camera, avoid: LabelBox[], measureOnly = false): DrawnLabel[] => {
      const span = GEO.projection === 'equirectangular' ? (camera.halfWidth * 2) / GEO.F : Infinity;
      if (!manifest.wrapsLongitude || span > PLACES_MAX_SPAN) {
        placeNames = [];
        placesDrawn = placesToken;
        return [];
      }
      if (!placeRows) {
        void loadPlaces().then((rows) => {
          if (dead || placeRows) return;
          placeRows = rows;
          overlayKey = '';
          paintOverlay();
        });
        return [];
      }
      // The map's own controls and the legend (bottom left). Collision is the only reason to skip a ranked town.
      const reserved: LabelBox[] = [...avoid, toolsBox ?? { x: width - 56, y: 0, w: 56, h: 168 }, { x: 0, y: height - 36, w: width, h: 36 }];
      const placed = drawPlaces(ctx, placeRows, GEO, camera, width, height, reserved, darkRef.current ? NIGHT_PLACES : DAY_PLACES, placeReading(), measureOnly ? 1 : Math.min(width, height) < 500 ? 6 : PLACES_MAX_LABELS, measureOnly, placeOnWater);
      if (measureOnly) return placed.labels;
      placeNames = placed.names;
      placesDrawn = placesToken;
      return placed.labels;
    };

    const waterLayer: WaterLayer | null = loaded.water.rings.length
      ? createWaterLayer(loaded.water, (raster) => {
        if (dead) return;
        gl?.setWater(raster.pixels, raster.width, raster.height, raster);
        canvasChart?.setWater(raster);
        overlayKey = '';
        cameraMoved = true;
      })
      : null;

    const paintGl = (frameDt = 0) => {
      if(cameraRef.current)orientSlice(cameraRef.current);
      const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
      if ((!gl && !canvasChart) || !camera) return;
      waterLayer?.update(GEO, camera, cssWidth, cssHeight);
      const absolute = manifest.forecastHours[0] * 60 + clockRef.current.minute;
      const blend = frameBlend(manifest.forecastHours, absolute);
      if (!blend) return;
      const active = fieldRef.current === 'none' ? 'mslp' : FIELD_VARIABLE[fieldRef.current];
      loaded.prepare?.(clockRef.current.minute, [active, 'u10', 'v10', ...(satelliteRef.current ? ['tcc'] : [])]);
      const spec = manifest.variables[active];
      const ready = blendReady(loaded, active, blend.i0, blend.i1);
      const nextPair = `${active}:${blend.i0}:${blend.i1}`;
      // Never clear the plate on a lens change. Fade the current field out,
      // then swap textures and fade the new one in. Playback stays on the
      // same field, so a new frame pair replaces in place.
      const want = fieldRef.current;
      const ease = (target: number) => {
        fieldCoverRef.current += (target - fieldCoverRef.current) * Math.min(1, frameDt * 14);
      };
      const upload = () => {
        pairKey = nextPair;
        const a = chartFrame(loaded, active, blend.i0);
        const b = chartFrame(loaded, active, blend.i1);
        gl?.setFrames(a, b, manifest.nx, manifest.ny);
        canvasChart?.setFrames(a && spec ? { data: a, scale: spec.scale, offset: spec.offset, fill: spec.fill } : null, b && spec ? { data: b, scale: spec.scale, offset: spec.offset, fill: spec.fill } : null);
        shownFieldRef.current = want;
      };
      if (want === 'none' || !ready) {
        ease(0);
        if (fieldCoverRef.current < 0.02) shownFieldRef.current = 'none';
      } else if (shownFieldRef.current !== want && fieldCoverRef.current > 0.04) {
        ease(0);
      } else {
        if (nextPair !== pairKey) upload();
        ease(1);
      }
      const drawField = fieldCoverRef.current > 0.02 ? shownFieldRef.current : 'none';
      const drawSpec = drawField === 'none' ? spec : manifest.variables[FIELD_VARIABLE[drawField]];
      const view = {
        cyclone:cycloneAt(loaded.cyclone,Date.parse(manifest.run)+absolute*60000),
        camera,
        ...camera,
        tiltCamera: renderCamera(camera).tiltCamera,
        slice: renderCamera(camera).slice,
        lambert: GEO,
        west: manifest.west,
        north: manifest.north,
        dlon,
        dlat,
        nx: manifest.nx,
        ny: manifest.ny,
        blend: blend.t,
        field: drawField,
        kiteBand: kiteTintRef.current,
        fieldAlpha: fieldCoverRef.current,
        dark: darkRef.current,
        wrapsLongitude: manifest.wrapsLongitude,
        scale: drawSpec.scale,
        offset: drawSpec.offset,
        fill: drawSpec.fill,
        cutaway: tiltRef.current>0?atmosphereInspectionRef.current:0,
        relief: terrain ? terrain.update(GEO, {...renderCamera(camera),slice:threeDRef.current?sliceRef.current:undefined}, cssWidth, Math.min(2, window.devicePixelRatio || 1)) : 0,
      };
      gl?.draw(view);
      canvasChart?.draw(view);
      const sliceIsReady=!!(sliceRef.current&&gl?.sliceReady(sliceRef.current));
      if(sliceIsReady&&sliceRef.current!==displayedSliceRef.current){
        if(sliceRef.current&&elevationAtRef.current){const base=terrainSliceBase(sliceRef.current,elevationAtRef.current);if(base!=null)sliceRef.current={...sliceRef.current,baseM:base};}
        displayedSliceRef.current=sliceRef.current;overlayKey='';cameraMoved=true;
      }
      if(sliceIsReady!==sliceReadyRef.current){
        sliceReadyRef.current=sliceIsReady;setSliceReady(sliceIsReady);overlayKey='';cameraMoved=true;
      }
      const uploaded = gl?.terrainEpoch() ?? 0;
      if (settledEpoch > paintedEpoch && uploaded > settleMark) paintedEpoch = settledEpoch;
    };

    const sendContour = () => {
      const absolute = manifest.forecastHours[0] * 60 + clockRef.current.minute;
      const blend = frameBlend(manifest.forecastHours, absolute);
      if (!blend) return;
      // Isobars follow the clock continuously: a new contour whenever the worker is free.
      const key = `${blend.i0}:${blend.i1}:${blend.t.toFixed(4)}`;
      if (key === lastKey && !queued) return;
      // Keep the last isobars until both MSLP frames of this blend have arrived.
      if (!blendReady(loaded, 'mslp', blend.i0, blend.i1)) return;
      if (busy) {
        queued = true;
        return;
      }
      lastKey = key;
      queued = false;
      busy = true;
      const id = ++contourId;
      const spec = manifest.variables.mslp;
      const blended = blendFrame(
        chartFrame(loaded, 'mslp', blend.i0),
        chartFrame(loaded, 'mslp', blend.i1),
        blend.t,
        spec,
      );
      if (!worker) {
        let result = contourPressure(blended, manifest.nx, manifest.ny, manifest.west, manifest.north, dlon, dlat, 4);
        const storm=cycloneAt(loaded.cyclone,Date.parse(manifest.run)+absolute*60000);
        if(storm){const environment=smoothGrid(smoothGrid(blended,manifest.nx,manifest.ny,manifest.wrapsLongitude),manifest.nx,manifest.ny,manifest.wrapsLongitude);result=cycloneContours(result,storm,(lon,lat)=>sampleFrame(environment,manifest,lon,lat));}
        contoursRef.current = result;
        busy = false;
        overlayKey = '';
        setIsobars(true);
        paintOverlay();
        if (!firstChart) { firstChart = true; performance.mark('isobar-first-chart'); }
        return;
      }
      worker.postMessage({
        cyclone:cycloneAt(loaded.cyclone,Date.parse(manifest.run)+absolute*60000),
        id,
        mslp: blended,
        nx: manifest.nx,
        ny: manifest.ny,
        west: manifest.west,
        north: manifest.north,
        dlon,
        dlat,
      }, [blended.buffer]);
    };

    if (worker) {
      worker.onmessage = (event: MessageEvent<{ id: number; lines: Polyline[]; centres: PressureCentre[] }>) => {
        busy = false;
        if (dead) return;
        if (event.data.id === contourId) {
          contoursRef.current = { lines: event.data.lines, centres: event.data.centres };
          overlayKey = '';
          setIsobars(true);
          paintOverlay();
          if (!firstChart) {
            firstChart = true;
            performance.mark('isobar-first-chart');
          }
        }
        if (queued) sendContour();
      };
    }

    const flowLayer: FlowLayer | null = flowCanvasRef.current ? createFlowLayer(flowCanvasRef.current) : null;
    const satLayer: SatelliteLayer | null = satCanvasRef.current ? createSatelliteLayer(satCanvasRef.current) : null;
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = reduceQuery.matches;
    const onReduce = () => { reducedMotion = reduceQuery.matches; };
    reduceQuery.addEventListener('change', onReduce);
    let shownCloud: string | null = null;

    const dataArrived = () => { placesToken += 1; overlayKey = ''; cameraMoved = true; };
    loaded.listeners.add(dataArrived);
    size();
    paintGl();
    sendContour();
    setReady(true);

    let lastWind = 0;
    const paintWind = (now: number, force = false) => {
      const node = windCanvasRef.current, camera = cameraRef.current;
      const ctx = node?.getContext('2d');
      if (!node || !ctx || !camera || (!force && now - lastWind < 160)) return;
      lastWind = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (windRef.current) drawWindBarbs(ctx, loaded, GEO, renderCamera(camera), node.width / dpr, node.height / dpr, dpr, clockRef.current.minute, darkRef.current);
      else ctx.clearRect(0, 0, node.width, node.height);
    };
    let lastTraffic = 0;
    let trafficWasOn = false;
    const paintTrafficLayer = (now: number, force = false) => {
      const node = trafficCanvasRef.current;
      const ctx = node?.getContext('2d');
      if (!node || !ctx) return;
      const mark = node as HTMLCanvasElement & { trafficGlyphs?: TrafficGlyph[] };
      if (!trafficRef.current) {
        if (trafficWasOn || node.dataset.traffic !== 'off') {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, node.width, node.height);
          node.dataset.traffic = 'off';
          node.dataset.trafficCount = '0';
          mark.trafficGlyphs = [];
          glyphsRef.current = [];
          trafficWasOn = false;
          setTrafficReplay(null);
        }
        return;
      }
      if (!force && !trafficDirtyRef.current && now - lastTraffic < (clockRef.current.playing ? 50 : 200)) return;
      lastTraffic = now;
      trafficDirtyRef.current = false;
      trafficWasOn = true;
      const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = node.width / dpr;
      const height = node.height / dpr;
      if (!camera || !(width > 0 && height > 0)) return;
      const epoch = Date.now();
      const avoid = chromeAvoid(stage);
      const selectedMs = Date.parse(manifest.run) + (manifest.forecastHours[0] * 60 + clockRef.current.minute) * 60000;
      const live = liveTrafficAtTime(clockRef.current.followNow, clockRef.current.playing, selectedMs, epoch);
      const previousHeld = heldTrafficRef.current;
      if (live) {
        heldTrafficRef.current = null;
        lastLiveTrafficRef.current = { selectedMs, epoch, aircraft: trafficInPicture(trafficSnapRef.current, trailsRef.current, epoch), trails: new Map(trailsRef.current), routes: new Map(routesRef.current) };
      } else if (lastLiveTrafficRef.current) {
        const prior = lastLiveTrafficRef.current;
        heldTrafficRef.current = !clockRef.current.playing && Math.abs(selectedMs - prior.selectedMs) < 1000 ? { ...prior, selectedMs } : null;
        lastLiveTrafficRef.current = null;
      }
      if (heldTrafficRef.current && (clockRef.current.playing || Math.abs(selectedMs - heldTrafficRef.current.selectedMs) > 1)) heldTrafficRef.current = null;
      const held = heldTrafficRef.current;
      if (held !== previousHeld) {
        // The canvas captures this picture after Pause has rendered. Publish
        // that transition to the cards immediately; a ref alone leaves them
        // showing missing replay data until the next network poll.
        setMinute(clockRef.current.minute);
        refreshTraffic(n => n + 1);
      }
      const pictureTrails = held?.trails ?? trailsRef.current;
      const aircraft = live ? lastLiveTrafficRef.current!.aircraft : held?.aircraft ?? trafficAtTime(trailsRef.current, selectedMs);
      const glyphs = layoutTraffic({
        aircraft,
        // Historical headings come from the sampled segment, never the latest trail.
        trails: live || held ? pictureTrails : new Map(),
        nowMs: held?.epoch ?? (live ? epoch : selectedMs),
        geo: GEO,
        camera,
        width,
        height,
        selectedColors: new Map(selectedTrafficRef.current.map((item) => [item.hex, trackColor(item.colorIndex, darkRef.current)])),
        avoid,
      });
      paintTraffic(ctx, glyphs, dpr, darkRef.current, () => paintTrafficPaths(ctx, { selected: selectedTrafficRef.current, trails: pictureTrails, routes: held?.routes ?? routesRef.current, timeMs: live || held ? undefined : selectedMs, geo: GEO, camera, width, height, dark: darkRef.current }));
      setTrafficReplay(live || held ? null : glyphs.length ? 'replay' : 'missing');
      node.dataset.trafficTime = String(selectedMs);
      node.dataset.trafficMode = live ? 'live' : 'replay';
      node.dataset.trafficPaths = String(selectedTrafficRef.current.length);
      node.dataset.traffic = 'on';
      node.dataset.trafficCount = String(glyphs.length);
      mark.trafficGlyphs = glyphs;
      glyphsRef.current = glyphs;
      const centre = unproject(GEO, camera.centerX, camera.centerY);
      if (centre && lastTileRef.current) {
        const tile = trafficTile(centre.lat, centre.lon, viewRadiusNm(GEO, camera));
        if (tile && tile.key !== lastTileRef.current) {
          lastTileRef.current = tile.key;
          pollKickRef.current?.();
        }
      }

    };
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const camera = cameraRef.current, home = homeRef.current;
      if (!camera || !home) return;
      const rect = overlay.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return;
      const x = (clientX - rect.left) / rect.width * 2 - 1;
      const y = 1 - (clientY - rect.top) / rect.height * 2;
      cameraMoveRef.current = null;
      cameraRef.current = zoomShared(camera, x, y, factor, home);
      cameraMoved = true;
    };
    const trackpad = bindTrackpadPinch(overlay, (factor, x, y) => {
      // iOS may deliver both pointer and gesture events. Touch pointers own
      // their pinch; this path fills Safari's trackpad-only event gap.
      if (pointersRef.current.size < 2) { zoomAt(factor, x, y); }
    });
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (trackpad.active()) return;
      const camera = cameraRef.current, home = homeRef.current;
      if (!camera || !home) return;
      const rect = overlay.getBoundingClientRect();
      // Trackpad parallel motion orbits/tilts only in selected 3D mode. Pinch is ctrl-wheel;
      // line/page wheel events keep mouse zoom available.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const delta = Math.max(-80, Math.min(80, event.deltaY * unit));
      if (event.ctrlKey || event.metaKey || event.deltaMode !== 0 || GEO.projection !== 'equirectangular' || !gl || !threeDRef.current) zoomAt(Math.exp(delta * .012), event.clientX, event.clientY);
      else changeOrientation(tiltRef.current + delta * .004,Math.max(-80,Math.min(80,event.deltaX*unit))*.004);
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    let raf = 0;
    let paintedField = fieldRef.current;
    let shownFlowSource: WindDisplaySource = 'unavailable';
    let legendWait = 0;
    const loop = (now: number) => {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      const elapsed = Math.max(0, (now - lastStamp) / 1000);
      const dt = Math.min(0.05, elapsed);
      lastStamp = now;
      if (!holdingRef.current && clockRef.current.playing) {
        const next = advancePlayback(clockRef.current, speedRef.current === REAL_TIME ? elapsed : dt, speedRef.current, span, nowMinute());
        clockRef.current = next;
      }
      if(keyboardStepRef.current(dt)) cameraMoved=true;
      const move = cameraMoveRef.current;
      if (move) {
        cameraRef.current = cameraDuringMove(move, now);
        cameraMoved = true;
        if (now >= move.start + move.duration && !(move.restore && holdMapCentreRef.current)) cameraMoveRef.current = null;
      }
      if(threeDRef.current && cameraRef.current) {
        const heading=recoveryRef.current.sample(now,pointersRef.current.size>0||mapKeysRef.current.size>0||!!cameraMoveRef.current,reducedMotion);
        if(heading!==null){cameraRef.current={...cameraRef.current,bearingRadians:heading};savedBearingRef.current=heading;cameraMoved=true;}
      }
      paintGl(dt);
      const cameraNow = cameraRef.current ? renderCamera(cameraRef.current) : null;
      // A pan or zoom that carries the point off the map closes it. A resize
      // or panel reframe keeps the point: the layout effect brings it back.
      if (pointRef.current && cameraNow && !cameraMoveRef.current && overlay.width > 0) {
        const sizeKey = `${overlay.width}x${overlay.height}`;
        const camKey = `${cameraNow.centerX.toFixed(4)}:${cameraNow.centerY.toFixed(4)}:${cameraNow.halfWidth.toFixed(4)}:${cameraNow.halfHeight.toFixed(4)}:${cameraNow.bearingRadians??0}:${tiltRef.current}`;
        const clip = mapProject(GEO, {...cameraNow,slice:undefined}, pointRef.current.lat, pointRef.current.lon);
        const inside = !!clip && Math.abs(clip.x) <= 1 && Math.abs(clip.y) <= 1;
        if (inside) {
          pointSeenCamRef.current = camKey;
          pointSeenSizeRef.current = sizeKey;
        } else if (pointSeenSizeRef.current !== sizeKey) {
          // The resize handler changes the camera with the canvas. That is not a pan.
          pointSeenSizeRef.current = sizeKey;
          pointSeenCamRef.current = camKey;
        } else if (pointSeenCamRef.current && pointSeenCamRef.current !== camKey) {
          pointSeenCamRef.current = '';
          pointViewRef.current = null;
          pointRef.current = null;
          setPoint(null);
        }
      } else if (!pointRef.current) {
        pointSeenCamRef.current = '';
      }
      if (cameraNow && flowLayer) {
        const flow = flowLayer.draw({
          chart: loaded,
          minute: clockRef.current.minute,
          geo: GEO,
          camera: cameraNow,
          dark: darkRef.current,
          windLens: fieldRef.current === 'wind',
          reduced: reducedMotion,
          dt,
          cssWidth,
          cssHeight,
        });
        if (flow.windSource !== shownFlowSource) {
          shownFlowSource = flow.windSource;
          setFlowSource(shownFlowSource);
        }
      }
      if (satLayer && cameraNow) {
        const word = satLayer.draw({
          enabled: satelliteRef.current,
          chart: loaded,
          minute: clockRef.current.minute,
          nowMs: Date.now(),
          geo: GEO,
          camera: cameraNow,
          dark: darkRef.current,
          cssWidth,
          cssHeight,
        });
        const nextWord = satelliteRef.current ? word : null;
        if (nextWord !== shownCloud) {
          shownCloud = nextWord;
          setCloudLegend(nextWord);
        }
      }
      if (fieldRef.current !== paintedField) {
        paintedField = fieldRef.current;
        legendWait = 3;
      }
      if (cameraMoved || legendWait > 0 || overlayTerrainRevision !== terrainRevision) {
        overlayTerrainRevision = terrainRevision;
        cameraMoved = false;
        if (legendWait > 0) legendWait -= 1;
        overlayKey = '';
        paintOverlay();
        paintWind(now, true);
        paintTrafficLayer(now, true);
        // Geographic DOM layers must follow every frame. Plain 2D has only
        // numeric controls to refresh, so batch those with the clock readout.
        if (tiltRef.current > .02 || teachingRef.current || pointRef.current) {
          refreshCamera((n) => n + 1);
          cameraUiDirty = false;
        } else cameraUiDirty = true;
      }
      paintWind(now);
      paintTrafficLayer(now);
      sendContour();
      if (now - lastUi > 140) {
        lastUi = now;
        if (cameraUiDirty) {
          cameraUiDirty = false;
          refreshCamera((n) => n + 1);
        }
        setMinute(clockRef.current.minute);
        setPlaying(clockRef.current.playing);
        // Re-check label placement against controls that moved without a camera
        // change (the keyed early-out makes an unchanged pass cheap).
        paintOverlay();
      }
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      size();
      paintGl();
      paintOverlay();
      paintTrafficLayer(performance.now(), true);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(stage);

    const api = {
      nowMinute,
      span,
      camera: () => cameraRef.current,
      tilt: () => tiltRef.current,
      cutaway: () => atmosphereInspectionRef.current,
      slice: () => sliceRef.current ?? null,
      sliceReady: () => sliceReadyRef.current,
      displayedSlice: () => displayedSliceRef.current ?? null,
      tiltGeometry: () => cameraRef.current ? renderCamera(cameraRef.current).tiltCamera?.geometry ?? null : null,
      eyeClearance: () => {
        const tilted = cameraRef.current ? renderCamera(cameraRef.current).tiltCamera : null;
        if (!tilted) return null;
        const eye = terrainEye(tilted), ground = elevationAtRef.current?.(eye.lon, eye.lat) ?? null;
        return {eye, ground, clearance: ground == null ? null : eye.heightM-ground};
      },
      cache: () => loaded.cacheStats?.() ?? null,
      /** Centre on a point. `heightDeg` is the geographic height of the view. */
      setView(lat: number, lon: number, heightDeg: number) {
        const camera = cameraRef.current, home = homeRef.current;
        if (!camera || !home) return;
        const point = project(GEO, lat, lon);
        if (!point) return;
        cameraMoveRef.current = null;
        const north = project(GEO, Math.min(89, lat + 1), lon);
        const perDegree = north && north.y !== point.y ? Math.abs(north.y - point.y) : 1;
        const aspect = camera.halfWidth / Math.max(camera.halfHeight, 1e-6);
        // A view that cannot sit on this point is tightened until it can.
        // Sliding the centre off the point would query traffic beside the place.
        let halfHeight = (heightDeg / 2) * perDegree;
        const place = (half: number) => clampToData(GEO, { centerX: point.x, centerY: point.y, halfHeight: half, halfWidth: half * aspect }, home);
        let placed = place(halfHeight);
        let best = placed;
        let bestDist = Infinity;
        for (let i = 0; i < 16; i++) {
          const centre = unproject(GEO, placed.centerX, placed.centerY);
          const lonDelta = centre ? Math.abs(((centre.lon - lon + 540) % 360) - 180) : 180;
          const dist = centre ? Math.hypot(centre.lat - lat, lonDelta) : Infinity;
          if (dist < bestDist) { bestDist = dist; best = placed; }
          if (dist <= 0.2) break;
          halfHeight *= 0.8;
          if (halfHeight < perDegree * 0.4) break;
          placed = place(halfHeight);
        }
        cameraRef.current = best;
        const centre = unproject(GEO, best.centerX, best.centerY);
        noteViewRef.current(centre?.lat ?? null, centre?.lon ?? null);
        api.redraw();
      },
      labels: () => labelRecords.map((label) => ({ ...label })),
      terrain: () => {
        const stats = terrain?.stats() ?? null;
        if (!stats) return null;
        const settled = stats.needed > 0 && stats.loaded + stats.missing >= stats.needed && stats.mosaics > 0;
        return { ...stats, painted: settled && paintedEpoch === settledEpoch && settledEpoch > 0 };
      },
      places: () => ({ ready: placesDrawn === placesToken, names: placeNames.slice() }),
      placeNames: () => placeNames.slice(),
      peaks: () => peakNames.slice(),
      screen(lat: number, lon: number) {
        const camera = cameraRef.current;
        if (!camera) return null;
        const point = project(GEO, lat, lon);
        if (!point) return null;
        if (GEO.projection === 'equirectangular') {
          const period = 360 * GEO.F;
          point.x += Math.round((camera.centerX - point.x) / period) * period;
        }
        const dprNow = Math.min(2, window.devicePixelRatio || 1);
        const cssWidth = overlay.width / dprNow;
        const cssHeight = overlay.height / dprNow;
        return {
          x: (1 + (point.x - camera.centerX) / camera.halfWidth) * cssWidth / 2,
          y: (1 - (point.y - camera.centerY) / camera.halfHeight) * cssHeight / 2,
        };
      },
      readPlate() {
        const plate = gl;
        if (!plate) return Promise.resolve(null);
        plate.requestPlate();
        return new Promise<{ width: number; height: number; data: Uint8ClampedArray } | null>((resolve) => {
          const wait = () => {
            const shot = plate.takePlate();
            if (shot) resolve(shot);
            else if (dead) resolve(null);
            else requestAnimationFrame(wait);
          };
          requestAnimationFrame(wait);
        });
      },
      redraw() {
        cameraMoveRef.current = null;
        placesToken += 1;
        cameraMoved = true;
      },
      reconstructionSamples: () => manifest.places[0]?.id==='h.everest' ? manifest.forecastHours.map(hour=>({
        time:new Date(Date.parse(manifest.run)+hour*3600000).toISOString(),
        profiles:EVEREST_ROUTE.map(p=>everestAtmosphere(loaded,Date.parse(manifest.run)+hour*3600000,elevationAtRef.current).profile(p.lat,p.lon)),
      })) : null,
      flowSample: () => flowLayer?.sample() ?? null,
    };
    redrawRef.current = () => { if (!dead) api.redraw(); };
    stage.dataset.api = '1';
    (stage as HTMLDivElement & { chartApi?: typeof api }).chartApi = api;

    return () => {
      dead = true;
      loaded.listeners.delete(dataArrived);
      redrawRef.current = null;
      cancelAnimationFrame(raf);
      reduceQuery.removeEventListener('change', onReduce);
      flowLayer?.destroy();
      satLayer?.destroy();
      cameraMoveRef.current = null;
      observer.disconnect();
      themeObserver.disconnect();
      worker?.terminate();
      waterLayer?.destroy();
      sectionAtRef.current = null;
      terrain?.destroy();
      gl?.setTerrain(null);
      canvasChart?.destroy();
      canvasChartRef.current = null;
      gl?.destroy();
      if (glRef.current === gl) glRef.current = null;
      glCanvas.style.display = '';
      canvasFallback.style.display = 'none';
      overlay.removeEventListener('wheel', onWheel);
      trackpad.dispose();
    };
  }, [chart]);

  // Optional modern surface photography. One bounded asset, only fetched near
  // its footprint; shader placement and the ordinary map are shared by both dates.
  useEffect(()=>{
    const plate=glRef.current;
    if(!plate||!photoTerrain){setPhotoStatus('off');plate?.setImagery(null);return;}
    const controller=new AbortController();let started=false;
    setPhotoStatus('waiting');
    const check=()=>{
      const camera=cameraRef.current;if(started||!camera||!chart?.manifest.wrapsLongitude)return;
      const g=EVEREST_IMAGERY.geographic_bounds_wgs84;
      if(camera.halfHeight>.5||camera.centerY<g.south-.2||camera.centerY>g.north+.2||camera.centerX<g.west-.2||camera.centerX>g.east+.2)return;
      started=true;setPhotoStatus('loading');
      void loadEverestImagery(controller.signal).then(({image,mapping})=>{
        try{if(!controller.signal.aborted&&glRef.current===plate){plate.setImagery(image,mapping);setPhotoStatus('ready');redrawRef.current?.();}}finally{image.close();}
      }).catch(()=>{if(!controller.signal.aborted){setPhotoStatus('unavailable');redrawRef.current?.();}});
    };
    const timer=window.setInterval(check,500);check();
    return()=>{controller.abort();clearInterval(timer);if(glRef.current===plate){plate.setImagery(null);redrawRef.current?.();}};
  },[chart,renderer,photoTerrain]);

  useEffect(() => {
    if (!trafficOn) {
      pollKickRef.current = null;
      return;
    }
    let alive = true;
    const poll = bindTrafficPoll({
      visible: () => document.visibilityState !== 'hidden',
      pull: async () => {
        const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
        if (!camera) return;
        const centre = unproject(GEO, camera.centerX, camera.centerY);
        if (!centre) return;
        const radiusNm = viewRadiusNm(GEO, camera);
        const tile = trafficTile(centre.lat, centre.lon, radiusNm);
        if (tile) lastTileRef.current = tile.key;
        const params = new URLSearchParams({
          lat: centre.lat.toFixed(4),
          lon: centre.lon.toFixed(4),
          radiusNm: String(Math.round(radiusNm)),
        });
        const bbox = viewGeoBox(GEO, camera);
        if (bbox && bbox.west >= -180 && bbox.east <= 180) params.set('bbox', [bbox.west, bbox.south, bbox.east, bbox.north].map((n) => n.toFixed(4)).join(','));
        const response = await fetch(`/api/traffic?${params}`, { cache: 'no-store', headers: { 'X-Traffic-Session': trafficSessionRef.current } });
        if (!alive || !response.ok) return;
        const snap = trafficResponse(await response.json());
        if (!alive || !snap) return;
        trafficSnapRef.current = snap;
        trailsRef.current = accumulateTracks(trailsRef.current, snap.aircraft, Date.now(), selectedTrafficRef.current.map((item) => item.hex));
        trafficDirtyRef.current = true;
        refreshTraffic((n) => n + 1);
      },
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
    });
    pollKickRef.current = () => poll.kick();
    const onVis = () => poll.onVisibility();
    document.addEventListener('visibilitychange', onVis);
    poll.start();
    return () => {
      alive = false;
      poll.stop();
      pollKickRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      if (!trafficRef.current) {
        lastLiveTrafficRef.current = null;
        heldTrafficRef.current = null;
        trafficSnapRef.current = null;
        trailsRef.current = new Map();
        lastTileRef.current = null;
        trafficDirtyRef.current = true;
      }
    };
  }, [trafficOn, GEO]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !selectedTrafficRef.current.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearTracks(); notifyMap('Tracks cleared');
      overlayRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, []);
  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    for (const request of trafficRequestsRef.current.values()) request.abort();
  }, []);

  // The panel is held to the aspect range in which the data grid frames all of Australia.
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setPanel((old) => (Math.abs(old.width - rect.width) < 0.5 && Math.abs(old.height - rect.height) < 0.5 ? old : { width: rect.width, height: rect.height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [chart]);
  const aspects = useMemo(() => (chart && !chart.manifest.wrapsLongitude ? australiaAspects(GEO, insetBox(chart.manifest, EDGE_FADE_DEG + 0.25)) : null), [chart, GEO]);
  const pointVisible = !!point && !fly && !teaching;
  // The map fills the content width under the timeline. A point panel overlays
  // the right edge and does not narrow the canvas. Fly's in-flow column does.
  const sidePanel = fly && flyDetail && !chatOpen && typeof window !== 'undefined' && window.matchMedia(DESKTOP_MQ).matches;
  const stageWidth = Math.max(0, panel.width - (sidePanel ? 400 : 0));
  const groupWidth = panel.width > 0 ? panel.width : 0;

  const pointFramedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (chatOpen) return;
    if (!pointVisible || !point) {
      pointFramedRef.current = null;
      if (pointViewRef.current && !teaching && homeRef.current) {
        const saved = pointViewRef.current;
        moveCamera(reframeCamera(GEO, saved.camera, saved.frame, homeRef.current));
      }
      return;
    }
    const stage = stageRef.current, sheet = pointPanelRef.current;
    if (!stage || !sheet) return;
    let raf = 0;
    const measure = () => {
      const camera = cameraRef.current, frame = homeRef.current;
      if (!camera || !frame || getComputedStyle(sheet).visibility === 'hidden') return;
      const map = stage.getBoundingClientRect(), cover = sheet.getBoundingClientRect();
      if (!map.width || !map.height || !cover.width || !cover.height) return;
      const visible = exposedMap(map, cover, sheet.dataset.pointLayout === 'side');
      // Frame a pin once, when it opens. A lens change or sheet resize later
      // must not pull the map back to it (owner, 9 Oct: "when I change the
      // map-type it moves the map location").
      // A layout switch (sheet ↔ side, viewport change) re-frames; a lens change doesn't.
      const key = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}|${sheet.dataset.pointLayout ?? ''}|${Math.round(map.width)}x${Math.round(map.height)}|${sheet.dataset.pointState === 'ready' ? 'ready' : 'compact'}`;
      if (pointFramedRef.current === key) return;
      pointFramedRef.current = key;
      moveCamera(pointCameraForView(camera, frame, point, map, visible));
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(stage); observer.observe(sheet);
    const styleObserver = new MutationObserver(schedule);
    styleObserver.observe(sheet, { attributes: true, attributeFilter: ['style', 'data-point-layout', 'data-point-state'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => { cancelAnimationFrame(raf); observer.disconnect(); styleObserver.disconnect(); window.removeEventListener('resize', schedule); };
  }, [pointVisible, point, GEO, teaching, chatOpen, coastalLens]);

  useLayoutEffect(() => {
    const host = panelRef.current, stage = stageRef.current;
    if (!host || !stage || !phone) return;
    let raf = 0;
    const measure = () => {
      const sheet = host.querySelector<HTMLElement>('[data-chat-panel], [data-point-panel], [data-fly-panel], [data-coastal-panel]');
      const map = stage.getBoundingClientRect();
      const exposed = sheet ? Math.max(0, sheet.getBoundingClientRect().top - map.top) : map.height;
      // On the host: the chat float (inside the stage) and the archive notice
      // (a stage sibling) both follow the exposed map through these variables.
      host.style.setProperty('--map-exposed-height', `${exposed}px`);
      host.style.setProperty('--map-chat-right', sheet ? '56px' : '10px');
      host.style.setProperty('--map-chat-width', `${stage.querySelector('.map-chat-float')?.getBoundingClientRect().width ?? 0}px`);
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    const chat = stage.querySelector('.map-chat-float');
    if (chat) resize.observe(chat);
    const sheet = host.querySelector<HTMLElement>('[data-chat-panel], [data-point-panel], [data-fly-panel], [data-coastal-panel]');
    if (sheet) resize.observe(sheet);
    const mutation = new MutationObserver(schedule);
    mutation.observe(host, { subtree: true, attributes: true, attributeFilter: ['data-fly-sheet', 'data-coastal-sheet'], childList: true });
    schedule();
    return () => { cancelAnimationFrame(raf); resize.disconnect(); mutation.disconnect(); host.style.removeProperty('--map-exposed-height'); host.style.removeProperty('--map-chat-right'); host.style.removeProperty('--map-chat-width'); };
  }, [phone, chatOpen, pointVisible, fly, chart]);

  useLayoutEffect(() => {
    if (!chatOpen || !phone) return;
    const stage = stageRef.current, host = panelRef.current;
    if (!stage || !host) return;
    let raf = 0;
    const measure = () => {
      const sheet = chatPanelRef.current;
      if (!sheet) return;
      const camera = cameraRef.current, frame = homeRef.current, selected = chatFocusRef.current ?? focusRef.current;
      if (!camera || !frame || !selected || getComputedStyle(sheet).visibility === 'hidden') return;
      if (!chatViewRef.current) chatViewRef.current = { camera: { ...camera }, frame };
      const map = stage.getBoundingClientRect(), cover = sheet.getBoundingClientRect();
      if (!map.height || !cover.height) return;
      moveCamera(pointCameraForView(camera, frame, selected, map, exposedMap(map, cover, sheet.dataset.chatLayout === 'side')));
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    const attach = () => { if (chatPanelRef.current) observer.observe(chatPanelRef.current); schedule(); };
    const mutation = new MutationObserver(attach);
    mutation.observe(host, { childList: true, subtree: true });
    attach();
    return () => { cancelAnimationFrame(raf); observer.disconnect(); mutation.disconnect(); };
  }, [chatOpen, phone, placeId, GEO]);

  const lens: Lens = fly ? 'fly' : coastalLens ?? (field === 'none' ? 'pressure' : field);

  townsRef.current = pointPlaces;
  airportsRef.current = airportRows;
  const manifestList = chart?.manifest.places ?? [];
  const manifestHit = manifestList.find((item) => item.id === placeId) ?? null;
  const roughPlace = manifestHit
    ? manifestCatalog(manifestHit)
    : (isPlaceId(placeId) ? resolvePlace(placeId, manifestList, pointPlaces, airportRows) : null);
  const place = roughPlace && !manifestHit && placeId.startsWith('g.') && pointAtSea(chart, roughPlace.lat, roughPlace.lon)
    ? resolvePlace(placeId, manifestList, pointPlaces, airportRows, { atSea: true })
    : roughPlace;
  if (place) focusRef.current = { lat: place.lat, lon: place.lon };
  const placeForecast = place && forecast?.id === place.id ? forecast.data : null;
  const shownForecast = historical || place?.manifest ? null : placeForecast;
  const span = chart ? (chart.manifest.forecastHours[chart.manifest.forecastHours.length - 1] - chart.manifest.forecastHours[0]) * 60 : 0;
  const runMs = chart ? Date.parse(chart.manifest.run) : 0;
  const validMs = chart ? runMs + (chart.manifest.forecastHours[0] * 60 + minute) * 60000 : 0;
  const zone = historical?'UTC':(place?.manifest ? place.zone : shownForecast?.zone) || 'UTC';
  const displayZone = clockZone(clockMode, zone);
  useEffect(()=>{
    const save=(event:MouseEvent)=>{
      const link=(event.target as Element)?.closest?.('a');if(!link||event.button!==0||event.metaKey||event.ctrlKey)return;
      const url=new URL(link.href,location.href),target=historical?'/':'/history';
      if(url.origin!==location.origin||url.pathname!==target||!cameraRef.current||!chart?.manifest.wrapsLongitude)return;
      const center=unproject(GEO,cameraRef.current.centerX,cameraRef.current.centerY);if(!center)return;
      const old=transitRef.current;
      const transfer:MapTransit={...center,pin:pointRef.current??undefined,halfHeight:cameraRef.current.halfHeight,degreesPerPixel:cameraRef.current.halfWidth*2/Math.max(1,stageRef.current?.clientWidth??1),pitch:tiltRef.current,bearingRadians:cameraRef.current.bearingRadians??0,threeD:threeDRef.current,target,savedAt:Date.now(),event:historical?historyEvent:old?.event,date:historical?new Date(validMs).toISOString().slice(0,10):old?.date,hour:historical?new Date(validMs).getUTCHours():old?.hour};
      try{sessionStorage.setItem(MAP_TRANSIT_KEY,JSON.stringify(transfer));}catch{}
    };
    document.addEventListener('click',save,true);return()=>document.removeEventListener('click',save,true);
  },[historical,historyEvent,chart,GEO,validMs]);

  const nowMs = Date.now();
  const nearNow = !historical && chart ? Math.abs(validMs - nowMs) < 90_000 : false;
  useEffect(() => {
    trafficDirtyRef.current = true;
    if (trafficOn && !nearNow) notifyMap('Traffic replay · recorded this session');
  }, [trafficOn, nearNow]);
  const forecastStartMs = chart ? runMs + chart.manifest.forecastHours[0] * 3_600_000 : 0;
  const forecastEndMs = chart ? runMs + chart.manifest.forecastHours[chart.manifest.forecastHours.length - 1] * 3_600_000 : 0;
  const forecastNow = shownForecast ? forecastReading(shownForecast, nowMs) : null;
  const forecastAt = shownForecast ? forecastReading(shownForecast, validMs) : null;

  // Tiles start at today. Collector places keep their export; any other place uses its own forecast.
  const days = useMemo(() => {
    if(historical && chart){
      const catalogDays=historyCatalog?.collections.find(c=>c.id===historyEvent)?.days.filter(d=>d.complete).map(d=>d.date);
      const dates=[...new Set(catalogDays?.length?catalogDays:chart.manifest.forecastHours.map(hour=>new Date(Date.parse(chart.manifest.run)+hour*3600000).toISOString().slice(0,10)))].sort();
      return dates.map(date=>({historical:true,event:historyEvent==='everest-1953'?EVEREST_EVENTS[date]:undefined,key:date,weekday:new Date(date+'T00:00:00Z').toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}),dayStart:Date.parse(date+'T00:00:00Z'),dayEnd:Date.parse(date+'T00:00:00Z')+86400000,hi:null,lo:null,rain:null,icon:null}));
    }
    if (shownForecast) {
      const today = localMidnight(Date.now(), shownForecast.zone || 'UTC');
      return forecastDaySummaries(shownForecast).filter((day) => day.dayEnd > today);
    }
    if (!chart?.points || !place?.manifest) return [];
    const today = localMidnight(Date.now(), place.zone || 'UTC');
    const base = daySummaries(chart.points, place.id, place.zone).filter((day) => day.dayEnd > today);
    return placeForecast ? overlayUv(base, placeForecast) : base;
  }, [historyCatalog,historyEvent,historical,chart, place?.id, place?.manifest, place?.zone, shownForecast, placeForecast]);
  const reading = place?.manifest && chart?.points ? readingAt(chart.points, place.id, validMs) : forecastAt?.reading ?? null;
  const nowReading = place?.manifest && chart?.points ? readingAt(chart.points, place.id, nowMs) : forecastNow?.reading ?? null;
  const headerMs = nearNow ? nowMs : validMs;
  const uv = placeForecast ? forecastUv(placeForecast, headerMs) : null;
  const todayKey = localDayKey(nowMs, zone);
  const selectedKey = days.find((day) => validMs >= day.dayStart && validMs < day.dayEnd)?.key ?? null;
  const stripStart = historical ? forecastStartMs : days[0]?.dayStart ?? forecastStartMs;
  const stripEnd = historical ? forecastEndMs : days[days.length - 1]?.dayEnd ?? forecastEndMs;
  const playheadLabel = chart ? formatClock(validMs, displayZone) : '';
  const teachBox = cameraRef.current ? viewGeoBox(GEO, cameraRef.current) : null;
  const teachHere = !!teachBox && boxesOverlap(teachBox, TEACHING_AU);

  const legend = useMemo(() => {
    if (!chart) return 'loading';
    const blend = frameBlend(chart.manifest.forecastHours, chart.manifest.forecastHours[0] * 60 + minute);
    return legendState(chart.state[field === 'none' ? 'mslp' : FIELD_VARIABLE[field]], blend);
    // dataVersion: a frame that was loading may now be ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, field, minute, dataVersion]);
  const pressureLegend = useMemo(() => {
    if (!chart) return 'loading';
    return legendState(chart.state.mslp, frameBlend(chart.manifest.forecastHours, chart.manifest.forecastHours[0] * 60 + minute));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, minute, dataVersion]);
  const pendingField = legend === 'loading' ? (field === 'none' ? 'Pressure' : FIELD_LABEL[field]) : pressureLegend === 'loading' ? 'Pressure' : null;

  const placeKey = place?.id ?? '';
  const placeLat = place?.lat ?? 0;
  const placeLon = place?.lon ?? 0;
  const placeManifest = !!place?.manifest;
  const aviation = chart?.aviation ?? null;
  const airport = flyReport;

  useEffect(() => {
    if (!chart?.manifest.wrapsLongitude || !place) return;
    if (framedId.current === place.id) return;
    const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
    const point = project(GEO, place.lat, place.lon);
    const home = homeRef.current?.home;
    if (camera && point && home && Math.abs(camera.centerX - point.x) < 1 && Math.abs(camera.centerY - point.y) < 1 && Math.abs(camera.halfWidth - home.halfWidth) < 1) {
      framedId.current = place.id;
      return;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const framed = frameData(GEO, Math.max(1, rect.width), Math.max(1, rect.height), chart.manifest, place);
    if(place.id==='h.everest'){framed.home.halfHeight=.04;framed.home.halfWidth=.04*rect.width/Math.max(1,rect.height);}
    homeRef.current = framed;
    moveCamera({ ...framed.home }, true);
    framedId.current = place.id;
    // placeKey/lat/lon stand in for `place`, which is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, placeKey, placeLat, placeLon, GEO]);

  useEffect(() => {
    if (historical || !place) {
      setForecast(null);
      return;
    }
    const id = place.id;
    setForecast((current) => (current?.id === id ? current : null));
    const controller = new AbortController();
    let live = true;
    void loadPlaceForecast(place.lat, place.lon, { signal: controller.signal }).then((data) => {
      if (live) setForecast({ id, data });
    }).catch(() => { /* aborted or unavailable: UV stays missing */ });
    return () => { live = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, placeLat, placeLon]);

  useEffect(() => {
    if (historical || !place || !chart) {
      setFlyReport(null);
      setFlyKnown(false);
      return;
    }
    if (place.manifest) {
      setFlyReport(nearestReported(place.lat, place.lon, aviation?.airports ?? []));
      setFlyKnown(aviation != null);
      return;
    }
    if (!airportsReady) {
      setFlyReport(null);
      setFlyKnown(false);
      return;
    }
    let live = true;
    const controller = new AbortController();
    const nearby = nearestAirports(place.lat, place.lon, airportsRef.current);
    setFlyReport(null);
    setFlyKnown(false);
    void (async () => {
      let found: AviationAirport | null = null;
      for (const row of nearby) {
        if (!live) return;
        const report = await loadAerodromeReport(row[0], { signal: controller.signal });
        if (!live || !report) continue;
        found = { icao: report.icao, name: report.name, zone: '', lat: report.lat, lon: report.lon, metar: report.metar, taf: report.taf };
        break;
      }
      if (!live) return;
      setFlyReport(found);
      setFlyKnown(true);
    })();
    return () => { live = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, placeLat, placeLon, placeManifest, chart, aviation, airportsReady]);

  useEffect(() => {
    if (flyKnown && !flyReport) {
      setFlyDetail(false);
      optionalRef.current = optionalRef.current.filter((item) => item !== 'section');
    }
  }, [flyKnown, flyReport]);

  function framePlace(next: { id: string; lat: number; lon: number }) {
    framedId.current = next.id;
    focusRef.current = { lat: next.lat, lon: next.lon };
    const loaded = chartRef.current;
    const stage = stageRef.current;
    if (!loaded?.manifest.wrapsLongitude || !stage) return;
    const rect = stage.getBoundingClientRect();
    const framed = frameData(GEO, Math.max(1, rect.width), Math.max(1, rect.height), loaded.manifest, next);
    homeRef.current = framed;
    moveCamera({ ...framed.home }, true);
  }

  function dismissHint() {
    setPlaceHint(false);
    try { localStorage.setItem(HINT_KEY, '0'); } catch { /* private mode */ }
  }

  function selectPlace(next: CatalogPlace, source: PlacePick | boolean = 'user') {
    const mode: PlacePick = source === true || source === 'user' ? 'user' : source === false || source === 'restore' ? 'restore' : source;
    if (mode === 'user' && next.id !== placeRef.current) {
      clearSlice();
      forgetPoint();
      // A new place wins over restoration of the previous chat camera.
      closeChat(false);
      trackUsage('place', { place: next.id });
    }
    if (mode === 'user' || mode === 'point') {
      placeSourceRef.current = 'user';
      dismissHint();
    } else if (mode === 'geo') placeSourceRef.current = 'geo';
    placeRef.current = next.id;
    setPlaceId(next.id);
    framePlace(next);
    if (mode === 'restore') return;
    setPref('place', next.id);
  }

  function toggleSaved() {
    if (!place) return;
    const ids = readSavedIds();
    const next = ids.includes(place.id) ? ids.filter((id) => id !== place.id) : [place.id, ...ids].slice(0, 32);
    setPref('places', next);
    setSavedIds(next);
  }

  function makeThisPlace(lat: number, lon: number): 'set' | 'restored' | 'same' {
    const next = placeForPoint(lat, lon, manifestList, pointPlaces, airportRows, { atSea: pointAtSea(chart, lat, lon) });
    if (place && place.id === next.id) {
      const previous = previousPlaceRef.current;
      if (previous && previous.id !== next.id) {
        selectPlace(previous, 'point');
        previousPlaceRef.current = null;
        return 'restored';
      }
      return 'same';
    }
    if (place) previousPlaceRef.current = place;
    selectPlace(next, 'point');
    return 'set';
  }

  function locate() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setLocateDenied(true); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude, longitude } = position.coords;
      selectPlace(placeForPoint(latitude, longitude, chartRef.current?.manifest.places ?? [], townsRef.current, airportsRef.current, { atSea: pointAtSea(chartRef.current, latitude, longitude) }), 'user');
      setLocateDenied(false);
      setLocatedTick((value) => value + 1);
    }, () => setLocateDenied(true), { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 });
  }

  function remember(next: { field?: FieldId; speed?: Speed }, persist = true) {
    if (next.field) {
      fieldRef.current = next.field;
      setField(next.field);
    }
    if (next.speed !== undefined) {
      if (next.speed !== REAL_TIME) clockRef.current.followNow = false;
      speedRef.current = next.speed;
      setSpeed(next.speed);
      if (persist) setPref('speed', next.speed);
    }
  }

  // Place and speed signed in on another device arrive here; apply them without re-stamping.
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  const selectPlaceRef = useRef(selectPlace);
  selectPlaceRef.current = selectPlace;
  useEffect(() => {
    const onSynced = (event: Event) => {
      if (!(event as CustomEvent<{ kinds: string[] }>).detail?.kinds.includes('settings')) return;
      const loaded = chartRef.current;
      if (!loaded) return;
      setSavedIds(readSavedIds());
      const band = readSetting('kiteBand');
      setKiteBand(validKiteBand(band) ? band : DEFAULT_KITE_BAND);
      const speed = readStoredSpeed();
      if (speed !== speedRef.current) rememberRef.current({ speed }, false);
      const nextId = readStoredPlace(loaded);
      if (nextId === placeRef.current) return;
      const resolved = resolvePlace(nextId, loaded.manifest.places, townsRef.current, airportsRef.current);
      if (resolved) selectPlaceRef.current(resolved, false);
      else { placeRef.current = nextId; setPlaceId(nextId); }
    };
    window.addEventListener(SYNCED, onSynced);
    return () => window.removeEventListener(SYNCED, onSynced);
  }, []);

  const geoAppliedRef = useRef(false);
  useEffect(() => {
    if (geoAppliedRef.current || !chart || !placesReady) return;
    if (placeSourceRef.current !== 'default') { geoAppliedRef.current = true; return; }
    geoAppliedRef.current = true;
    if (!initialGeo) return;
    const nearest = nearestCatalogPlace(initialGeo.lat, initialGeo.lon, pointPlaces, chart.manifest.places);
    if (!nearest) return;
    selectPlaceRef.current(nearest, 'geo');
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ }
    setPlaceHint(true);
  }, [chart, placesReady, pointPlaces, initialGeo]);

  const atReadyRef = useRef(false);
  useEffect(() => {
    if (!chart) return;
    if (!atReadyRef.current) {
      atReadyRef.current = true;
      const raw = new URLSearchParams(window.location.search).get('at');
      if (raw) {
        const [lat, lon] = raw.split(',').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          setPoint({ lat, lon });
          return;
        }
      }
    }
    const url = new URL(window.location.href);
    if (point) url.searchParams.set('at', `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`);
    else url.searchParams.delete('at');
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) history.replaceState(null, '', next);
  }, [chart, point]);

  useEffect(() => {
    if (!pointTitle) return undefined;
    const previous = document.title;
    document.title = `${pointTitle} · Isobar`;
    return () => { document.title = previous; };
  }, [pointTitle]);

  useEffect(() => {
    if (!chip) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-map-chip]')) return;
      swallowRef.current = true;
      chipRef.current = null;
      setChip(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      chipRef.current = null;
      setChip(null);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [chip]);

  function seek(nextMinute: number, hold: boolean) {
    lastLiveTrafficRef.current = null;
    heldTrafficRef.current = null;
    clockRef.current = { ...clockRef.current, minute: Math.min(span, Math.max(0, nextMinute)), followNow: false, playing: hold ? false : clockRef.current.playing };
    setMinute(clockRef.current.minute);
    setPlaying(clockRef.current.playing);
  }

  const deskLinkApplied = useRef(false);
  useEffect(() => {
    if (deskLinkApplied.current || !chart || !airportsReady) return;
    const params = new URLSearchParams(location.search);
    const icao = params.get('icao')?.toUpperCase();
    const point = reportPoint(params);
    const hasPoint = point !== null;
    if ((!icao || !/^[A-Z][A-Z0-9]{3}$/.test(icao)) && !hasPoint) return;
    deskLinkApplied.current = true;
    if (icao && /^[A-Z][A-Z0-9]{3}$/.test(icao)) {
      const resolved = resolvePlace(`a.${icao}`, chart.manifest.places, townsRef.current, airportRows);
      if (resolved) selectPlaceRef.current(resolved, false);
    }
    if (point) selectPlaceRef.current(placeForPoint(point.lat, point.lon, chart.manifest.places, townsRef.current, airportRows, { atSea: pointAtSea(chart, point.lat, point.lon) }), false);
    const time = Date.parse(params.get('time') ?? '');
    if (!Number.isFinite(time)) return;
    // The map's displayed clock stays within its actual published horizon.
    const requested = (time - Date.parse(chart.manifest.run)) / 60000 - chart.manifest.forecastHours[0] * 60;
    clockRef.current = { ...clockRef.current, minute: Math.min(span, Math.max(0, requested)), playing: false };
    setMinute(clockRef.current.minute);
    setPlaying(false);
  }, [chart, airportsReady, airportRows, span]);

  function goNow() {
    if (teachingRef.current) return;
    const stage = stageRef.current as (HTMLDivElement & { chartApi?: { nowMinute: () => number } }) | null;
    const next = stage?.chartApi?.nowMinute() ?? 0;
    cancelTimelineHoverArm();
    hoverHoldRef.current = false;
    holdingRef.current = false;
    if (!historical) remember({ speed: REAL_TIME });
    clockRef.current = { minute: next, playing: true, direction: 1, followNow: !historical };
    setMinute(next);
    setPlaying(true);
  }

  function scrubFromClientX(clientX: number, track: HTMLElement) {
    const rect = (track.querySelector('[data-timeline-track]') ?? track).getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const at = stripStart + t * (stripEnd - stripStart);
    const minuteValue = (at - runMs) / 60000 - (chart?.manifest.forecastHours[0] ?? 0) * 60;
    if (!teachingRef.current) seek(minuteValue, true);
  }

  function cancelTimelineHoverArm() {
    hoverArmGenerationRef.current += 1;
    if (hoverArmTimerRef.current !== null) {
      clearTimeout(hoverArmTimerRef.current);
      hoverArmTimerRef.current = null;
    }
  }

  useEffect(() => () => cancelTimelineHoverArm(), []);

  const timelinePointer = {
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (teachingRef.current) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        seek(event.key === 'Home' ? 0 : event.key === 'End' ? span : clockRef.current.minute + (event.key === 'ArrowLeft' ? -60 : 60), false);
        trackUsage('scrub', { key: event.key });
      }
    },
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (teachingRef.current) return;
      cancelTimelineHoverArm();
      scrubRestorePlayingRef.current = hoverHoldRef.current ? hoverRestorePlayingRef.current : clockRef.current.playing;
      hoverHoldRef.current = false;
      holdingRef.current = true;
      trackUsage('hold', { source: 'pointer' });
      clockRef.current = { ...clockRef.current, followNow: false, playing: false };
      setPlaying(false);
      scrubFromClientX(event.clientX, event.currentTarget);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (teachingRef.current) return;
      if (holdingRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
        scrubFromClientX(event.clientX, event.currentTarget);
        return;
      }
      if (event.buttons === 0 && event.pointerType === 'mouse') {
        hoverLatestXRef.current = event.clientX;
        if (hoverHoldRef.current) {
          scrubFromClientX(event.clientX, event.currentTarget);
          return;
        }
        if (hoverArmTimerRef.current === null) {
          const generation = hoverArmGenerationRef.current;
          const target = event.currentTarget;
          hoverArmTimerRef.current = setTimeout(() => {
            hoverArmTimerRef.current = null;
            if (generation !== hoverArmGenerationRef.current || holdingRef.current || teachingRef.current || !target.isConnected) return;
            trackUsage('hold', { source: 'hover' });
            hoverRestorePlayingRef.current = clockRef.current.playing;
            hoverHoldRef.current = true;
            clockRef.current = { ...clockRef.current, followNow: false, playing: false };
            setPlaying(false);
            scrubFromClientX(hoverLatestXRef.current, target);
          }, 300);
        }
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      if (teachingRef.current) return;
      holdingRef.current = false;
      hoverHoldRef.current = false;
      trackUsage('scrub', {});
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      clockRef.current = { ...clockRef.current, playing: scrubRestorePlayingRef.current };
      setPlaying(scrubRestorePlayingRef.current);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      if (teachingRef.current) return;
      cancelTimelineHoverArm();
      if (!holdingRef.current && !hoverHoldRef.current) return;
      const restore = hoverHoldRef.current ? hoverRestorePlayingRef.current : scrubRestorePlayingRef.current;
      holdingRef.current = false;
      hoverHoldRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      clockRef.current = { ...clockRef.current, playing: restore };
      setPlaying(restore);
    },
    onPointerLeave: () => {
      if (teachingRef.current) return;
      cancelTimelineHoverArm();
      if (holdingRef.current || !hoverHoldRef.current) return;
      hoverHoldRef.current = false;
      clockRef.current = { ...clockRef.current, playing: hoverRestorePlayingRef.current };
      setPlaying(hoverRestorePlayingRef.current);
    },
  };

  function redrawCamera() {
    cameraMoveRef.current = null;
    (stageRef.current as (HTMLDivElement & { chartApi?: { redraw: () => void } }) | null)?.chartApi?.redraw();
  }
  function zoomCamera(factor: number) {
    if (cameraRef.current && homeRef.current) cameraRef.current = zoomShared(cameraRef.current, 0, 0, factor, homeRef.current);
    redrawCamera();
  }

  function releaseMapPointer(pointerId: number) {
    pointersRef.current.delete(pointerId);
    const survivor = [...pointersRef.current.values()][0];
    panStartRef.current = survivor && cameraRef.current
      ? { camera: { ...cameraRef.current }, last: cameraRef.current, pitch: tiltRef.current, x: survivor.x, y: survivor.y, moving: true } : null;
    pinchRef.current = 0;
    if (pointersRef.current.size !== 0 || mapHeldPlayingRef.current === null) return;
    const restore = mapHeldPlayingRef.current;
    mapHeldPlayingRef.current = null;
    // An ordinary click still selects aircraft without leaving live tracking.
    // A deliberate hold resumes from its held instant instead.
    clockRef.current.followNow = mapHeldNowRef.current && performance.now() - mapHeldAtRef.current < 300;
    clockRef.current = { ...clockRef.current, playing: restore };
    setPlaying(restore);
  }
  function moveCamera(to: Camera, glide = false, restore?: { camera: Camera; frame: DataFrame }) {
    const from = cameraRef.current;
    if (!from) {
      cameraRef.current = { ...to };
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cameraMoveRef.current = {
      from: { ...from }, to, start: performance.now(),
      duration: reduce ? 0 : glide ? 240 : 250,
      ease: glide ? 'out' : undefined, restore,
    };
  }
  function closeChat(restore = true, returnFocus = true) {
    const saved = chatViewRef.current;
    if (restore && saved && homeRef.current) moveCamera(reframeCamera(GEO, saved.camera, saved.frame, homeRef.current));
    chatViewRef.current = null;
    chatFocusRef.current = null;
    setChatOpen(false);
    if (restore && returnFocus && chatOpen) document.querySelector<HTMLButtonElement>('[data-chat-button]')?.focus({ preventScroll: true });
  }
  function focusChatPlace(lat: number, lon: number, onlyIfOffscreen = false) {
    if (!chatOpen || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const stage = stageRef.current as (HTMLDivElement & { chartApi?: { setView: (lat: number, lon: number, heightDeg: number) => void } }) | null;
    const camera = cameraRef.current, frame = homeRef.current, sheet = chatPanelRef.current;
    if (!stage || !camera || !frame || !sheet) return;
    chatFocusRef.current = { lat, lon };
    const map = stage.getBoundingClientRect();
    const visible = exposedMap(map, sheet.getBoundingClientRect(), sheet.dataset.chatLayout === 'side');
    const projected = projectPoint(GEO, { lat, lon }, camera);
    const clip = projected ? cameraProject(camera, projected.x, projected.y) : null;
    const x = clip ? map.left + (clip.x + 1) * map.width / 2 : NaN;
    const y = clip ? map.top + (1 - clip.y) * map.height / 2 : NaN;
    if (onlyIfOffscreen && x >= visible.left + 16 && x <= visible.left + visible.width - 16
      && y >= visible.top + 16 && y <= visible.top + visible.height - 16) return;
    // setView finds the closest clamped view of the place; the glide then runs
    // from the user's current view, not from that jump (no one-frame snap).
    const from = { ...camera };
    stage.chartApi?.setView(lat, lon, 12);
    const landed = cameraRef.current;
    if (landed) {
      const target = pointCameraForView(landed, frame, { lat, lon }, map, visible);
      cameraRef.current = from;
      moveCamera(target);
    }
  }
  function toggleChat() {
    if(historical){notifyMap('Historical questions are not connected yet');return;}
    if (chatOpen) { closeChat(); return; }
    trackUsage('chat-open', {});
    setChatOpen(true);
  }
  function notifyMap(message: string) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setMapNotice(message);
    noticeTimerRef.current = setTimeout(() => setMapNotice(''), 2600);
  }
  function clearTracks() {
    selectedTrafficRef.current = []; setSelectedTraffic([]);
    optionalRef.current = optionalRef.current.filter((item) => item !== 'tracks');
    trafficDirtyRef.current = true;
    for (const request of trafficRequestsRef.current.values()) request.abort();
    trafficRequestsRef.current.clear();
  }
  function disableOptional(overlay: OptionalOverlay) {
    optionalRef.current = optionalRef.current.filter((item) => item !== overlay);
    if (overlay === 'tracks') clearTracks();
    if (overlay === 'section') setFlyDetail(false);
    if (overlay === 'satellite') { satelliteRef.current = false; setSatellite(false); setCloudLegend(null); }
    if (overlay === 'barbs') { windRef.current = false; setWindBarbs(false); }
  }
  function useOptional(overlay: OptionalOverlay, label: string) {
    const result = enableOverlay(optionalRef.current, overlay);
    if (result.replaced) disableOptional(result.replaced);
    optionalRef.current = result.overlays;
    notifyMap(result.replaced ? `${label} · replaced ${result.replaced === 'barbs' ? 'wind barbs' : result.replaced}` : label);
  }
  function toggleWindBarbs(value: boolean) {
    if (value) useOptional('barbs', 'Wind barbs on'); else { disableOptional('barbs'); notifyMap('Wind barbs off'); }
    setWindBarbs(value); windRef.current = value;
  }
  function toggleSatellite(value: boolean) {
    if(historical&&value){notifyMap('Satellite unavailable for this date');return;}
    if (value) useOptional('satellite', 'Satellite on'); else { disableOptional('satellite'); notifyMap('Satellite off'); }
    satelliteRef.current = value; setSatellite(value);
  }
  function toggleTraffic(value: boolean) {
    if(historical&&value){notifyMap('Traffic unavailable for this date');return;}
    trafficRef.current = value; setTrafficOn(value); trafficDirtyRef.current = true;
    if (value) {
      trafficSessionRef.current = crypto.randomUUID();
      // Traffic never moves the forecast clock; the NOW/FORECAST badge carries the state.
      notifyMap('Traffic on');
    } else {
      const session = trafficSessionRef.current;
      if (session) void fetch('/api/traffic/trace', { method: 'DELETE', headers: { 'X-Traffic-Session': session }, keepalive: true }).catch(() => undefined);
      clearTracks(); trafficSnapRef.current = null; routesRef.current.clear();
      trailsRef.current = new Map(); lastTileRef.current = null; trafficSessionRef.current = '';
      notifyMap('Traffic off');
    }
  }
  function toggleSection(value: boolean) {
    if (value) useOptional('section', 'Section open'); else { disableOptional('section'); notifyMap('Section closed'); }
    setFlyDetail(value);
  }
  function changeLens(next: Lens) {
    if(historical && (['fly','surf','kite'].includes(next)||next==='rain'&&!chart?.manifest.variables.rain24||next==='temp'&&!chart?.manifest.variables.t2m)){notifyMap('This layer is unavailable for the selected date');return;}
    if (teachingRef.current || next === lens) return;
    // Optional overlays are lens-scoped and reset on a lens change; the selected
    // point is the user's and survives (hidden under Fly, back when they return).
    for (const item of [...optionalRef.current]) disableOptional(item);
    if (trafficRef.current) toggleTraffic(false);
    closeChat(true, false);
    remember({ field: next === 'kite' ? 'wind' : next === 'rain' || next === 'wind' || next === 'temp' ? next : 'none' });
    setCoastalLens(next === 'kite' || next === 'surf' ? next : null);
    // Fly opens its aerodrome sheet at peek and turns live traffic on; neither moves the clock.
    // The open sheet is the section overlay, so it occupies one of the two slots.
    setFly(next === 'fly'); setFlyDetail(next === 'fly');
    if (next === 'fly') {
      optionalRef.current = enableOverlay(optionalRef.current, 'section').overlays;
      toggleTraffic(true);
    } else notifyMap(`${next[0].toUpperCase() + next.slice(1)} lens`);
    trackUsage('lens', { lens: next });
  }
  function selectTraffic(aircraft: TrafficAircraft) {
    const prior = selectedTrafficRef.current;
    const removing = prior.some((item) => item.hex === aircraft.hex);
    if (!removing && prior.length >= 8) { notifyMap('8 aircraft selected'); return; }
    if (!removing) useOptional('tracks', `Tracking ${aircraft.callsign}`);
    const next = toggleTrafficSelection(prior, aircraft.hex);
    selectedTrafficRef.current = next; setSelectedTraffic(next); trafficDirtyRef.current = true;
    if (removing) {
      notifyMap(`Removed ${aircraft.callsign}`);
      trafficRequestsRef.current.get(aircraft.hex)?.abort(); trafficRequestsRef.current.delete(aircraft.hex);
      if (!next.length) optionalRef.current = optionalRef.current.filter((item) => item !== 'tracks');
      return;
    }
    const session = trafficSessionRef.current;
    const controller = new AbortController();
    trafficRequestsRef.current.set(aircraft.hex, controller);
    const options = { cache: 'no-store' as const, signal: controller.signal, headers: { 'X-Traffic-Session': session } };
    const current = () => !controller.signal.aborted && session === trafficSessionRef.current && selectedTrafficRef.current.some((item) => item.hex === aircraft.hex);
    void Promise.allSettled([
      fetch(`/api/traffic/trace?hex=${encodeURIComponent(aircraft.hex)}`, options).then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (!current() || !Array.isArray(body.points)) return;
        const trail = trailsRef.current.get(aircraft.hex);
        trailsRef.current.set(aircraft.hex, { aircraft: trail?.aircraft ?? aircraft, points: mergeTrackPoints(trail?.points ?? [], body.points, Date.now()) });
      }),
      ...(!trafficSnapRef.current?.routeLookupEnabled || routesRef.current.has(aircraft.callsign) ? [] : [fetch(`/api/traffic/route-lookup?callsign=${encodeURIComponent(aircraft.callsign)}`, options).then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (current()) routesRef.current.set(aircraft.callsign, parseFlightRoute(body.route, aircraft.callsign));
      })]),
    ]).finally(() => {
      if (trafficRequestsRef.current.get(aircraft.hex) === controller) trafficRequestsRef.current.delete(aircraft.hex);
      if (current()) { trafficDirtyRef.current = true; refreshTraffic((n) => n + 1); }
    });
  }
  function forgetPoint() {
    pointViewRef.current = null;
    pointRef.current = null;
    pointSeenCamRef.current = '';
    setPoint(null);
  }
  function closePoint(focus = true) {
    const saved = pointViewRef.current;
    pointViewRef.current = null;
    pointRef.current = null;
    if (saved && homeRef.current) moveCamera(reframeCamera(GEO, saved.camera, saved.frame, homeRef.current), false, saved);
    setPoint(null);
    if (focus) overlayRef.current?.focus({ preventScroll: true });
  }
  function mapLocation(clientX: number, clientY: number): { lat: number; lon: number; left: number; top: number } | null {
    const canvas = overlayRef.current, camera = cameraRef.current, stage = stageRef.current;
    if (!canvas || !camera || !stage || teachingRef.current) return null;
    const rect = canvas.getBoundingClientRect();
    const host = stage.getBoundingClientRect();
    const x = camera.centerX + ((clientX - rect.left) / rect.width * 2 - 1) * camera.halfWidth;
    const y = camera.centerY + (1 - (clientY - rect.top) / rect.height * 2) * camera.halfHeight;
    const location = mapUnproject(GEO, renderCamera(camera), (clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    if (!location || location.lat < -90 || location.lat > 90) return null;
    const lon = ((location.lon + 180) % 360 + 360) % 360 - 180;
    return { lat: location.lat, lon, left: host.width ? ((clientX - host.left) / host.width) * 100 : 0, top: host.height ? ((clientY - host.top) / host.height) * 100 : 0 };
  }
  function openChip(clientX: number, clientY: number) {
    const hit = mapLocation(clientX, clientY);
    if (!hit) return;
    const next = { ...hit, note: '' };
    chipRef.current = next;
    setChip(next);
  }
  function flashChip(note: string) {
    const current = chipRef.current;
    if (!current) return;
    setGhost({ left: current.left, top: current.top, note });
    window.clearTimeout(ghostTimerRef.current);
    ghostTimerRef.current = window.setTimeout(() => setGhost(null), 1400);
    chipRef.current = null;
    setChip(null);
  }
  function pickPoint(clientX: number, clientY: number) {
    const canvas = overlayRef.current, camera = cameraRef.current;
    if (!canvas || !camera || teachingRef.current) return;
    const rect = canvas.getBoundingClientRect();
    if (trafficRef.current) {
      const hit = trafficHit(glyphsRef.current, clientX - rect.left, clientY - rect.top);
      if (hit?.aircraft) {
        selectTraffic(hit.aircraft);
        return;
      }
    }
    // Fly keeps the aerodrome sheet: a map tap selects traffic (handled above) or nothing.
    if (fly) return;
    const x = camera.centerX + ((clientX - rect.left) / rect.width * 2 - 1) * camera.halfWidth;
    const y = camera.centerY + (1 - (clientY - rect.top) / rect.height * 2) * camera.halfHeight;
    const location = mapUnproject(GEO, renderCamera(camera), (clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    if (location && location.lat >= -90 && location.lat <= 90) {
      const snapped = snapToSummit(clientX - rect.left, clientY - rect.top, labelledPeaksRef.current);
      const lat = snapped ? snapped.lat : location.lat;
      const rawLon = snapped ? snapped.lon : location.lon;
      const lon = ((rawLon + 180) % 360 + 360) % 360 - 180;
      if (!pointViewRef.current && homeRef.current) pointViewRef.current = { camera: { ...camera }, frame: homeRef.current };
      closeChat(false);
      setFly(false);
      setPoint({ lat, lon, ...(snapped ? { name: snapped.name } : {}) });
      trackUsage('point', { lat, lon });
    }
  }
  const projectedPoint = pointVisible && point && cameraRef.current ? projectPoint(GEO, point, cameraRef.current) : null;
  const pointClip = pointVisible && point && cameraRef.current ? mapProject(GEO, renderCamera(cameraRef.current), point.lat, point.lon) : null;
  function focusFeature(point: GeoPoint) {
    const p = project(GEO, point.lat, point.lon), frame = homeRef.current;
    if (!p || !frame) return;
    const home = frame.home;
    const phone = stageSize.width < 650;
    cameraRef.current = clampToData(GEO, { ...home, centerX: p.x + (phone ? 0 : home.halfWidth * .35), centerY: p.y - (phone ? home.halfHeight * .50 : 0) }, frame);
    redrawCamera();
  }

  const transportNode = (compact: boolean) => (
    <Transport
      compact={compact}
      held={teaching}
      playing={playing}
      onToggle={() => {
        if (teachingRef.current) return;
        clockRef.current = { ...clockRef.current, followNow: false, playing: !clockRef.current.playing };
        setPlaying(clockRef.current.playing);
        setMinute(clockRef.current.minute);
      }}
      speed={speed}
      onSpeed={(value) => remember({ speed: value })}
      onNow={goNow}
      nowLabel={historical?'Start':'Now'}
    />
  );
  const timelineNode = (bare: boolean) => chart ? (
    <Timeline
      bare={bare}
      startMs={stripStart}
      endMs={stripEnd}
      dayMarks={days.slice(1).map((day) => day.dayStart)}
      forecastStartMs={forecastStartMs}
      forecastEndMs={forecastEndMs}
      validMs={validMs}
      zone={displayZone}
      timeState={historical?{live:false,label:'HISTORY'}:mapTimeState(validMs, nowMs)}
      valueText={chartTitle(validMs, displayZone, nearNow)}
      span={span}
      minute={minute}
      onPointer={timelinePointer}
    />
  ) : null;

  const historyPicker = historical ? <div className="history-picker flex min-w-0 items-center gap-2">{historyCatalog ? <select aria-label="Historical event" value={historyEvent} onChange={e=>{clearSlice();setHistoryRequest({event:e.target.value,version:++historySelectionVersion.current});setPoint(null);}} className="min-w-0 rounded-md bg-[var(--md-surface-container-high)] px-2 py-1 text-sm">{historyCatalog.collections.map(c=><option key={c.id} value={c.id}>{c.title}{c.title.includes(c.days[0]?.date.slice(0,4)??"—")?"":` · ${c.days[0]?.date.slice(0,4)??""}`}</option>)}</select> : null}<a href="/" data-history-exit aria-label="Back to present day" className="history-exit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5 3 12l7 7M3 12h18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg><span>Present day</span></a></div> : null;
  const timeState = chart ? historical?{live:false,label:'HISTORY'}:mapTimeState(validMs, nowMs) : null;
  const heldTraffic = !playing && heldTrafficRef.current && Math.abs(validMs - heldTrafficRef.current.selectedMs) < 1 ? heldTrafficRef.current : null;
  const trafficLive = liveTrafficAtTime(clockRef.current.followNow, playing, validMs, nowMs);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-map-page data-history-mode={historical?'true':undefined}>
      <div ref={chromeRef} data-map-chrome data-collapsed={chromeCollapsed ? 'true' : 'false'} className="map-chrome shrink-0">
        <PressNote text={chromeNote.note} />
        <div ref={chromeBodyRef} className="map-chrome-body">
          {chromeCollapsed ? historyPicker : null}
          {chromeCollapsed ? (
            <CompactForecast
              placeName={place?.name ?? ''}
              onPlace={() => collapseToRef.current(false)}
              reading={nearNow ? nowReading : reading}
              transport={transportNode(true)}
              timeline={timelineNode(true)}
              validMs={chart ? validMs : null}
              zone={zone}
              timeState={timeState}
              toggle={<ChromeToggle collapsed onToggle={() => collapseToRef.current(false)} />}
            />
          ) : (
            <>
              <MapHeader
                leading={historyPicker}
                historical={historical}
        graticule={graticule}
        onGraticule={() => {
          const next = !graticule;
          graticuleRef.current = next;
          setGraticule(next);
          writeGraticule(window.localStorage, next);
          notifyMap(next ? 'Lat long on' : 'Lat long off');
        }}
                uv={uv}
                phone={phone}
                placeName={place?.name ?? ''}
                place={(
                  <PlaceField
                    selected={place}
                    savedIds={savedIds}
                    saved={!!place && savedIds.includes(place.id)}
                    manifest={manifestList}
                    towns={pointPlaces}
                    airports={airportRows}
                    denied={locateDenied}
                    hint={historical ? false : placeHint}
                    located={locatedTick}
                    onSelect={(next) => selectPlace(next, 'user')}
                    onToggleSaved={toggleSaved}
                    onLocate={locate}
                  />
                )}
                reading={nearNow ? nowReading : reading}
                forecast={shownForecast ? {
                  source: shownForecast.provenance.source,
                  model: shownForecast.provenance.model,
                  run: shownForecast.provenance.run,
                  cycle: shownForecast.provenance.cycle,
                  valid: (nearNow ? forecastNow : forecastAt)?.valid ?? null,
                } : null}
                validMs={chart ? validMs : null}
                zone={zone}
                runMs={runMs}
                nowMs={nowMs}
                phoneWind={chart?.manifest.variables.u10 && chart.manifest.variables.v10 ? <button type="button" aria-label="Wind barbs" aria-pressed={windBarbs}
                  onClick={() => toggleWindBarbs(!windBarbs)}>Wind barbs<span aria-hidden="true" className="ml-auto">{windBarbs ? '✓' : ''}</span></button> : null}
                onMenuOpen={() => { closeChat(true, false); }}
                onMenuChange={setMenuOpen}
              />
              {chart ? (
                <div className="map-deck grid shrink-0 grid-cols-1 gap-x-4 px-3 md:grid-cols-[minmax(176px,auto)_1fr] md:px-4">
                  <div className="transport-side flex items-center max-md:hidden md:row-span-2 md:pt-6">{transportNode(false)}</div>
                  {historical ? <select className="history-day rounded-md bg-[var(--md-surface-container-high)] px-2" aria-label="Historical day" value={selectedKey ?? days[0]?.key} onChange={event=>{const day=days.find(d=>d.key===event.target.value);if(day&&!teachingRef.current){const version=++historySelectionVersion.current;setHistoryError('');if(day.dayStart<forecastStartMs||day.dayStart>forecastEndMs)setHistoryRequest({event:historyEvent,date:day.key,version});else seek((day.dayStart-runMs)/60000-chart.manifest.forecastHours[0]*60,false);if(day.event)notifyMap(day.event.detail);}}}>{days.map(day=><option key={day.key} value={day.key}>{day.weekday}{day.event?` · ${day.event.title}`:''}</option>)}</select> : <DayTiles
                    days={days}
                    todayKey={todayKey}
                    selectedKey={selectedKey}
                    nowTemp={nowReading?.tempC ?? null}
                    onDay={(day) => {
                      if (teachingRef.current) return;
                      const at = historical ? day.dayStart : day.key === todayKey ? nowMs : day.dayStart + 15 * 3_600_000;
                      if(day.event)notifyMap(day.event.detail);
                      seek((at - runMs) / 60000 - chart.manifest.forecastHours[0] * 60, false);
                    }}
                  />}
                  <div className="time-block flex min-w-0 items-center gap-2 pt-1">
                    <div className="transport-inline shrink-0 md:hidden">{transportNode(false)}</div>
                    <div className="min-w-0 flex-1">{timelineNode(false)}</div>
                    <ChromeToggle collapsed={false} onToggle={() => collapseToRef.current(true)} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {chart === undefined ? (
        <p className="px-4 py-6 text-sm text-[var(--md-on-surface-variant)]">Loading chart</p>
      ) : chart === null ? (
        <div className="px-4 py-6 text-sm"><p role="alert">{historical?historyError||'Historical chart unavailable':'Chart unavailable'}</p>{historical ? <button type="button" className="mt-2 rounded-md border px-3 py-2" aria-label="Retry historical chart" onClick={() => { const query = new URLSearchParams(window.location.search); setHistoryRequest(request => ({...(request ?? {event: query.get('event') ?? transitRef.current?.event, date: query.get('date') ?? transitRef.current?.date, hour: query.has('hour') ? Number(query.get('hour')) : transitRef.current?.hour}), version: ++historySelectionVersion.current})); }}>Retry ↻</button> : null}</div>
      ) : (
        <>

          <div
            ref={panelRef}
            data-map-panel
            className="relative mx-3 mt-2 flex min-h-[160px] flex-1 justify-center overflow-hidden md:mx-4"
            style={!phone && aspects && stageWidth > 0 ? { maxHeight: Math.floor(stageWidth / aspects.min) } : undefined}
          >
            <div
              ref={stageRef}
              data-terrain-imagery={photoStatus} data-map-ready={ready ? 'true' : 'false'}
              data-graticule={graticule ? 'on' : 'off'}
              data-isobars={isobars ? 'true' : 'false'}
              data-frames={complete ? 'complete' : 'streaming'}
              data-renderer={renderer}
              data-tilt={tilt.toFixed(4)}
              data-slice={sliced ? sliceReady ? "ready" : "preparing" : "off"}
              data-bearing={(cameraRef.current?.bearingRadians??0).toFixed(4)}
              data-map-mode={threeD ? '3d' : '2d'}
              data-valid-ms={validMs}
              className="relative min-w-0 flex-1 touch-none overflow-hidden rounded-md bg-[#e9eff4] dark:bg-[#232f3e]"
            >
              <canvas ref={glCanvasRef} data-chart-layer="webgl" className="absolute" aria-hidden="true" />
              <canvas ref={canvasFallbackRef} data-chart-layer="canvas2d" className="absolute hidden" aria-hidden="true" />
              <canvas ref={satCanvasRef} data-satellite-layer className="pointer-events-none absolute" aria-hidden="true" />
              <canvas ref={flowCanvasRef} data-flow-layer className="pointer-events-none absolute" aria-hidden="true" />
              <canvas
                ref={overlayRef}
                aria-label={`Mean sea level pressure, ${chartTitle(validMs, zone, nearNow)}`}
                className="absolute touch-none"
                onPointerDown={(event) => {
                  if (swallowRef.current) { swallowRef.current = false; return; }
                  if (event.button !== 0) return;
                  if (event.pointerType === 'touch') event.preventDefault();
                  cameraMoveRef.current = null;
                  recoveryRef.current.cancel();
                  const canvas = event.currentTarget;
                  try { canvas.setPointerCapture(event.pointerId); } catch { /* a dispatched pointer has no browser id */ }
                  if (pointersRef.current.size === 0 && mapHeldPlayingRef.current === null) {
                    mapHeldPlayingRef.current = clockRef.current.playing;
                    mapHeldNowRef.current = clockRef.current.followNow === true;
                    mapHeldAtRef.current = performance.now();
                    clockRef.current = { ...clockRef.current, followNow: false, playing: false };
                    setMinute(clockRef.current.minute);
                    setPlaying(false);
                  }
                  pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                  if (pointersRef.current.size === 1) {
                    dragRef.current = { moved: 0, multi: false, started: performance.now(), x: event.clientX, y: event.clientY, kind: event.pointerType, armed: false };
                    panStartRef.current = cameraRef.current ? { camera: { ...cameraRef.current }, last: cameraRef.current, pitch: tiltRef.current, x: event.clientX, y: event.clientY, moving: false } : null;
                    pinchRef.current = 0;
                  touchGestureRef.current = null;
                    window.clearTimeout(longTimerRef.current);
                    if (event.pointerType === 'touch') {
                      longTimerRef.current = window.setTimeout(() => {
                        if (dragRef.current.moved > 8 || dragRef.current.multi) return;
                        dragRef.current.armed = true;
                        navigator.vibrate?.(10);
                      }, 450);
                    }
                  } else {
                    panStartRef.current = null;
                    dragRef.current.multi = true;
                    dragRef.current.armed = false;
                    window.clearTimeout(longTimerRef.current);
                    pinchRef.current = 0;
                    const pts=[...pointersRef.current.values()];
                    const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
                    const x=(pts[0].x+pts[1].x)/2,y=(pts[0].y+pts[1].y)/2;
                    touchGestureRef.current={mode:'pending',distance,x,y,lastDistance:distance,lastX:x,lastY:y,updated:0,batchStarted:0};
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (dragRef.current.kind === 'touch' && pointersRef.current.size > 0) return;
                  openChip(event.clientX, event.clientY);
                }}
                onPointerMove={(event) => {
                  const pointers = pointersRef.current;
                  if (!pointers.has(event.pointerId) || !cameraRef.current || !homeRef.current) return;
                  const previous = pointers.get(event.pointerId);
                  if (!previous) return;
                  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                  const rect = event.currentTarget.getBoundingClientRect();
                  const stage = stageRef.current as (HTMLDivElement & { chartApi?: { redraw: () => void } }) | null;
                  if (pointers.size >= 2) {
                    const pts = [...pointers.values()];
                    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                    dragRef.current.multi = true;
                    dragRef.current.moved = 20;
                    const middle = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
                    const gesture = touchGestureRef.current ?? { mode: 'pending' as const, distance: dist, x: middle.x, y: middle.y, lastDistance: dist, lastX: middle.x, lastY: middle.y, updated:0, batchStarted:0 };
                    if (gesture.mode === 'pending') {
                      // Pointer events arrive one finger at a time. Compare a paired
                      // sample, otherwise a fast parallel swipe looks like a pinch.
                      // Allow a stationary second finger after a short bounded wait.
                      const now=performance.now();
                      if(!gesture.updated)gesture.batchStarted=now;
                      gesture.updated|=1<<[...pointers.keys()].indexOf(event.pointerId);
                      if(gesture.updated!==3&&now-gesture.batchStarted<48){touchGestureRef.current=gesture;return;}
                      gesture.updated=0;
                      const spread = Math.abs(dist - gesture.distance), travel = Math.hypot(middle.x - gesture.x,middle.y - gesture.y);
                      if (spread > 9 && spread > travel) gesture.mode = 'pinch';
                      else if (travel > 10 && travel > spread) gesture.mode = 'tilt';
                    }
                    if (gesture.mode === 'tilt') changeOrientation(tiltRef.current + (middle.y - gesture.lastY) * .006,(middle.x - gesture.lastX) * .006);
                    if (gesture.mode === 'pinch' && gesture.lastDistance > 0 && dist > 0) {
                      const clipX = (middle.x - rect.left) / rect.width * 2 - 1;
                      const clipY = 1 - (middle.y - rect.top) / rect.height * 2;
                      cameraRef.current = zoomShared(cameraRef.current, clipX, clipY, gesture.lastDistance / dist, homeRef.current);
                      stage?.chartApi?.redraw();
                    }
                    gesture.lastDistance = dist; gesture.lastX = middle.x; gesture.lastY = middle.y;
                    touchGestureRef.current = gesture;
                    pinchRef.current = dist;
                    return;
                  }
                  const travel = Math.hypot(event.clientX - dragRef.current.x, event.clientY - dragRef.current.y);
                  dragRef.current.moved = Math.max(dragRef.current.moved, travel);
                  if (travel > 8 || panStartRef.current?.moving) {
                    if (panStartRef.current) panStartRef.current.moving = true;
                    dragRef.current.armed = false;
                    window.clearTimeout(longTimerRef.current);
                  } else return;
                  const dx = ((event.clientX - previous.x) / rect.width) * 2;
                  const dy = -((event.clientY - previous.y) / rect.height) * 2;
                  if (threeDRef.current) {
                    // Restart after a multi-touch gesture using this event's prior
                    // sample; a stale pre-pinch camera must never be restored.
                    const active = panStartRef.current;
                    const current = cameraRef.current;
                    const pan = active && active.pitch === tiltRef.current && active.last === current
                      ? active : { camera: { ...current }, last: current, pitch: tiltRef.current, x: previous.x, y: previous.y, moving: true };
                    panStartRef.current = pan;
                    cameraRef.current = panTilt(GEO, pan.camera, tiltRef.current,
                      (event.clientX-pan.x)/rect.width*2, -(event.clientY-pan.y)/rect.height*2, homeRef.current);
                    pan.last = cameraRef.current;
                    recoveryRef.current.travel(performance.now(),cameraRef.current.bearingRadians??0);
                  } else cameraRef.current = clampToData(GEO, panBy(cameraRef.current, dx, dy), homeRef.current);
                  stage?.chartApi?.redraw();
                }}
                onPointerUp={(event) => {
                  const canvas = event.currentTarget;
                  window.clearTimeout(longTimerRef.current);
                  // A hold freezes time. A touch that stays within 8 px opens the
                  // action chip on release; a short click still selects a point.
                  const drag = dragRef.current;
                  const tracked = pointersRef.current.has(event.pointerId) && pointersRef.current.size === 1 && event.button === 0 && !drag.multi;
                  const duration = performance.now() - drag.started;
                  if (tracked && drag.kind === 'touch' && drag.armed && drag.moved <= 8) openChip(event.clientX, event.clientY);
                  else if (tracked && drag.moved < 6 && duration < (drag.kind === 'touch' ? 450 : 350)) pickPoint(event.clientX, event.clientY);
                  try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
                  releaseMapPointer(event.pointerId);
                }}
                onPointerCancel={(event) => {
                  window.clearTimeout(longTimerRef.current);
                  dragRef.current.armed = false;
                  releaseMapPointer(event.pointerId);
                }}
                onLostPointerCapture={(event) => {
                  window.clearTimeout(longTimerRef.current);
                  releaseMapPointer(event.pointerId);
                }}
                tabIndex={0}
                onBlur={()=>mapKeysRef.current.clear()}
                onKeyUp={(event)=>{mapKeysRef.current.delete(event.key.startsWith('Arrow')?event.key:event.key.toLowerCase());}}
                onKeyDown={(event) => {
                  if(event.metaKey||event.ctrlKey||event.altKey)return;
                  const key=event.key.startsWith('Arrow')?event.key:event.key.toLowerCase();
                  if(threeDRef.current&&key==='n'){event.preventDefault();northUp();return;}
                  if(threeDRef.current&&['w','a','s','d','e','q','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)){
                    event.preventDefault();mapKeysRef.current.add(key);
                    if(!event.repeat){keyboardStepRef.current(1/60);redrawCamera();}
                    return;
                  }
                  const camera = cameraRef.current, home = homeRef.current;
                  if (!camera || !home) return;
                  if (event.key === '2' || event.key === '3') { event.preventDefault(); changeMapMode(event.key === '3'); return; }
                  if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); changeTilt(tiltRef.current + (event.key === 'PageDown' ? 1 : -1) * Math.PI / 18); return; }
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) {
                    event.preventDefault();
                    if (event.key === 'Home') { cameraMoveRef.current = null; cameraRef.current = { ...home.home }; }
                    else if (event.key === '+' || event.key === '=' || event.key === '-') cameraRef.current = zoomShared(camera, 0, 0, event.key === '-' ? 1.2 : 1 / 1.2, home);
                    else {
                      const dx = event.key === 'ArrowLeft' ? .12 : event.key === 'ArrowRight' ? -.12 : 0;
                      const dy = event.key === 'ArrowUp' ? -.12 : event.key === 'ArrowDown' ? .12 : 0;
                      const focus = tiltRef.current ? mapUnproject(GEO, renderCamera(camera), 0, 0) : null;
                      cameraRef.current = focus ? anchorTilt(GEO, camera, tiltRef.current, focus, dx, dy, home, elevationAtRef.current, true) : clampToData(GEO, panBy(camera, dx, dy), home);
                    }
                    redrawCamera();
                  }
                }}
                
              />
              <canvas data-wind-barbs ref={windCanvasRef} className="pointer-events-none absolute" aria-hidden="true" />
              <canvas ref={trafficCanvasRef} data-traffic-layer className="pointer-events-none absolute" aria-hidden="true" />
              {cameraRef.current && GEO.projection === 'equirectangular' && Number.isFinite(validMs) ? <AtmosphereMap camera={renderCamera(cameraRef.current)} geo={GEO} elevation={elevationAtRef.current} terrainEpoch={terrainEpoch}
                lat={cameraRef.current.centerY} lon={((cameraRef.current.centerX / GEO.F + GEO.lon0 + 540) % 360) - 180}
                validMs={validMs} width={stageSize.width} height={stageSize.height} active={tilt > .02} onInspection={inspectAtmosphere} reconstruction={historical&&historyEvent==='everest-1953'?{chart,elevation:elevationAtRef.current}:undefined} /> : null}
              {trafficOn && trafficReplay ? <span className="traffic-replay-status" data-traffic-replay={trafficReplay} title="Recorded during this viewing session. Earlier history and gaps are unavailable.">{trafficReplay === 'replay' ? 'Replay · session' : 'No recorded traffic'}</span> : null}
              {trafficOn && selectedTraffic.length ? <TrafficCards selected={selectedTraffic} trails={heldTraffic?.trails ?? trailsRef.current} routes={heldTraffic?.routes ?? routesRef.current} zone={displayZone} nowMs={heldTraffic?.epoch ?? nowMs} replayMs={trafficLive || heldTraffic ? undefined : validMs} onRemove={selectTraffic} /> : null}
              {mapNotice ? <div className="map-notice" role="status" aria-live="polite">{mapNotice}</div> : null}
              {pointClip && point && Math.abs(pointClip.x) <= 1 && Math.abs(pointClip.y) <= 1 ? <span data-point-marker data-lat={point.lat} data-lon={point.lon}
                aria-hidden="true" className={pointStyles.marker}
                style={{ left: `${(pointClip.x + 1) * 50}%`, top: `${(1 - pointClip.y) * 50}%` }} /> : null}
              {chip && chart ? (() => {
                const named = describePoint(chip, { towns: pointPlaces, airports: airportRows, manifest: chart.manifest.places, atSea: pointAtSea(chart, chip.lat, chip.lon) });
                return <MapPointChip title={named.title} detail={named.detail} left={chip.left} top={chip.top} note={chip.note} section
                  onAsk={() => { if(historical){notifyMap('Historical questions are not connected yet');return;} setPoint({ lat: chip.lat, lon: chip.lon }); setFly(false); setChatOpen(true); flashChip('Ask about here'); }}
                  onPlace={() => {
                    const outcome = makeThisPlace(chip.lat, chip.lon);
                    const note = outcome === 'restored' ? 'Restored' : outcome === 'same' ? 'Your place' : 'Set as my place';
                    setChip((current) => current ? { ...current, note } : current);
                  }}
                  onSection={() => { setPoint({ lat: chip.lat, lon: chip.lon }); setFly(false); setCoastalLens(null); flashChip('Section from here'); }}
                  onCopy={() => {
                    const text = `${chip.lat.toFixed(4)}, ${chip.lon.toFixed(4)}`;
                    const mark = (note: string) => setChip((current) => {
                      if (current) chipRef.current = { ...current, note };
                      return current ? { ...current, note } : current;
                    });
                    if (!navigator.clipboard?.writeText) { mark('Copy unavailable'); return; }
                    void navigator.clipboard.writeText(text).then(() => mark('Copied'), () => mark('Copy unavailable'));
                  }}
                  onClose={() => { chipRef.current = null; setChip(null); }} />;
              })() : null}
              {ghost ? <span className="map-chip-float" style={{ left: `${ghost.left}%`, top: `${ghost.top}%` }} role="status">{ghost.note}</span> : null}
              {!teaching ? <div className="map-tools" aria-label="Map camera">
                <div className="map-tool-buttons">
                <div className="map-zoom">
                  <button type="button" aria-label="Zoom in" onClick={() => zoomCamera(1 / 1.25)}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" d="M12 7v10M7 12h10" /></svg></button>
                  <button type="button" aria-label="Zoom out" onClick={() => zoomCamera(1.25)}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" d="M7 12h10" /></svg></button>
                </div>
                {renderer === 'webgl2' && GEO.projection === 'equirectangular' ? <div className="map-zoom">
                  <button type="button" aria-label="2D map" aria-pressed={!threeD} title="2D map · 2" onClick={() => changeMapMode(false)}>2D</button>
                  <button type="button" aria-label="3D map" aria-pressed={threeD} title="3D · WASD move · arrows look · E/Q height" onClick={() => changeMapMode(true)}>3D</button>
                  {threeD ? <button type="button" aria-label="North up" title="North up · N" onClick={northUp}><span aria-hidden="true" style={{display:'inline-flex',alignItems:'center',whiteSpace:'nowrap'}}><span style={{transform:`rotate(${-(cameraRef.current?.bearingRadians??0)}rad)`}}>↑</span>N</span></button> : null}
                </div> : null}
                {threeD ? <div className="map-slice-control"><button type="button" className="map-slice" aria-label="Terrain and atmosphere slice" disabled={!sliced&&(cameraRef.current?.halfHeight??10)>1} aria-pressed={sliced} aria-busy={sliced&&!sliceReady} title={!sliced&&(cameraRef.current?.halfHeight??10)>1?"Zoom in for a terrain and atmosphere slice":sliced&&!sliceReady?"Preparing terrain slice · click to cancel":"Narrow terrain and atmosphere slice"} onClick={toggleSlice}>Slice</button>{sliced ? <input className="map-slice-position" type="range" min={-100} max={100} step={1} value={sliceOffset} aria-label="Slice position" aria-valuetext={`${Math.round(sliceOffset/100*(sliceOriginRef.current?.halfWidthM??0)*.6)} metres from centre`} title="Move the slice back and forth" onChange={event=>moveSlice(Number(event.target.value))} /> : null}</div> : null}
                <span className="relative grid"><button type="button" aria-label="Recenter map" title={place?.name ? `Return to ${place.name}` : 'Recenter map'} className="map-return" onClick={recenterMap}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" /><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg><span>{place?.name ?? 'Home'}</span></button><PressNote text={recenterNote.note} /></span>
                {/* One control per viewport: phones carry the lens-scoped overlay toggles here; wider surfaces keep them in the lens row. */}
                {phone && !historical && ['pressure', 'rain', 'temp'].includes(lens) ? <span className="relative grid"><button type="button" aria-label="Satellite" aria-pressed={satellite} onClick={() => { satelliteNote.show(satellite ? 'Satellite off' : 'Satellite on'); toggleSatellite(!satellite); }}><SatelliteIcon /></button><PressNote text={satelliteNote.note} /></span> : null}
                {phone && lens === 'fly' ? <span className="relative grid"><button type="button" aria-label="Traffic" aria-pressed={trafficOn} onClick={() => { trafficNote.show(trafficOn ? 'Traffic off' : 'Traffic on'); toggleTraffic(!trafficOn); }}><TrafficIcon /></button><PressNote text={trafficNote.note} /></span> : null}
                <button type="button" aria-label="Data sources" title="Data sources" aria-expanded={showSources} onClick={() => setShowSources((v) => !v)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" /><path fill="currentColor" d="M11.2 10.2h1.6V16h-1.6zM11.2 7.4h1.6V9h-1.6z" /></svg></button>
                </div>
                {showSources ? <div className="map-sources" style={{maxWidth:'calc(100vw - 7rem)'}}><label className="flex items-center gap-2 px-2 py-1"><input type="checkbox" checked={photoTerrain} onChange={togglePhotoTerrain} />Photo terrain</label>{photoTerrain?<p>Everest · {EVEREST_IMAGERY.acquisition_datetime.slice(0,10)} · {EVEREST_IMAGERY.attribution} Modern surface imagery; historical weather retains its selected date.{photoStatus==='unavailable'?' Imagery unavailable; switch off and on to retry.':''}</p>:null}{historyEvent==='everest-1953'?<p>{EVEREST_DETAILS} <a href={EVEREST_SOURCE} target="_blank" rel="noreferrer">Expedition observations</a> · <a href="https://teara.govt.nz/en/interactive/28428/final-ascent-of-everest" target="_blank" rel="noreferrer">Ascent route</a></p>:null}{chart.cyclone?<p>Best-track cyclone reconstruction over ERA5. The 11 km maximum-wind radius, radial profile and 15° inflow are synthetic; track and intensity follow BOM records. <a href={chart.cyclone.source} target="_blank" rel="noreferrer">Best track</a></p>:null}{historyEvent==='dday'?<HistoricalSceneControls layers={historyLayers} onToggle={layer=>setHistoryLayers(v=>({...v,[layer]:!v[layer]}))}/>:null}<div ref={setExplainHost} /><p role="note">{flowWindLegend(flowSource)}. {threeD ? 'Atmospheric layers use synthetic data with scale-adapted height and emphasised vertical motion. ' : ''}{historical?chart.manifest.attribution.map(a=>`${a.source} · ${a.licence}`).join('; '):ATTRIBUTION}</p></div> : null}
              </div> : null}
              {teachHere || teaching ? <MapTeaching geo={GEO} chart={chart} complete={complete} minute={minute} camera={cameraRef.current} width={stageSize.width} height={stageSize.height}
                onActive={(active, at) => {
                  if (active && !teachingRef.current) { heldPlayingRef.current = clockRef.current.playing; heldFieldRef.current = fieldRef.current; }
                  teachingRef.current = active; setTeaching(active);
                  clockRef.current = { ...clockRef.current, followNow: false, playing: active ? false : heldPlayingRef.current, minute: at ?? clockRef.current.minute };
                  setPlaying(clockRef.current.playing); setMinute(clockRef.current.minute);
                  if (!active) remember({ field: heldFieldRef.current });
                  setFly(false);
                  if (active) { toggleTraffic(false); for (const item of [...optionalRef.current]) disableOptional(item); }
                  if (active) closeChat(false);
                }}
                onFocus={focusFeature} onField={(f) => remember({ field: f })} explainHost={explainHost} autoTour={autoTour} onStarted={() => setShowSources(false)} /> : null}
              {phone && !teaching ? <div className="map-chat-float"><ChatButton open={chatOpen} onClick={toggleChat} /></div> : null}
              <PhoneHoldNames active={phone} />
              {windBarbs ? <span className="pointer-events-none absolute bottom-16 right-2 rounded bg-[var(--md-surface)]/90 px-2 py-1 text-[10px] sm:bottom-6">10 m wind · barb = 10 kt · half = 5</span> : null}
              <div className="map-legend pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 px-2 py-0.5 text-[11px] tabular-nums" data-pressure-legend={units.pressure} data-pressure-state={pressureLegend} aria-busy={!!pendingField}>
                {pendingField ? <span className="map-loading-mark" role="status" aria-label={`${pendingField} loading for selected time`} title={`${pendingField}: loading selected time`}>◌</span> : null}
                {field === 'none' ? <span data-pressure-chip data-legend={legend} title="Mean sea level pressure">{legend === 'missing' ? 'Pressure unavailable' : units.pressure}</span> : null}
                {field === 'none' || stageSize.width >= 760 ? <ScaleBar geo={GEO} camera={cameraRef.current ? renderCamera(cameraRef.current) : null} width={stageSize.width} units={units} /> : null}
                {field !== 'none' ? (legend === 'missing' ? (
                  <span data-legend="missing">{FIELD_LABEL[field]} unavailable</span>
                ) : (
                  <>
                    <span data-field-label data-legend={legend}>{coastalLens === 'kite' ? 'Kite' : FIELD_LABEL[field]}</span>
                    {legend === 'ready' ? <Legend field={field} band={coastalLens === 'kite' ? kiteBand : null} /> : null}
                  </>
                )) : null}
                {legend === 'error' || pressureLegend === 'error' ? <button type="button" className="pointer-events-auto underline" onClick={() => chart.retry?.(clockRef.current.minute, [field === 'none' ? 'mslp' : FIELD_VARIABLE[field], 'u10', 'v10', ...(satellite ? ['tcc'] : [])])} aria-label="Retry weather for selected time">Retry ↻</button> : null}
                {cloudLegend ? <span data-cloud-legend={cloudLegend === 'model' ? 'model' : 'satellite'}>{cloudLegend}</span> : null}
              </div>
              {/* Sources are credited in the page footer; only a synthetic test chart is marked on the map. */}
              {chart.manifest.attribution.some((a) => a.source.startsWith('Synthetic')) ? <span className="chart-fixture-note pointer-events-none text-[10px] font-medium text-[var(--md-on-surface-variant)]">Synthetic chart · test data</span> : null}
            </div>
            {!menuOpen && fly && flyDetail && !chatOpen && airport ? <FlyPanel airport={airport} place={place ?? null} zone={displayZone} validMs={validMs} nowMs={nowMs} onClose={() => toggleSection(false)} anchorRef={panelRef} /> : null}
            {!menuOpen && pointVisible && point && !chatOpen && !coastalLens ? <PointPanel reconstructedModel={cycloneReading?.model??reconstructedPoint} archiveOnly={historical} point={point} name={pointTitle} detail={pointDetail} isPlace={place?.id === placeForPoint(point.lat, point.lon, manifestList, pointPlaces, airportRows, { atSea: pointAtSea(chart, point.lat, point.lon) }).id} onMakePlace={() => makeThisPlace(point.lat, point.lon)} validMs={validMs} lens={lens} terrainM={terrainM} section={sectionSamples} sectionGeometry={sectionGeometry} sectionExpedition={historical&&historyEvent==='everest-1953'} orographyM={orographyM} mslpHpa={mslpHpa}
              collectorIcao={chart.aviation?.airports.find((item) => distanceBearing(point.lat, point.lon, item.lat, item.lon).km < 1)?.icao}
              onClose={() => closePoint()} anchorRef={panelRef} panelRef={pointPanelRef} /> : null}
            {!menuOpen && coastalLens && !teaching && !chatOpen && (point || place) ? <CoastalPanel
              lens={coastalLens} point={point ?? place!} name={point ? pointTitle : place?.name ?? ''} detail={point ? pointDetail : place?.datum ?? ''} isPlace={place?.id === placeForPoint((point ?? place!).lat, (point ?? place!).lon, manifestList, pointPlaces, airportRows, { atSea: pointAtSea(chart, (point ?? place!).lat, (point ?? place!).lon) }).id} onMakePlace={() => { const at = point ?? place; return at ? makeThisPlace(at.lat, at.lon) : 'same'; }}
              coast={shoreCoast ?? chart.coast} nowMs={nowMs} zone={zone} clockZone={clockMode === 'place' ? null : displayZone} band={kiteBand}
              onBand={(band) => { setKiteBand(band); setPref('kiteBand', band); }}
              onClose={() => { closePoint(false); changeLens('pressure'); document.querySelector<HTMLButtonElement>('[data-lens="pressure"]')?.focus({ preventScroll: true }); }}
              anchorRef={panelRef} panelRef={pointPanelRef} /> : null}
            <ChatPanel open={chatOpen} onClose={() => closeChat()} onOpen={() => toggleChat()} anchorRef={panelRef} panelRef={chatPanelRef}
              context={() => {
                const camera = cameraRef.current ? renderCamera(cameraRef.current) : null;
                const centre = camera ? unproject(GEO, camera.centerX, camera.centerY) : null;
                const model = point ? peekPointModel(point.lat, point.lon, validMs) : null;
                return {
                  place: place ? { id: place.id, name: place.name, zone } : null,
                  timeUtc: new Date(validMs).toISOString(),
                  timeLocal: playheadLabel || null,
                  lens,
                  camera: centre && camera ? { lat: centre.lat, lon: centre.lon, zoom: camera.halfHeight } : null,
                  point: point ? { lat: point.lat, lon: point.lon, name: pointTitle || null, profile: model ? pointSurfaceAt(model, validMs) : null } : null,
                  fly: fly && airport ? { icao: airport.icao, metar: airport.metar?.raw ?? null, taf: airport.taf?.raw ?? null } : null,
                  units: {
                    mode: units.mode,
                    pressure: units.pressure,
                    temp: units.temp,
                    wind: 'kt',
                    height: units.height,
                    visibility: units.visibility,
                    rain: units.rain,
                    flightLevel: units.flightLevel,
                    transitionFt: units.transitionFt,
                  },
                  runId: chart.manifest.run,
                  dataSha256: null,
                  level: null,
                  cardId: null,
                  rules: null,
                } satisfies ChatContext;
              }}
              onPlace={(lat, lon) => focusChatPlace(lat, lon)}
              onAnchor={(anchor) => focusChatPlace(anchor.lat, anchor.lon, true)}
              onTime={(iso) => {
                const ms = Date.parse(iso);
                if (!Number.isFinite(ms)) return;
                const next = Math.max(0, Math.min(span, (ms - runMs) / 60_000 - chart.manifest.forecastHours[0] * 60));
                clockRef.current = { ...clockRef.current, minute: next, playing: false };
                setMinute(next); setPlaying(false);
              }}
            />
          </div>

          <div className="mx-3 flex justify-center md:mx-4">
          <div className="map-lens-wrap flex min-w-0 flex-1 items-center gap-1" style={groupWidth > 0 ? { maxWidth: groupWidth } : undefined}>
          <LensBar
            lens={lens}
            availableLenses={historical ? ['pressure', 'wind', ...(chart.manifest.variables.rain24 ? ['rain' as const] : []), ...(chart.manifest.variables.t2m ? ['temp' as const] : [])] : undefined}
            satelliteAvailable={!historical}
            onLens={changeLens}
            phone={phone}
            section={flyDetail}
            onSection={() => toggleSection(!flyDetail)}
            sectionAvailable={!!airport}
            windBarbs={windBarbs}
            windAvailable={!!chart.manifest.variables.u10 && !!chart.manifest.variables.v10}
            onWindBarbs={toggleWindBarbs}
            satellite={satellite}
            onSatellite={toggleSatellite}
            traffic={trafficOn}
            onTraffic={toggleTraffic}
          />
          {!phone ? <ChatButton open={chatOpen} onClick={toggleChat} /> : null}
          </div>
          </div>
        </>
      )}
    </div>
  );
}

function Legend({ field, band }: { field: FieldId; band?: KiteBand | null }) {
  const { units } = useUnits();
  if (band) return <span className="flex items-center gap-2" data-kite-legend>{(['below', 'inside', 'above'] as const).map((state, i) => {
    const c = kiteBandColor(state)!;
    return <span key={i} className="flex items-center gap-1"><span className="h-2 w-2" style={{ background: `rgb(${c.join(',')})` }} />{i === 0 ? `<${band.min}` : i === 1 ? `${band.min}–${band.max}` : `>${band.max} kt`}</span>;
  })}</span>;
  if (field === 'none') return null;
  const scale = legendScale(field);
  const text = (stop: number, last: boolean) => {
    if (field === 'wind') return last ? `${stop} kt` : String(stop);
    if (field === 'temp') {
      const n = units.temp === 'F' ? Math.round(cToF(stop)) : stop;
      return last ? `${n} ${units.temp === 'F' ? '°F' : '°C'}` : String(n);
    }
    const n = units.rain === 'in' ? formatRainAmount(stop, units) : String(stop);
    return last ? `${n} ${units.rain === 'in' ? 'in' : 'mm'}` : n;
  };
  const gradient = scale.stops.map(({ value, color }) => {
    const css = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${color.a})`;
    return `${css} ${((value - scale.min) / (scale.max - scale.min)) * 100}%`;
  }).join(', ');
  const base = (dark: boolean) => {
    const color = fieldBase(field, dark, true);
    return color ? `rgb(${color.r * 255}, ${color.g * 255}, ${color.b * 255})` : 'var(--md-surface)';
  };
  return (
    <>
      <span>{field === 'temp' ? '≤' : ''}{text(scale.min, false)}</span>
      <span className="map-legend-scale" aria-hidden="true" style={{ backgroundImage: `linear-gradient(90deg, ${gradient})`, '--scale-day': base(false), '--scale-night': base(true) } as CSSProperties} />
      <span>≥{text(scale.max, true)}</span>
    </>
  );
}
