import {describe,it,expect} from 'vitest';
import {transitionWalk} from '../e2e/transition-walk';
describe('release journey transition coverage',()=>{
 it('covers every ordered pair including repeats, with deterministic replay',()=>{
  const actions=['drag','mode','lens','point','time','resize'];
  for(const seed of [0,1,17,20261010]){
   const walk=transitionWalk(actions,seed),pairs=new Set(walk.slice(1).map((a,i)=>`${walk[i]}>${a}`));
   expect(walk).toHaveLength(actions.length**2+1);
   for(const a of actions)for(const b of actions)expect(pairs.has(`${a}>${b}`)).toBe(true);
   expect(transitionWalk(actions,seed)).toEqual(walk);
  }
  expect(transitionWalk(actions,1)).not.toEqual(transitionWalk(actions,17));
 });
});
