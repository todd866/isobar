import { DDAY_FEATURES, DDAY_SOURCES, type HistoryLayer } from '@/lib/historical-scenes';

export function HistoricalSceneControls({layers,onToggle}:{layers:Record<HistoryLayer,boolean>;onToggle:(layer:HistoryLayer)=>void}) {
  return <>
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1">
      {(['political','military','ships'] as HistoryLayer[]).map(layer=><label key={layer} className="flex items-center gap-1">
        <input type="checkbox" checked={layers[layer]} onChange={()=>onToggle(layer)} />
        {layer==='political'?'Political':layer==='military'?'Military':'Ships'}
      </label>)}
    </div>
    <details className="px-2 py-1">
      <summary>D-Day reconstruction</summary>
      <p>Documented assignments; estimated positions and vessel motion.</p>
      {DDAY_FEATURES.map(feature=><details key={feature.id}>
        <summary>{feature.title}</summary>
        <p>{feature.geometry_method} · Approx. {Math.round(feature.precision_m/1000)} km positional scale. {feature.note}</p>
        {feature.source_refs.map(id=>{
          const source=DDAY_SOURCES.find(s=>s.id===id);
          return source?<p key={id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>:null;
        })}
      </details>)}
    </details>
  </>;
}
