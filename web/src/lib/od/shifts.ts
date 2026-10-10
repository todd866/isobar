import { DECREES, ruleStrand } from './decrees';
import type { Edition } from './model';
import type { Judgement } from './judge';

/** Pressure is story/scoring data. An unsafe on-time release never earns quota. */
export function shiftPlan(number:number,edition:Edition) {
  if(!Number.isInteger(number)||number<1||number>DECREES.length)throw new RangeError('Unknown shift');
  const introduced=DECREES[number-1];
  return {number,introduces:introduced.id,activeDecrees:DECREES.slice(0,number).map(d=>d.id),
    dossierCount:Math.min(8,3+Math.floor((number-1)/3)),onTimeQuota:Math.min(4,1+Math.floor((number-1)/5)),
    targetStrand:ruleStrand(introduced,edition),citationPenalty:2,correctDecisionPoints:3,safeOnTimeBonus:1};
}
export function scoreShift(number:number,edition:Edition,outcomes:readonly {judgement:Judgement;released:boolean;delayMinutes:number}[]) {
  const plan=shiftPlan(number,edition);
  if(outcomes.length>plan.dossierCount)throw new RangeError('Too many dossiers for shift');
  if(outcomes.some(o=>!Number.isFinite(o.delayMinutes)||o.delayMinutes<0))throw new RangeError('Invalid delay');
  const assessed=outcomes.filter(o=>o.judgement.assessable);
  const correct=assessed.filter(o=>o.judgement.correct).length;
  const citations=assessed.length-correct;
  const onTime=assessed.filter(o=>o.judgement.correct&&o.released&&o.delayMinutes===0&&o.judgement.after.every(a=>a.result.status==='pass')).length;
  return {correct,citations,onTime,quotaMet:onTime>=plan.onTimeQuota,points:correct*plan.correctDecisionPoints-citations*plan.citationPenalty+onTime*plan.safeOnTimeBonus,
    complete:outcomes.length===plan.dossierCount,unassessed:outcomes.length-assessed.length};
}
