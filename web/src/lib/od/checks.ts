import { FLEET, tripPlan, alternatePlan, holdingFuelKg, requiredFuelKg, runwayDistanceM, pressureAltitudeFt, densityAltitudeFt, crosswindKt, canDispatchMel } from './manual';
import { covers, forecastWindow, freezingLevelFt, metarConditions } from './weather';
import type { Dossier, Edition, RuleResult, Alternate } from './model';

const M = 60_000, H = 60*M;
export const pass = (detail = 'Requirement met'): RuleResult => ({ status: 'pass', detail });
export const fail = (detail: string): RuleResult => ({ status: 'fail', detail });
export const unknown = (detail: string): RuleResult => ({ status: 'unavailable', detail });
const test = (ok: boolean, detail: string) => ok ? pass(detail) : fail(detail);
function pair(edition: Edition): asserts edition is 'aus' | 'us' {
  if (edition !== 'aus' && edition !== 'us') throw new RangeError('Unsupported edition');
}
export function coverageWindow(edition: Edition): [number, number] {
  pair(edition);
  return edition === 'aus' ? [30,60] : [60,60];
}
export function selectedAlternate(d: Dossier): Alternate | undefined { return d.alternatives.find(a => a.aerodrome.id === d.plan.alternateId); }
export function masses(d: Dossier) {
  const payload = d.documents.passengerManifest.passengerMassKg + d.documents.passengerManifest.baggageKg;
  const takeoff = d.plan.dryOperatingKg + payload + d.plan.fuelKg;
  return { takeoff, landing: takeoff-tripPlan(d.aircraft,d.plan.distanceNm,d.plan.cruiseLevel,d.plan.headwindKt).fuelKg };
}
export function fuelRequired(d: Dossier, edition: Edition) {
  pair(edition);
  const turbine = d.aircraft === 'a727' || d.aircraft === 'commuter';
  const commercial = d.operation !== 'private';
  const reserve = edition === 'us' ? d.plan.rules === 'VFR' && !d.plan.night && d.operation!=='airline' ? 30 : 45
    : turbine ? 30 : d.plan.rules === 'VFR' && !d.plan.night && !commercial ? 30 : 45;
  const fuel = requiredFuelKg({ aircraft:d.aircraft, distanceNm:d.plan.distanceNm, cruiseLevel:d.plan.cruiseLevel, headwindKt:d.plan.headwindKt,
    alternateDistanceNm:selectedAlternate(d)?.distanceNm ?? null, holdingMinutes:d.plan.holdingMinutes, finalReserveMinutes:reserve,
    contingencyPercent:edition === 'aus' ? commercial ? turbine ? 5 : 10 : turbine ? 5 : 0 : 0 });
  // AUS air transport minimum contingency; US reserves use cruise consumption,
  // whereas Australian final reserve is evaluated at holding consumption.
  if (edition === 'aus' && commercial) fuel.contingencyKg = Math.max(fuel.contingencyKg,holdingFuelKg(d.aircraft,5));
  if (edition === 'aus' && d.operation === 'airline' && !d.plan.alternateId) fuel.alternateKg = holdingFuelKg(d.aircraft,15);
  if (edition === 'us') {
    const trip = tripPlan(d.aircraft,d.plan.distanceNm,d.plan.cruiseLevel,0);
    fuel.finalReserveKg = trip.fuelKg/trip.timeMinutes*reserve;
  }
  fuel.totalKg = fuel.taxiKg+fuel.tripKg+fuel.contingencyKg+fuel.alternateKg+fuel.holdingKg+fuel.finalReserveKg;
  return fuel;
}
export function performanceDistance(d: Dossier, phase: 'takeoff'|'landing'): number | null {
  const wx = metarConditions(phase === 'takeoff' ? d.departureWeather : d.destinationWeather);
  if (!wx) return null;
  const a = phase === 'takeoff' ? d.departure : d.destination;
  const r = phase === 'takeoff' ? d.plan.departureRunway : d.plan.arrivalRunway;
  return runwayDistanceM({ aircraft:d.aircraft, phase, weightKg:masses(d)[phase === 'takeoff' ? 'takeoff':'landing'],
    flapDeg:phase === 'takeoff' ? d.plan.takeoffFlap:d.plan.landingFlap, runwayState:r.state,
    pressureAltitudeFt:pressureAltitudeFt(a.elevationFt,wx.qnhHpa),temperatureC:wx.temperatureC });
}
export function suitableAlternate(d: Dossier, edition: Edition): boolean {
  pair(edition);
  const a=selectedAlternate(d);
  if (!a || a.aerodrome.id===d.destination.id || a.distanceNm<=0) return false;
  const diversionMinutes=alternatePlan(d.aircraft,a.distanceNm,Math.max(0,d.plan.headwindKt)).timeMinutes;
  const eta=Date.parse(d.plan.arrivalUtc)+diversionMinutes*M;
  // 91.169(c) assesses the US alternate at its ETA, not the destination's
  // 1-2-3 window. The AUS Code retains the broader forecast-use buffer.
  const groups=forecastWindow(a.weather,eta-(edition==='aus'?30:0)*M,eta+(edition==='aus'?60:0)*M);
  if (!groups?.length || a.runway.state==='contaminated' && !a.runway.inspected) return false;
  if (groups.some(g=>g.cond.ts || (g.cond.ceilingFt??Infinity)<a.minima.ceilingFt || (g.cond.visM??0)<a.minima.visibilityM)) return false;
  const winds=groups.flatMap(g=>{
    const m=/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(g.body);
    if(!m)return [];
    const speed=Math.max(Number(m[2]),Number(m[3]??0));
    return [m[1]==='VRB'?speed:crosswindKt(a.runway.headingTrueDeg,Number(m[1]),speed)];
  });
  if(!winds.length||winds.some(w=>w>FLEET[d.aircraft].crosswindLimitsKt[a.runway.state]))return false;
  if (d.documents.notams.some(n=>n.aerodromeId===a.aerodrome.id && n.runwayId===a.runway.id && n.closed && Date.parse(n.from)<=eta && eta<Date.parse(n.to))) return false;
  // Alternate performance is recomputed with the same payload and fuel, less
  // trip + diversion burn. A conservative destination mass avoids double credit.
  const copy=structuredClone(d); copy.destination=a.aerodrome; copy.destinationWeather=a.weather; copy.plan.arrivalRunway=a.runway;
  try { const distance=performanceDistance(copy,'landing'); return distance!==null && distance<=a.runway.lengthM; } catch { return false; }
}
export function coverage(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  const [before,after]=coverageWindow(edition);
  return test(covers(d.destinationWeather,Date.parse(d.plan.arrivalUtc),before,after),`Destination forecast must cover ETA −${before}/+${after} min (Code planning scope).`);
}
function conditions(d: Dossier, edition: Edition) {
  // Part 91 MOS 8.04(1): adverse periods expand by 30 min at each end.
  // This is distinct from 7.02(6)'s forecast coverage of ETA −30/+60.
  const eta=Date.parse(d.plan.arrivalUtc), buffer=edition==='us'?60:30;
  return forecastWindow(d.destinationWeather,eta-buffer*M,eta+buffer*M);
}
function thresholds(d: Dossier, edition: Edition) {
  if(edition==='aus') return d.plan.alternateMinima;
  if(d.operation==='charter') return {ceilingFt:Math.max(2000,d.plan.landingMinima.ceilingFt+1500),visibilityM:Math.max(3*1609.344,d.plan.landingMinima.visibilityM+2*1609.344)};
  return {ceilingFt:2000,visibilityM:3*1609.344};
}
export function alternateCheck(d: Dossier, edition: Edition, overlays: boolean): RuleResult {
  pair(edition);
  // Missing coverage is solely decree 1's evidence, not duplicate assessment.
  if(coverage(d,edition).status!=='pass') return {status:'blocked',blockedBy:'forecast-coverage',detail:'Requires forecast-coverage to pass first.'};
  if(d.plan.rules==='VFR') return pass('VFR weather is assessed separately.');
  const groups=conditions(d,edition); if(!groups) return unknown('Forecast cannot be interpreted.');
  // Nomination is a commitment even when optional: US 91.169(c), and a
  // conservative Code requirement in the AUS edition.
  if(!overlays&&d.plan.alternateId&&!suitableAlternate(d,edition))return fail('The nominated alternate is unsuitable at diversion arrival.');
  const minima=thresholds(d,edition);
  const relevant=groups.filter(g=>overlays===!['base','FM','BECMG'].includes(g.kind));
  const low=relevant.filter(g=>(g.cond.ceilingFt??Infinity)<minima.ceilingFt || (g.cond.visM??0)<minima.visibilityM);
  const required=low.length>0 || !overlays && (!d.plan.instrumentApproach || edition==='aus' && d.operation==='airline');
  if(!required) return pass('No alternate trigger in this group class.');
  if(suitableAlternate(d,edition)) return pass('Suitable alternate nominated.');
  if(edition==='aus' && d.operation!=='airline' && overlays && low.every(g=>g.change!==null)) {
    const hold=Math.max(...low.map(g=>g.change==='INTER'?30:60));
    if(d.plan.holdingMinutes>=hold) return pass(`${hold} minutes holding planned in lieu.`);
  }
  return fail(edition==='us'?'Alternate required by the applicable US ceiling/visibility window.':'Below the stated alternate minima: nominate a suitable alternate or qualifying holding.');
}
export function crosswind(d: Dossier): RuleResult {
  const dep=metarConditions(d.departureWeather);if(!dep)return unknown('Departure wind unavailable.');
  const arrival=forecastWindow(d.destinationWeather,Date.parse(d.plan.arrivalUtc),Date.parse(d.plan.arrivalUtc));
  // Decree 1 owns missing coverage; do not attribute it again to crosswind.
  const winds=arrival?.flatMap(g=>{
    const m=/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(g.body);
    return m?[{windFromTrueDeg:m[1]==='VRB'?null:Number(m[1]),windKt:Math.max(Number(m[2]),Number(m[3]??0))}]:[];
  })??[];
  if(arrival && !winds.length)return unknown('Arrival forecast wind unavailable.');
  for(const [wx,r] of [[dep,d.plan.departureRunway],...winds.map(w=>[w,d.plan.arrivalRunway] as const)] as const) {
    const component=wx.windFromTrueDeg===null?wx.windKt:crosswindKt(r.headingTrueDeg,wx.windFromTrueDeg,wx.windKt);
    if(component>FLEET[d.aircraft].crosswindLimitsKt[r.state]+1e-9) return fail(`Crosswind ${component.toFixed(1)} kt exceeds the ${r.state} teaching limit.`);
  }
  return pass('Both runway crosswinds within limits, including gusts.');
}
export function icing(d: Dossier): RuleResult {
  if(!d.documents.technicalLog.defects.includes('antiIce') && !['trainer','club-single'].includes(d.aircraft)) return pass();
  if(!d.plan.cloudExposure) return pass('No cloud exposure on the stipulated route.');
  const levels=[freezingLevelFt(d.departureWeather,Date.parse(d.plan.departureUtc)),freezingLevelFt(d.destinationWeather,Date.parse(d.plan.arrivalUtc))];
  if(levels.some(n=>n===null)) return unknown('Both endpoint profiles are required for the stipulated cloud-exposure proxy.');
  const potentialIce=d.plan.cruiseLevel*100>=Math.min(...levels as number[]);
  return test(!potentialIce,'Stipulated cloud exposure at/above either endpoint freezing level is prohibited with this icing capability; this is not a route icing forecast.');
}
export function thunderstorms(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  if(coverage(d,edition).status!=='pass') return {status:'blocked',blockedBy:'forecast-coverage',detail:'Requires forecast-coverage to pass first.'};
  const groups=conditions(d,edition); if(!groups) return unknown('Forecast unavailable.');
  const ts=groups.filter(g=>g.cond.ts); if(!ts.length) return pass();
  // A Code restriction in both editions; fuel permits waiting, never penetration.
  const eta=Date.parse(d.plan.arrivalUtc), to=Date.parse(d.destinationWeather.taf!.to);
  const hold=Math.max(...ts.map(g=>g.change==='INTER'?30:g.change==='TEMPO'?60:g.end>=to?Infinity:Math.max(0,(g.end-eta)/M+30)));
  return test(d.plan.holdingMinutes>=hold,`Thunderstorm: plan ${Number.isFinite(hold)?hold:'an end to'} minutes of waiting, or delay beyond the forecast event.`);
}
export function fuel(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  const needed=fuelRequired(d,edition).totalKg;
  return test(d.plan.fuelKg+1e-6>=needed && d.plan.fuelKg<=FLEET[d.aircraft].maxFuelKg,`Usable fuel ${d.plan.fuelKg.toFixed(1)} kg; required ${needed.toFixed(1)} kg.`);
}
/** Acclimatised, unaugmented lineholder table; extensions excluded. */
export function usFdpHours(hour: number, sectors: number): number {
  const rows:[number,number[]][]=[[4,[9,9,9,9,9,9,9]],[5,[10,10,10,10,9,9,9]],[6,[12,12,12,12,11.5,11,10.5]],[7,[13,13,12,12,11.5,11,10.5]],[12,[14,14,13,13,12.5,12,11.5]],[13,[13,13,13,13,12.5,12,11.5]],[17,[12,12,12,12,11.5,11,10.5]],[22,[12,12,11,11,10,9,9]],[23,[11,11,10,10,9,9,9]],[24,[10,10,10,9,9,9,9]]];
  if(!Number.isFinite(hour)||hour<0||hour>=24||!Number.isInteger(sectors)||sectors<1) throw new RangeError('Invalid duty start/sectors');
  return rows.find(([end])=>hour<end)![1][Math.min(7,sectors)-1];
}
export function duty(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  const r=d.documents.duty, duration=(Date.parse(r.endUtc)-Date.parse(r.startUtc))/H;
  if(d.operation==='private') return test(r.scheme==='private','Private flight: no commercial duty-table claim.');
  if(!r.acclimatised) return unknown('Unacclimatised duty is outside this exercise.');
  if(edition==='aus') {
    if(r.scheme!=='au-basic') return unknown('Australian exercise requires Appendix 1 Basic Limits.');
    const limit=r.startLocalHour<6||r.startLocalHour>=14?8:9;
    // The exercise stipulates the other cumulative/late-duty checks complete.
    return test(r.startLocalHour>=7 && r.startLocalHour+duration<=25 && duration<=limit && r.priorRestHours>=12 && r.sleepOpportunityHours>=8 && r.freeHoursLast168>=36,'Appendix 1: stated start/end, FDP, home-base rest and weekly rest must all fit.');
  }
  if(d.operation==='charter') return test(r.scheme==='us-135' && duration<=14 && r.priorRestHours>=10 && r.flightMinutes<=(d.documents.crew.length>=2?600:480),'Part 135 unscheduled teaching roster: flight time and stipulated 14-hour duty/rest pattern.');
  return test(r.scheme==='us-117' && duration<=usFdpHours(r.startLocalHour,r.sectors) && r.flightMinutes<=(r.startLocalHour>=5&&r.startLocalHour<20?540:480) && r.priorRestHours>=10 && r.sleepOpportunityHours>=8 && r.freeHoursLast168>=30,'Part 117: FDP by start/sectors, flight time, 10-hour rest, 8-hour sleep and 30-hour weekly break.');
}
export function distance(d: Dossier, phase:'takeoff'|'landing'): RuleResult {
  const mass=masses(d)[phase==='takeoff'?'takeoff':'landing'], sheet=FLEET[d.aircraft];
  if(mass>(phase==='takeoff'?sheet.maxTakeoffKg:sheet.maxLandingKg)) return fail(`${phase} mass exceeds the teaching limit.`);
  const required=performanceDistance(d,phase); if(required===null) return unknown('Performance weather missing.');
  const r=phase==='takeoff'?d.plan.departureRunway:d.plan.arrivalRunway;
  return test(r.lengthM>=required,`${phase}: ${required} m required; ${r.lengthM} m available (teaching dispatch distances).`);
}
export function contaminated(d: Dossier): RuleResult {
  return test([d.plan.departureRunway,d.plan.arrivalRunway].every(r=>r.contaminationMm>=0 && (r.state!=='contaminated'||r.inspected && r.contaminationMm<=3)),'Contaminated runway needs an inspection and no more than 3 mm under the fictional Code.');
}
export function density(d: Dossier): RuleResult {
  const wx=metarConditions(d.departureWeather); if(!wx) return unknown('Pressure/temperature missing.');
  const da=densityAltitudeFt(pressureAltitudeFt(d.departure.elevationFt,wx.qnhHpa),wx.temperatureC);
  return test(Math.abs(d.plan.plannedDensityAltitudeFt-da)<=100,`Density altitude ${Math.round(da)} ft; worksheet tolerance 100 ft.`);
}
export function mel(d: Dossier): RuleResult {
  const t=d.documents.technicalLog; if(!t.defects.length) return pass();
  if(!t.melAuthorised||!t.placarded||!t.dispatchProcedureComplete) return fail('Deferral authority, placard and procedure are all required.');
  for(const defect of t.defects) {
    if(defect==='antiIce') continue; // Assessed once by decree 5.
    if(!canDispatchMel(d.aircraft,defect,{flightLevel:d.plan.cruiseLevel,passengerCount:d.documents.passengerManifest.names.length,ifr:d.plan.rules==='IFR',pilotCount:d.documents.crew.length,externalPower:t.externalPower,externalAir:t.externalAir}))return fail(`${defect}: teaching MEL conditions not met.`);
  }
  return pass('All interacting MEL conditions satisfied.');
}
export function licence(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  const at=Date.parse(d.plan.departureUtc);
  return test(d.documents.crew.length>0 && d.documents.crew.every(c=>{
    const privileges=d.operation==='airline'?c.licence==='atp':d.operation==='charter'?['atp','commercial'].includes(c.licence):true;
    const medical=edition==='aus'?(d.operation!=='private'?c.medical.class===1:c.medical.class<=2)
      :d.operation==='airline'?c.medical.class===1:d.operation==='charter'?c.medical.class<=2:true;
    return privileges && medical && c.aircraftRatings.includes(d.aircraft) && (d.plan.rules==='VFR'||c.instrumentRated) && Date.parse(c.medical.validUntil)>=at && Date.parse(c.flightReviewValidUntil)>=at;
  }),'Each crew member needs the stipulated privileges, rating, review and medical validity.');
}
export function recency(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  if(!d.documents.passengerManifest.names.length) return pass('No passenger carriage.');
  const at=Date.parse(d.plan.departureUtc), since=at-90*24*H, c=d.documents.crew[0];
  if(!c) return fail('No pilot in command.');
  const takeoffs=c.takeoffs.filter(e=>Date.parse(e.at)>=since&&Date.parse(e.at)<at&&(!d.plan.night||e.night));
  const landings=c.landings.filter(e=>Date.parse(e.at)>=since&&Date.parse(e.at)<at&&(!d.plan.night||e.night&& (edition==='aus'||e.fullStop)));
  return test(takeoffs.length>=3&&landings.length>=3,`Three take-offs and landings in 90 days${d.plan.night&&edition==='us'?', night full-stop landings':''}; no check exemptions in this exercise.`);
}
export function maintenance(d: Dossier): RuleResult {
  const m=d.documents.maintenanceRelease;
  return test(m.signed && Date.parse(m.validUntil)>=Date.parse(d.plan.arrivalUtc) && m.nextInspectionHours>=m.airframeHours+tripPlan(d.aircraft,d.plan.distanceNm,d.plan.cruiseLevel,d.plan.headwindKt).timeMinutes/60 && d.documents.technicalLog.defects.every(x=>m.endorsedDefects.includes(x)),'Release/current inspection and recorded defects must cover the flight.');
}
export function notams(d: Dossier): RuleResult {
  return test(d.documents.notams.every(n=>{
    const departure=n.aerodromeId===d.departure.id, arrival=n.aerodromeId===d.destination.id;
    if(!departure&&!arrival) return true;
    const at=Date.parse(departure?d.plan.departureUtc:d.plan.arrivalUtc), runway=departure?d.plan.departureRunway:d.plan.arrivalRunway;
    return n.acknowledged && !(n.closed&&n.runwayId===runway.id&&Date.parse(n.from)<=at&&at<Date.parse(n.to));
  }),'Relevant NOTAMs must be reviewed and the selected runway open.');
}
export function vfr(d: Dossier, edition: Edition): RuleResult {
  pair(edition);
  if(d.plan.rules!=='VFR') return pass();
  if(d.plan.cruiseLevel>=100) return unknown('VMC exercise is Class C below 10,000 ft only.');
  const groups=forecastWindow(d.destinationWeather,Date.parse(d.plan.arrivalUtc),Date.parse(d.plan.arrivalUtc));
  if(!groups) return unknown('VFR forecast unavailable.');
  const c=d.plan.cloudClearance;
  return test(groups.every(g=>(g.cond.visM??0)>=(edition==='aus'?5000:3*1609.344)) && c.aboveFt>=1000 && c.belowFt>=(edition==='aus'?1000:500) && c.horizontalM>=(edition==='aus'?1500:609.6),'Class C VMC: visibility and all stipulated cloud separations must meet this edition.');
}
export function manifest(d: Dossier): RuleResult {
  const m=d.documents.passengerManifest, c=d.documents.crew[0];
  return test(m.names.length+d.documents.crew.length<=FLEET[d.aircraft].seats && (!m.names.length||c?.licence!=='student') && (!m.paid||d.operation!=='private'),'Manifest fits the seats and passenger/paid-carriage privileges.');
}
