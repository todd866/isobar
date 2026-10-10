import { AERODROMES } from './aerodromes';
import { DECREES, decree, editionVariant, ruleStrand } from './decrees';
import { FLEET, densityAltitudeFt, pressureAltitudeFt, runwayDistanceM, tripPlan, type AircraftId } from './manual';
import { fuelRequired, performanceDistance, suitableAlternate } from './checks';
import { evaluateDossier } from './judge';
import { forecastGroups, metarConditions } from './weather';
import {STRANDS} from '../../../../training/src/levels';
import type { Aerodrome, Decision, Dossier, Edition, Runway, Strand, WeatherReport } from './model';

const M=60_000,H=60*M;
const clocks=new Map(AERODROMES.map(a=>[a.zone,new Intl.DateTimeFormat('en-AU',{timeZone:a.zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]));
function localClock(at:string,zone:string):string {const clock=clocks.get(zone);if(!clock)throw new RangeError('Unsupported aerodrome zone');return clock.format(new Date(at));}
export interface GenerateInput {
  seed:number; edition:Edition; difficulty:number; strand:Strand;
  reports:readonly WeatherReport[]; decreeId?:string; shift?:number;
  polarity?:'pass'|'fail'; aircraft?:AircraftId;
}
export type Generated = {kind:'ready';dossier:Dossier;intent:{violations:string[];decision:Decision}}
  | {kind:'unavailable';reason:string;decreeId:string};
function rngFor(seed:number) {let x=seed>>>0;return()=>{x=(x+0x6D2B79F5)|0;let t=Math.imul(x^(x>>>15),1|x);t^=t+Math.imul(t^(t>>>7),61|t);return((t^(t>>>14))>>>0)/4294967296;};}
function rotated<T>(rows:readonly T[],rng:()=>number):T[] {const start=Math.floor(rng()*rows.length);return [...rows.slice(start),...rows.slice(0,start)];}
function runway(a:Aerodrome,weather:WeatherReport,worst=false):Runway {
  const w=metarConditions(weather);
  const ordered=[...a.runways].sort((a,b)=>{
    const component=(h:number)=>w?.windFromTrueDeg===null?1:Math.abs(Math.sin(((w?.windFromTrueDeg??0)-h)*Math.PI/180));
    return component(a.headingTrueDeg)-component(b.headingTrueDeg);
  });
  const r=ordered[worst?ordered.length-1:0];
  return {...r,state:'dry',contaminationMm:0,inspected:true};
}
const add=(at:string,minutes:number)=>new Date(Date.parse(at)+minutes*M).toISOString();
function question(d:Dossier):string {
  const local=localClock(d.plan.arrivalUtc,d.destination.zone);
  return `You are dispatching ${FLEET[d.aircraft].name} from ${d.departure.name} to ${d.destination.name}, arriving ${d.plan.arrivalUtc.slice(11,16)}Z (${local} local); can you release this flight under the ${d.edition==='aus'?'Australian':'US'} edition of the Code?`;
}
function fingerprint(d:Dossier):string {let h=2166136261;for(const c of JSON.stringify(d)){h=Math.imul(h^c.charCodeAt(0),16777619);}return(h>>>0).toString(16);}

/** Build a clean fictional plan against immutable supplied weather. It is
 * deliberately exported for authored scenarios and independent regression tests. */
export function draftDossier(input:{edition:Edition;aircraft:AircraftId;departure:Aerodrome;destination:Aerodrome;departureWeather:WeatherReport;destinationWeather:WeatherReport;arrivalUtc:string;difficulty:number;seed:number;decreeId:string;shift:number}):Dossier {
  const sheet=FLEET[input.aircraft],r=decree(input.decreeId),random=rngFor(input.seed);
  const distance=sheet.tripRows[0].distanceNm;
  const cruiseLevel=sheet.cruiseLevels[Math.min(sheet.cruiseLevels.length-1,Math.max(0,Math.floor(input.difficulty)))];
  const headwind=input.difficulty>=1.5?Math.floor(random()*20):0;
  const trip=tripPlan(input.aircraft,distance,cruiseLevel,headwind);
  const departureUtc=add(input.arrivalUtc,-trip.timeMinutes);
  const startUtc=add(departureUtc,-60);
  const startLocalHour=Number(localClock(startUtc,input.departure.zone).slice(0,2));
  const pilotCount=input.aircraft==='a727'||input.aircraft==='commuter'?2:1;
  const pilotLicence=input.aircraft==='a727'?'atp' as const:input.aircraft==='trainer'||input.aircraft==='club-single'?'private' as const:'commercial' as const;
  const credential={licence:pilotLicence,aircraftRatings:[input.aircraft],instrumentRated:true,
    medical:{class:1 as const,validUntil:add(input.arrivalUtc,60*24*365)},flightReviewValidUntil:add(input.arrivalUtc,60*24*365),
    landings:[1,2,3].map(n=>({at:add(departureUtc,-n*24*60),night:true,fullStop:true})),takeoffs:[1,2,3].map(n=>({at:add(departureUtc,-n*24*60),night:true}))};
  const wx=metarConditions(input.departureWeather);
  if(!wx)throw new RangeError('Departure METAR cannot support the exercise');
  const pressure=Math.floor(random()*4);
  const localArrival=localClock(input.arrivalUtc,input.destination.zone);
  const d:Dossier={id:`od-${input.edition}-${input.seed}-${r.id}`,edition:input.edition,shift:input.shift,
    question:`You are dispatching ${sheet.name} from ${input.departure.name} to ${input.destination.name}, arriving ${input.arrivalUtc.slice(11,16)}Z (${localArrival} local); can you release this flight under the ${input.edition==='aus'?'Australian':'US'} edition of the Code?`,
    target:{decreeIds:[r.id],strand:ruleStrand(r,input.edition),difficulty:input.difficulty},aircraft:input.aircraft,operation:'private',
    departure:structuredClone(input.departure),destination:structuredClone(input.destination),departureWeather:structuredClone(input.departureWeather),destinationWeather:structuredClone(input.destinationWeather),alternatives:[],
    plan:{rules:input.aircraft==='trainer'?'VFR':'IFR',night:false,departureUtc,arrivalUtc:input.arrivalUtc,distanceNm:distance,cruiseLevel,headwindKt:headwind,fuelKg:0,holdingMinutes:0,alternateId:null,dryOperatingKg:sheet.emptyKg,
      takeoffFlap:sheet.flaps.takeoff.at(-1)!,landingFlap:sheet.flaps.landing.at(-1)!,departureRunway:runway(input.departure,input.departureWeather),arrivalRunway:runway(input.destination,input.destinationWeather),
      landingMinima:{ceilingFt:300,visibilityM:1000},alternateMinima:{ceilingFt:800,visibilityM:4000},instrumentApproach:true,
      cloudClearance:{aboveFt:1500,belowFt:1500,horizontalM:2000},plannedDensityAltitudeFt:densityAltitudeFt(pressureAltitudeFt(input.departure.elevationFt,wx.qnhHpa),wx.temperatureC),cloudExposure:false},
    documents:{crew:Array.from({length:pilotCount},(_,i)=>({...structuredClone(credential),id:`crew-${i+1}`})),
      duty:{scheme:'private',startUtc,startLocalHour,acclimatised:true,endUtc:add(input.arrivalUtc,30),sectors:1,flightMinutes:trip.timeMinutes,priorRestHours:14,sleepOpportunityHours:9,freeHoursLast168:48},
      technicalLog:{defects:[],melAuthorised:true,placarded:true,externalPower:true,externalAir:true,dispatchProcedureComplete:true},
      maintenanceRelease:{signed:true,validUntil:add(input.arrivalUtc,60*24*10),airframeHours:2000,nextInspectionHours:2050,endorsedDefects:[]},
      passengerManifest:{names:['S. Merin'],passengerMassKg:75,baggageKg:5,paid:false},notams:[]},
    pressure:{kind:(['none','captain','ministry','quota'] as const)[pressure],line:['The desk clock advances.','The captain asks you to sign before reading the weather.','The Ministry passenger is already waiting.','The on-time ledger has one space left.'][pressure],rebelHook:random()<0.15?random()<0.5?'border-diversion':'manifest-note':null}};
  balance(d,input.edition);
  return d;
}
function balance(d:Dossier,edition:Edition,fillFuel=true) {
  if(fillFuel)d.plan.fuelKg=Math.ceil(fuelRequired(d,edition).totalKg+5);
  const sheet=FLEET[d.aircraft],trip=tripPlan(d.aircraft,d.plan.distanceNm,d.plan.cruiseLevel,d.plan.headwindKt),payload=d.documents.passengerManifest.passengerMassKg+d.documents.passengerManifest.baggageKg;
  // Ballast is explicit in dry operating mass; keeps the exercise within the
  // published teaching weight rows without pretending missing data is zero.
  d.plan.dryOperatingKg=Math.max(sheet.emptyKg,sheet.runway.takeoff[0].weightKg+20-d.plan.fuelKg-payload,sheet.runway.landing[0].weightKg+trip.fuelKg+20-d.plan.fuelKg-payload);
}
function setDefect(d:Dossier,item:Dossier['documents']['technicalLog']['defects'][number]) {d.documents.technicalLog.defects=[item];d.documents.maintenanceRelease.endorsedDefects=[item];}

function trigger(d:Dossier,id:string,difficulty:number):void {
  switch(id) {
    case 'forecast-coverage': {
      const delta=(Date.parse(d.destinationWeather.taf!.to)-Date.parse(d.plan.arrivalUtc))/M-30;
      d.plan.arrivalUtc=add(d.plan.arrivalUtc,delta);d.plan.departureUtc=add(d.plan.departureUtc,delta);break;
    }
    case 'destination-alternate':case 'forecast-groups':d.plan.alternateId=null;d.plan.holdingMinutes=0;break;
    case 'crosswind':d.plan.departureRunway=runway(d.departure,d.departureWeather,true);d.plan.departureRunway.state='contaminated';d.plan.departureRunway.contaminationMm=1;break;
    case 'icing':setDefect(d,'antiIce');d.plan.cloudExposure=true;break;
    case 'thunderstorms':d.plan.holdingMinutes=0;break;
    case 'fuel':d.plan.fuelKg=Math.max(0,fuelRequired(d,d.edition).totalKg-(difficulty>=1.5?1:30));break;
    case 'duty': {
      const duty=d.documents.duty;
      duty.endUtc=add(duty.startUtc,d.edition==='aus'?10*60:15*60);break;
    }
    case 'takeoff-distance':d.plan.departureRunway.lengthM=(performanceDistance(d,'takeoff')??0)-(difficulty>=1.5?1:150);break;
    case 'landing-distance':d.plan.arrivalRunway.lengthM=(performanceDistance(d,'landing')??0)-(difficulty>=1.5?1:150);break;
    case 'contaminated-runway':d.plan.departureRunway.state='contaminated';d.plan.departureRunway.contaminationMm=4;break;
    case 'density-altitude':d.plan.plannedDensityAltitudeFt+=difficulty>=1.5?101:1000;break;
    case 'mel':setDefect(d,'autopilot');d.documents.technicalLog.placarded=false;break;
    case 'licence-medical':d.documents.crew[0].medical.validUntil=add(d.plan.departureUtc,-1);break;
    case 'passenger-recency':d.documents.crew[0].landings=d.documents.crew[0].landings.slice(0,2);break;
    case 'maintenance-release':d.documents.maintenanceRelease.signed=false;break;
    case 'notams':d.documents.notams=[{id:'R001/26',aerodromeId:d.departure.id,from:add(d.plan.departureUtc,-30),to:add(d.plan.departureUtc,45),runwayId:d.plan.departureRunway.id,closed:true,acknowledged:true}];break;
    case 'vfr':d.plan.rules='VFR';d.plan.cloudClearance.belowFt=d.edition==='aus'?900:400;break;
    case 'manifest':d.documents.passengerManifest.paid=true;break;
    default:throw new RangeError('No scenario template');
  }
}

/** Bounded rejection sampling over real input weather. Difficulty controls
 * arithmetic scaffolding and distance to the decision boundary; it never
 * changes legal thresholds. Unavailable scenarios are dropped, not fabricated. */
export function generateDossier(input:GenerateInput):Generated {
  if(!Number.isInteger(input.seed)||!Number.isFinite(input.difficulty)||input.difficulty< -4||input.difficulty>4)throw new RangeError('Invalid seed/difficulty');
  if(input.edition==='easa'||input.edition==='ca')return {kind:'unavailable',reason:`${input.edition==='ca'?'CAN':'EASA'} has no playable dossier yet`,decreeId:input.decreeId??'none'};
  if(input.edition!=='aus'&&input.edition!=='us')throw new RangeError('Unsupported edition');
  if(!STRANDS.includes(input.strand))throw new RangeError('Unsupported scheduler strand');
  const rng=rngFor(input.seed);
  const pool=DECREES.filter(r=>ruleStrand(r,input.edition)===input.strand && (!input.shift||r.shiftIntroduced<=input.shift));
  const target=input.decreeId?decree(input.decreeId):pool[Math.floor(rng()*pool.length)];
  if(!target||ruleStrand(target,input.edition)!==input.strand)throw new RangeError('No decree for scheduler target');
  const shift=input.shift??Math.max(target.shiftIntroduced,DECREES.length);
  if(!Number.isInteger(shift)||shift<target.shiftIntroduced||shift>DECREES.length)throw new RangeError('Decree not introduced');
  const bad=input.polarity?input.polarity==='fail':rng()<0.5;
  const preferred:AircraftId=input.aircraft??(['vfr'].includes(target.id)?'club-single':input.difficulty< -0.5?'club-single':input.difficulty<0.5?'piston-twin':input.difficulty<1.5?'commuter':'a727');
  const unique=new Map<string,WeatherReport>();
  for(const w of input.reports)if(w?.metar&&w?.taf&&AERODROMES.some(a=>a.station===w.station)&&forecastGroups(w)&&metarConditions(w)&&!unique.has(w.station))unique.set(w.station,w);
  const stations=rotated([...unique.values()],rng);
  const targetWeather=stations.filter(w=>{
    const g=forecastGroups(w)!;
    if(target.id==='destination-alternate')return g.some(g=>['base','FM','BECMG'].includes(g.kind)&&((g.cond.ceilingFt??Infinity)<(input.edition==='us'?2000:800)||(g.cond.visM??0)<(input.edition==='us'?4828.032:4000)));
    if(target.id==='forecast-groups')return g.some(g=>!['base','FM','BECMG'].includes(g.kind)&&((g.cond.ceilingFt??Infinity)<(input.edition==='us'?2000:800)||(g.cond.visM??0)<(input.edition==='us'?4828.032:4000)));
    if(target.id==='thunderstorms')return g.some(g=>g.cond.ts);
    return true;
  });
  // Clear forecasts first for paperwork/arithmetic drills. This reduces rejected
  // candidates without fabricating weather or changing seeded reproducibility.
  const hazard=(w:WeatherReport)=>forecastGroups(w)!.filter(g=>g.cond.ts||(g.cond.ceilingFt??Infinity)<2000||(g.cond.visM??0)<5000).length;
  if(!['destination-alternate','forecast-groups','thunderstorms'].includes(target.id))targetWeather.sort((a,b)=>hazard(a)-hazard(b));
  const departures=[...stations].sort((a,b)=>hazard(a)-hazard(b));
  for(const weather of targetWeather) {
    const destination=AERODROMES.find(a=>a.station===weather.station)!;
    for(const depWx of departures) {
      const departure=AERODROMES.find(a=>a.station===depWx.station)!;
      if(destination.id===departure.id)continue;
      const wx=metarConditions(depWx)!,sheet=FLEET[preferred];
      let minimumField:number;
      try { minimumField=runwayDistanceM({aircraft:preferred,phase:'takeoff',weightKg:sheet.runway.takeoff[0].weightKg,flapDeg:sheet.flaps.takeoff.at(-1)!,runwayState:'dry',pressureAltitudeFt:pressureAltitudeFt(departure.elevationFt,wx.qnhHpa),temperatureC:wx.temperatureC}); } catch { continue; }
      if(departure.runways.every(r=>r.lengthM<minimumField))continue;
      // Sample bounded arrival times after issue; retain original weather text.
      const from=Date.parse(weather.taf!.from),to=Date.parse(weather.taf!.to);
      const offsets=rotated(Array.from({length:16},(_,i)=>120+i*30),rng);
      for(const offset of offsets) {
        const eta=from+offset*M;if(eta>=to-H)continue;
        let d:Dossier;
        try {
          d=draftDossier({edition:input.edition,aircraft:preferred,departure,destination,departureWeather:depWx,destinationWeather:weather,arrivalUtc:new Date(eta).toISOString(),difficulty:input.difficulty,seed:input.seed,decreeId:target.id,shift});
          d.alternatives=stations.filter(w=>w.station!==destination.station).map(w=>{
            const a=AERODROMES.find(a=>a.station===w.station)!;
            return {aerodrome:structuredClone(a),weather:structuredClone(w),distanceNm:preferred==='trainer'?50:100,runway:runway(a,w),minima:{ceilingFt:1000,visibilityM:5000}};
          });
          // A suitable nominated alternate and an explicit waiting allocation
          // scaffold earlier decrees while the requested rule is isolated.
          for(const alt of d.alternatives) {d.plan.alternateId=alt.aerodrome.id;if(suitableAlternate(d,input.edition))break;d.plan.alternateId=null;}
          const ts=forecastGroups(weather)!.filter(g=>g.cond.ts);
          if(ts.length)d.plan.holdingMinutes=Math.max(...ts.map(g=>g.change==='INTER'?30:g.change==='TEMPO'?60:Math.max(0,(g.end-eta)/M+30)));
          if(target.id==='vfr'){d.plan.rules='VFR';d.plan.cruiseLevel=FLEET[preferred].cruiseLevels.find(fl=>fl<100)??d.plan.cruiseLevel;}
          if(target.id==='duty') {
            d.operation=preferred==='a727'||input.edition==='aus'&&preferred==='commuter'?'airline':'charter';d.plan.rules='IFR';
            d.documents.crew.forEach(c=>c.licence=d.operation==='airline'?'atp':'commercial');
            d.documents.duty.scheme=input.edition==='aus'?'au-basic':d.operation==='airline'?'us-117':'us-135';
            d.documents.duty.endUtc=add(d.documents.duty.startUtc,7*60);
          }
          if(target.id==='icing') {
            d.plan.cruiseLevel=FLEET[preferred].cruiseLevels.at(-1)!;
            const minutes=tripPlan(d.aircraft,d.plan.distanceNm,d.plan.cruiseLevel,d.plan.headwindKt).timeMinutes;
            d.plan.departureUtc=add(d.plan.arrivalUtc,-minutes);d.documents.duty.flightMinutes=minutes;
            d.documents.duty.startUtc=add(d.plan.departureUtc,-60);
            d.documents.duty.startLocalHour=Number(localClock(d.documents.duty.startUtc,d.departure.zone).slice(0,2));
          }
          if(target.id==='mel') {
            setDefect(d,'autopilot');
            if(['trainer','club-single'].includes(preferred))d.plan.rules='VFR';
            else if(d.documents.crew.length<2)d.documents.crew.push({...structuredClone(d.documents.crew[0]),id:'crew-2'});
          }
          if(target.id==='notams')d.documents.notams=[{id:'R002/26',aerodromeId:d.departure.id,from:add(d.plan.departureUtc,-90),to:add(d.plan.departureUtc,-5),runwayId:d.plan.departureRunway.id,closed:true,acknowledged:true}];
          balance(d,input.edition);
          if(bad) {
            trigger(d,target.id,input.difficulty);
            if(!['fuel','takeoff-distance','landing-distance'].includes(target.id))balance(d,input.edition);
            else if(target.id==='fuel')balance(d,input.edition,false);
          }
          const checks=evaluateDossier(d,input.edition,true);
          const failures=checks.filter(a=>a.result.status==='fail').map(a=>a.decreeId);
          if(checks.some(a=>a.result.status==='unavailable'||a.result.status==='blocked'&&!failures.includes(a.result.blockedBy??'')) || (bad ? failures.length!==1||failures[0]!==target.id:failures.length!==0))continue;
          // Weather targets must engage their intended condition even for a
          // positive example; reverse the remedy and check the rule changes.
          if(!bad) {
            const probe=structuredClone(d);trigger(probe,target.id,input.difficulty);
            if(editionVariant(target,input.edition).check(probe).status!=='fail')continue;
          }
          const decision:Decision={stamp:bad?'REFUSE':'RELEASE'};
          d.question=question(d);
          d.id+=`-${preferred}-${input.difficulty}-${bad?'fail':'pass'}-${fingerprint(d)}`;
          return {kind:'ready',dossier:d,intent:{violations:failures,decision}};
        } catch { /* Unsupported weather/performance case: try a bounded peer. */ }
      }
    }
  }
  return {kind:'unavailable',decreeId:target.id,reason:'No supplied weather and plan can isolate this decree at the requested difficulty.'};
}
