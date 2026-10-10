'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { parseCoast, type Coast } from '@/lib/coast';
import { marchIsobars } from '@/lib/contour';
import {
  availableDays, availableDaysForWeather, fetchCatalog, fetchManifest, fetchWeather, frameAt, normalizeDays, type HistoricalCatalog,
  type HistoricalManifest, type HistoricalWeather, type HistoricalWeatherFrame,
  utcDateLabel, utcTimeLabel,
} from '@/lib/history';



function clamp(value: number, low: number, high: number) { return Math.max(low, Math.min(high, value)); }

type HistoricalViewMode = 'world' | 'normandy';

function HistoricalMap({ weather, frame, view, coast, canNormandy, onViewChange }: { weather: HistoricalWeather | null; frame: HistoricalWeatherFrame | null; view: HistoricalViewMode; coast: Coast | null; canNormandy: boolean; onViewChange: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [paper,setPaper]=useState<HTMLImageElement | null>(null);
  useEffect(()=>{
    let disposed=false;
    const image=new Image();image.src='/history/themes/wwii-paper.png';
    image.decode().then(()=>{if(!disposed)setPaper(image);}).catch(()=>{});
    return ()=>{disposed=true;};
  },[]);
  const [zoom,setZoom]=useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const drag=useRef<{x:number;y:number;px:number;py:number}|null>(null);
  useEffect(()=>{setZoom(1);setPan({x:0,y:0});},[view]);
  const contours = useMemo(() => {
    if (!weather || !frame) return [];
    const {nx, ny, step_degrees: step = 2.5, longitudes, latitudes} = weather.grid;
    const wraps = Math.abs(nx * step - 360) < .001;
    const columns = nx + (wraps ? 1 : 0);
    const values = new Float32Array(columns * ny);
    for (let row=0; row<ny; row++) {
      values.set(frame.pressure_msl.slice(row*nx,(row+1)*nx),row*columns);
      if (wraps) values[row*columns+nx]=frame.pressure_msl[row*nx];
    }
    return Array.from({length:41},(_,i)=>940+i*4).flatMap(level => marchIsobars(values,columns,ny,level,longitudes[0],latitudes[0],step,-step));
  }, [weather, frame]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !weather || !frame || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { width, height } = size;
    ctx.fillStyle = '#e6ddc4';
    ctx.fillRect(0, 0, width, height);
    if(paper){const pattern=ctx.createPattern(paper,'repeat');if(pattern){ctx.fillStyle=pattern;ctx.fillRect(0,0,width,height);}}
    const lons = weather.grid.longitudes;
    const lats = weather.grid.latitudes;
    const dataWest = Math.min(...lons), dataEast = Math.max(...lons), dataNorth = Math.max(...lats), dataSouth = Math.min(...lats);
    const west = view === 'normandy' ? Math.max(dataWest, -8) : dataWest;
    const east = view === 'normandy' ? Math.min(dataEast, 4) : (Math.abs(weather.grid.nx*(weather.grid.step_degrees ?? 0)-360)<.001 ? 180 : dataEast);
    const north = view === 'normandy' ? Math.min(dataNorth, 54) : dataNorth;
    const south = view === 'normandy' ? Math.max(dataSouth, 48) : dataSouth;
    const pad = 18;
    const aspect = view === 'normandy' ? Math.cos(51*Math.PI/180) : 1;
    const scale=Math.min((width-pad*2)/((east-west)*aspect),(height-pad*2)/(north-south))*zoom;
    const plotW=(east-west)*aspect*scale, plotH=(north-south)*scale;
    const left=(width-plotW)/2+pan.x, top=(height-plotH)/2+pan.y;
    const project = (lon:number,lat:number) => ({x:left+(lon-west)*aspect*scale,y:top+(north-lat)*scale});
    ctx.save(); ctx.beginPath();ctx.rect(left,top,plotW,plotH);ctx.clip();
    ctx.fillStyle='rgba(155,184,184,.32)';ctx.fillRect(left,top,plotW,plotH);
    if(coast){
      ctx.beginPath();
      for(const ring of coast.rings){
        // Natural Earth rings are already cut at the antimeridian.
        for(let i=0;i<ring.lon.length;i++){const p=project(ring.lon[i],ring.lat[i]);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}
        ctx.closePath();
      }
      ctx.fillStyle='rgba(145,145,99,.38)';ctx.fill('evenodd');
    }
    ctx.strokeStyle='rgba(91,89,68,.16)';ctx.lineWidth=.6;
    const gridStep=view==='world'?30:2;
    for(let lon=Math.ceil(west/gridStep)*gridStep;lon<=east;lon+=gridStep){const a=project(lon,north),b=project(lon,south);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
    for(let lat=Math.ceil(south/gridStep)*gridStep;lat<=north;lat+=gridStep){const a=project(west,lat),b=project(east,lat);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
    const pressure = frame.pressure_msl;
    const texture=document.createElement('canvas');texture.width=weather.grid.nx+1;texture.height=weather.grid.ny;
    const tx=texture.getContext('2d')!; const pixels=tx.createImageData(texture.width,texture.height);
    for (let row=0;row<texture.height;row++) for(let col=0;col<texture.width;col++) {
      const value=pressure[row*weather.grid.nx+(col%weather.grid.nx)];
      const a=clamp((value-960)/80,0,1);const p=(row*texture.width+col)*4;
      // A fixed pressure scale, stable across all dates.
      pixels.data[p]=Math.round(28+a*103);pixels.data[p+1]=Math.round(65+a*65);pixels.data[p+2]=Math.round(99-a*16);pixels.data[p+3]=30;
    }
    tx.putImageData(pixels,0,0);
    const step=weather.grid.step_degrees ?? 2.5;
    const tl=project(dataWest-step/2,dataNorth+step/2),br=project(dataEast+step*1.5,dataSouth-step/2);
    ctx.imageSmoothingEnabled=true;ctx.drawImage(texture,tl.x,tl.y,br.x-tl.x,br.y-tl.y);
    ctx.strokeStyle='rgba(141,55,39,.65)';ctx.lineWidth=.9;
    const labelBoxes:{x:number;y:number}[]=[];
    for (const line of contours) {
      ctx.beginPath();
      for(let i=0;i<line.lon.length;i++){const p=project(line.lon[i],line.lat[i]);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}
      ctx.stroke();
      const mid=Math.floor(line.lon.length/2),p=project(line.lon[mid],line.lat[mid]);
      if(line.level%8===0 && line.lon.length>14 && p.x>30&&p.x<width-35&&p.y>50&&p.y<height-30 && labelBoxes.every(b=>Math.abs(b.x-p.x)>65||Math.abs(b.y-p.y)>28)){
        labelBoxes.push(p);
        ctx.font='italic 11px Georgia';ctx.fillStyle='#803e30';ctx.fillText(String(line.level),p.x,p.y);
      }
    }
    if (coast) {
      ctx.save(); ctx.strokeStyle = 'rgba(65,68,44,.85)'; ctx.lineWidth = 1;
      for (const ring of coast.rings) {
        ctx.beginPath(); let started = false;
        for (let i = 0; i < ring.lon.length; i += 1) {
          if (i > 0 && Math.abs(ring.lon[i] - ring.lon[i - 1]) > 180) { started = false; continue; }
          if (ring.lon[i] < west - 3 || ring.lon[i] > east + 3 || ring.lat[i] < south - 3 || ring.lat[i] > north + 3) { started = false; continue; }
          const point = project(ring.lon[i], ring.lat[i]);
          if (!started) { ctx.moveTo(point.x, point.y); started = true; } else ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save(); ctx.strokeStyle = 'rgba(48,66,68,.65)'; ctx.fillStyle = 'rgba(48,66,68,.75)'; ctx.lineWidth = 1;
    const stride = view === 'world' ? Math.max(1, Math.ceil(weather.grid.nx / Math.max(8,width*zoom/40))) : 1;
    for (let row = 0; row < weather.grid.ny; row += stride) for (let col = 0; col < weather.grid.nx; col += stride) {
      const index = row * weather.grid.nx + col;
      if (lons[col] < west - 2 || lons[col] > east + 2 || lats[row] < south - 2 || lats[row] > north + 2) continue;
      const p = project(lons[col], lats[row]); const u = frame.u[index], v = frame.v[index];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const length = clamp(Math.hypot(u, v) * 0.7, 3, 18);
      const scale = Math.max(0.001, Math.hypot(u, v));
      const end = { x: p.x + (u / scale) * length, y: p.y - (v / scale) * length };
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(end.x - (u / scale) * 4 - (v / scale) * 2, end.y + (v / scale) * 4 + (u / scale) * 2); ctx.lineTo(end.x - (u / scale) * 4 + (v / scale) * 2, end.y + (v / scale) * 4 - (u / scale) * 2); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }, [coast, contours, frame, pan, paper, size, view, weather, zoom]);

  return <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-[#0e2430]" data-historical-map>
    <canvas ref={canvasRef} style={{ visibility: weather && frame ? 'visible' : 'hidden' }} tabIndex={0} aria-label="Historical weather map; use arrow keys to pan" className="absolute inset-0 h-full w-full touch-none cursor-grab"
      onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};}}
      onPointerMove={e=>{if(drag.current)setPan({x:clamp(drag.current.px+e.clientX-drag.current.x,-size.width*zoom/2,size.width*zoom/2),y:clamp(drag.current.py+e.clientY-drag.current.y,-size.height*zoom/2,size.height*zoom/2)});}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
      onKeyDown={e=>{const delta:{[key:string]:[number,number]}={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]};if(delta[e.key]){e.preventDefault();const [x,y]=delta[e.key];setPan(p=>({x:p.x+x,y:p.y+y}));}}} />
    {!weather ? <div className="absolute inset-0 grid place-items-center text-sm text-white/80">No weather frame for this date</div> : null}
    <div className="absolute right-3 top-3 z-20 flex gap-1 rounded-md border border-white/25 bg-black/60 p-1 text-white">
      {canNormandy ? <button type="button" onClick={()=>{setPan({x:0,y:0});setZoom(1);onViewChange();}} className="px-2 py-1" aria-label={`Show ${view === 'world' ? 'Normandy' : 'world'} view`}>{view === 'world' ? 'Normandy' : 'World'}</button> : null}
      <button type="button" aria-label="Zoom out" disabled={zoom<=1} onClick={()=>{setZoom(z=>Math.max(1,z/2));setPan({x:0,y:0});}} className="px-2 py-1 disabled:opacity-40">−</button>
      <button type="button" aria-label="Zoom in" disabled={zoom>=8} onClick={()=>setZoom(z=>Math.min(8,z*2))} className="px-2 py-1 disabled:opacity-40">+</button>
    </div>
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/45 px-2 py-1 font-mono text-[11px] text-white/85"><span className="text-[#efb3a0]">━</span> hPa · Wind →</div>
  </div>;
}

export function HistoricalView() {
  const [catalog, setCatalog] = useState<HistoricalCatalog | null>(null);
  const [collectionId, setCollectionId] = useState('');
  const [date, setDate] = useState('');
  const [manifest, setManifest] = useState<HistoricalManifest | null>(null);
  const [weather, setWeather] = useState<HistoricalWeather | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [mapUrl, setMapUrl] = useState<string>();
  const [mapOpen, setMapOpen] = useState(false);
  const mapDialog=useRef<HTMLDialogElement>(null);
  const [coast, setCoast] = useState<Coast | null>(null);
  const weatherCache = useRef(new Map<string, HistoricalWeather | null>());
  const manifestCache = useRef(new Map<string, HistoricalManifest>());
  const [view, setView] = useState<HistoricalViewMode>('world');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const collection = useMemo(() => catalog?.collections.find((item) => item.id === collectionId) ?? catalog?.collections[0], [catalog, collectionId]);
  const days = useMemo(() => collection ? availableDays(collection) : [], [collection]);
  const selectedDay = days.find((item) => item.date === date) ?? days[0];
  const dayFrameIndexes = useMemo(() => weather && selectedDay ? weather.frames.flatMap((item, index) => item.time.slice(0, 10) === selectedDay.date ? [index] : []) : [], [selectedDay, weather]);
  const dayPosition = Math.max(0, dayFrameIndexes.indexOf(frameIndex));
  const frame = weather ? (weather.frames[frameIndex] ?? frameAt(weather, weather.times[frameIndex] ?? 0)) : null;

  useEffect(() => {
    fetchCatalog().then((value) => {
      setCatalog(value);
      setCollectionId((current) => value.collections.some((item) => item.id === current)
        ? current
        : value.collections.find((item) => item.id === 'dday')?.id ?? value.collections[0]?.id ?? '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Historical catalogue unavailable'));
  }, [catalogRetry]);
  useEffect(() => {
    let disposed = false;
    fetch('/history/world-coast.bin', { cache: 'force-cache' }).then((response) => response.arrayBuffer()).then((buffer) => { if (!disposed) setCoast(parseCoast(new Uint8Array(buffer))); }).catch(() => { /* weather remains usable without coastline */ });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!collection) return;
    const next = availableDays(collection)[0]?.date ?? '';
    setDate((current) => availableDays(collection).some((day) => day.date === current) ? current : next);
  }, [collection]);
  useEffect(() => {
    if (!collection || !selectedDay) return;
    let disposed = false;
    setError(null); setLoading(true); setPlaying(false); setMapOpen(false); setManifest(null); setWeather(null); setMapUrl(undefined); setView('world');
    (async () => {
      let value = manifestCache.current.get(collection.manifest);
      if (!value) { value = await fetchManifest(collection.manifest); manifestCache.current.set(collection.manifest, value); }
      if (disposed) return;
      setManifest(value);
      const source = selectedDay.weather ?? value.weather;
      if (source) {
        const key = `${collection.id}|${typeof source === 'string' ? source : 'inline'}`;
        let next = weatherCache.current.get(key);
        if (next === undefined) {
          next = await fetchWeather(source);
          weatherCache.current.set(key, next);
          const collectionKeys = [...weatherCache.current.keys()].map((item) => item.split('|', 1)[0]);
          const keep = [...new Set(collectionKeys)].slice(-3);
          for (const existing of [...weatherCache.current.keys()]) if (!keep.includes(existing.split('|', 1)[0])) weatherCache.current.delete(existing);
        }
        if (disposed) return;
        if(!next || !availableDaysForWeather(collection,next).some(day=>day.date===selectedDay.date))throw new Error('This day has no complete weather data');
        setWeather(next);
        const first = next?.frames.findIndex((item) => item.time.slice(0, 10) === selectedDay.date) ?? -1;
        setFrameIndex(first >= 0 ? first : 0);
      }
      const map = selectedDay.map ?? value.maps?.[0]?.url;
      setMapUrl(map);
    })().then(() => { if (!disposed) setLoading(false); }).catch((reason: unknown) => { if (!disposed) {setLoading(false);setWeather(null);setMapUrl(undefined);setError(reason instanceof Error ? reason.message : 'Historical collection unavailable');} });
    return () => { disposed = true; };
  }, [collection, retry, selectedDay]);
  useEffect(() => {
    if (!playing || !weather?.frames.length || !dayFrameIndexes.length) return;
    const timer = window.setInterval(() => setFrameIndex(dayFrameIndexes[(dayFrameIndexes.indexOf(frameIndex) + 1) % dayFrameIndexes.length]!), 850);
    return () => window.clearInterval(timer);
  }, [dayFrameIndexes, frameIndex, playing, weather]);
  useEffect(() => { if (mapUrl) { const image = new Image(); image.src = mapUrl; void image.decode().catch(()=>{}); } }, [mapUrl]);
  useEffect(()=>{ if(mapOpen)mapDialog.current?.showModal();else mapDialog.current?.close(); },[mapOpen]);
  const label = selectedDay?.label ?? (selectedDay ? utcDateLabel(selectedDay.date) : 'Choose a day');
  const resolvedManifestDays = manifest?.days ? normalizeDays(manifest.days) : [];
  const frameTime = frame?.time ?? weather?.times[0];
  const displayWeather = weather?.event?.id === collection?.id && frame?.time.slice(0,10) === selectedDay?.date ? weather : null;
  const canNormandy = collection?.id === 'dday';
  const mapTitle = manifest?.maps?.[0]?.title ?? 'Historical map facsimile';
  return <section className="history-page flex min-h-0 flex-1 flex-col gap-2 bg-[var(--md-app-background)] p-3" data-historical-page>
    <div className="history-controls grid shrink-0 gap-2 rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] p-2" data-historical-controls>
      <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--md-on-surface-variant)]"><select aria-label="Historical collection" value={collection?.id ?? ''} onChange={(event) => setCollectionId(event.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--md-outline-soft)] bg-[var(--md-surface)] px-2 py-2 text-sm text-[var(--md-on-surface)]">{catalog?.collections.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--md-on-surface-variant)]"><select aria-label="Available historical days" value={selectedDay?.date ?? ''} onChange={(event) => setDate(event.target.value)} disabled={!days.length} className="min-w-0 flex-1 rounded-md border border-[var(--md-outline-soft)] bg-[var(--md-surface)] px-2 py-2 text-sm text-[var(--md-on-surface)]">{days.map((day) => <option key={day.date} value={day.date}>{day.label ?? utcDateLabel(day.date)}</option>)}</select></label>
      {mapUrl ? <button type="button" onClick={() => setMapOpen(true)} className="rounded-md border border-[var(--md-outline-soft)] px-3 py-2 text-sm font-medium text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)]">Map</button> : null}
      <button type="button" onClick={() => setSourcesOpen((value) => !value)} aria-expanded={sourcesOpen} className="rounded-md border border-[var(--md-outline-soft)] px-3 py-2 text-sm font-medium text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)]">Sources</button>
    </div>
    <div className="relative flex min-h-0 flex-1 flex-col gap-2">
      <HistoricalMap weather={displayWeather} frame={frame ?? null} coast={coast} view={view} canNormandy={canNormandy} onViewChange={() => setView((current) => current === 'world' ? 'normandy' : 'world')} />
      {loading ? <div className="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit rounded-md bg-black/60 px-3 py-1.5 text-xs text-white">Loading archive…</div> : null}
      <div className="flex shrink-0 items-center gap-2 rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] px-2 py-1.5" aria-label="Historical playback controls">
        <button type="button" disabled={!dayFrameIndexes.length} aria-label={playing ? 'Pause historical weather' : 'Play historical weather'} onClick={() => setPlaying((value) => !value)} className="grid h-9 w-9 place-items-center rounded-full bg-[var(--md-primary)] text-lg text-[var(--md-on-primary)]">{playing ? 'Ⅱ' : '▶'}</button>
        <input aria-label="Historical hour" type="range" min="0" max={Math.max(0, dayFrameIndexes.length - 1)} value={dayPosition} onChange={(event) => { setPlaying(false); setFrameIndex(dayFrameIndexes[Number(event.target.value)] ?? 0); }} className="min-w-0 flex-1 accent-[var(--md-primary)]" />
        <span className="w-[116px] text-right font-mono text-[11px] text-[var(--md-on-surface-variant)]">{frameTime ? utcTimeLabel(frameTime) : '—'}</span>
      </div>
    </div>
    {error ? <div role="alert" className="flex shrink-0 items-center justify-between gap-3 rounded-lg bg-[var(--md-error-container)] px-3 py-2 text-sm text-[var(--md-on-error)]"><span>{error}</span><button type="button" onClick={() => catalog ? setRetry((value) => value + 1) : setCatalogRetry((value) => value + 1)} className="rounded border border-current px-2 py-1 font-medium">Retry</button></div> : null}
    {sourcesOpen ? <aside className="max-h-[30%] shrink-0 overflow-y-auto rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-3 text-xs text-[var(--md-on-surface-variant)]" data-historical-sources>
      <p className="m-0 font-medium text-[var(--md-on-surface)]">{collection?.title ?? 'Historical collection'} {selectedDay ? `· ${label}` : ''}</p>
      <p className="m-1.5">{collection?.description ?? 'Historical map and weather sources are assembled for offline browsing.'}</p>
      <p className="m-0">{weather?.model ?? 'ERA5'} · {weather?.provenance?.provider ?? 'Source metadata pending'} · {weather?.provenance?.sampling_limitations ?? 'Hourly reconstruction; local detail is limited.'}</p>
      {weather?.provenance?.source ? <a className="mt-1 inline-block text-[var(--md-primary)] underline" href={weather.provenance.source} target="_blank" rel="noreferrer">Dataset source</a> : null}
      {weather?.provenance?.license ? /^https?:\/\//.test(weather.provenance.license) ? <a className="ml-2 text-[var(--md-primary)] underline" href={weather.provenance.license} target="_blank" rel="noreferrer">Dataset licence</a> : <span className="ml-2">{weather.provenance.license}</span> : null}
      {manifest?.maps?.map((map) => <span key={map.url} className="ml-2">{map.source ? <a href={map.source} target="_blank" rel="noreferrer" className="underline">{map.attribution ?? map.title ?? 'Map facsimile'}</a> : (map.attribution ?? map.title ?? 'Map facsimile')}</span>)}
      {collection?.id === 'dday' ? <a className="ml-2 text-[var(--md-primary)] underline" href="https://blogs.loc.gov/folklife/2023/06/vhp-collection-spotlight-joseph-vaghis-d-day-map/" target="_blank" rel="noreferrer">D-Day map source</a> : null}
      <a className="ml-2 text-[var(--md-primary)] underline" href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noreferrer">Natural Earth geography</a>
      <span className="ml-2">AI-generated paper texture</span>
      {resolvedManifestDays.length ? <span className="ml-2">{resolvedManifestDays.length} manifest days</span> : null}
    </aside> : null}
    <dialog ref={mapDialog} onClose={()=>setMapOpen(false)} aria-label="Historical map facsimile" className="history-dialog rounded-xl bg-[var(--md-surface)] p-3 backdrop:bg-black/75">
      <div className="mb-2 flex items-center justify-between gap-3"><span className="text-sm">{mapTitle}</span><button type="button" aria-label="Close map facsimile" onClick={()=>setMapOpen(false)} className="rounded-md border px-3 py-2">Close</button></div>
      {mapUrl ? <img src={mapUrl} alt={mapTitle} className="h-full max-h-[75dvh] w-full object-contain" /> : null}
    </dialog>
  </section>;
}
