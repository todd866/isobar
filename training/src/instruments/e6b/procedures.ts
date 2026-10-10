/** Canonical hand actions, checked against the actual scale pose. The same
 * records drive Watch, Guided, Solo, diagnosis and the exported workbook.
 * No answer is obtained from a demo's precomputed `read` field. */
import { E6B, mark, scale } from './face.ts';
import { densityAtIndex, tasTheta, altTheta, machTheta, CONVERSIONS, type ConversionKind, type Demo, type Step, type Result, type Highlight } from './demos.ts';
import { densityAltitude, sigma, tasIncompressible, trueHeightComputer, speedOfSound } from './atmosphere.ts';
import { angleOf, norm, turn, rotationFor, valueAt, placeDecade, scaleTolerance } from './slide.ts';
import { HIGH_SPEED_SLIDE, SLIDE, U, windDot, toScreen, toPlate, readDot, gsForArc, solveHeading, solveWind, wrap360, type WindState } from './wind.ts';
import type { Pose, Goal } from './coach.ts';
import { goalMet, TOL } from './coach.ts';
import type { Shape, Problem } from './practice.ts';

export type Operation = 'time' | 'speed' | 'distance' | 'fuel' | 'endurance' | 'climb' | 'convert' | 'sg' | 'tas' | 'truealt' | 'density' | 'mach' | 'offcourse' | 'windhdg' | 'windfind' | 'components' | 'jet';
export const OPERATION_NAMES: Record<Operation, string> = {
  time: 'Time en route', speed: 'Ground speed', distance: 'Distance', fuel: 'Fuel burn', endurance: 'Endurance', climb: 'Climb / descent rate',
  convert: 'Unit conversions', sg: 'Fuel specific gravity', tas: 'TAS from CAS', truealt: 'True altitude', density: 'Density altitude', mach: 'Mach to TAS',
  offcourse: 'Off-course: 1 in 60', windhdg: 'Heading & ground speed', windfind: 'Find the wind', components: 'Wind components', jet: 'B727 high-speed slide',
};
const SHAPE: Record<Operation, Shape> = { time:'tsd', speed:'tsd', distance:'tsd', fuel:'fuel', endurance:'fuel', climb:'tsd', convert:'convert', sg:'convert', tas:'tas', truealt:'truealt', density:'tas', mach:'mach', offcourse:'offcourse', windhdg:'windhdg', windfind:'windfind', components:'windhdg', jet:'windhdg' };
export const OPERATION_WHY: Record<Operation,string> = {
  time:'Blue minutes and black distance share the same ratio. Sixty minutes opposite speed fixes distance per hour everywhere on the circle.',
  speed:'Distance divided by minutes is the ratio. Reading black at blue 60 changes that per-minute ratio to distance per hour.',
  distance:'A constant speed fixes one ratio: every blue elapsed time has its distance opposite on black.',
  fuel:'Fuel used is proportional to elapsed time at a constant flow. Sixty minutes represents one hour of that flow.',
  endurance:'The fuel-to-time ratio is already set by hourly flow. Reverse the reading: find fuel on black and time below on blue.',
  climb:'Height divided by minutes gives feet per minute. Use the unit index; RATE 60 would give feet per hour.',
  convert:'Conversion arrows are separated by the exact unit ratio. Aligning them applies that ratio to every pair of numbers.',
  sg:'Density is kilograms per litre. Multiplying litres by density gives kilograms; the FUEL LBS arrow assumes a different fixed avgas density.',
  tas:'At lower density a given dynamic pressure needs more speed. This window encodes TAS = CAS divided by the square root of density ratio; compressibility is omitted.',
  truealt:'Cold air compresses the pressure layers. Correct the height above the reporting station, then restore the station elevation.',
  density:'Density altitude is the ISA altitude with this density. Pressure altitude and temperature determine density, independent of the aircraft speed.',
  mach:'Mach is a fraction of local sound speed. Sound speed varies with the square root of absolute temperature, not altitude by itself.',
  offcourse:'For a small angle, lateral error divided by forward distance approximates radians. Multiplying by 60 estimates degrees. Parallel and closing turns add.',
  windhdg:'The grommet represents the ground vector. The upwind dot supplies the wind difference; its TAS arc and drift ray complete the vector triangle.',
  windfind:'Known air and ground vectors leave the wind as their difference. Rotating that difference above the grommet reveals the FROM direction.',
  components:'The wind splits into a component along the runway and one across it. The table records cosine and sine projections; interpolate nearby entries.',
  jet:'The wind triangle is unchanged at jet speed. A fivefold coarser teaching grid fits larger vectors; ten knots now separate adjacent speed arcs.',
};
export type Reading =
  | { kind: 'scale'; ring: 'outer' | 'inner'; estimate: number; add?: number; divide?: number }
  | { kind: 'density' }
  | { kind: 'wind'; field: 'gs' | 'th' | 'wca' | 'from' | 'kt' }
  | { kind: 'sum'; keys: string[] }
  | { kind: 'component'; field: 'head' | 'cross'; angle: number; speed: number };
export type PhysicalAction =
  | { kind: 'estimate'; value: number }
  | { kind: 'orient'; angle: number }
  | { kind: 'disc'; theta: number }
  | { kind: 'cursor'; angle: number }
  | { kind: 'slide-end'; end: 'low' | 'high' }
  | { kind: 'plate'; bearing: number }
  | { kind: 'slide'; gs: number }
  | { kind: 'dot'; dot: [number, number] }
  | { kind: 'fit-tas'; tas: number }
  | { kind: 'dot-up' }
  | { kind: 'read'; key: string; reading: Reading };
export interface ProcedurePose extends Pose { viewAngle: number; values: Record<string, number>; estimate: number | null }
export interface ProcedureStep {
  action: string; success: string; wrongMove: string; correction: string; why: string;
  physical: PhysicalAction; demoStep: Step; goals: Goal[]; viewAngle?: number;
  result?: Result; highlights: Highlight[];
}
export interface ProcedureExercise {
  id: string; operation: Operation; level: 'easy' | 'intermediate' | 'exam'; title: string; scenario: string;
  estimate: string; estimateValue: number; procedure: ProcedureStep[]; demo: Demo;
  answer: Result; readingTolerance: number; shape: Shape; source: string;
  /** The problem's own numbers, named, for the method and why lines. */
  vals: Record<string, number>;
  /** Units for conversions. */
  units?: { from: string; to: string };
}
export const initialProcedurePose = (): ProcedurePose => ({ theta: 0, cursor: 0, wind: { plate:0, gs:150, dot:null, slide:'low' }, viewAngle:0, values:{}, estimate:null });
const clone = (p: ProcedurePose): ProcedurePose => ({ ...p, wind:{ ...p.wind, dot: p.wind.dot ? [...p.wind.dot] : null }, values:{...p.values} });
const units = (w: WindState) => w.slide === 'high' ? HIGH_SPEED_SLIDE.unitsPerKt : U;
const slideOf = (w: WindState) => w.slide === 'high' ? HIGH_SPEED_SLIDE : SLIDE;
const f = (v: number): string => Number(v.toFixed(2)).toLocaleString('en-AU');
const outer = (value:number): Highlight => ({kind:'scale',scale:'outer',value});
const inner = (value:number): Highlight => ({kind:'scale',scale:'middle',value});

/** Computed equivalent of the ASA crosswind table method (p.27): ten-knot rows and ten-degree columns.
 * Interpolate between the four surrounding entries, then restore tail/left
 * signs. This is deliberately a table reading, independently checked against
 * sine/cosine below; it is not a claim of greater precision than the paper. */
export function componentTable(speed: number, angle: number, field: 'head'|'cross'): number {
  const a = Math.abs(turn(angle)), acute = a > 90 ? 180-a : a;
  const lo = Math.floor(acute/10)*10, hi = Math.min(90,lo+10), t = hi===lo ? 0 : (acute-lo)/(hi-lo);
  const v0 = Math.floor(speed/10)*10, v1=v0+10, u=(speed-v0)/10;
  const entry = (v:number,d:number) => Math.round(v*(field==='head'?Math.cos(d*Math.PI/180):Math.sin(d*Math.PI/180))*10)/10;
  const interpolate=(v:number)=>entry(v,lo)*(1-t)+entry(v,hi)*t;
  const sign = field==='head' ? (a>90?-1:1) : (turn(angle)<0?-1:1);
  return sign*(interpolate(v0)*(1-u)+interpolate(v1)*u);
}
export function readProcedure(reading: Reading, pose: ProcedurePose): number {
  switch(reading.kind) {
    case 'scale': return placeDecade(valueAt(pose.cursor-(reading.ring==='inner'?pose.theta:0)),reading.estimate)/(reading.divide??1)+(reading.add??0);
    case 'density': return densityAtIndex(pose.theta);
    case 'sum': return reading.keys.reduce((sum,key)=>sum+(pose.values[key]??NaN),0);
    case 'component': return componentTable(reading.speed,reading.angle,reading.field);
    case 'wind': {
      const d=readDot(pose.wind);
      switch(reading.field) {
        case 'gs':return pose.wind.gs;
        case 'th':return d ? wrap360(pose.wind.plate+d.wca):NaN;
        case 'wca':return d?.wca??NaN;
        case 'from':return pose.wind.plate;
        case 'kt':return pose.wind.dot ? Math.hypot(...pose.wind.dot)/units(pose.wind):NaN;
      }
    }
  }
}
/** Move a simulated hand, then read its resulting pose. */
export function applyProcedureAction(pose: ProcedurePose, a: PhysicalAction): ProcedurePose {
  const p=clone(pose);
  switch(a.kind) {
    case 'estimate':p.estimate=a.value;break;
    case 'orient':p.viewAngle=norm(a.angle);break;
    case 'disc':p.theta=norm(a.theta);break;
    case 'cursor':p.cursor=norm(a.angle);break;
    case 'slide-end':p.wind={...p.wind,slide:a.end,gs:a.end==='high'?500:150};break;
    case 'plate':p.wind.plate=wrap360(a.bearing);break;
    case 'slide':p.wind.gs=a.gs;break;
    case 'dot':p.wind.dot=[...a.dot];break;
    case 'fit-tas': {
      if(!p.wind.dot) throw new Error('Mark the wind before fitting TAS');
      const [x,y]=toScreen(p.wind.dot,p.wind.plate);
      p.wind.gs=gsForArc(x,y,a.tas,slideOf(p.wind));break;
    }
    case 'dot-up': {
      if(!p.wind.dot) throw new Error('Mark the air vector before turning the dot upright');
      p.wind.plate=wrap360(Math.atan2(p.wind.dot[0],-p.wind.dot[1])*180/Math.PI);break;
    }
    case 'read':p.values[a.key]=readProcedure(a.reading,p);break;
  }
  return p;
}
export function validateProcedureStep(item:ProcedureExercise,index:number,pose:Pose & { viewAngle?:number },entry?:number):boolean {
  const step=item.procedure[index]; if(!step) return false;
  if(!step.goals.every(g=>goalMet(g,pose))) return false;
  const a=step.physical;
  if(step.demoStep.wind && a.kind!=='estimate' && (pose.wind.slide??'low') !== (step.demoStep.wind.slide??'low'))return false;
  if(a.kind==='orient') return pose.viewAngle!=null && Math.abs(turn(pose.viewAngle-a.angle))<=1;
  if(a.kind==='slide-end') return (pose.wind.slide??'low')===a.end;
  if(a.kind==='estimate') return entry!=null && Number.isFinite(entry) && (a.value===0?Math.abs(entry)<=1:entry/a.value>=0.25 && entry/a.value<=4);
  if(a.kind==='read') return entry!=null && Number.isFinite(entry) && Math.abs(step.result!.unit==='°T'?turn(entry-step.result!.exact):entry-step.result!.exact)<=step.result!.tolerance;
  return true;
}
export function executeProcedure(item:ProcedureExercise):{ok:boolean;readings:number[];pose:ProcedurePose;failedAt?:number;reason?:string} {
  let pose=initialProcedurePose(); const readings:number[]=[];
  for(let i=0;i<item.procedure.length;i++) {
    const step=item.procedure[i]; pose=applyProcedureAction(pose,step.physical);
    const entry=step.physical.kind==='estimate'?pose.estimate:step.physical.kind==='read'?pose.values[step.physical.key]:undefined;
    if(step.physical.kind==='read')readings.push(entry!);
    if(!validateProcedureStep(item,i,pose,entry??undefined))return {ok:false,readings,pose,failedAt:i,reason:step.success};
  }
  return {ok:true,readings,pose};
}
class Path {
  pose=initialProcedurePose(); steps:ProcedureStep[]=[]; results:Result[]=[];
  operation:Operation; n:number; scenario:string; estimate:string; estimateValue:number; source:string; vals:Record<string,number>={}; units?:{from:string;to:string};
  constructor(operation:Operation,n:number,scenario:string,estimate:string,estimateValue:number,source:string) {
    this.operation=operation;this.n=n;this.scenario=scenario;this.estimate=estimate;this.estimateValue=estimateValue;this.source=source;
    // The estimate is the learner's to make; the model figure appears only in the correction after a miss.
    this.add({kind:'estimate',value:estimateValue},'Estimate in your head',[], 'Chose a decimal place without checking the size.', `Model estimate: ${estimate}. Use a round-number rate and time; the scale repeats every factor of ten.`);
  }
  add(a:PhysicalAction,text:string,highlights:Highlight[]=[],wrong='Moved the wrong part of the computer.',correction='Move only the named ring; the setting is how black and blue sit against each other.',result?:Result):void {
    this.pose=applyProcedureAction(this.pose,a);
    const p=this.pose; const wind=['windhdg','windfind','jet'].includes(this.operation);
    // Check the retained alignment too: a correct cursor cannot excuse a wrong disc.
    const goals:Goal[]=a.kind==='estimate'||a.kind==='slide-end'?[]:wind ? [{kind:'plate',plate:p.wind.plate,tol:TOL.plate},{kind:'slide',gs:p.wind.gs,tol:p.wind.slide==='high'?5:TOL.slide}]
      : a.kind==='orient'||this.operation==='components'?[]:[{kind:'disc',theta:p.theta,tol:TOL.disc}];
    if(wind&&p.wind.dot)goals.push({kind:'dot',dot:[...p.wind.dot],tol:2.5*units(p.wind)});
    if(a.kind==='cursor'||(a.kind==='read'&&a.reading.kind==='scale'))goals.push({kind:'cursor',angle:p.cursor,tol:TOL.cursor});
    const success=a.kind==='read'?`Enter ${f(result!.exact)} ${result!.unit} within ±${f(result!.tolerance)}.`:a.kind==='estimate'?'A finite estimate within a factor of four; use the correct sign.':a.kind==='orient'?`Working mark at 12 o'clock (view ${f(norm(a.angle))}°, ±1°).`:a.kind==='slide-end'?`${a.end==='high'?'High':'Low'} slide end selected.`:goals.map(g=>g.kind==='disc'?`Disc ${f(g.theta)}° ±${g.tol}°`:g.kind==='cursor'?`Hairline ${f(g.angle)}° ±${g.tol}°`:g.kind==='plate'?`TRUE INDEX ${f(g.plate)}° ±${g.tol}°`:g.kind==='slide'?`Grommet ${f(g.gs)} kt ±${g.tol} kt`:'Wind dot within the marked reading tolerance').join('; ');
    const demoStep:Step={say:text,theta:p.theta,cursor:p.cursor,highlights,...(wind?{wind:{...p.wind,dot:p.wind.dot?[...p.wind.dot]:null}}:{})};
    this.steps.push({action:text,success,wrongMove:wrong,correction,why:OPERATION_WHY[this.operation],physical:a,demoStep,goals,viewAngle:a.kind==='orient'?a.angle:undefined,result,highlights});
    if(result)this.results.push(result);
  }
  orient(angle:number,markText:string,moveHairline=true):void {if(moveHairline && Math.abs(turn(this.pose.cursor-angle))>.01)this.add({kind:'cursor',angle},`Move the red hairline over ${markText}; keep the disc fixed.`,[],'Turned the blue disc instead of the reading pointer.','Drag the red hairline or use Shift-scroll. This places the pointer without changing the ratio.');this.add({kind:'orient',angle:-angle},`Turn the whole view until ${markText} is at the top, upright.`,[], 'Turned the blue disc to orient the page.', 'Swipe with two fingers, or use [ / ]; the alignment must stay unchanged.');}
  align(o:number,i:number,text?:string):void {this.orient(angleOf(o),`${f(o)} on black`);this.add({kind:'disc',theta:rotationFor(o,i)},text??`Turn the blue disc until ${f(i)} on inner blue sits under ${f(o)} on outer black.`,[outer(o),inner(i)],'Aligned the reciprocal ratio, or used 10 instead of 60.','Blue is the denominator: put the stated inner value directly under the stated black value.');}
  cursor(value:number,ring:'outer'|'inner',unit=''):void {
    const angle=norm(angleOf(value)+(ring==='inner'?this.pose.theta:0));
    this.add({kind:'cursor',angle},`Move the red hairline to ${f(value)} ${unit} on ${ring==='inner'?'inner blue':'outer black'}.`,[ring==='inner'?inner(value):outer(value)],'Read at the right number on the wrong scale.',`Keep the disc still; move the red hairline to ${ring==='inner'?'blue':'black'}.`);
    this.orient(angle,`${f(value)} ${unit} on ${ring==='inner'?'blue':'black'}`,false);
  }
  read(key:string,reading:Reading,exact:number,unit:string,text:string,tolerance=Math.max(0.02,scaleTolerance(Math.abs(exact)||1))):void {
    const result:Result={label:key,read:readProcedure(reading,this.pose),exact,tolerance,unit,format:v=>`${f(v)} ${unit}`};
    this.add({kind:'read',key,reading},text,[], 'Read the wrong colour or placed the decimal one decade out.',`Use your estimate, then read ${reading.kind==='scale'?(reading.ring==='inner'?'inner blue':'outer black'):'the indicated mark'}. Expected order of magnitude: ${f(exact)} ${unit}.`,result);
  }
  finish():ProcedureExercise {
    const answer=this.results[this.results.length-1],title=OPERATION_NAMES[this.operation];
    return {id:`${this.operation}-${this.n+1}`,operation:this.operation,level:(['easy','intermediate','exam'] as const)[this.n],title,scenario:this.scenario,estimate:this.estimate,estimateValue:this.estimateValue,
      procedure:this.steps,demo:{id:`procedure-${this.operation}-${this.n+1}`,title,cite:this.source,steps:this.steps.map(s=>s.demoStep),results:this.results},answer,readingTolerance:answer.tolerance,shape:SHAPE[this.operation],source:this.source,vals:this.vals,units:this.units};
  }
}
const all:ProcedureExercise[]=[];
const add=(p:Path)=>all.push(p.finish());
const rateCases=[[120,60,30],[145,174,72],[450,1650,220]];
const contexts=['Jandakot training leg','Busselton coastal navigation exercise','B727 across the Nullarbor'];
for(const operation of ['time','speed','distance'] as const)rateCases.forEach(([gs,dist,min],n)=>{
  const exact=operation==='time'?dist/gs*60:operation==='speed'?dist/min*60:gs*min/60;
  const unit=operation==='time'?'min':operation==='speed'?'kt':'NM';
  const scenario=`${contexts[n]}: ${operation==='time'?`${gs} kt, ${dist} NM. Find elapsed time.`:operation==='speed'?`${dist} NM in ${min} min. Find ground speed.`:`${gs} kt for ${min} min. Find distance.`}`;
  const p=new Path(operation,n,scenario,`${f(Math.round(exact/10)*10)} ${unit}; check using distance ≈ speed × hours.`,exact,'ASA pp. 8–10');p.vals={gs,dist,min};
  if(operation==='speed'){p.align(dist,min);p.cursor(60,'inner','RATE');}
  else {p.align(gs,60);p.cursor(operation==='time'?dist:min,operation==='time'?'outer':'inner',operation==='time'?'NM':'min');}
  p.read('Answer',{kind:'scale',ring:operation==='time'?'inner':'outer',estimate:exact},exact,unit,`Read ${unit} on ${operation==='time'?'inner blue':'outer black'} under the hairline. Use your estimate for the decimal place.`);add(p);
});
for(const operation of ['fuel','endurance'] as const)[[36,90],[2400,125],[4300,215]].forEach(([rate,min],n)=>{
  const fuel=rate*min/60, exact=operation==='fuel'?fuel:min,unit=operation==='fuel'?'kg':'min';
  const p=new Path(operation,n,`${['Albany piston training flight','Darwin turbine leg','B727 Perth–Sydney planning'][n]}: ${rate} kg/h; ${operation==='fuel'?`${min} min. Find burn.`:`${f(fuel)} kg available for this segment after reserves. Find endurance.`}`,`About ${f(Math.round(exact/10)*10)} ${unit}.`,exact,'ASA pp. 11–12');
  p.vals={rate,min,fuel};p.align(rate,60);p.cursor(operation==='fuel'?min:fuel,operation==='fuel'?'inner':'outer');
  p.read('Answer',{kind:'scale',ring:operation==='fuel'?'outer':'inner',estimate:exact},exact,unit,`Read ${operation==='fuel'?'fuel on outer black':'minutes on inner blue, then convert to h:mm'}. The available fuel already excludes reserves.`);add(p);
});
[[3000,10],[12000,18],[18000,14]].forEach(([height,min],n)=>{
  const exact=height/min,p=new Path('climb',n,`${['Perth departure climb','Canberra arrival descent','B727 climb'][n]}: change height by ${height} ft in ${min} min. Find ft/min.`,`Roughly ${f(Math.round(exact/100)*100)} ft/min. A per-minute rate uses the unit index.`,exact,'ASA p. 10');
  p.vals={height,min};p.align(height,min);p.cursor(10,'inner','unit index');p.read('Rate',{kind:'scale',ring:'outer',estimate:exact},exact,'ft/min','Read black at the blue 10 unit index. Choose the decade for feet per minute, not feet per hour.');add(p);
});
(['nm-sm','kg-lb','l-usgal'] as ConversionKind[]).forEach((kind,n)=>{
  const value=[60,2000,1375][n],spec=CONVERSIONS[kind],from=mark(E6B,spec.from),to=mark(E6B,spec.to),exact=value*spec.factor;
  const p=new Path('convert',n,`${['Broome diversion distance','B727 uplift mass','Remote WA fuel bowser'][n]}: convert ${value} ${spec.fromUnit} to ${spec.toUnit}.`,`About ${f(Math.round(exact/10)*10)} ${spec.toUnit}; compare the size of one unit.`,exact,'ASA pp. 13–17');
  p.vals={value,factor:spec.factor};p.units={from:spec.fromUnit,to:spec.toUnit};p.align(spec.method==='arrows'?from.value:to.value,spec.method==='arrows'?value:from.value,spec.method==='arrows'?`Put ${value} on inner blue under the black ${from.text} arrow.`:`Turn the disc to align blue ${from.text} with black ${to.text}.`);
  p.cursor(spec.method==='arrows'?to.value:value,spec.method==='arrows'?'outer':'inner');p.read('Converted',{kind:'scale',ring:spec.method==='arrows'?'inner':'outer',estimate:exact},exact,spec.toUnit,`Read ${spec.toUnit} on ${spec.method==='arrows'?'inner blue under the black '+to.text+' arrow':'outer black above your blue input'}.`);add(p);
});
[[100,0.72],[1800,0.8],[7350,0.785]].forEach(([litres,sg],n)=>{
  const exact=litres*sg,p=new Path('sg',n,`${['Jandakot avgas uplift','Darwin Jet A-1 uplift','B727 Perth uplift'][n]}: ${litres} L, measured density ${sg} kg/L (SG ${sg}). Find kilograms.`,`Less than ${litres} kg: multiply litres by about ${sg}.`,exact,'ASA multiplication principle pp. 5–7; supplied fuel density');
  p.vals={litres,sg};p.align(sg,10,`Set blue 10 (one unit) under black ${sg}. This encodes kilograms per litre; do not use the fixed FUEL LBS avgas arrow.`);p.cursor(litres,'inner','L');p.read('Mass',{kind:'scale',ring:'outer',estimate:exact},exact,'kg','Read mass on outer black. SG is the multiplier: 1 L has this many kilograms.');add(p);
});
const atmos=[[5000,5,120],[10000,20,135],[15000,-15,145]];
for(const operation of ['tas','density'] as const)atmos.forEach(([pa,oat,cas],n)=>{
  const exact=operation==='tas'?tasIncompressible(cas,pa,oat):densityAltitude(sigma(pa,oat));
  const p=new Path(operation,n,`${['Sydney training area','Alice Springs summer cruise','Canberra high-altitude leg'][n]}: PA ${pa} ft, OAT ${oat} °C${operation==='tas'?`, CAS ${cas} kt. Find TAS (E6-B incompressible approximation).`:'. Find density altitude.'}`,operation==='tas'?`TAS should exceed ${cas} kt as density falls.`:`Compare OAT to ISA at ${pa} ft; hotter means density altitude above PA.`,exact,'ASA pp. 18–19; SOURCES.md approximation');
  p.vals={pa,oat,cas};const theta=tasTheta({pa,oat});p.orient(scale(E6B,'pa-as').at(pa),'the airspeed correction window');
  p.add({kind:'disc',theta},`Turn blue until ${pa/1000} on black pressure altitude meets ${oat} °C on blue temperature in AIRSPEED CORRECTION.`,[{kind:'scale',scale:'pa-as',value:pa},{kind:'scale',scale:'temp-as',value:oat}],'Used indicated altitude or the altitude-correction window.','Use pressure altitude and AIRSPEED CORRECTION; temperature belongs to the blue disc.');
  if(operation==='tas'){p.cursor(cas,'inner','kt CAS');p.read('TAS',{kind:'scale',ring:'outer',estimate:exact},exact,'kt','Read TAS on outer black; at jet speeds this window omits compressibility.',scaleTolerance(exact)+exact*0.003);}
  else {p.orient(E6B.index.density+theta,'the density ▲');p.read('Density altitude',{kind:'density'},exact,'ft','Read the black density-altitude graduation under the blue ▲. Thousands of feet; interpolate between marks.',500);}
  add(p);
});
[[5000,0,6000,1000],[10000,-19,12000,5000],[15000,-30,17000,4200]].forEach(([pa,oat,indicated,station],n)=>{
  const height=indicated-station,exact=trueHeightComputer(height,pa,oat)+station;
  const p=new Path('truealt',n,`${['Canberra cold-weather exercise','Snowy Mountains training leg','Australian alpine navigation exercise'][n]}: indicated ${indicated} ft, PA ${pa} ft, OAT ${oat} °C, reporting station ${station} ft AMSL. Find true altitude.`,`Cold air makes true height lower; correct only ${height} ft above the station, then add ${station} ft.`,exact,'ASA pp. 21–22: assumed lapse rate');
  p.vals={pa,oat,indicated,station,height};const theta=altTheta({pa,oat});p.orient(scale(E6B,'temp-alt').at(oat),'the altitude-correction window');
  p.add({kind:'disc',theta},`Turn blue PA ${pa/1000} to meet black ${oat} °C in ALTITUDE CORRECTION.`,[{kind:'scale',scale:'pa-alt',value:pa},{kind:'scale',scale:'temp-alt',value:oat}],'Used the airspeed window or corrected all indicated altitude.','ALTITUDE CORRECTION uses blue PA and black temperature. Subtract the station elevation first.');
  p.cursor(height,'inner','ft above station');p.read('True altitude',{kind:'scale',ring:'outer',estimate:exact-station,add:station},exact,'ft',`Read true height on black, then add station elevation ${station} ft to obtain AMSL.`,scaleTolerance(exact-station)+(exact-station)*0.003);add(p);
});
[[15,0.3],[-20,0.65],[-46,0.8]].forEach(([oat,mach],n)=>{
  const exact=mach*speedOfSound(oat),p=new Path('mach',n,`${['Perth jet training','Brisbane upper-air cruise','B727 FL330 cruise'][n]}: Mach ${mach}, OAT ${oat} °C. Find TAS.`,`Speed of sound is roughly ${Math.round(speedOfSound(oat)/10)*10} kt; take ${mach} of it.`,exact,'ASA p. 20');
  p.vals={oat,mach};const theta=machTheta(oat);p.orient(E6B.index.mach,'MACH NO. INDEX');p.add({kind:'disc',theta},`Turn the disc until blue ${oat} °C is opposite black MACH NO. INDEX in the airspeed window.`,[{kind:'index',id:'mach'},{kind:'scale',scale:'temp-as',value:oat}],'Used pressure altitude instead of the Mach index.','Mach depends on absolute air temperature: bring MACH NO. INDEX into the window.');p.cursor(mach,'inner','Mach');p.read('TAS',{kind:'scale',ring:'outer',estimate:exact},exact,'kt','Read TAS on outer black. The estimate chooses hundreds of knots.',scaleTolerance(exact)+exact*0.003);add(p);
});
[[2,60,60],[5,100,150],[8,125,235]].forEach(([off,flown,remaining],n)=>{
  const parallel=60*off/flown,closing=60*off/remaining,total=parallel+closing;
  const p=new Path('offcourse',n,`${['Jandakot navigation sortie','Kalgoorlie cross-country','Broken Hill navigation exercise'][n]}: ${off} NM right of track after ${flown} NM, ${remaining} NM remaining. Find the turn left to regain track.`,`Add a parallel correction to a closing correction; both are toward the track.`,total,'ASA pp. 24–26; p.25 printed-key correction in SOURCES.md');
  p.vals={off,flown,remaining};for(const [distance,key] of [[flown,'Parallel'],[remaining,'Closing']] as const){p.align(off,distance);p.cursor(60,'inner','RATE');p.read(key,{kind:'scale',ring:'outer',estimate:60*off/distance},60*off/distance,'°',`Read ${key.toLowerCase()} correction on black at blue 60 RATE.`);}
  p.read('Turn left',{kind:'sum',keys:['Parallel','Closing']},total,'°','Add your parallel and closing readings. Turn left, toward the track; do not subtract them.',Math.max(0.2,scaleTolerance(parallel)+scaleTolerance(closing)));add(p);
});
for(const operation of ['windhdg','jet'] as const)(operation==='jet'?[[90,400,270,40],[85,450,310,65],[110,480,250,100]]:[[90,120,270,15],[135,145,210,25],[270,175,320,40]]).forEach(([tc,tas,from,speed],n)=>{
  const end=operation==='jet'?'high':'low',slide=end==='high'?HIGH_SPEED_SLIDE:SLIDE,exact=solveHeading(tc,tas,from,speed);
  const p=new Path(operation,n,`${operation==='jet'?'B727 Nullarbor cruise':'Australian cross-country leg'} ${n+1}: TC ${tc}°T, TAS ${tas} kt, wind ${from}°T/${speed} kt. Find heading and ground speed.`,`Sketch wind from ${from}°: predict drift direction and whether GS exceeds ${tas} kt.`,exact.gs,'ASA pp. 28–31; high-speed 10-kt convention p.28');
  p.vals={tc,tas,from,speed};p.add({kind:'slide-end',end},`Select the ${end==='high'?'high-speed slide (10 kt lines)':'low-speed slide (2 kt lines)'}.`,[],'Read high-speed knots on the low-speed slide.','Check the slide end and count the printed arc intervals before marking wind.');
  p.add({kind:'plate',bearing:from},`Turn the clear plate until wind FROM ${from}°T is under TRUE INDEX.`,[{kind:'wind',id:'index'}],'Set the direction the wind blows toward.','Reported wind is FROM; do not add 180°.');
  p.add({kind:'dot',dot:windDot(from,speed,slide)},`With the grommet at ${p.pose.wind.gs} kt, mark ${speed} kt up the centre line: ${f(speed/slide.arcStepKt)} printed intervals.`,[{kind:'wind',id:'dot'}],'Counted one knot per printed line.','Read the arc interval for this slide end, then count upwards from the grommet.');
  p.add({kind:'plate',bearing:tc},`Turn the plate until true course ${tc}°T is under TRUE INDEX; keep the pencil dot.`,[{kind:'wind',id:'index'}],'Erased or moved the dot while changing course.','The wind dot stays attached to the clear plate.');
  p.add({kind:'fit-tas',tas},`Slide the grid until the dot lies on the ${tas} kt TAS arc.`,[{kind:'arc',value:tas}],'Put TAS at the grommet instead of under the wind dot.','TAS goes under the dot; ground speed is read at the grommet.');
  p.read('Heading',{kind:'wind',field:'th'},exact.th,'°T',`Read the drift ray through the dot; add right drift or subtract left drift from ${tc}°T.`,end==='high'?1.5:1.2);
  p.read('Ground speed',{kind:'wind',field:'gs'},exact.gs,'kt','Read the speed arc under the grommet, not the wind dot.',end==='high'?5:2);add(p);
});
[[95,90,120,130],[160,180,140,120],[285,270,180,155]].forEach(([th,tc,tas,gs],n)=>{
  const wca=turn(th-tc),exact=solveWind(th,tc,tas,gs),u=U,point={x:tas*u*Math.sin(wca*Math.PI/180),y:gs*u-tas*u*Math.cos(wca*Math.PI/180)};
  const p=new Path('windfind',n,`${['Perth coastal fix','Canberra timed leg','Northern Territory navigation exercise'][n]}: TH ${th}°T, TC ${tc}°T, TAS ${tas} kt, GS ${gs} kt. Find wind FROM and speed.`,`The heading is ${Math.abs(wca)}° ${wca<0?'left':'right'} of track; predict which side the wind comes from.`,exact.kt,'ASA pp. 32–35');
  p.vals={th,tc,tas,gs};p.add({kind:'slide-end',end:'low'},'Select the low-speed slide (2 kt lines).');p.add({kind:'plate',bearing:tc},`Set TC ${tc}°T under TRUE INDEX.`,[{kind:'wind',id:'index'}]);p.add({kind:'slide',gs},`Slide the ${gs} kt ground-speed arc under the grommet.`,[{kind:'wind',id:'grommet'}],'Placed TAS under the grommet.','Known ground speed belongs under the grommet.');p.add({kind:'dot',dot:toPlate(point.x,point.y,tc)},`Mark the ${tas} kt TAS arc at ${Math.abs(wca)}° ${wca<0?'left':'right'} drift (heading minus course).`,[{kind:'wind',id:'dot'}],'Marked the reciprocal drift side.','Heading right of course means right drift ray; heading left means left ray.');p.add({kind:'dot-up'},'Turn the plate until the dot is on the centre line above the grommet.',[{kind:'wind',id:'dot'}],'Turned the dot below the grommet.','Wind is FROM: put the dot above, never below.');p.read('Wind FROM',{kind:'wind',field:'from'},exact.from,'°T','Read wind FROM at TRUE INDEX.',1.2);p.read('Wind speed',{kind:'wind',field:'kt'},exact.kt,'kt','Count knots from the grommet up to the wind dot; each printed line is 2 kt.',2);add(p);
});
[[240,270,20],[180,230,14],[210,335,27]].forEach(([runway,from,speed],n)=>{
  const angle=turn(from-runway),cross=speed*Math.sin(angle*Math.PI/180),head=speed*Math.cos(angle*Math.PI/180);
  const p=new Path('components',n,`${['Perth runway exercise','Regional WA ATIS exercise','Adelaide gust planning exercise'][n]}: runway heading ${runway}°M, ATIS wind ${from}°M/${speed} kt. Find headwind and crosswind.`,`Both directions are magnetic here. ${Math.abs(angle)}° difference; predict ${head<0?'tailwind':'headwind'} and wind from the ${cross<0?'left':'right'}.`,cross,'ASA crosswind table pp. 27–28');
  p.vals={runway,from,speed};p.read('Headwind',{kind:'component',field:'head',angle,speed},head,'kt',`On the printed component table, use ${Math.min(Math.abs(angle),180-Math.abs(angle))}° column and bracket ${speed} kt between the ten-knot rows. Interpolate the headwind entries${head<0?'; the wind is behind, so record a negative headwind (tailwind)':''}.`,0.6);
  p.read('Crosswind',{kind:'component',field:'cross',angle,speed},cross,'kt',`In the same table cells, interpolate crosswind. Record ${cross<0?'negative for left':'positive for right'}; do not mix true wind with magnetic runway headings.`,0.6);add(p);
});
export const E6B_PROCEDURES:ReadonlyArray<ProcedureExercise>=all;
export const PROCEDURES_BY_OPERATION:ReadonlyMap<Operation,ProcedureExercise[]>=new Map((Object.keys(OPERATION_NAMES) as Operation[]).map(op=>[op,all.filter(p=>p.operation===op)]));
export const exercisesFor=(operation:Operation):ProcedureExercise[]=>PROCEDURES_BY_OPERATION.get(operation)??[];
export function problemForProcedure(p:ProcedureExercise):Problem {return {shape:p.shape,easy:p.level==='easy',stem:p.scenario,givens:[],unit:p.answer.unit,demo:p.demo,key:p.answer,time:p.answer.unit==='min',slips:[]};}
export function procedureDiagnosis(p:ProcedureExercise,pose:Pose & {viewAngle?:number}):string {
  const last=[...p.procedure].reverse().find(s=>s.physical.kind==='read');
  if(last?.demoStep.wind && (pose.wind.slide??'low')!==(last.demoStep.wind.slide??'low'))return 'Select the slide end used for this construction before reading it.';
  const missed=last?.goals.find(g=>!goalMet(g,pose));
  const action=missed?[...p.procedure].reverse().find(s=>s.physical.kind===missed.kind):null;
  return action?.correction??'Keep the alignment. Check which colour you read, then compare the decimal place with your estimate.';
}
