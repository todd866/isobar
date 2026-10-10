import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {DECREES,editionVariant,ruleStrand} from '../../src/lib/od/decrees';
import {generateDossier} from '../../src/lib/od/generator';
import {evaluateDossier,judge} from '../../src/lib/od/judge';
import {fuelRequired,recency,duty,usFdpHours,vfr,mel,licence,icing} from '../../src/lib/od/checks';
import {FLEET,holdingFuelKg,tripPlan,canDispatchMel,alternatePlan} from '../../src/lib/od/manual';
import {shiftPlan} from '../../src/lib/od/shifts';
import type {Edition,WeatherReport} from '../../src/lib/od/model';

/** Entirely synthetic parser/scenario fixtures. Never bundled or represented
 * as live observations; production generation requires caller-supplied data. */
function report(station:string,wind:string,groups:string):WeatherReport {
  const time=Array.from({length:9},(_,i)=>Date.parse('2026-10-09T00:00:00Z')+i*3*3600_000);
  return {station,source:'/data/aviation.json',capturedAt:'2026-10-09T00:00:00Z',
    metar:{raw:`METAR ${station} 090000Z ${wind} 9999 BKN050 15/10 Q1013`,time:'2026-10-09T00:00:00Z'},
    taf:{raw:`TAF ${station} 082300Z 0900/1000 ${wind} ${groups}`,issue:'2026-10-08T23:00:00Z',from:'2026-10-09T00:00:00Z',to:'2026-10-10T00:00:00Z'},
    profile:{icao:station,run:'2026-10-09T00:00:00Z',lat:-30,lon:120,elevationFt:100,coastKm:null,time,
      levels:[{hPa:1000,z:time.map(()=>100),t:time.map(()=>10),rh:time.map(()=>95),ws:time.map(()=>20),wd:time.map(()=>100),cc:time.map(()=>90),w:time.map(()=>0)},
        {hPa:700,z:time.map(()=>3100),t:time.map(()=>-10),rh:time.map(()=>95),ws:time.map(()=>20),wd:time.map(()=>100),cc:time.map(()=>90),w:time.map(()=>0)}]}};
}
const REPORTS=[report('YPPH','10025KT','9999 BKN050'),report('YSSY','16015KT','3000 BKN006'),
  report('YMML','18015KT','9999 BKN050 TEMPO 0902/0912 2000 BKN004'),
  report('YSCB','17015KT','9999 BKN050 TEMPO 0902/0912 9999 TSRA BKN030CB'),report('YHBA','11010KT','9999 BKN050')];
function scenario(id:string,edition:Edition,polarity:'pass'|'fail'='pass',seed=1,difficulty=2) {
  const r=DECREES.find(r=>r.id===id)!;
  const generated=generateDossier({seed,edition,difficulty,strand:ruleStrand(r,edition),decreeId:id,polarity,reports:REPORTS});
  if(generated.kind!=='ready')throw new Error(`${id}/${edition}/${polarity}/${seed}: ${generated.reason}`);
  return generated;
}

describe('Operational Decision decree contract',()=>{
  it('uses graph concepts, consecutive shifts and sourced AU/US decision trees',()=>{
    const graph=JSON.parse(readFileSync(new URL('../../../docs/training/concepts.json',import.meta.url),'utf8'));
    const ids=new Set(graph.concepts.map((c:{id:string})=>c.id));
    DECREES.forEach((d,i)=>{
      expect(ids.has(d.conceptId),d.id).toBe(true);expect(d.shiftIntroduced).toBe(i+1);
      expect(shiftPlan(i+1,'aus').introduces).toBe(d.id);
      for(const edition of ['aus','us'] as const){const v=editionVariant(d,edition);
        expect(v.reason.length).toBeGreaterThan(15);expect(v.decisionTree.length).toBeGreaterThanOrEqual(2);expect(v.decisionTree.length).toBeLessThanOrEqual(4);
        expect(v.realRule.length).toBeGreaterThan(0);expect(v.realRule.every(r=>r.section&&r.scope&&r.verified&&r.url.startsWith('https://'))).toBe(true);
      }
    });
  });
  for(const edition of ['aus','us'] as const)for(const rule of DECREES) {
    it(`${edition} ${rule.id}: positive and negative independently re-evaluate`,()=>{
      for(const polarity of ['pass','fail'] as const){const g=scenario(rule.id,edition,polarity);
        const actual=evaluateDossier(g.dossier,edition,true);
        expect(actual.filter(a=>a.result.status==='unavailable')).toEqual([]);
        expect(actual.filter(a=>a.result.status==='fail').map(a=>a.decreeId)).toEqual(polarity==='fail'?[rule.id]:[]);
        expect(judge(g.dossier,{stamp:polarity==='fail'?'REFUSE':'RELEASE'},{edition,responseMs:18000}).correct).toBe(true);
        expect(judge(g.dossier,{stamp:polarity==='fail'?'RELEASE':'REFUSE'},{edition,responseMs:18000}).correct).toBe(false);
      }
    });
  }
  for(const edition of ['aus','us'] as const)for(const rule of DECREES) {
    it(`${edition} ${rule.id}: 500 seeded plans isolate the intended rule`,async()=>{
      for(let seed=0;seed<500;seed++) {
        if(seed%20===0)await new Promise(resolve=>setTimeout(resolve,0));
        // Multiple arithmetic levels, both polarities; no weather is rewritten.
        const g=scenario(rule.id,edition,seed%2?'pass':'fail',seed,rule.id==='vfr'?0:[-1,0,1,2][Math.floor(seed/2)%4]);
        const decision=judge(g.dossier,g.intent.decision,{edition,responseMs:12000});
        expect(decision.correct,`${seed}`).toBe(true);
        expect(decision.before.filter(a=>a.result.status==='fail').map(a=>a.decreeId)).toEqual(g.intent.violations);
        for(const w of [g.dossier.departureWeather,g.dossier.destinationWeather])expect(REPORTS.find(r=>r.station===w.station)).toEqual(w);
      }
    },120000);
  }
  it('is deterministic, does not mutate input, and drops unsuitable weather',()=>{
    const before=JSON.stringify(REPORTS);
    expect(scenario('fuel','aus')).toEqual(scenario('fuel','aus'));
    expect(JSON.stringify(REPORTS)).toBe(before);
    expect(generateDossier({seed:1,edition:'aus',difficulty:1,strand:'charts',decreeId:'forecast-groups',polarity:'fail',reports:[REPORTS[0]]}).kind).toBe('unavailable');
    expect(()=>generateDossier({seed:1,edition:'us',difficulty:1,strand:'rules-aus',reports:REPORTS})).toThrow();
  });
  it('separates edition reserve arithmetic and night currency',()=>{
    const d=scenario('passenger-recency','aus').dossier;
    d.plan.night=true;d.documents.crew[0].landings.forEach(l=>l.fullStop=false);
    expect(recency(d,'aus').status).toBe('pass');expect(recency(d,'us').status).toBe('fail');
    d.operation='airline';d.plan.holdingMinutes=0;d.plan.alternateId=null;
    const au=fuelRequired(d,'aus'),us=fuelRequired(d,'us');
    expect(au.finalReserveKg).toBe(1500);expect(au.alternateKg).toBe(750);
    expect(us.finalReserveKg).toBeCloseTo(5500/74*45);expect(us.contingencyKg).toBe(0);
  });
  it('uses current Part 117 start/sector limits and a different AU basic roster',()=>{
    expect(usFdpHours(7,1)).toBe(14);expect(usFdpHours(7,3)).toBe(13);expect(usFdpHours(12,1)).toBe(13);
    expect(usFdpHours(23,4)).toBe(9);expect(()=>usFdpHours(25,1)).toThrow();
    const d=scenario('duty','us').dossier;d.operation='airline';d.documents.duty.scheme='us-117';d.documents.duty.startLocalHour=8;
    d.documents.duty.endUtc=new Date(Date.parse(d.documents.duty.startUtc)+12*3600_000).toISOString();
    expect(duty(d,'us').status).toBe('pass');d.documents.duty.scheme='au-basic';expect(duty(d,'aus').status).toBe('fail');
  });
  it('has different Class C cloud minima and interacting MEL conditions',()=>{
    const d=scenario('vfr','us','pass',1,0).dossier;d.plan.cloudClearance.belowFt=600;
    expect(vfr(d,'us').status).toBe('pass');expect(vfr(d,'aus').status).toBe('fail');
    const jet=scenario('mel','aus').dossier;
    jet.documents.technicalLog.defects=['onePack','autopilot','apu'];jet.plan.cruiseLevel=250;
    expect(mel(jet).status).toBe('pass');jet.documents.technicalLog.externalAir=false;expect(mel(jet).status).toBe('fail');
    jet.documents.technicalLog.externalAir=true;jet.plan.cruiseLevel=290;expect(mel(jet).status).toBe('fail');
  });
  it('gives different stamps for the same usable fuel under the two editions',()=>{
    const au=scenario('fuel','aus').dossier;au.plan.fuelKg=fuelRequired(au,'aus').totalKg;
    const us=structuredClone(au);us.edition='us';
    expect(judge(au,{stamp:'RELEASE'},{edition:'aus',responseMs:20000}).correct).toBe(true);
    expect(judge(us,{stamp:'RELEASE'},{edition:'us',responseMs:20000}).correct).toBe(false);
    expect(judge(us,{stamp:'REFUSE'},{edition:'us',responseMs:20000}).rules).toEqual(['fuel']);
  });
  it('checks fuel reserve/contingency by operation, powerplant and flight rules',()=>{
    const base={aus:scenario('fuel','aus').dossier,us:scenario('fuel','us').dossier};
    for(const edition of ['aus','us'] as const)for(const aircraft of Object.keys(FLEET) as (keyof typeof FLEET)[])for(const operation of ['private','charter','airline'] as const)for(const rules of ['VFR','IFR'] as const)for(const night of [false,true]) {
      const d=structuredClone(base[edition]);
      d.aircraft=aircraft;d.operation=operation;d.plan.rules=rules;d.plan.night=night;
      d.plan.cruiseLevel=FLEET[aircraft].cruiseLevels[0];d.plan.distanceNm=FLEET[aircraft].tripRows[0].distanceNm;d.plan.headwindKt=0;d.plan.alternateId=null;d.plan.holdingMinutes=0;
      const turbine=aircraft==='a727'||aircraft==='commuter',commercial=operation!=='private';
      const minutes=edition==='us'?(rules==='VFR'&&!night&&operation!=='airline'?30:45):(turbine?30:!commercial&&rules==='VFR'&&!night?30:45);
      const trip=tripPlan(aircraft,d.plan.distanceNm,d.plan.cruiseLevel,0);
      const fuel=fuelRequired(d,edition);
      expect(fuel.finalReserveKg).toBeCloseTo(edition==='aus'?holdingFuelKg(aircraft,minutes):trip.fuelKg/trip.timeMinutes*minutes);
      expect(fuel.contingencyKg).toBeCloseTo(edition==='us'?0:commercial?Math.max(trip.fuelKg*(turbine ? .05 : .1),holdingFuelKg(aircraft,5)):turbine?trip.fuelKg*.05:0);
    }
  });
  it('keeps anti-ice/MEL decisions consistent and uses alternate travel time',()=>{
    const d=scenario('icing','aus','fail').dossier;
    expect(icing(d).status).toBe('fail');expect(canDispatchMel(d.aircraft,'antiIce',{icingForecast:true})).toBe(false);
    d.plan.cloudExposure=false;expect(icing(d).status).toBe('pass');expect(canDispatchMel(d.aircraft,'antiIce',{icingForecast:false})).toBe(true);
    d.plan.cloudExposure=true;d.destinationWeather.profile=null;expect(icing(d).status).toBe('unavailable');
    expect(alternatePlan('a727',100)).toEqual({timeMinutes:17,fuelKg:1250});
    const c=scenario('licence-medical','aus').dossier;c.operation='charter';c.documents.crew.forEach(p=>{p.licence='commercial';p.medical.class=2;});
    expect(licence(c,'aus').status).toBe('fail');expect(licence(c,'us').status).toBe('pass');
  });
});
