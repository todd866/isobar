'use client';
import {atmosphereDisplayCamera} from '@/lib/atmosphere-display';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildAtmosphereProfile } from '@/lib/atmosphere-profile';
import { syntheticAtmosphereProfile, syntheticAtmosphereVectors, drawAtmosphereFlow } from '@/lib/atmosphere-flow';
import { type TeachingAtmosphereContext, type TeachingScenario } from '@/lib/atmosphere-teaching';
import { drawAtmosphereHeightGuide } from '@/lib/atmosphere-height-guide';
import {mapProject,type Lambert} from '@/lib/lambert';
import type { TiltedCamera } from '@/lib/tilt-navigation';
import {createMountainWindRenderer} from '@/lib/mountain-wind-renderer';
import type {MountainStreamline} from '@/lib/mountain-streamlines';
import type { CloudDensityTexture } from '@/lib/cloud-density';
import { createCloudVolumeLayer, type CloudVolumeLayer } from '@/lib/cloud-volume';
import type { ElevationAt } from '@/lib/map-generalise';
import { loadPointProfile, pointProfileAt, type PointModel } from '@/lib/point/openmeteo';
import { mountainTile } from '@/lib/mountain-wind';
import type { AtmosphereWorkerInput, WaveSummary } from '@/lib/cloud-density.worker';
import styles from './AtmosphereMap.module.css';

const GROUND_SIZE = 256, TILE_SIZE = 128;

export function AtmosphereMap({ compact = false, camera, geo, lat, lon, validMs, width, height, active, mountain, elevation, terrainEpoch, onInspection, origin, onFrame }: {
  compact?: boolean;
  onFrame?: (topM:number,anchor?:{lat:number;lon:number},radiusM?:number)=>void;
  origin?: {lat:number;lon:number};
  onInspection?: (strength:number)=>void;
  elevation?: ElevationAt | null;
  terrainEpoch?: number;
  /** Real wind over mountains. Historical views have no profile, so their field stays missing. */
  mountain?: {historical: boolean};
  camera: TiltedCamera; geo: Lambert; lat: number; lon: number; validMs: number; width: number; height: number; active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sectionButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState(false);
  const [clouds, setClouds] = useState(false);
  const [scenario, setScenario] = useState<TeachingScenario>('circulation');
  const [anchor, setAnchor] = useState(() => ({lat:origin?.lat ?? lat,lon:origin?.lon ?? lon}));
  useEffect(() => { if(origin) setAnchor({lat:origin.lat,lon:origin.lon}); },[origin?.lat,origin?.lon]);
  const wasActive=useRef(false);
  useEffect(()=>{if(active&&!wasActive.current)setAnchor({lat,lon});wasActive.current=active;},[active,lat,lon]);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudFailed, setCloudFailed] = useState(false);
  const [cloudRenderFailed,setCloudRenderFailed]=useState(false);
  const cloudCanvas=useRef<HTMLCanvasElement>(null);
  const cloudLayer=useRef<CloudVolumeLayer|null>(null);
  const cloudFrameTime=useRef<number|null>(null);
  const [streamlines,setStreamlines]=useState<MountainStreamline[]>([]);
  const [wave,setWave]=useState<{summary:WaveSummary|null;missing:string|null}|null>(null);
  const windRenderer=useMemo(()=>createMountainWindRenderer(),[]);
  const [cloudData,setCloudData]=useState<CloudDensityTexture|null>(null);
  const latestCloudData=useRef(cloudData);latestCloudData.current=cloudData;
  useEffect(() => { try { setClouds(sessionStorage.getItem('isobar.clouds') === 'on'); } catch {} }, []);
  const toggleClouds = (enabled:boolean) => {setClouds(enabled);try {sessionStorage.setItem('isobar.clouds',enabled?'on':'off');} catch {}};
  const [aircraftFt, setAircraftFt] = useState(5000);
  const selectedLat = Math.round(lat * 10) / 10, selectedLon = Math.round(lon * 10) / 10;
  const vectorTime = Math.floor(validMs / 300000) * 300000;
  const anchorGround = elevation?.(anchor.lon,anchor.lat) ?? 0;
  const teaching = useMemo<TeachingAtmosphereContext | undefined>(() => mountain ? undefined : ({kind:scenario,...anchor,groundM:Number.isFinite(anchorGround)?anchorGround:0,timeMs:vectorTime}), [mountain,scenario,anchor,anchorGround,vectorTime]);
  // Fixed geographic solver tile: the view centre over mountains, the anchor for teaching.
  const tile = mountainTile(mountain ? lat : anchor.lat, mountain ? lon : anchor.lon);
  // The point sounding's own fetch and cache: one Open-Meteo profile per tile and day.
  const wantsProfile = active && (mountain ? !mountain.historical : scenario === 'mountain-wave');
  const profileDay = new Date(validMs).toISOString().slice(0,10);
  const [pointModel,setPointModel]=useState<{key:string;model:PointModel|null}|null>(null);
  const profileKey = `${tile.key}:${profileDay}`;
  useEffect(()=>{
    if(!wantsProfile)return;
    const controller=new AbortController();let live=true;
    loadPointProfile(tile.lat,tile.lon,{mapTimeMs:validMs,signal:controller.signal}).then(model=>{if(live)setPointModel({key:profileKey,model});},()=>{if(live)setPointModel({key:profileKey,model:null});});
    return()=>{live=false;controller.abort();};
  // validMs is read for the request day only; profileKey carries it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[wantsProfile,profileKey]);
  const realModel = wantsProfile && pointModel?.key===profileKey ? pointModel.model : null;
  const profileLevels = useMemo(()=>{const p=pointProfileAt(realModel,validMs);return p?p.levels.map(l=>({hPa:l.hPa,zM:l.zM,tC:l.tC,rh:l.rh,windKt:l.windKt,windFrom:l.windFrom})):null;},[realModel,validMs]);
  const vectors = useMemo(() => mountain ? [] : syntheticAtmosphereVectors(lat, lon, camera.halfHeight, width / Math.max(1, height), vectorTime, camera.slice, elevation ?? undefined, teaching), [teaching, mountain, lat, lon, camera.halfHeight, camera.slice, width, height, vectorTime, elevation, terrainEpoch]);
  const cloudVectors = useMemo(() => vectors.map(v => ({...v, cloudPct: v.cloudPct ?? 0})), [vectors]);
  const solverWanted = !!mountain || teaching?.kind === 'mountain-wave';
  const cloudInput=useRef({vectors:cloudVectors,lat,lon,halfHeight:camera.halfHeight,aspect:width/Math.max(1,height),elevation,vectorTime,teaching,slice:camera.slice,mode:`${clouds}:${!!mountain}`,sliceKey:JSON.stringify(camera.slice??null),profile:profileLevels,profileKey:wantsProfile?`${profileKey}:${vectorTime}:${profileLevels?'1':'0'}`:'',tile:solverWanted?tile:null,mountain,profileSettled:pointModel?.key===profileKey});
  cloudInput.current={vectors:cloudVectors,lat,lon,halfHeight:camera.halfHeight,aspect:width/Math.max(1,height),elevation,vectorTime,teaching,slice:camera.slice,mode:`${clouds}:${!!mountain}`,sliceKey:JSON.stringify(camera.slice??null),profile:profileLevels,profileKey:wantsProfile?`${profileKey}:${vectorTime}:${profileLevels?'1':'0'}`:'',tile:solverWanted?tile:null,mountain,profileSettled:pointModel?.key===profileKey};
  useEffect(()=>{
    if(!active)return;
    let stopped=false,busy=false,last='',lastBase='';
    let sampledAt=0;
    let requested:typeof cloudInput.current|null=null;
    setCloudFailed(false);setCloudReady(false);setCloudData(null);setStreamlines([]);setWave(null);
    let worker:Worker;
    try {worker=new Worker(new URL('../lib/cloud-density.worker.ts',import.meta.url));}
    catch {setCloudFailed(true);return;}
    worker.onmessage=event=>{busy=false;if(stopped)return;const current=cloudInput.current;if(!requested||requested.vectorTime!==current.vectorTime||requested.profileKey!==current.profileKey||Math.abs(requested.lat-current.lat)>.02||Math.abs(requested.lon-current.lon)>.02||Math.abs(requested.halfHeight-current.halfHeight)>.01||requested.mode!==current.mode||requested.aspect!==current.aspect||requested.sliceKey!==current.sliceKey||JSON.stringify(requested.teaching)!==JSON.stringify(current.teaching)){last='';lastBase='';return;}if(event.data.error){setCloudFailed(true);return;}if(canvas.current){canvas.current.dataset.buildMs=String(event.data.buildMs);canvas.current.dataset.solveMs=String(Math.round(event.data.solveMs??0));canvas.current.dataset.renderedScenario=event.data.scenario??'mountain';canvas.current.dataset.renderedSlice=requested.sliceKey;}cloudFrameTime.current=requested.vectorTime;setCloudData(event.data.cloud);setStreamlines(event.data.streamlines);setWave({summary:event.data.wave??null,missing:event.data.missing??null});setCloudReady(!!event.data.cloud);};
    worker.onerror=()=>{busy=false;if(!stopped)setCloudFailed(true);};
    const update=()=>{
      const input=cloudInput.current;
      if(document.hidden||busy||input.halfHeight>.35||(!input.mountain&&!input.vectors.length))return;
      // Real wind waits for its profile request to settle; the result may be "missing".
      if(input.mountain&&!input.mountain.historical&&!input.profileSettled)return;
      const span=Math.min(.24,Math.max(.025,input.halfHeight*2));
      const north=Math.min(89.9,Math.round(input.lat/.02)*.02+span),south=Math.max(-89.9,Math.round(input.lat/.02)*.02-span);
      const east=Math.round(input.lon/.02)*.02+Math.min(.24,span*input.aspect),west=Math.round(input.lon/.02)*.02-Math.min(.24,span*input.aspect);
      const fingerprint=input.vectors.reduce((hash,v)=>{for(const n of [v.lat,v.lon,v.heightM,v.u,v.v,v.w??NaN,v.cloudPct])hash=Math.imul(hash^Math.round(n*1000),16777619);return hash;},2166136261);
      const baseKey=[west,east,south,north,input.vectorTime,input.profileKey,input.sliceKey,input.mode,input.tile?.key,fingerprint].join(':');
      // Recheck the DEM periodically because tiles can arrive without changing
      // the elevation callback; avoid rebuilding the terrain grids every idle tick.
      if(baseKey===lastBase&&performance.now()-sampledAt<5000)return;
      lastBase=baseKey;sampledAt=performance.now();
      // Ground for clipping: the drawn terrain's own sampler over the displayed volume.
      const margin=.02*(north-south);
      const groundBounds={west:west-margin,east:east+margin,south:south-margin,north:north+margin};
      const sampleGrid=(b:typeof groundBounds,nx:number,ny:number)=>{const h=new Float32Array(nx*ny);for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)h[y*nx+x]=input.elevation?.(b.west+x/(nx-1)*(b.east-b.west),b.south+y/(ny-1)*(b.north-b.south))??NaN;return h;};
      // ~100 m cells (256–512 per axis) so trails clip against the drawn DEM, not a coarser copy.
      const gy=Math.max(GROUND_SIZE,Math.min(512,Math.round((groundBounds.north-groundBounds.south)*111132/100)));
      const gx=Math.max(GROUND_SIZE,Math.min(512,Math.round((groundBounds.east-groundBounds.west)*111320*Math.cos((north+south)/2*Math.PI/180)/100)));
      const ground=sampleGrid(groundBounds,gx,gy);
      const tileGrid=input.tile?sampleGrid(input.tile,TILE_SIZE,TILE_SIZE):null;
      const terrainHash=(h:Float32Array|null)=>h?h.reduce((sum,v,i)=>(sum+(Number.isFinite(v)?Math.round(v):-99999)*(i+1))%2147483647,0):0;
      const key=baseKey+':'+terrainHash(ground)+':'+terrainHash(tileGrid);if(key===last)return;
      busy=true;last=key;requested=input;
      const tb=input.tile;
      const message:AtmosphereWorkerInput={slice:input.slice,cloudEnabled:clouds&&input.halfHeight<=.2,teaching:input.teaching,mountain:!!input.mountain,profile:input.profile,vectors:input.vectors,
        bounds:{west,east,south,north,minHeight:input.mountain?0:input.teaching?.groundM??0,maxHeight:input.mountain?13000:(input.teaching?.groundM??0)+(input.teaching?.kind==='sea-breeze'?2700:13000)},
        ground:{heights:ground,nx:gx,ny:gy,bounds:groundBounds},
        tile:tb&&tileGrid?{heights:tileGrid,nx:TILE_SIZE,ny:TILE_SIZE,bounds:{west:tb.west,east:tb.east,south:tb.south,north:tb.north}}:undefined,
        timeSeconds:(input.vectorTime-Math.floor(input.vectorTime/86400000)*86400000)/1000};
      worker.postMessage(message,[ground.buffer,...(tileGrid?[tileGrid.buffer]:[])]);
    };
    update();const timer=setInterval(update,1000);
    return()=>{stopped=true;clearInterval(timer);worker.terminate();};
  },[clouds,active,!!mountain,scenario,anchor.lat,anchor.lon]);
  useEffect(()=>{
    const previous=cloudFrameTime.current;
    if(previous!=null&&(previous!==vectorTime||Math.floor(previous/86400000)!==Math.floor(vectorTime/86400000))){
      setCloudReady(false);setCloudData(null);setStreamlines([]);cloudLayer.current?.clear();
    }
  },[vectorTime]);
  useLayoutEffect(()=>{
    if(!active||!clouds||!cloudCanvas.current)return;
    const node=cloudCanvas.current;
    const recreate=()=>{
      cloudLayer.current?.destroy();cloudLayer.current=null;
      try {
        cloudLayer.current=createCloudVolumeLayer(node);
        const data=latestCloudData.current;
        if(data)cloudLayer.current?.setData(data);
        setCloudRenderFailed(!cloudLayer.current);
      } catch {setCloudRenderFailed(true);}
    };
    const lost=(event:Event)=>{event.preventDefault();cloudLayer.current?.destroy();cloudLayer.current=null;setCloudRenderFailed(true);};
    node.addEventListener('webglcontextlost',lost);
    node.addEventListener('webglcontextrestored',recreate);
    recreate();
    return()=>{node.removeEventListener('webglcontextlost',lost);node.removeEventListener('webglcontextrestored',recreate);cloudLayer.current?.destroy();cloudLayer.current=null;};
  },[active,clouds]);
  useEffect(()=>{if(cloudData)cloudLayer.current?.setData(cloudData);},[cloudData,clouds,active]);
  const model = useMemo(() => mountain ? realModel : syntheticAtmosphereProfile(lat, lon, vectorTime, elevation ?? undefined, teaching), [teaching, mountain, realModel, lat, lon, selectedLat, selectedLon, vectorTime, elevation, terrainEpoch]);
  const profile = useMemo(() => model ? buildAtmosphereProfile(model, validMs) : null, [model, validMs]);
  const ground = profile?.terrainM ?? null;
  const aircraftM = Math.max(Math.min(aircraftFt * .3048,teaching?.kind==='sea-breeze'?teaching.groundM+2400:Infinity), ground == null ? 0 : ground + 100);
  const ceiling = Math.max(teaching?.kind==='sea-breeze'?(teaching.groundM+2700):12000, Math.min(aircraftM + 500,teaching?.kind==='sea-breeze'?teaching.groundM+2700:Infinity), ...(profile?.layers.map(l => l.topM + 500) ?? []));
  const inspection=section&&active?Math.min(1,.35+Math.max(0,aircraftM-(ground??0))/2500):0;
  useEffect(()=>{onInspection?.(inspection);return()=>onInspection?.(0);},[inspection,onInspection]);
  const closeSection = useCallback(() => {
    setSection(false);
    const control = compact ? sectionButton.current?.closest('[data-map-page]')?.querySelector<HTMLButtonElement>('[aria-label="Map tools"]') : sectionButton.current;
    // The compact launcher can disappear when Tools was closed outside the panel.
    // Focus the persistent disclosure after React restores its visibility.
    requestAnimationFrame(() => control?.focus({ preventScroll: true }));
  }, [compact]);
  useEffect(() => {
    if (!section) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeSection(); e.preventDefault(); e.stopPropagation(); } };
    // The open instrument owns Escape before a temporarily hidden point sheet.
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [section, closeSection]);
  // One short on-screen source line; blocked flow says so.
  const windState = mountain ? (camera.halfHeight > .35 ? 'distant' : wave?.summary ? 'linear' : wave?.missing || (wantsProfile && pointModel?.key===profileKey && !profileLevels) || mountain.historical ? 'missing' : 'preparing') : teaching?.kind==='mountain-wave' && wave?.summary ? 'idealised' : 'teaching';
  const sourceLine = windState==='distant' ? 'Zoom in for mountain wind' : windState==='missing' ? (wave?.missing==='terrain' ? 'Terrain unavailable' : 'Wind aloft unavailable') : wave?.summary ? wave.summary.label : mountain ? 'Wind aloft loading' : 'Illustrative profile';
  const waveTitle = wave?.summary ? `${wave.summary.blocked?'Flow largely blocked — linear theory approximate. ':''}Nh/U ${wave.summary.nh.toFixed(1)} · N ${wave.summary.N.toFixed(4)} s⁻¹ · mean wind ${Math.round(Math.hypot(wave.summary.U,wave.summary.V)/.514444)} kt${wave.summary.coverage<.999?` · ${Math.round(wave.summary.coverage*100)}% of the terrain tile loaded`:''}` : undefined;
  useLayoutEffect(() => {
    const node = canvas.current, ctx = node?.getContext('2d');
    if (!node || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (node.width !== Math.round(width * dpr)) node.width = Math.round(width * dpr);
    if (node.height !== Math.round(height * dpr)) node.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let request = 0, last = -Infinity;
    const draw = (now: number) => {
      if (now - last >= 32) {
        last = now; ctx.clearRect(0, 0, width, height);
        const volume=cloudLayer.current;
        if(clouds&&cloudReady&&!cloudRenderFailed&&camera.halfHeight<=.2)volume?.draw(atmosphereDisplayCamera(camera,teaching),width,height,document.documentElement.classList.contains('dark'),inspection,teaching ? .32 : 1);
        else volume?.clear();
        node.dataset.cloudBounds=cloudData?JSON.stringify(cloudData.bounds):'';
        node.dataset.cloudTime=String(cloudFrameTime.current??'');
        node.dataset.clouds=clouds?(cloudFailed||cloudRenderFailed?'unavailable':camera.halfHeight>.2?'distant':cloudReady?'on':'preparing'):'off';
        const displayCamera=atmosphereDisplayCamera(camera,teaching);
        const drawn = active ? ((mountain || (teaching && camera.halfHeight<=.35 && streamlines.length)) ? windRenderer(ctx,streamlines,geo,displayCamera,width,height,now/1000,document.documentElement.classList.contains('dark'),!!teaching) : drawAtmosphereFlow(ctx, vectors, geo, displayCamera, width, height, now / 1000, document.documentElement.classList.contains('dark'), elevation ?? undefined, vectorTime)) : {layers: 0, flows: 0};
        if(active && teaching && camera.halfHeight<=.35) drawAtmosphereHeightGuide(ctx,geo,displayCamera,width,height,teaching,document.documentElement.classList.contains('dark'));
        node.dataset.scenario=teaching?.kind??'mountain';node.dataset.wind=windState;
        node.dataset.anchor=teaching?`${teaching.lat},${teaching.lon}`:'';
        node.dataset.columnProjection=teaching?JSON.stringify([0,teaching.kind==='sea-breeze'?2500:teaching.kind==='mountain-wave'?12000:10000].map(z=>mapProject(geo,displayCamera,teaching.lat,teaching.lon,teaching.groundM+z))):'';
        node.dataset.frameTime=String(now);node.dataset.vectorCount=String(vectors.length);node.dataset.pathCount=String(streamlines.length);node.dataset.sliceKey=JSON.stringify(camera.slice??null);
        node.dataset.layers = String(drawn.layers); node.dataset.flows = String(drawn.flows);
      }
      if (active && (vectors.length || streamlines.length)) request = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(request);
  }, [cloudData,teaching,streamlines,windRenderer,mountain,windState,active, clouds, cloudReady, cloudFailed, cloudRenderFailed, cloudVectors, inspection, validMs, vectors, camera, geo, width, height, elevation]);
  if (!active) return null;
  const y = (m: number) => 180 - m / ceiling * 168;
  const knownCloud = !!profile?.levels.some(l => l.cloudFractionPct != null);
  const verticalKnown = !!profile?.levels.some(l => l.verticalVelocityMs != null);
  const status = camera.halfHeight >= 6 ? 'distant' : 'ready';
  let lastLabelY = Infinity;
  const shownLevels = profile?.levels.filter((level, i, levels) => {
    if (!compact) return i===0 || Math.abs(y(level.heightM)-y(levels[i-1].heightM))>=24;
    const position = y(level.heightM);
    if (Math.abs(position-lastLabelY)<40) return false;
    lastLabelY = position;
    return true;
  });
  return <>
    <canvas ref={cloudCanvas} data-cloud-volume className={styles.canvas} aria-hidden="true" style={{display:clouds?undefined:'none'}} />
    <canvas ref={canvas} data-atmosphere-layer data-source={mountain?(wave?.summary?'linear-wave':'missing'):'synthetic'} data-field-time={vectorTime} data-profile-time={profile?.timeMs} data-profile-state={status} className={styles.canvas} aria-hidden="true" />
    <div className={styles.instrument} data-atmosphere-instrument data-atmosphere-section-open={section ? 'true' : 'false'}>
      <div className={styles.row}>
        <button ref={sectionButton} aria-expanded={section} aria-label="Atmospheric section" onClick={() => section ? closeSection() : setSection(true)}>▱ <span>Atmosphere</span></button>
        <span className={styles.state} title={mountain?`${sourceLine}. Amber rises, blue sinks.`:"Synthetic airflow: amber rises, blue sinks. Open Atmosphere to choose a teaching model."} aria-label={mountain?`${sourceLine}: amber rises, blue sinks`:"Synthetic airflow: amber rises, blue sinks; illustrative pressure-level flow"}>≈</span>
      </div>
      {section ? <div className={styles.section} data-atmosphere-section>
        <div className={styles.row}>{teaching ? <select aria-label="Atmosphere model" title={scenario==='sea-breeze'?'Sea-breeze height shown at 3×; labels retain actual altitude':'Idealised teaching fields at this location'} value={scenario} onChange={e=>{setScenario(e.target.value as TeachingScenario);setAnchor({lat,lon});onFrame?.(e.target.value==='sea-breeze'?7500:e.target.value==='mountain-wave'?12000:10000,{lat,lon},e.target.value==='sea-breeze'?8000:0);}}><option value="circulation">Convection</option><option value="sea-breeze">Sea breeze</option><option value="thunderstorm">Thunderstorm</option><option value="mountain-wave">Mountain wave</option></select> : <span data-wind-source title={waveTitle}>{sourceLine}</span>}<button aria-label="Frame atmosphere" title="Fit the atmospheric column" onClick={()=>onFrame?.(teaching?.kind==='sea-breeze'?7500:teaching?.kind==='mountain-wave'?12000:10000,teaching??{lat,lon},teaching?.kind==='sea-breeze'?8000:0)}>⤢</button><button aria-label="Close atmospheric section" onClick={closeSection}>×</button></div>
        <div className={styles.cloudControls}><label className={styles.cloudToggle} title={cloudFailed||cloudRenderFailed?'Cloud texture unavailable; switch off and on to retry':'Synthetic clouds at the selected weather time'}><input type="checkbox" checked={clouds} onChange={event=>toggleClouds(event.target.checked)} />Clouds</label>
        {clouds&&windState==='idealised'&&!profileLevels?<span data-cloud-status>Synthetic humidity</span>:null}{compact&&(!profile||!knownCloud||profile.layers.length===0)?<span data-cloud-status>{!profile||!knownCloud?'No profile':'No layers'}</span>:null}</div>
        <svg viewBox={compact ? "0 0 260 235" : "0 0 260 205"} role="img" aria-label={profile ? `Synthetic column at ${selectedLat}, ${selectedLon}. Heights in feet above mean sea level. Horizontal shape is illustrative. ${!knownCloud ? "Cloud profile unavailable." : profile.layers.length===0 ? "No sampled cloud layer." : ""}` : 'Atmospheric profile unavailable'}>
          {(teaching?.kind==='sea-breeze'?[0,500,1000,1500,2000,2500].map(z=>z+teaching.groundM):[0, 3000, 6000, 9000, 12000]).filter(m => m <= ceiling).filter((_, i, rows) => !compact || i===0 || i===rows.length-1 || i===Math.floor(rows.length/2)).map(m => <g key={m}><path d={`M42 ${y(m)}H246`} className={styles.grid} /><text x="36" y={y(m) + 4} textAnchor="end">{Math.round(m / .3048 / 1000)}k</text></g>)}
          {profile?.layers.map(l => <g key={l.id}><rect x="80" width="130" y={y(l.topM)} height={Math.max(2, y(l.baseM) - y(l.topM))} rx="7" className={styles.cloud}/>{compact ? <title>{Math.round(l.cloudFractionPct)}% cloud</title> : <text x="145" y={(y(l.baseM) + y(l.topM)) / 2 + 4} textAnchor="middle">{Math.round(l.cloudFractionPct)}%</text>}</g>)}
          {ground != null ? <path d={`M42 ${y(ground)}H246V180H42Z`} className={styles.ground}/> : null}
          {shownLevels?.map((l, i) => <g key={i}>
            {l.windKt != null && l.windFromDeg != null ? <text x="240" y={y(l.heightM) + 4} textAnchor="end">{Math.round(l.windKt)}</text> : null}
            {l.verticalVelocityMs != null ? <text x="50" y={y(l.heightM) + 4} fill={l.verticalVelocityMs > 0 ? '#ad6726' : '#287b9e'}>{Math.abs(l.verticalVelocityMs)>.05 ? `${l.verticalVelocityMs>0?'↑':'↓'}${Math.abs(l.verticalVelocityMs).toFixed(1)}` : '·'}</text> : null}
          </g>)}
          <path d={`M42 ${y(aircraftM)}H246`} className={styles.aircraftLine}/><text x="65" y={y(aircraftM) - 4}>✈</text>
          <text x="8" y={compact?228:201}>ft AMSL</text><text x="244" y={compact?228:201} textAnchor="end">wind kt</text>
          {compact ? null : !profile || !knownCloud ? <text x="145" y="95" textAnchor="middle">{status === 'distant' ? 'Zoom in for atmosphere' : 'Cloud profile unavailable'}</text> : profile.layers.length === 0 ? <text x="145" y="95" textAnchor="middle">No sampled cloud layer</text> : null}
        </svg>
        <label className={styles.altitude}><span>✈</span><input type="range" aria-label="Reference aircraft altitude" min={Math.ceil(((ground ?? 0) + 100) / .3048 / 500) * 500} max={Math.floor(ceiling/.3048/500)*500} step="500" value={Math.round(aircraftM / .3048)} onChange={e => setAircraftFt(Number(e.target.value))}/><output>{Math.round(aircraftM / .3048 / 100) * 100} ft</output></label>
        <div className={styles.meta} title={profile ? `${profile.source.source} · ${profile.source.model} · ${profile.source.cycleKnown ? 'Run' : 'Retrieved'} ${profile.source.run}. ${verticalKnown ? 'Geometric vertical velocity, m/s positive up.' : 'Vertical velocity unavailable; horizontal wind is not an inferred updraft.'} Aircraft icon is an altitude marker at distant scale.` : 'Missing data is not clear sky.'}>
          <span>{profile?.source.model ?? 'Profile —'}</span><span>{verticalKnown ? '↕ m/s' : 'w —'}</span>
        </div>
        {teaching&&wave?.summary?<div className={styles.meta}><span data-wind-source title={waveTitle}>{sourceLine}</span></div>:null}
        <div className={styles.meta}><span>{selectedLat.toFixed(1)}°, {selectedLon.toFixed(1)}°</span><time dateTime={new Date(validMs).toISOString()}>{new Date(validMs).toISOString().slice(11,16)}Z</time></div>
      </div> : null}
    </div>
  </>;
}
