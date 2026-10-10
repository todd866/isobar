import assert from 'node:assert/strict';
import test from 'node:test';
import { FlightComputer } from '../src/instruments/e6b/instrument.ts';
import { E6B } from '../src/instruments/e6b/face.ts';
import { E6B_PROCEDURES, applyProcedureAction, initialProcedurePose } from '../src/instruments/e6b/procedures.ts';
import { emptyRecord } from '../src/instruments/e6b/skills.ts';
import { homeHtml, FIRST_CONTACT, componentTableSvg } from '../src/instruments/e6b/launch.ts';
import { MISSIONS, missionProblem } from '../src/instruments/e6b/missions.ts';
import { readDot, solveHeading } from '../src/instruments/e6b/wind.ts';
import { mark, scale } from '../src/instruments/e6b/face.ts';
import { turn } from '../src/instruments/e6b/slide.ts';

// No browser mocks for the sequence logic: only rendering is replaced. Real
// startSequence, seqGo, checkAlignment, form validation and coachNext run.
test('all 51 paths can be performed in the actual Guided controller, including typed reading gates', () => {
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{clearTimeout,setTimeout}});
  try {
    for(const p of E6B_PROCEDURES){
      const h=Object.create(FlightComputer.prototype);
      Object.assign(h,{face:E6B,activeExercise:p,autoTurn:false,theta:0,cursor:0,viewAngle:0,side:p.demo.steps[0].wind?'wind':'computer',
        wind:{plate:0,gs:150,dot:null},procedureEntries:{},el:{classList:{add(){},remove(){}}},
        renderTask(){},renderCoach(){},renderStrip(){},renderChrome(){},paint(){h.checkAlignment();},
        setSide(side:string){h.side=side;},setSlide(end:string){h.slideEnd=end;},orientWork(){},
      });
      let finished=false; h.startSequence(p.demo,'guided',1,()=>{finished=true;});
      let pose=initialProcedurePose();
      for(let i=0;i<p.procedure.length;i++){
        assert.equal(h.seq.index,i,`${p.id}: reached ${i}`);
        const step=p.procedure[i];
        pose=applyProcedureAction(pose,step.physical);
        Object.assign(h,{theta:pose.theta,cursor:pose.cursor,wind:{...pose.wind},viewAngle:pose.viewAngle});
        h.checkAlignment();
        if(step.physical.kind==='estimate'||step.physical.kind==='read'){
          assert.equal(h.seq.met,false,`${p.id}: cannot skip typing step ${i}`);
          assert.equal(h.enterProcedureReading(''),false);
          const value=step.physical.kind==='estimate'?pose.estimate!:pose.values[step.physical.key];
          assert.equal(h.enterProcedureReading(String(value)),true,`${p.id}: reading ${i}`);
        }
        assert.equal(h.seq.met,true,`${p.id}: physical step ${i}`);
        h.coachNext();
      }
      assert.equal(finished,true,p.id);
    }
  } finally { if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window'); }
});

test('start-screen actions are wired IDs and progress is specific to each operation',()=>{
  const r=emptyRecord();r.curriculum={time:{stage:'done',solved:['time-1','time-2','time-3']},speed:{stage:'guided',solved:[]}};
  const html=homeHtml(r);
  assert.match(html,/data-pick="src:daily"/);assert.match(html,/data-pick="mission:jet-sydney"/);
  assert.match(html,/data-pick="exercise:speed-1"/);
  assert.match(html,/data-skill="time"[\s\S]*?● Fluent/);
  assert.match(html,/data-skill="speed"[\s\S]*?◐ Learning/);
  assert.match(html,/data-skill="distance"[\s\S]*?○ New/);
  for(const item of html.matchAll(/data-pick="([^"]+)"/g))assert.ok(/^(exercise|mission|src):/.test(item[1]),item[1]);
  assert.equal(FIRST_CONTACT.length,4);
  for(const t of FIRST_CONTACT)for(const h of t.highlight){if(h.kind==='mark')assert.ok(mark(E6B,h.id));if(h.kind==='scale')assert.ok(scale(E6B,h.scale));}
  assert.doesNotMatch(html,/…|text-overflow/);
  assert.match(componentTableSvg(27,125,'cross'),/table-cell-active-cross/);
});

test('B727 mission derives ground speed on high slide and carries it into time and burn',()=>{
  const m=MISSIONS.find(m=>m.id==='jet-sydney')!;
  assert.deepEqual(m.links.map(l=>l.log),['TAS','GS','Time','Fuel']);
  const tas=missionProblem(m,0,[]).key.exact;
  const wind=missionProblem(m,1,[tas]);
  const state=wind.demo.steps[wind.demo.steps.length-1].wind!;
  assert.equal(state.slide,'high');assert.ok(Math.abs(readDot(state)!.tas-Math.round(tas))<1e-8);
  assert.equal(wind.key.exact,solveHeading(state.plate,Math.round(tas),260,65).gs);
  const time=missionProblem(m,2,[tas,wind.key.exact]);
  assert.match(time.stem,/wind-side ground speed/);
  const fuel=missionProblem(m,3,[tas,wind.key.exact,time.key.exact]);
  assert.ok(Math.abs(fuel.key.exact-4300*Math.round(time.key.exact)/60)<1e-8);
});

test('Watch moves to the same physical pose as every canonical action',()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldMedia=Object.getOwnPropertyDescriptor(globalThis,'matchMedia');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{clearTimeout(){},setTimeout(fn:()=>void){fn();return 0;}}});
  Object.defineProperty(globalThis,'matchMedia',{configurable:true,value:()=>({matches:true})});
  try {
    for(const p of E6B_PROCEDURES){
      const h=Object.create(FlightComputer.prototype);
      Object.assign(h,{...initialProcedurePose(),face:E6B,activeExercise:p,slideEnd:'low',slideG:{innerHTML:''},paint(){},renderStrip(){}});
      let pose=initialProcedurePose();
      for(const step of p.procedure){
        pose=applyProcedureAction(pose,step.physical);
        let completed=false;h.moveToStep(step.demoStep,()=>{completed=true;});
        assert.equal(completed,true,`${p.id}: ${step.physical.kind}`);
        assert.ok(Math.abs(turn(h.theta-pose.theta))<1e-7,p.id);
        assert.ok(Math.abs(turn(h.cursor-pose.cursor))<1e-7,p.id);
        assert.ok(Math.abs(turn(h.viewAngle-pose.viewAngle))<1e-7,p.id);
        assert.ok(Math.abs(turn(h.wind.plate-pose.wind.plate))<1e-7,p.id);
        assert.ok(Math.abs(h.wind.gs-pose.wind.gs)<1e-7,p.id);
        assert.deepEqual(h.wind.dot,pose.wind.dot,p.id);assert.equal(h.wind.slide,pose.wind.slide,p.id);
      }
    }
  } finally {
    if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');
    if(oldMedia)Object.defineProperty(globalThis,'matchMedia',oldMedia);else Reflect.deleteProperty(globalThis,'matchMedia');
  }
});

test('changing the slide preserves the pencil dot on the clear plate',()=>{
  const h=Object.create(FlightComputer.prototype);
  Object.assign(h,{slideEnd:'low',wind:{plate:90,gs:150,dot:[102,-204],slide:'low'},slideG:{innerHTML:''},renderStrip(){},paint(){}});
  h.setSlide('high');assert.deepEqual(h.wind.dot,[102,-204]);assert.equal(h.wind.slide,'high');
  h.setSlide('low');assert.deepEqual(h.wind.dot,[102,-204]);assert.equal(h.wind.slide,'low');
  const pose=applyProcedureAction({...initialProcedurePose(),wind:{plate:90,gs:150,dot:[102,-204],slide:'low'}},{kind:'slide-end',end:'high'});
  assert.deepEqual(pose.wind.dot,[102,-204]);
});

test('first contact runs four fifteen-second steps and Skip cancels the pending step',()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const pending=new Map<number,{fn:()=>void;ms:number}>();let id=0,saved=0,home=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{clearInterval(){},clearTimeout(n:number){pending.delete(n);},setTimeout(fn:()=>void,ms:number){pending.set(++id,{fn,ms});return id;}}});
  try {
    const h=Object.create(FlightComputer.prototype);
    Object.assign(h,{record:emptyRecord(),store:{save(){saved++;}},stop(){},setSide(){},setViewRotation(){},renderChrome(){},paint(){},moveTo(){},openHome(){home++;}});
    h.startTour();
    for(let step=0;step<4;step++){
      assert.equal(h.tourIndex,step);assert.equal(pending.size,1);
      const [key,timer]=[...pending][0];assert.equal(timer.ms,15000);pending.delete(key);timer.fn();
    }
    assert.equal(home,1);assert.equal(saved,1);assert.equal(h.record.firstContact,true);assert.equal(pending.size,0);
    h.startTour();h.finishTour();assert.equal(pending.size,0);assert.equal(h.tourIndex,-1);
  } finally {if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');}
});

test('leaving a lesson cancels its delayed flip before it can change the next screen',()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const pending=new Map<number,()=>void>();let id=0,changed=0,completed=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{clearTimeout(n:number){pending.delete(n);},setTimeout(fn:()=>void){pending.set(++id,fn);return id;}}});
  try {
    const h=Object.create(FlightComputer.prototype);
    Object.assign(h,{side:'computer',dial:{classList:{add(){},remove(){}}},setSide(){changed++;},viewTween:{from:0,to:90,start:0}});
    h.flipTo('wind',()=>{completed++;});assert.equal(pending.size,1);
    h.stop();assert.equal(pending.size,0);assert.equal(changed,0);assert.equal(completed,0);assert.equal(h.viewTween,null);
    h.flipTo('wind',()=>{completed++;});const [key,first]=[...pending][0];pending.delete(key);first();
    assert.equal(changed,1);assert.equal(pending.size,1);h.stop();assert.equal(pending.size,0);assert.equal(completed,0);
  } finally {if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');}
});
