import { DECREES, decree, editionVariant, ruleStrand } from './decrees';
import { fuelRequired } from './checks';
import { FLEET, holdingFuelKg } from './manual';
import type { Decision, Dossier, Edition, Evidence, RuleResult } from './model';

export interface Assessment { decreeId:string; result:RuleResult }
function finiteTree(value:unknown):boolean {
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.every(finiteTree);
  if(value&&typeof value==='object')return Object.values(value).every(finiteTree);
  return true;
}
/** Unsupported inputs carry no learning evidence. A missing datum is not a
 * wrong answer or a fabricated safe condition. */
export function evaluateDossier(d:Dossier,edition:Edition,all=false):Assessment[] {
  if(edition!==d.edition)throw new RangeError('Dossier and judge editions differ');
  if(!['aus','us'].includes(edition)||!Number.isInteger(d.shift)||d.shift<1||!finiteTree(d))throw new RangeError('Invalid dossier');
  if(!FLEET[d.aircraft]||!Number.isFinite(Date.parse(d.plan.departureUtc))||!Number.isFinite(Date.parse(d.plan.arrivalUtc))||Date.parse(d.plan.arrivalUtc)<=Date.parse(d.plan.departureUtc))throw new RangeError('Invalid plan');
  if(!['private','charter','airline'].includes(d.operation)||!['IFR','VFR'].includes(d.plan.rules))throw new RangeError('Unknown operation');
  if(d.operation==='airline'&&(!['commuter','a727'].includes(d.aircraft)||d.plan.rules!=='IFR'))throw new RangeError('Airline exercise requires an IFR commuter or A727');
  if(d.operation==='charter'&&(d.aircraft==='a727'||edition==='aus'&&d.aircraft==='commuter'))throw new RangeError('Use the larger-aeroplane airline regime for this aircraft');
  if([d.plan.fuelKg,d.plan.holdingMinutes,d.plan.dryOperatingKg,d.documents.passengerManifest.passengerMassKg,d.documents.passengerManifest.baggageKg].some(n=>n<0))throw new RangeError('Negative plan quantity');
  if(d.plan.alternateId && !d.alternatives.some(a=>a.aerodrome.id===d.plan.alternateId))throw new RangeError('Unknown alternate');
  return DECREES.filter(r=>all||r.shiftIntroduced<=d.shift).map(r=>{
    try{return {decreeId:r.id,result:editionVariant(r,edition).check(d)};}
    catch(e){return {decreeId:r.id,result:{status:'unavailable' as const,detail:e instanceof Error?e.message:'Unsupported calculation'}};}
  });
}
/** Fuel is total usable fuel after amendment, delay is minutes, alternate is
 * an offered aerodrome ID. Supplying fuel explicitly rebudgets all surplus
 * after reserves/diversion as holding, even if the tank quantity is unchanged.
 * The original dossier is never mutated. */
export function amendDossier(d:Dossier,decision:Extract<Decision,{stamp:'AMEND'}>,edition:Edition):Dossier {
  if(decision.alternate===undefined&&decision.fuel===undefined&&decision.delay===undefined)throw new RangeError('Empty amendment');
  if(Object.keys(decision).some(k=>!['stamp','alternate','fuel','delay'].includes(k)))throw new RangeError('Unsupported amendment');
  const next=structuredClone(d);
  if(decision.alternate!==undefined) {
    if(!d.alternatives.some(a=>a.aerodrome.id===decision.alternate))throw new RangeError('Alternate is not offered');
    next.plan.alternateId=decision.alternate;
  }
  if(decision.delay!==undefined) {
    if(!Number.isFinite(decision.delay)||decision.delay<1||decision.delay>1440)throw new RangeError('Delay must be 1 minute to 24 hours');
    const delta=decision.delay*60_000;
    next.plan.departureUtc=new Date(Date.parse(d.plan.departureUtc)+delta).toISOString();
    next.plan.arrivalUtc=new Date(Date.parse(d.plan.arrivalUtc)+delta).toISOString();
    // Waiting on duty does not create rest or erase duty already worked.
    next.documents.duty.endUtc=new Date(Date.parse(d.documents.duty.endUtc)+delta).toISOString();
  }
  if(decision.fuel!==undefined) {
    if(!Number.isFinite(decision.fuel)||decision.fuel<d.plan.fuelKg||decision.fuel>FLEET[d.aircraft].maxFuelKg)throw new RangeError('Invalid total fuel');
    next.plan.fuelKg=decision.fuel;
    const withoutHold=structuredClone(next);withoutHold.plan.holdingMinutes=0;
    const extra=decision.fuel-fuelRequired(withoutHold,edition).totalKg;
    next.plan.holdingMinutes=Math.max(0,extra)/holdingFuelKg(d.aircraft,1);
  }
  if(JSON.stringify(next.plan)===JSON.stringify(d.plan))throw new RangeError('Amendment changes nothing');
  return next;
}
export interface Judgement {
  assessable:boolean; correct:boolean; rules:string[]; citations:string[];
  evidence:Evidence[]; before:Assessment[]; after:Assessment[];
  amendedDossier:Dossier|null; error:string|null;
}
export function judge(d:Dossier,decision:Decision,input:{edition:Edition;responseMs:number}):Judgement {
  if(!Number.isFinite(input.responseMs)||input.responseMs<0)throw new RangeError('Invalid response time');
  const before=evaluateDossier(d,input.edition);
  const failed=before.filter(a=>a.result.status==='fail');
  let after=before,amendedDossier:Dossier|null=null,error:string|null=null;
  let correct=false;
  if(decision.stamp==='RELEASE')correct=before.every(a=>a.result.status==='pass');
  else if(decision.stamp==='REFUSE')correct=failed.length>0;
  else if(decision.stamp==='AMEND') {
    try {amendedDossier=amendDossier(d,decision,input.edition);after=evaluateDossier(amendedDossier,input.edition);correct=failed.length>0 && after.every(a=>a.result.status==='pass');}
    catch(e){error=e instanceof Error?e.message:'Invalid amendment';}
  } else throw new RangeError('Unknown stamp');
  const assessable=before.every(a=>a.result.status!=='unavailable' && (a.result.status!=='blocked'||failed.some(f=>f.decreeId===a.result.blockedBy)));
  if(!assessable)correct=false;
  const involved=failed.length?failed.map(a=>a.decreeId):d.target.decreeIds.filter(id=>before.some(a=>a.decreeId===id));
  const rules=[...new Set([...involved,...after.filter(a=>a.result.status==='fail').map(a=>a.decreeId)])];
  const citations=rules.map(id=>{
    const v=editionVariant(decree(id),input.edition);
    return `${v.citation} ${v.realRule.map(r=>`${r.document} ${r.section}`).join('; ')}. ${v.reason}`;
  });
  const evidence:Evidence[]=assessable?involved.map(id=>{
    const r=decree(id);return {conceptId:r.conceptId,strand:ruleStrand(r,input.edition),difficulty:d.target.difficulty,correct,responseMs:input.responseMs,rules:input.edition,dossierId:d.id,decreeId:id};
  }):[];
  return {assessable,correct,rules,citations,evidence,before,after,amendedDossier,error};
}
