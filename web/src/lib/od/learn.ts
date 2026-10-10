import { difficultyTarget, updateStrand, type Person, type ServePace } from '../../../../training/src/ability';
import { rulesStrand } from '../../../../training/src/levels.ts';
import type { Evidence, Edition, Strand } from './model';

export function schedulerTarget(person:Person,strand:Strand,rng:()=>number,pace:ServePace):{edition:Edition;strand:Strand;difficulty:number} {
  if(!person.rules)throw new RangeError('Operational Decision requires a Code edition');
  if(strand.startsWith('rules-')&&strand!==rulesStrand(person.rules))throw new RangeError('Rules strand belongs to the other edition');
  return {edition:person.rules,strand,difficulty:difficultyTarget(person,strand,rng,pace)};
}
/** Feed only the assessed strands. answerCard's general prior propagation is
 * deliberately not used: an AUS law result must never calibrate US law. The
 * caller owns persistence and deduplication by dossierId + decreeId. */
export function applyEvidence(person:Person,evidence:readonly Evidence[],now:number):Person {
  if(!Number.isFinite(now))throw new RangeError('Invalid evidence time');
  let result=structuredClone(person);
  const seen=new Set<string>();
  for(const e of evidence) {
    const key=`${e.dossierId}/${e.decreeId}`;if(seen.has(key))continue;seen.add(key);
    if(!Number.isFinite(e.difficulty)||!Number.isFinite(e.responseMs)||e.responseMs<0)throw new RangeError('Invalid evidence');
    if(e.strand.startsWith('rules-')&&e.strand!==rulesStrand(e.rules))throw new RangeError('Mixed rules evidence');
    const stat=result.concepts[e.conceptId]??{exposure:0,correct:0};
    result={...result,strands:{...result.strands,[e.strand]:updateStrand(result.strands[e.strand],e.difficulty,e.correct,e.responseMs,now)},
      concepts:{...result.concepts,[e.conceptId]:{exposure:stat.exposure+1,correct:stat.correct+(e.correct?1:0)}},
      history:[...result.history,{at:now,strand:e.strand,difficulty:e.difficulty,correct:e.correct}],updatedAt:now};
  }
  if(evidence.length)result.consecutiveFailures=evidence.every(e=>e.correct)?0:person.consecutiveFailures+1;
  return result;
}
