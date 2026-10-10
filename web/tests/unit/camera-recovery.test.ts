import {describe,it,expect} from 'vitest';
import {CameraRecovery} from '../../src/lib/camera-recovery';
describe('intent-aware camera recovery',()=>{
 it('waits for quiet travel then eases along the shortest heading without overshoot',()=>{
  const recovery=new CameraRecovery();recovery.travel(0,Math.PI*1.5);
  expect(recovery.sample(449,false)).toBeNull();
  let previous=Math.PI/2;
  for(let t=450;t<=1050;t+=10){const bearing=recovery.sample(t,false)!;expect(bearing).toBeLessThanOrEqual(0);expect(Math.abs(bearing)).toBeLessThanOrEqual(previous+1e-12);previous=Math.abs(bearing);}
  expect(previous).toBe(0);expect(recovery.sample(1100,false)).toBeNull();
 });
 it('never turns during held input and waits again after it ends',()=>{
  const recovery=new CameraRecovery();recovery.travel(0,1);
  expect(recovery.sample(2000,true)).toBeNull();expect(recovery.sample(2449,false)).toBeNull();expect(recovery.sample(2450,false)).toBe(1);
 });
 it('deliberate looking and fresh input cancel immediately; reduced motion skips animation',()=>{
  const recovery=new CameraRecovery();recovery.travel(0,1);expect(recovery.sample(700,false)).toBeGreaterThan(0);
  recovery.cancel();expect(recovery.sample(2000,false)).toBeNull();
  recovery.travel(2000,-1);expect(recovery.sample(2450,false,true)).toBe(0);
 });
});
