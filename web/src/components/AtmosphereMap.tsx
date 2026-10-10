'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildAtmosphereProfile } from '@/lib/atmosphere-profile';
import { syntheticAtmosphereProfile, syntheticAtmosphereVectors, drawAtmosphereFlow } from '@/lib/atmosphere-flow';
import type { Lambert } from '@/lib/lambert';
import type { TiltedCamera } from '@/lib/tilt-navigation';
import {createMountainWindRenderer} from '@/lib/mountain-wind-renderer';
import type {MountainStreamline} from '@/lib/mountain-streamlines';
import type { CloudDensityTexture } from '@/lib/cloud-density';
import { everestAtmosphere, type EverestVector } from '@/lib/everest';
import { createCloudVolumeLayer, type CloudVolumeLayer } from '@/lib/cloud-volume';
import type { LoadedChart } from '@/lib/chart-store';
import type { ElevationAt } from '@/lib/map-generalise';
import styles from './AtmosphereMap.module.css';

export function AtmosphereMap({ camera, geo, lat, lon, validMs, width, height, active, reconstruction, elevation, terrainEpoch, onInspection }: {
  onInspection?: (strength:number)=>void;
  elevation?: ElevationAt | null;
  terrainEpoch?: number;
  reconstruction?: {chart: LoadedChart; elevation: ElevationAt | null};
  camera: TiltedCamera; geo: Lambert; lat: number; lon: number; validMs: number; width: number; height: number; active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sectionButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState(false);
  const [clouds, setClouds] = useState(false);
  const [lenticular,setLenticular]=useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudFailed, setCloudFailed] = useState(false);
  const [cloudRenderFailed,setCloudRenderFailed]=useState(false);
  const cloudCanvas=useRef<HTMLCanvasElement>(null);
  const cloudLayer=useRef<CloudVolumeLayer|null>(null);
  const cloudFrameTime=useRef<number|null>(null);
  const [streamlines,setStreamlines]=useState<MountainStreamline[]>([]);
  const windRenderer=useMemo(()=>createMountainWindRenderer(),[]);
  const [cloudData,setCloudData]=useState<CloudDensityTexture|null>(null);
  useEffect(() => { try { setClouds(sessionStorage.getItem('isobar.clouds') === 'on'); } catch {} }, []);
  const toggleClouds = (enabled:boolean) => {setClouds(enabled);try {sessionStorage.setItem('isobar.clouds',enabled?'on':'off');} catch {}};
  const [aircraftFt, setAircraftFt] = useState(5000);
  const selectedLat = Math.round(lat * 10) / 10, selectedLon = Math.round(lon * 10) / 10;
  const vectorTime = Math.floor(validMs / (reconstruction?60000:300000)) * (reconstruction?60000:300000);
  const reconstructed = useMemo(() => reconstruction ? everestAtmosphere(reconstruction.chart, vectorTime, reconstruction.elevation) : null, [reconstruction?.chart, reconstruction?.elevation, vectorTime, terrainEpoch]);
  const vectors = useMemo(() => reconstructed ? reconstructed.vectors(lat, lon, camera.halfHeight, width / Math.max(1, height)) : syntheticAtmosphereVectors(lat, lon, camera.halfHeight, width / Math.max(1, height), vectorTime, camera.slice, elevation ?? undefined), [reconstructed, lat, lon, camera.halfHeight, camera.slice, width, height, vectorTime, elevation, terrainEpoch]);
  const cloudVectors = useMemo(() => (clouds || reconstructed) ? vectors.map(v => ({...v, cloudPct: reconstructed ? (v as EverestVector).cloudPct : (v.pressure === 850 || v.pressure === 700 ? 65 : 0)})) : [], [clouds, vectors, reconstructed]);
  const cloudInput=useRef({vectors:cloudVectors,lat,lon,halfHeight:camera.halfHeight,aspect:width/Math.max(1,height),elevation:elevation ?? reconstruction?.elevation,vectorTime,run:reconstruction?.chart.manifest.run});
  cloudInput.current={vectors:cloudVectors,lat,lon,halfHeight:camera.halfHeight,aspect:width/Math.max(1,height),elevation:elevation ?? reconstruction?.elevation,vectorTime,run:reconstruction?.chart.manifest.run};
  useEffect(()=>{
    if((!clouds&&!reconstruction)||!active)return;
    let stopped=false,busy=false,last='',lastBase='';
    let sampledAt=0;
    let requested:typeof cloudInput.current|null=null;
    setCloudFailed(false);setCloudReady(false);setCloudData(null);setStreamlines([]);
    let worker:Worker;
    try {worker=new Worker(new URL('../lib/cloud-density.worker.ts',import.meta.url));}
    catch {setCloudFailed(true);return;}
    worker.onmessage=event=>{busy=false;if(stopped)return;const current=cloudInput.current;if(!requested||Math.abs(requested.vectorTime-current.vectorTime)>15*60000||Math.floor(requested.vectorTime/86400000)!==Math.floor(current.vectorTime/86400000)||requested.run!==current.run)return;if(event.data.error){setCloudFailed(true);return;}if(canvas.current)canvas.current.dataset.buildMs=String(event.data.buildMs);cloudFrameTime.current=requested.vectorTime;setCloudData(event.data.cloud);setStreamlines(event.data.streamlines);setCloudReady(!!event.data.cloud);};
    worker.onerror=()=>{busy=false;if(!stopped)setCloudFailed(true);};
    const update=()=>{
      const input=cloudInput.current;
      if(document.hidden||busy||input.halfHeight>.2||!input.vectors.length)return;
      const span=Math.min(.24,Math.max(.025,input.halfHeight*2));
      const north=Math.min(89.9,Math.round(input.lat/.02)*.02+span),south=Math.max(-89.9,Math.round(input.lat/.02)*.02-span);
      const east=Math.round(input.lon/.02)*.02+Math.min(.24,span*input.aspect),west=Math.round(input.lon/.02)*.02-Math.min(.24,span*input.aspect);
      const fingerprint=input.vectors.reduce((hash,v)=>{for(const n of [v.lat,v.lon,v.heightM,v.u,v.v,v.w??NaN,v.cloudPct,(v as EverestVector).temperatureC,(v as EverestVector).rhPct,(v as EverestVector).pressureHPa,(v as EverestVector).stabilityN2])hash=Math.imul(hash^Math.round(n*1000),16777619);return hash;},2166136261);
      const baseKey=[west,east,south,north,input.vectorTime,input.run,fingerprint].join(':');
      // Recheck the DEM periodically because tiles can arrive without changing
      // the elevation callback; avoid rebuilding the terrain grid every idle tick.
      if(baseKey===lastBase&&performance.now()-sampledAt<5000)return;
      lastBase=baseKey;sampledAt=performance.now();
      const terrainSize=64,terrain=new Float32Array(terrainSize*terrainSize);
      const terrainBounds={west:west-.08,east:east+.08,south:south-.08,north:north+.08};
      for(let y=0;y<terrainSize;y++)for(let x=0;x<terrainSize;x++)terrain[y*terrainSize+x]=input.elevation?.(terrainBounds.west+x/(terrainSize-1)*(terrainBounds.east-terrainBounds.west),terrainBounds.south+y/(terrainSize-1)*(terrainBounds.north-terrainBounds.south))??NaN;
      const key=baseKey+':'+terrain.reduce((sum,h,i)=>sum+(Number.isFinite(h)?Math.round(h):-99999)*(i+1),0);if(key===last)return;
      busy=true;last=key;requested=input;worker.postMessage({cloudEnabled:clouds,lenticular,mountain:!!reconstruction,vectors:input.vectors,bounds:{west,east,south,north,minHeight:reconstruction?3500:0,maxHeight:13000},terrain,terrainSize,terrainBounds,timeSeconds:(input.vectorTime-(input.run?Date.parse(input.run):Math.floor(input.vectorTime/86400000)*86400000))/1000},[terrain.buffer]);
    };
    update();const timer=setInterval(update,1000);
    return()=>{stopped=true;clearInterval(timer);worker.terminate();};
  },[clouds,lenticular,active,reconstruction?.chart]);
  useEffect(()=>{
    const previous=cloudFrameTime.current;
    if(previous!=null&&(Math.abs(previous-vectorTime)>15*60000||Math.floor(previous/86400000)!==Math.floor(vectorTime/86400000))){
      setCloudReady(false);setCloudData(null);setStreamlines([]);cloudLayer.current?.clear();
    }
  },[vectorTime]);
  useLayoutEffect(()=>{
    if(!active||!clouds||!cloudCanvas.current)return;
    const node=cloudCanvas.current;
    const lost=(event:Event)=>{event.preventDefault();setCloudRenderFailed(true);};
    node.addEventListener('webglcontextlost',lost);
    try {cloudLayer.current=createCloudVolumeLayer(node);setCloudRenderFailed(!cloudLayer.current);}catch{setCloudRenderFailed(true);}
    return()=>{node.removeEventListener('webglcontextlost',lost);cloudLayer.current?.destroy();cloudLayer.current=null;};
  },[active,clouds]);
  useEffect(()=>{if(cloudData)cloudLayer.current?.setData(cloudData);},[cloudData,clouds,active]);
  const model = useMemo(() => reconstructed ? reconstructed.profile(lat, lon) : syntheticAtmosphereProfile(lat, lon, vectorTime, elevation ?? undefined), [reconstructed, lat, lon, selectedLat, selectedLon, vectorTime, elevation, terrainEpoch]);
  const profile = useMemo(() => model ? buildAtmosphereProfile(model, validMs) : null, [model, validMs]);
  const ground = profile?.terrainM ?? null;
  const aircraftM = Math.max(aircraftFt * .3048, ground == null ? 0 : ground + 100);
  const ceiling = Math.max(12000, aircraftM + 500, ...(profile?.layers.map(l => l.topM + 500) ?? []));
  const inspection=section&&active?Math.min(1,.35+Math.max(0,aircraftM-(ground??0))/2500):0;
  useEffect(()=>{onInspection?.(inspection);return()=>onInspection?.(0);},[inspection,onInspection]);
  useEffect(() => {
    if (!section) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSection(false); sectionButton.current?.focus(); e.preventDefault(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [section]);
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
        if(clouds&&cloudReady&&!cloudRenderFailed&&camera.halfHeight<=.2)volume?.draw(camera,width,height,document.documentElement.classList.contains('dark'),inspection);
        else volume?.clear();
        node.dataset.cloudTime=String(cloudFrameTime.current??'');
        node.dataset.clouds=clouds?(cloudFailed||cloudRenderFailed?'unavailable':camera.halfHeight>.2?'distant':cloudReady?'on':'preparing'):'off';
        const drawn = active ? (reconstructed ? windRenderer(ctx,streamlines,geo,camera,width,height,now/1000,document.documentElement.classList.contains('dark')) : drawAtmosphereFlow(ctx, vectors, geo, camera, width, height, now / 1000, document.documentElement.classList.contains('dark'), elevation ?? undefined, vectorTime)) : {layers: 0, flows: 0};
        node.dataset.layers = String(drawn.layers); node.dataset.flows = String(drawn.flows);
      }
      if (active && vectors.length) request = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(request);
  }, [streamlines,windRenderer,reconstructed,active, clouds, cloudReady, cloudFailed, cloudRenderFailed, cloudVectors, inspection, validMs, vectors, camera, geo, width, height, elevation]);
  if (!active) return null;
  const y = (m: number) => 180 - m / ceiling * 168;
  const knownCloud = !!profile?.levels.some(l => l.cloudFractionPct != null);
  const verticalKnown = !!profile?.levels.some(l => l.verticalVelocityMs != null);
  const status = camera.halfHeight >= 6 ? 'distant' : 'ready';
  return <>
    <canvas ref={cloudCanvas} data-cloud-volume className={styles.canvas} aria-hidden="true" style={{display:clouds?undefined:'none'}} />
    <canvas ref={canvas} data-atmosphere-layer data-source="synthetic" data-field-time={vectorTime} data-profile-time={profile?.timeMs} data-profile-state={status} className={styles.canvas} aria-hidden="true" />
    <div className={styles.instrument} data-atmosphere-instrument>
      <div className={styles.row}>
        <button ref={sectionButton} aria-expanded={section} aria-label="Atmospheric section" onClick={() => setSection(v => !v)}>▱ <span>Atmosphere</span></button>
        <span className={styles.state} title="Synthetic airflow: amber rises, blue sinks; illustrative pressure-level flow" aria-label="Synthetic airflow: amber rises, blue sinks; illustrative pressure-level flow">≈</span>
      </div>
      {section ? <div className={styles.section} data-atmosphere-section>
        <div className={styles.row}><span>{lenticular&&clouds?"Base wind profile":"Illustrative profile"}</span><button aria-label="Close atmospheric section" onClick={() => { setSection(false); sectionButton.current?.focus(); }}>×</button></div>
        <div className={styles.cloudControls}><label className={styles.cloudToggle} title={cloudFailed||cloudRenderFailed?'Cloud texture unavailable; switch off and on to retry':'Synthetic clouds at the selected weather time'}><input type="checkbox" checked={clouds} onChange={event=>toggleClouds(event.target.checked)} />Clouds</label>
        {clouds&&reconstruction?<select aria-label="Cloud model" title="Lenticular is a synthetic moist-layer experiment" value={lenticular?"lenticular":"reconstructed"} onChange={e=>setLenticular(e.target.value==="lenticular")}><option value="reconstructed">Reconstructed</option><option value="lenticular">Lenticular</option></select>:null}</div>
        <svg viewBox="0 0 260 205" role="img" aria-label={profile ? `Synthetic column at ${selectedLat}, ${selectedLon}. Heights in feet above mean sea level. Horizontal shape is illustrative.` : 'Atmospheric profile unavailable'}>
          {[0, 3000, 6000, 9000, 12000].filter(m => m <= ceiling).map(m => <g key={m}><path d={`M42 ${y(m)}H246`} className={styles.grid} /><text x="36" y={y(m) + 4} textAnchor="end">{Math.round(m / .3048 / 1000)}k</text></g>)}
          {!(lenticular&&clouds)&&profile?.layers.map(l => <g key={l.id}><rect x="80" width="130" y={y(l.topM)} height={Math.max(2, y(l.baseM) - y(l.topM))} rx="7" className={styles.cloud}/><text x="145" y={(y(l.baseM) + y(l.topM)) / 2 + 4} textAnchor="middle">{Math.round(l.cloudFractionPct)}%</text></g>)}
          {ground != null ? <path d={`M42 ${y(ground)}H246V180H42Z`} className={styles.ground}/> : null}
          {profile?.levels.filter((l, i, levels) => i===0 || Math.abs(y(l.heightM)-y(levels[i-1].heightM))>=24).map((l, i) => <g key={i}>
            {l.windKt != null && l.windFromDeg != null ? <text x="240" y={y(l.heightM) + 4} textAnchor="end">{Math.round(l.windKt)}</text> : null}
            {l.verticalVelocityMs != null ? <text x="50" y={y(l.heightM) + 4} fill={l.verticalVelocityMs > 0 ? '#ad6726' : '#287b9e'}>{l.verticalVelocityMs > .001 ? '↑' : l.verticalVelocityMs < -.001 ? '↓' : '·'}</text> : null}
          </g>)}
          <path d={`M42 ${y(aircraftM)}H246`} className={styles.aircraftLine}/><text x="65" y={y(aircraftM) - 4}>✈</text>
          <text x="8" y="201">ft AMSL</text><text x="244" y="201" textAnchor="end">wind kt</text>
          {lenticular&&clouds ? null : !profile || !knownCloud ? <text x="145" y="95" textAnchor="middle">{status === 'distant' ? 'Zoom in for atmosphere' : 'Cloud profile unavailable'}</text> : profile.layers.length === 0 ? <text x="145" y="95" textAnchor="middle">No sampled cloud layer</text> : null}
        </svg>
        <label className={styles.altitude}><span>✈</span><input type="range" aria-label="Reference aircraft altitude" min={Math.ceil(((ground ?? 0) + 100) / .3048 / 500) * 500} max="40000" step="500" value={Math.round(aircraftM / .3048)} onChange={e => setAircraftFt(Number(e.target.value))}/><output>{Math.round(aircraftM / .3048 / 100) * 100} ft</output></label>
        <div className={styles.meta} title={profile ? `${profile.source.source} · ${profile.source.model} · ${profile.source.cycleKnown ? 'Run' : 'Retrieved'} ${profile.source.run}. ${verticalKnown ? 'Geometric vertical velocity, m/s positive up.' : 'Vertical velocity unavailable; horizontal wind is not an inferred updraft.'} Aircraft icon is an altitude marker at distant scale.` : 'Missing data is not clear sky.'}>
          <span>{profile?.source.model ?? 'Profile —'}</span><span>{verticalKnown ? '↕ m/s' : 'w —'}</span>
        </div>
        <div className={styles.meta}><span>{selectedLat.toFixed(1)}°, {selectedLon.toFixed(1)}°</span><time dateTime={new Date(validMs).toISOString()}>{new Date(validMs).toISOString().slice(11,16)}Z</time></div>
      </div> : null}
    </div>
  </>;
}
