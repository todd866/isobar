import type { InstrumentDefinition, Values } from './types.ts';
import { windTriangle, vector, ROUTES } from './physics.ts';
import { air, tasKtFromMach } from '../b727/model.ts';
import { arrow, clamp, handle, line, n, plane, signed, text } from './svg.ts';
const deg = (x: number, y: number) => (Math.atan2(x,-y)*180/Math.PI+360)%360;
const solution = (s: Values) => windTriangle({ tas:s.tas,track:s.track,windFrom:s.windFrom,windSpeed:s.windSpeed });
export const windInstrument: InstrumentDefinition = {
  id: 'wind', title: 'Wind triangle', eyebrow: 'AIR + WIND = GROUND', overlay: '1-in-60 / E6-B',
  controls: [
    {key:'track', label:'Track',unit:'°T',min:0,max:359,step:1,tone:'ground'},
    {key:'tas',label:'TAS',unit:'kt',min:60,max:520,step:1,tone:'air'},
    {key:'windFrom',label:'Wind from',unit:'°T',min:0,max:359,step:1,tone:'wind'},
    {key:'windSpeed',label:'Wind',unit:'kt',min:0,max:180,step:1,tone:'wind'},
  ],
  scenario(seed, card) {
    const routeKeys = ['YPPH-YSSY','YSSY-YMML','YMML-YBBN','YPAD-YSSY'];
    const tracks = routeKeys.map(k=>Math.round(ROUTES[k].trackTrue)), routes = routeKeys.map(k=>k.replace('-', ' → '));
    const i = Math.abs(seed)%4, tas = Math.round(tasKtFromMach(.8,air(31000 + i*1000)));
    const diagram = card?.figure?.diagram;
    const state:Values = diagram?.kind === 'wind' ? {track:diagram.track,tas:diagram.tas ?? tas,windFrom:diagram.from,windSpeed:diagram.speed} : {track:tracks[i],tas,windFrom:(tracks[i]+60+i*20)%360,windSpeed:80+(Math.abs(seed)*13)%81};
    state.component=card?.drill?.skill==='wind-component'?1:0;
    return { state, route: diagram?.kind === 'wind' ? 'Your drill · true bearings'+(diagram.tas==null?' · illustrative TAS':'') : routes[i]+' · M 0.80, B727 ISA TAS',
      prompt:card?.numeric?card.stem:'What groundspeed holds the teal track?',answer:card?.numeric?.value??solution(state).groundspeed,tolerance:card?.numeric?.tolerance??1,unit:card?.numeric?.unit??'kt',
      estimate:state.component?'Estimate the signed wind component along track: tailwind positive, headwind negative.':'Estimate groundspeed first. How much of the amber wind is along the track?',
      watch:'Blue air velocity + amber wind = teal ground velocity. Crab into the crosswind to stay on track.',
      guided:'Make a pure crosswind: set Wind from to '+n((state.track+90)%360)+'°T. Notice the largest heading correction.',
      guideKey:'windFrom',guideTarget:(state.track+90)%360,guideStart:state.track,guideTolerance:2,
      explain:'The crosswind is cancelled by the sideways part of TAS. That leaves less airspeed along track; then the headwind or tailwind changes groundspeed.' };
  },
  draw(s,c) {
    const r=solution(s), scale=155/Math.max(s.tas,s.windSpeed,60), o={x:300,y:212};
    const a=vector(r.feasible?r.heading:s.track,s.tas*scale), g=vector(s.track,r.feasible?r.groundspeed*scale:0), w=vector(s.windFrom+180,s.windSpeed*scale);
    const ax=o.x+a.x,ay=o.y+a.y,gx=ax+w.x,gy=ay+w.y,t=vector(s.track,177);
    let out='';
    for (let i=0;i<360;i+=10) { const p=vector(i,172),q=vector(i,i%30===0?161:167);out+=line(o.x+p.x,o.y+p.y,o.x+q.x,o.y+q.y,'compass-tick'); }
    out+=`<circle cx="300" cy="212" r="126" class="grid"/><circle cx="300" cy="212" r="84" class="grid"/>`;
    out+=text(300,27,'N','muted','middle')+text(487,218,'E','muted','middle')+text(300,405,'S','muted','middle')+text(110,218,'W','muted','middle');
    out+=line(o.x-t.x*.8,o.y-t.y*.8,o.x+t.x,o.y+t.y,'track-line ground');
    out+=`<path d="M${o.x} ${o.y} L${ax} ${ay} L${gx} ${gy} Z" class="triangle-fill"/>`;
    out+=arrow(o.x,o.y,ax,ay,'air')+arrow(ax,ay,gx,gy,'wind');
    if(r.feasible) out+=arrow(o.x,o.y,o.x+g.x,o.y+g.y,'ground');
    out+=plane(o.x,o.y,r.feasible?r.heading:s.track,.75);
    out+=handle(o.x+a.x*.5,o.y+a.y*.5,'tas','TAS vector','air')+handle(gx,gy,'windFrom','Wind vector: direction and speed','wind')+handle(o.x-t.x*.72,o.y-t.y*.72,'track','True track','ground');
    out+=text(o.x-t.x*.72,o.y-t.y*.72+32,'Track','ground label','middle');
    out+=text(22,30,'TAS','air label')+text(22,54,n(s.tas)+' kt','air')+text(578,30,'WIND FROM','wind label','end')+text(578,54,n(s.windFrom)+'° / '+n(s.windSpeed)+' kt','wind','end');
    if(!r.feasible) out+=text(300,378,'Track cannot be held','danger','middle');
    if(c.overlay) {
      out+=`<rect x="12" y="302" width="230" height="88" rx="8" class="annotation-plate"/>`;
      out+=text(25,324,'1-IN-60 · APPROXIMATION','muted label')+text(25,350,c.hidden?'Drift ≈ 60 × crosswind / TAS':`Drift ≈ ${n(60*Math.abs(r.crosswind)/s.tas,1)}°`,'wind')+text(25,376,c.hidden?'E6-B: dot on TAS arc':`E6-B GS ${r.feasible?n(r.groundspeed):'—'} kt`,'ground');
    }
    return out;
  },
  readings(s,hidden) {
    const r=solution(s), v=(x:number,d=0)=>hidden?'?':n(x,d);
    const readings=[{label:'Heading',value:r.feasible?v(r.heading):'Unflyable',unit:r.feasible?'°T':'',tone:'air'},
      {label:'Drift (track − heading)',value:r.feasible?(hidden?'?':signed(r.drift,1)):'—',unit:'°',tone:'wind'},
      {label:'Groundspeed',value:r.feasible?v(r.groundspeed):'—',unit:'kt',tone:'ground'}];
    if(s.component)readings.push({label:'Tailwind component',value:hidden?'?':signed(-r.headwind,1),unit:'kt',tone:'wind'});
    return readings;
  },
  drag(key,x,y,s) {
    const scale=155/Math.max(s.tas,s.windSpeed,60),r=solution(s),a=vector(r.feasible?r.heading:s.track,s.tas*scale);
    if(key==='track') return {...s,track:(deg(x-300,y-212)+180)%360};
    if(key==='tas') return {...s,tas:clamp(Math.hypot(x-300,y-212)*2/scale,60,520)};
    if(key==='windFrom'||key==='windSpeed') return {...s,windFrom:(deg(x-300-a.x,y-212-a.y)+180)%360,windSpeed:clamp(Math.hypot(x-300-a.x,y-212-a.y)/scale,0,180)};
    return s;
  },
  how: [
    {title:'The triangle closes',body:'The aeroplane moves through the air (blue). The whole air mass moves downwind (amber). Add the vectors tip to tail to get motion over the ground (teal). Wind direction is where it comes FROM; its arrow points downwind.'},
    {title:'Why the crosswind matters',body:'For a fixed wind speed and required track, crosswind peaks at 90° to track. Heading correction = asin(crosswind ÷ TAS). Groundspeed = √(TAS² − crosswind²) − headwind. A crosswind stronger than TAS, or no forward progress, makes that track impossible.'},
    {title:'1-in-60 and the E6-B',body:'For small angles, correction ≈ 60 × crosswind ÷ TAS degrees. On the E6-B wind side, set wind direction at the index and mark wind speed above the grommet. Set true course, slide the wind dot to the TAS arc, then read groundspeed at the grommet and drift at the dot. The overlay gives the equivalent geometric answer; a separate E6-B instrument is not bundled on this branch.'},
  ],
};
