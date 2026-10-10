import { ROUTES, profile } from './physics.ts';
import { arrow, clamp, handle, line, n, plane, signed, text } from './svg.ts';
import type { InstrumentDefinition, Values } from './types.ts';
const solve=(s:Values)=>profile({weight:s.weight,level:s.level,isaDeviation:s.isaDeviation,climbWind:s.climbWind,descentWind:s.descentWind,distance:s.distance,arrivalAltitude:s.arrivalAltitude,landingWeight:s.landingWeight});
const px=(nm:number,s:Values)=>70+nm/s.distance*470,py=(ft:number)=>320-ft/40000*250;
export const profileInstrument:InstrumentDefinition={
  id:'profile',title:'Climb & descent',eyebrow:'HEIGHT → TIME → GROUND DISTANCE',overlay:'3× rule',
  controls:[
    {key:'level',label:'Cruise level',unit:'FL',min:50,max:390,step:10,tone:'air'},
    {key:'climbWind',label:'Climb tailwind',unit:'kt',min:-80,max:80,step:5,tone:'wind'},
    {key:'descentWind',label:'Descent tailwind',unit:'kt',min:-80,max:80,step:5,tone:'wind'},
    {key:'weight',label:'Departure weight',unit:'kg',min:55000,max:85000,step:1000,tone:'air'},
    {key:'distance',label:'Route distance',unit:'NM',min:100,max:3000,step:1,tone:'ground'},
  ],
  scenario(seed,card){
    const i=Math.abs(seed),key=['YSSY-YMML','YMML-YBBN','YPPH-YPAD','YPPH-YSSY'][i%4],route=ROUTES[key];
    const state:Values={weight:66000+i%5*2000,landingWeight:60000+i%3*2000,level:290+i%4*20,isaDeviation:0,climbWind:[20,-30,40,-10][i%4],descentWind:[30,-20,10,40][i%4],distance:Math.round(route.distanceNm),arrivalAltitude:1500};
    const given=card?.numeric?.given;if(given?.cruiseFl!=null){state.level=given.cruiseFl;state.arrivalAltitude=0;}
    // A supported retry lowers difficulty rung, but keeps the same mechanism.
    const sampleFraction=given?.sampleFraction??((card?.numeric?.steps?.find(s=>s.id==='fraction')?.value??state.level*2/3)/state.level);
    const descentSupport=sampleFraction===.5;
    const r=solve(state);
    return {state,route:given?'Your drill · forecast-height mechanism':`${route.from} → ${route.to} · great-circle · landing ${n(state.landingWeight)} kg`,
      prompt:given?`At what height is the ${descentSupport?'descent':'climb'} wind sampled before choosing a forecast level?`:'Where is top of descent, measured from departure?',
      answer:given?state.level*100*(descentSupport?.5:2/3):r.tod,tolerance:given?50:2,unit:given?'ft':'NM from departure',
      estimate:given?`Estimate ${descentSupport?'half':'two-thirds'} of the cruise height. The worksheet then chooses the nearest forecast level, at or above FL185.`:`Lose ${n(state.level*100-state.arrivalAltitude)} ft. Estimate descent distance at 3 NM per 1,000 ft, then subtract it from ${n(state.distance)} NM.`,
      watch:given?`Watch the cruise height change. The amber ${descentSupport?'half-height':'two-thirds-height'} marker follows the same fraction.`:'A tailwind adds ground distance during each minute of descent. Top of descent moves earlier along the route.',
      guided:given?`Set cruise back to FL${state.level}. Read the amber ${descentSupport?'½':'⅔'} height before choosing the forecast row.`:'Set descent tailwind to +40 kt. Follow the amber arrow: a longer descent puts ToD farther from arrival.',guideKey:given?'level':'descentWind',guideTarget:given?state.level:40,guideStart:given?state.level-40:-40,guideTolerance:given?0:2,
      explain:'Climb uses wind at two-thirds of its height; descent uses the midpoint of its altitude interval. Wind correction is wind × minutes ÷ 60. Negative values are headwinds.'};
  },
  draw(s,c){
    const r=solve(s),top=s.level*100,tx=px(r.toc,s),dx=px(r.tod,s),ty=py(top),cy=py(r.climbWindLevel),dy=py(r.descentWindLevel),cx=px(r.toc*2/3,s),wx=px(r.tod+r.descentNm/2,s);
    let out=text(30,24,`B727 · ${n(s.weight/1000)} t · ISA ${signed(s.isaDeviation)}°C`,'muted label')+text(570,24,`${n(s.distance)} NM`,'ground','end');
    for(const ft of [0,10000,20000,30000,40000])out+=line(70,py(ft),540,py(ft),'grid')+text(60,py(ft)+5,`${ft/1000}k`,'muted small','end');
    if(!r.feasible){out+=text(305,170,'Profile cannot fit this flight','danger','middle')+text(305,202,'Check weights, level and route distance.','muted','middle');return out;}
    out+=`<path d="M70 320 L${tx} ${ty} L${dx} ${ty} L540 ${py(s.arrivalAltitude)}" class="profile-line air"/>`;
    out+=text(tx+12,ty-15,'ToC','air label')+text(dx-12,ty-15,'ToD','air label','end');
    out+=plane((tx+dx)/2,ty,90,.65)+handle((tx+dx)/2,ty,'level','Cruise altitude','air');
    out+=line(tx,ty,tx,320,'track-line air')+line(dx,ty,dx,320,'track-line air');
    out+=arrow(cx,cy,cx+s.climbWind*.7,cy,'wind')+handle(cx,cy,'climbWind','Climb wind: negative is headwind','wind');
    out+=arrow(wx,dy,wx+s.descentWind*.7,dy,'wind')+handle(wx,dy,'descentWind','Descent wind: negative is headwind','wind');
    out+=text(clamp(cx+28,115,350),cy-17,`⅔ · ${n(r.climbWindLevel)} ft`,'wind label')+text(clamp(wx-28,290,535),dy+36,`½ · ${n(r.descentWindLevel)} ft`,'wind label','end');
    out+=text(70,345,'DEPARTURE','muted label')+text(540,345,`ARRIVAL ${n(s.arrivalAltitude)} ft`,'muted label','end');
    if(c.overlay){const ex=px(s.distance-r.threeRuleNm,s);out+=line(ex,367,540,367,'vector ground','stroke-dasharray="5 4"')+line(ex,357,ex,377,'ground')+line(540,357,540,377,'ground')+text(305,399,c.hidden?'3 × altitude loss (thousands of ft)':`3× estimate ${n(r.threeRuleNm,1)} NM · model ${n(r.descentNm,1)} NM`,'ground','middle');}
    else out+=text(305,391,'+ tailwind → farther · − headwind → shorter','muted label','middle');
    return out;
  },
  readings(s,h){const r=solve(s);return[
    {label:'ToC from departure',value:h?'?':r.feasible?n(r.toc):'Unavailable',unit:r.feasible?'NM':'',tone:'air'},
    {label:'ToD from departure',value:h?'?':r.feasible?n(r.tod):'Unavailable',unit:r.feasible?'NM':'',tone:'ground'},
    {label:'Descent distance',value:h?'?':r.feasible?n(r.descentNm):'Unavailable',unit:r.feasible?'NM':'',tone:'wind'},
  ];},
  drag(key,x,y,s){const r=solve(s);if(key==='level')return {...s,level:clamp((320-y)/250*400,50,390)};if(key==='climbWind')return {...s,climbWind:clamp(s.climbWind+(x-px(r.toc*2/3,s))*1.5,-80,80)};if(key==='descentWind')return {...s,descentWind:clamp(s.descentWind+(x-px(r.tod+r.descentNm/2,s))*1.5,-80,80)};return s;},
  how:[
    {title:'Why three times height?',body:'A slope of 1,000 ft in 3 NM is about 3.14°. Multiply the altitude loss in thousands of feet by three. This quick geometric estimate does not include deceleration, speed restrictions or wind.'},
    {title:'Wind where the time is spent',body:'Use wind near two-thirds of climb height and halfway between the descent start and end altitudes as planning approximations. A +30 kt tailwind adds 10 NM during a 20-minute descent. The rule uses a representative wind, not a vertically integrated forecast.'},
    {title:'What drives this profile',body:'The local B727 model integrates the climb and idle descent speed schedules. Departure and landing weights are specified separately; cruise fuel burn is not solved here. Distances use airport great-circle coordinates, not a published airway or clearance. The chart is a training model, not an operational flight plan.'},
  ],
};
