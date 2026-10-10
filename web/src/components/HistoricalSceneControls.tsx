import { sceneLayers, HISTORY_LAYER_LABELS, type HistoricalScene, type HistoryLayer } from '@/lib/historical-scenes';

export function HistoricalSceneControls({scene,layers,onToggle}:{scene:HistoricalScene;layers:Record<HistoryLayer,boolean>;onToggle:(layer:HistoryLayer)=>void}) {
  return <>
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1">
      {sceneLayers(scene).map(layer=><label key={layer} className="flex items-center gap-1">
        <input type="checkbox" checked={layers[layer]} onChange={()=>onToggle(layer)} />
        {HISTORY_LAYER_LABELS[layer]}
      </label>)}
    </div>
    <details className="px-2 py-1">
      <summary>{scene.title} reconstruction</summary>
      <p>{scene.provenance.summary}</p>
      {scene.features.map(feature=><details key={feature.id}>
        <summary>{feature.title}</summary>
        <p>{feature.geometry_method} · Approx. {feature.precision_m<1000?`${Math.round(feature.precision_m)} m`:`${Math.round(feature.precision_m/1000)} km`} positional scale. {feature.note}</p>
        {feature.source_refs.map(id=>{
          const source=scene.provenance.sources.find(s=>s.id===id);
          return source?<p key={id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>:null;
        })}
      </details>)}
    </details>
  </>;
}
