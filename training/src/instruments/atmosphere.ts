import type { InstrumentDefinition, Values } from './types.ts';
import { atmosphere } from './physics.ts';
import { isaTemperatureK } from '../b727/model.ts';
import { roundTo } from '../b727/engine.ts';
import { clamp, handle, line, n, plane, signed, text } from './svg.ts';
const calc=(s:Values)=>atmosphere({level:s.level,oat:s.oat,qnh:s.qnh,setting:s.setting,fieldElevation:0});
export const atmosphereInstrument: InstrumentDefinition = {
  id:'atmosphere',title:'ISA & altimetry',eyebrow:'PRESSURE IS NOT HEIGHT',overlay:'Cold approach',
  controls:[
    {key:'level',label:'Indicated altitude',unit:'ft',min:1000,max:42000,step:100,tone:'air'},
    {key:'oat',label:'OAT at aircraft',unit:'°C',min:-80,max:45,step:0.1,tone:'wind'},
    {key:'qnh',label:'Actual QNH',unit:'hPa',min:960,max:1040,step:.25,tone:'ground'},
    {key:'setting',label:'Altimeter setting',unit:'hPa',min:960,max:1040,step:.25,tone:'air'},
  ],
  scenario(seed,card){
    const i=Math.abs(seed)%4,level=[4000,6000,8000,10000][i]+Math.floor(Math.abs(seed)/4)%5*1000;
    const state:Values={level,oat:Math.round(isaTemperatureK(level)-273.15)-[15,20,10,25][i],qnh:[990,1000,980,995][i],setting:1013.25};
    const given=card?.numeric?.given;
    if(given?.fl!=null&&given.oatC!=null)Object.assign(state,{level:given.fl*100,oat:given.oatC,qnh:1013.25,setting:1013.25,tableStep:given.roundingStep??0});
    const r=calc(state);
    return {state,route:given?'Your drill · ISA and table rounding':['Canberra approach · YSCB','Hobart approach · YMHB','Perth arrival · YPPH','Melbourne arrival · YMML'][i]+' · sea-level reference exercise',
      prompt:given?card!.stem:'Estimate true altitude above the sea-level reference.',answer:given?card!.numeric!.value:r.trueAltitude,tolerance:given?card!.numeric!.tolerance:50,unit:given?'°C':'ft',
      estimate:given?'Estimate OAT minus local ISA. Use about 2°C per 1,000 ft, then hold −56.5°C above the tropopause.':'Cold air and lower pressure. Will true altitude be above or below the blue indication? Estimate the height.',
      watch:given?'Watch OAT approach ISA. The amber temperature gap closes; ISA deviation becomes zero.':'The blue indication stays fixed. Lower QNH and colder air compress the column: the teal aircraft is lower.',
      guided:given?`Set OAT to ${n(r.isa,1)}°C: this is ISA at your pressure altitude.`:`Set actual QNH to ${n(state.setting,2)} hPa. This removes the setting error; cold-temperature error remains.`,
      guideKey:given?'oat':'qnh',guideTarget:given?r.isa:state.setting,guideStart:given?state.oat:980,guideTolerance:.5,
      explain:given?card!.numeric!.method:'Pressure altitude is a pressure coordinate. Density altitude describes density. True altitude is geometric height: a warm or cold column changes the spacing between pressure surfaces.'};
  },
  draw(s,c){
    const r=calc(s),top=Math.max(6000,s.level*1.35,r.densityAltitude*1.15),y=(ft:number)=>350-ft/top*280;
    let out=`<rect x="153" y="44" width="126" height="306" rx="16" class="standard-column"/><path d="M322 350 L322 ${y(Math.max(0,r.trueAltitude))} Q377 ${y(Math.max(0,r.trueAltitude))-20} 434 ${y(Math.max(0,r.trueAltitude))} L434 350Z" class="actual-column"/>`;
    const step=top>18000?5000:2000;
    for(let h=0;h<top;h+=step){ const yy=y(h);out+=line(92,yy,463,yy,'grid')+text(80,yy+6,n(h),'muted small','end'); }
    out+=text(215,28,'INDICATED','air label','middle')+text(378,28,'TRUE','ground label','middle');
    out+=line(150,y(s.level),450,y(s.level),'track-line air')+line(280,y(s.level),325,y(Math.max(0,r.trueAltitude)),'connector wind');
    out+=plane(215,y(s.level),90,.85)+plane(378,y(Math.max(0,r.trueAltitude)),90,.85);
    out+=handle(215,y(s.level),'level','Indicated altitude','air')+handle(378,y(Math.max(0,r.trueAltitude)),'qnh','Actual QNH moves the true altitude','ground');
    out+=text(275,y(s.level)-20,n(s.level)+' ft','air','end');
    out+=text(435,y(Math.max(0,r.trueAltitude))+35,c.hidden?'True altitude ?':n(r.trueAltitude)+' ft','ground','end');
    out+=`<rect x="475" y="80" width="15" height="215" rx="8" class="thermometer"/>`;
    const oy=295-(s.oat+80)/125*215;
    const iy=295-(r.isa+80)/125*215;
    out+=line(464,iy,500,iy,'track-line air')+text(461,iy-8,'ISA','air label','end');
    out+=line(482,295,482,oy,'temperature-stem wind')+handle(482,oy,'oat','Outside air temperature','wind')+text(514,oy+6,n(s.oat,1)+'°','wind');
    out+=line(140,350,455,350,'ground-line')+text(297,382,'SEA-LEVEL REFERENCE','muted label','middle');
    if(c.overlay){
      out+=`<rect x="20" y="294" width="245" height="54" rx="8" class="annotation-plate"/>`;
      out+=text(32,316,'COLD ERROR · SAME QNH','wind label')+text(32,340,c.hidden?'Colder → lower than indicated':`${n(Math.abs(r.coldError))} ft ${r.coldError>=0?'below':'above'} indication`,'wind');
    }
    return out;
  },
  readings(s,h){const r=calc(s);return [
    {label:'ISA deviation',value:h?'?':signed(r.isaDeviation,1),unit:'°C',tone:'wind'},
    {label:'Pressure altitude',value:h?'?':n(r.pressureAltitude),unit:'ft',tone:'air'},
    s.tableStep?{label:`Table entry · ${s.tableStep}°C`,value:h?'?':signed(roundTo(r.isaDeviation,s.tableStep)),unit:'°C',tone:'wind'}:{label:'Density altitude',value:h?'?':n(r.densityAltitude),unit:'ft',tone:'warm'},
    {label:'True altitude',value:h?'?':n(r.trueAltitude),unit:'ft',tone:'ground'},
  ];},
  drag(key,x,y,s){const r=calc(s),top=Math.max(6000,s.level*1.35,r.densityAltitude*1.15);if(key==='level')return {...s,level:clamp((350-y)/280*top,1000,42000)};if(key==='qnh')return {...s,qnh:clamp(s.setting+(((350-y)/280*top)/(1+r.isaDeviation/288.15)-s.level)/27,960,1040)};if(key==='oat')return {...s,oat:clamp((295-y)/215*125-80,-80,45)};return s;},
  how:[
    {title:'High to low, look out below',body:'Hold the blue indication and altimeter setting fixed; reduce actual QNH. You are on a lower pressure surface than the instrument assumes, so true altitude falls. Resetting the altimeter to local QNH removes this pressure-setting error.'},
    {title:'Three different altitudes',body:'ISA falls 1.98°C per 1,000 ft to the tropopause. ISA deviation compares OAT with standard temperature at pressure altitude. Pressure altitude uses 1013.25 hPa. Density altitude is the ISA altitude with the same density, taken from the B727 atmosphere model.'},
    {title:'Cold approach mechanism',body:'Even with correct QNH, cold air compresses the column. This teaching model applies a constant temperature offset through an ISA lapse-rate column, above a sea-level reference. Cold error isolates temperature with correct QNH. For an actual approach, use the published procedure and approved cold-temperature correction method referenced to the reporting aerodrome; this is not an operational correction calculator.'},
  ],
};
