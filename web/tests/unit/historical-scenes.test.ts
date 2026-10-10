import {describe,it,expect} from 'vitest';
import {DDAY_FEATURES,DDAY_SOURCES,HISTORICAL_SCENES,historicalScene,sceneForPlace,sceneLayers,featurePosition,featureVisible,historyLayer} from '../../src/lib/historical-scenes';
describe('D-Day scene',()=>{
 it('has bounded supported geometry and resolvable provenance',()=>{
  expect(new Set(DDAY_FEATURES.map(f=>f.id)).size).toBe(DDAY_FEATURES.length);
  for(const f of DDAY_FEATURES){
   expect(['Point','LineString','MultiLineString']).toContain(f.geometry.type);
   expect(f.source_refs.length).toBeGreaterThan(0);
   for(const ref of f.source_refs)expect(DDAY_SOURCES.some(s=>s.id===ref),ref).toBe(true);
   const points=f.geometry.type==='Point'?[f.geometry.coordinates]:f.geometry.type==='MultiLineString'?(f.geometry.coordinates as number[][][]).flat():f.geometry.coordinates;
   for(const p of points as number[][]){expect(p.length).toBe(2);expect(Math.abs(p[0])).toBeLessThanOrEqual(180);expect(Math.abs(p[1])).toBeLessThanOrEqual(90);}
   expect(f.date_validity.date_end>=f.date_validity.date_start).toBe(true);
  }
 });
 it('hides operational features before their day and below detail zoom',()=>{
  const f=DDAY_FEATURES.find(f=>f.kind==='assault-sector')!;
  expect(featureVisible(f,Date.parse('1944-06-05T12:00Z'),12)).toBe(false);
  expect(featureVisible(f,Date.parse('1944-06-06T12:00Z'),3)).toBe(false);
  expect(featureVisible(f,Date.parse('1944-06-06T12:00Z'),12)).toBe(true);
  expect(featureVisible(f,NaN,12)).toBe(false);
  expect(featureVisible(f,Date.parse('1944-06-07T00:00Z'),12)).toBe(false);
 });
 it('moves named vessels continuously without extrapolating their synthetic tracks',()=>{
  const ships=DDAY_FEATURES.filter(f=>historyLayer(f)==='ships');expect(ships.length).toBe(5);
  for(const f of ships){const t=f.track!;expect(t.length).toBeGreaterThan(1);
   for(let i=1;i<t.length;i++)expect(Date.parse(t[i].time)).toBeGreaterThan(Date.parse(t[i-1].time));
   const a=Date.parse(t[0].time),b=Date.parse(t[1].time);
   expect(featurePosition(f,a-1)).toBeNull();expect(featurePosition(f,Date.parse(t.at(-1)!.time)+1)).toBeNull();
   expect(featurePosition(f,a)).toEqual(t[0].coordinates);
   featurePosition(f,(a+b)/2)!.forEach((v,j)=>expect(v).toBeCloseTo((t[0].coordinates[j]+t[1].coordinates[j])/2,10));
  }
 });
});

describe('reusable historical scenes',()=>{
 it('resolves independent event framing, valid timezones and only relevant controls',()=>{
  for(const scene of HISTORICAL_SCENES){
   expect(historicalScene(scene.id)).toBe(scene);
   expect(sceneForPlace(scene.id==='dday'?'h.normandy':`h.${scene.id}`)).toBe(scene);
   expect(Number.isInteger(scene.focusHour)&&scene.focusHour>=0&&scene.focusHour<=23).toBe(true);
   expect(()=>new Intl.DateTimeFormat('en',{timeZone:scene.focus.zone})).not.toThrow();
   expect(scene.features.length).toBeGreaterThan(0);
   const instant=Date.parse(`${scene.focusDate}T${String(scene.focusHour).padStart(2,'0')}:00Z`);
   const zoom=Math.log2(360*580/(256*scene.focus.halfHeight*2));
   expect(scene.features.some(f=>featureVisible(f,instant,zoom))).toBe(true);
   for(const f of scene.features){
    expect(f.date_validity.date_start<=f.date_validity.date_end).toBe(true);
    expect(['Point','LineString','MultiLineString']).toContain(f.geometry.type);
    for(const id of f.source_refs)expect(scene.provenance.sources.some(s=>s.id===id)).toBe(true);
    if(f.track)expect(featurePosition(f,Date.parse(f.track[0].time))).toEqual(f.track[0].coordinates);
   }
  }
  expect(sceneLayers(historicalScene('sydney-hobart-1998')!)).toEqual(['routes']);
  expect(sceneLayers(historicalScene('shackleton-1916')!)).toEqual(['ships','routes']);
 });
});
