import { AIRCRAFT, BALANCE, armFromIndex, cgLimits, indexUnits, percentMac } from '../b727/model.ts';
import { balance } from './physics.ts';
import { clamp, handle, line, n, signed, text } from './svg.ts';
import type { InstrumentDefinition, Values } from './types.ts';
const zones=['A','B','C','D','E'],holds=[1,2,4,5];
const armX=(arm:number)=>50+12*arm;
function solve(s:Values){
  const passengers=[0,0,0,0,0],cargo=[0,0,0,0];passengers[s.passengerZone]=s.passengers;cargo[s.cargoHold]=s.cargoKg;
  const r=balance({passengers,cargo,fuel:s.fuel});
  if(s.baseWeight!=null){
    const oldMoment=AIRCRAFT.weights.basicWeightKg*armFromIndex(AIRCRAFT.weights.basicWeightKg,BALANCE.typicalBasicIndex);
    r.weight+=s.baseWeight-AIRCRAFT.weights.basicWeightKg-(s.removedKg??0);
    r.moment+=s.baseWeight*s.baseArm-oldMoment-(s.removedKg??0)*(s.removedArm??0);
    r.cg=percentMac(r.moment/r.weight);r.index=BALANCE.indexOffset+indexUnits(r.weight,r.moment/r.weight);
    const limits=cgLimits(r.weight);r.forward=limits.forwardMac;r.aft=limits.aftMac;
    r.status=r.status==='capacity'?'capacity':r.weight>AIRCRAFT.weights.maxTakeoffKg?'overweight':r.cg<r.forward?'forward':r.cg>r.aft?'aft':'within';
  }
  return r;
}
export const balanceInstrument:InstrumentDefinition={
  id:'balance',title:'CG balance beam',eyebrow:'WEIGHT × ARM = MOMENT',overlay:'Index units',
  controls:[
    {key:'passengers',label:'Passenger group',unit:'pax',min:0,max:50,step:1,tone:'air'},
    {key:'passengerZone',label:'Zone',unit:'',min:0,max:4,step:1,tone:'air'},
    {key:'cargoKg',label:'Cargo group',unit:'kg',min:0,max:5000,step:50,tone:'ground'},
    {key:'cargoHold',label:'Hold',unit:'',min:0,max:3,step:1,tone:'ground'},
    {key:'fuel',label:'Fuel',unit:'kg',min:0,max:AIRCRAFT.fuel.usableWithAuxKg,step:100,tone:'wind'},
  ],
  scenario(seed,card){
    const i=Math.abs(seed),state:Values={passengers:18+i%4*4,passengerZone:2,cargoKg:800+i%4*200,cargoHold:i%4,fuel:10000+i%7*1400};
    const g=card?.numeric?.given;
    if(g){Object.assign(state,{passengers:g.adults??0,passengerZone:0,cargoKg:g.addKg??g.moveKg??g.freightKg??g.weightKg??0,cargoHold:Math.max(0,holds.indexOf(g.to??g.compartment??1)),fuel:0});
      if(g.mac!=null)Object.assign(state,{baseWeight:g.weightKg,baseArm:g.baseArm,removedKg:g.moveKg??0,removedArm:g.fromArm??0});
      if(g.referenceArmM!=null)state.contribution=1;
    }
    return {state,route:g?'Your drill · B727 loading data':['YPPH → YSSY','YSSY → YMML','YMML → YBBN','YPAD → YSSY'][i%4]+' · 82 kg/adult',
      prompt:g?card!.stem:'What is the loaded CG, in percent MAC?',answer:g?card!.numeric!.value:solve(state).cg,tolerance:g?card!.numeric!.tolerance:.2,unit:g?card!.numeric!.unit:'% MAC',
      estimate:state.contribution?'Estimate the load’s index contribution. Is its arm ahead of or behind the 21.89875 m reference?':'Estimate the balance point. A load far from the wing has a longer lever arm.',
      watch:'The blue group moves aft at constant weight. Moment grows and the CG marker moves right.',
      guided:state.passengers?'Drag the blue passenger group to zone D. The mass stays the same; only its arm changes.':'Drag the green cargo group to hold 4. The same weight gains a longer arm.',guideKey:state.passengers?'passengerZone':'cargoHold',guideTarget:state.passengers?3:2,guideStart:0,guideTolerance:0,
      explain:g?card!.numeric!.method:'Add the moments, then divide by total weight. The same load moved farther changes CG more. The shaded envelope is the B727 model limit at each weight.'};
  },
  draw(s,c){
    const r=solve(s),pa=BALANCE.zones[zones[s.passengerZone]].armM,ca=BALANCE.compartments[holds[s.cargoHold]].armM;
    const status={within:'✓ Within limits',forward:'CG forward of limit',aft:'CG aft of limit',overweight:'Over weight limit',capacity:'Load exceeds capacity'}[r.status];
    let out=text(25,25,'B727-200 · NOSE DATUM','muted label')+text(575,25,c.hidden?'Locate the balance point':status,r.status==='within'?'ground label':'danger label','end');
    out+=`<path class="aircraft air" d="M48 110 Q65 89 99 88 L431 88 L465 48 L477 48 L475 94 L536 104 Q551 108 536 120 L94 120 Q57 119 48 110Z"/>`;
    out+=`<path class="aircraft air" d="M280 111 L229 143 L253 146 L334 117 M444 89 L455 71 L486 73 L484 86Z"/>`;
    for(const z of zones){const x=armX(BALANCE.zones[z].armM);out+=line(x,88,x,118,'grid')+text(x,109,z,'label','middle');}
    out+=line(48,154,546,154,'beam ground');
    if(!c.hidden&&Number.isFinite(r.cg)){
      const cgX=armX(AIRCRAFT.wing.lemacM+r.cg/100*AIRCRAFT.wing.macM);
      out+=`<path d="M${cgX} 154 l-10 17 h20 Z" class="marker ground"/>`;
    }
    out+=line(armX(pa),74,armX(pa),88,'connector air')+handle(armX(pa),68,'passengerZone','Move passengers between zones','air')+text(armX(pa),44,`${n(s.passengers)} pax`,'air','middle');
    for(const h of holds){const x=armX(BALANCE.compartments[h].armM);out+=text(x,192,`H${h}`,'ground label','middle');}
    out+=line(armX(ca),154,armX(ca),207,'connector ground')+handle(armX(ca),213,'cargoHold','Move cargo between holds','ground')+text(armX(ca),244,`${n(s.cargoKg)} kg`,'ground','middle');
    const x=(mac:number)=>360+(mac-8)/34*210,y=(kg:number)=>365-(kg-40000)/47000*110;
    out+=text(465,243,'CG ENVELOPE','muted label','middle');
    const path=[...BALANCE.envelope.forward,...BALANCE.envelope.aft.slice().reverse()].map(p=>`${x(p.mac)},${y(p.kg)}`).join(' ');
    out+=`<polygon points="${path}" class="envelope-fill ground"/>`;
    for(const kg of [50000,70000,85000])out+=line(358,y(kg),574,y(kg),'grid')+text(352,y(kg)+5,`${kg/1000} t`,'muted small','end');
    for(const mac of [12,24,36])out+=text(x(mac),388,`${mac}%`,'muted small','middle');
    if(!c.hidden&&Number.isFinite(r.cg))out+=`<circle cx="${clamp(x(r.cg),358,574)}" cy="${clamp(y(r.weight),253,367)}" r="8" class="marker ${r.status==='within'?'ground':'warm'}"/>`;
    out+=text(28,279,'FUEL · AUTO TANK ORDER','wind label')+line(40,310,255,310,'ruler')+line(40,310,40+s.fuel/AIRCRAFT.fuel.usableWithAuxKg*215,310,'vector wind')+handle(40+s.fuel/AIRCRAFT.fuel.usableWithAuxKg*215,310,'fuel','Fuel quantity','wind');
    out+=text(28,347,`${n(s.fuel)} kg fuel`,'wind')+text(28,378,c.overlay?(c.hidden?'IU = 100 + offset moment / 500':`Index ${signed(r.index,1)} IU`):`${n(r.weight)} kg total`,'label');
    return out;
  },
  readings(s,h){const r=solve(s);return[
    {label:s.contribution?'Hold index contribution':'Loaded CG',value:h?'?':n(s.contribution?indexUnits(s.cargoKg,BALANCE.compartments[holds[s.cargoHold]].armM):r.cg,1),unit:s.contribution?'IU':'% MAC',tone:'ground'},
    {label:'Total moment',value:h?'?':n(r.moment/1000,1),unit:'×10³ kg·m',tone:'air'},
    {label:'Total index',value:h?'?':signed(r.index,1),unit:'IU',tone:'wind'},
  ];},
  drag(key,x,y,s){
    if(key==='passengerZone'){const closest=zones.map(z=>Math.abs(armX(BALANCE.zones[z].armM)-x));return {...s,passengerZone:closest.indexOf(Math.min(...closest))};}
    if(key==='cargoHold'){const closest=holds.map(h=>Math.abs(armX(BALANCE.compartments[h].armM)-x));return {...s,cargoHold:closest.indexOf(Math.min(...closest))};}
    if(key==='fuel')return {...s,fuel:clamp((x-40)/215*AIRCRAFT.fuel.usableWithAuxKg,0,AIRCRAFT.fuel.usableWithAuxKg)};
    return s;
  },
  how:[
    {title:'Move mass, keep the moment',body:'A group is 82 kg per adult in the Isobar model. Drag it among zones A–E or cargo among holds 1, 2, 4 and 5. A transfer keeps weight fixed. Its change of moment is mass × change of arm, measured aft of the nose datum.'},
    {title:'From the beam to the envelope',body:'CG arm = total moment ÷ total weight. Percent MAC = (arm − 20.75 m) ÷ 4.595 m × 100. The horizontal coordinate is % MAC; the vertical coordinate is weight. The polygon uses the local B727 forward and aft limits.'},
    {title:'Index units save arithmetic',body:'Add each load’s index contribution: mass × (arm − 21.89875 m) ÷ 500. The total includes the basic index 125.5. Fuel follows the model tank loading order. Seat, cargo, fuel and structural limits are checked separately. Model training only; use approved aircraft loading data operationally.'},
  ],
};
