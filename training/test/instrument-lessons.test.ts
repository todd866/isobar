import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENTS } from '../src/instruments/registry.ts';
import { advanceLesson, beginLesson } from '../src/instruments/steps.ts';
import { instrumentForCard } from '../src/instruments/support.ts';
import { toCard } from '../src/skills/card.ts';
import { windComponent } from '../src/skills/wind.ts';
import { retestCard, transferCard } from '../src/adaptive.ts';
import type { Card } from '../src/model.ts';

test('every instrument produces bounded scenarios across seeds', () => {
  for (const instrument of INSTRUMENTS) {
    const answers = new Set<number>();
    for (let seed = 0; seed <= 20; seed += 1) {
      const scenario = instrument.scenario(seed);
      assert.ok(Number.isFinite(scenario.answer), `${instrument.id} seed ${seed} answer`);
      answers.add(scenario.answer);
      assert.ok(!instrument.draw(scenario.state,{hidden:false,overlay:false,compact:false}).includes('Profile cannot fit'),`${instrument.id} seed ${seed} must be flyable`);
      for (const control of instrument.controls) {
        const value = scenario.state[control.key];
        assert.ok(Number.isFinite(value), `${instrument.id} ${control.key} seed ${seed}`);
        assert.ok(value >= control.min && value <= control.max, `${instrument.id} ${control.key} range`);
      }
    }
    assert.ok(answers.size > 1, `${instrument.id} should vary its generated problems`);
  }
});

test('learn lesson requires estimate, watch, guided manipulation, then solo answer', () => {
  for (const instrument of INSTRUMENTS) {
    const scenario = instrument.scenario(7);
    let lesson = beginLesson();
    lesson = advanceLesson(lesson, { type: 'estimate', value: scenario.answer + 1 });
    assert.equal(lesson.phase, 'watch', instrument.id);
    lesson = advanceLesson(lesson, { type: 'watched' });
    assert.equal(lesson.phase, 'guided', instrument.id);
    lesson = advanceLesson(lesson, { type: 'manipulated', correct: true });
    assert.equal(lesson.phase, 'solo', instrument.id);
    lesson = advanceLesson(lesson, { type: 'answer', value: scenario.answer, answer: scenario.answer, tolerance: scenario.tolerance });
    assert.equal(lesson.phase, 'complete', instrument.id);
  }
});

test('a wrong solo answer adds scaffolding and cannot bypass the guided recovery', () => {
  const scenario = INSTRUMENTS[0].scenario(3);
  let lesson = beginLesson();
  lesson = advanceLesson(lesson, { type: 'estimate', value: scenario.answer });
  lesson = advanceLesson(lesson, { type: 'watched' });
  lesson = advanceLesson(lesson, { type: 'manipulated', correct: true });
  lesson = advanceLesson(lesson, { type: 'answer', value: scenario.answer + scenario.tolerance * 10 + 1, answer: scenario.answer, tolerance: scenario.tolerance });
  assert.equal(lesson.phase, 'scaffold');
  assert.equal(advanceLesson(lesson, { type: 'answer', value: scenario.answer, answer: scenario.answer, tolerance: scenario.tolerance }).phase, 'scaffold');
  lesson = advanceLesson(lesson, { type: 'manipulated', correct: true });
  assert.equal(lesson.phase, 'solo');
  assert.equal(advanceLesson(lesson, { type: 'answer', value: scenario.answer, answer: scenario.answer, tolerance: scenario.tolerance }).phase, 'complete');
});

test('invalid lesson input is ignored and direct manipulation moves a real control', () => {
  const dragPoints: Record<string, [number, number]> = {
    wind: [350, 212], atmosphere: [215, 100], interpolation: [445, 91], balance: [400, 180], profile: [300, 100],
  };
  for (const instrument of INSTRUMENTS) {
    const scenario = instrument.scenario(5);
    const initial = beginLesson();
    assert.deepEqual(advanceLesson(initial, { type: 'estimate', value: Number.NaN }), initial, instrument.id);
    const key = instrument.id === 'balance' ? 'passengerZone' : instrument.controls[0].key;
    const changed = instrument.drag(key, ...dragPoints[instrument.id], scenario.state);
    assert.ok(Number.isFinite(changed[key]), `${instrument.id} drag remains finite`);
    assert.notEqual(changed[key], scenario.state[key], `${instrument.id} drag should move ${key}`);
  }
});

function numericCard(skill: string, given: Record<string, number> = {}): Card {
  return { id: skill, conceptIds: [], subject: 'plan', kind: 'numeric', planStep: null, stem: skill, options: [], correctId: '', explanation: '', citations: [], complexity: 1, topics: [skill], numeric: { value: 1, tolerance: 1, unit: 'kt', decimals: 0, method: '', thumb: '', diagnoses: [], given }, drill: { skill, rung: 1, seed: 1, support: 0 } };
}

test('support map only opens mechanisms with a matching instrument', () => {
  assert.equal(instrumentForCard(numericCard('wind-component')), 'wind');
  assert.equal(instrumentForCard(numericCard('isa-dev')), 'atmosphere');
  assert.equal(instrumentForCard(numericCard('met-level')), 'profile');
  assert.equal(instrumentForCard(numericCard('interpolate')), 'interpolation');
  assert.equal(instrumentForCard(numericCard('cg-shift')), 'balance');
  assert.equal(instrumentForCard(numericCard('tas-mach')), null);
  assert.equal(instrumentForCard(numericCard('zone-time')), null);
  assert.equal(instrumentForCard(numericCard('zone-time', { trackDeg: 90, windFromDeg: 180, windKt: 30 })), 'wind');
  assert.equal(instrumentForCard(null), null);
});

test('generated card support retains the scenario inputs', () => {
  const drill = windComponent.generate(19, 1);
  assert.ok(drill);
  const card = toCard({ ...drill, id: 'test.wind' }, { seed: 19 });
  assert.equal(card.numeric?.given?.trackDeg, drill.given.trackDeg);
  assert.equal(card.numeric?.given?.windFromDeg, drill.given.windFromDeg);
  assert.equal(instrumentForCard(card), 'wind');
});

test('contextual supports use the exact learner inputs, not unrelated generated numbers', async () => {
  const { SKILLS }=await import('../src/skills/index.ts');
  for(const id of ['isa-dev','interpolate','cg-shift','wind-component','met-level'])for(const rung of [1,2,3,4] as const){
    const drill=SKILLS.find(s=>s.id===id)!.generate(77,rung),card=toCard(drill,{seed:77});
    const def=INSTRUMENTS.find(d=>d.id===instrumentForCard(card))!,s=def.scenario(0,card);
    if(id==='isa-dev'){assert.equal(s.state.level,drill.given.fl*100);assert.equal(s.state.oat,drill.given.oatC);}
    if(id==='met-level'){
      assert.equal(s.state.level,drill.given.cruiseFl);
      assert.equal(s.guideKey,'level');
      assert.equal(s.answer,drill.given.cruiseFl*100*([2,4].includes(rung)?.5:2/3));
    }
    else assert.equal(s.answer,drill.answer,`${id} r${rung} answer`);
    if(id==='interpolate')assert.equal(s.state.a,card.figure!.table!.spans![0].low);
    if(id==='cg-shift'&&rung===3){assert.equal(s.state.cargoKg,drill.given.moveKg);assert.equal(s.state.baseWeight,drill.given.weightKg);assert.equal(s.state.removedArm,drill.given.fromArm);}
  }
});

test('lesson machine rejects out-of-order events and non-finite grading', () => {
  const begin=beginLesson();
  assert.deepEqual(advanceLesson(begin,{type:'watched'}),begin);
  assert.deepEqual(advanceLesson(begin,{type:'manipulated',correct:true}),begin);
  let s=advanceLesson(beginLesson(true),{type:'estimate',value:12});
  assert.equal(s.phase,'solo');
  assert.deepEqual(advanceLesson(s,{type:'answer',value:12,answer:NaN,tolerance:1}),s);
  assert.deepEqual(advanceLesson(s,{type:'answer',value:12,answer:12,tolerance:-1}),s);
  s=advanceLesson(s,{type:'answer',value:14,answer:12,tolerance:1});
  assert.equal(s.phase,'scaffold');
  const bad=advanceLesson(s,{type:'manipulated',correct:false});assert.equal(bad.phase,'scaffold');assert.ok(bad.feedback.length>0);
});

test('contextual CG support retains hold capacity warnings after replacing the basic aircraft', () => {
  const def=INSTRUMENTS.find(d=>d.id==='balance')!;
  const card=numericCard('cg-shift',{weightKg:60000,baseArm:22,mac:27,addKg:1000,to:1});
  const state=def.scenario(0,card).state;
  const graphic=def.draw({...state,cargoKg:5000},{hidden:false,overlay:false,compact:false});
  assert.ok(graphic.includes('Load exceeds capacity'));
});

test('support inputs survive easier retests and refresh with transferred problems', async () => {
  const { SKILLS }=await import('../src/skills/index.ts');
  for(const id of ['isa-dev','interpolate','cg-shift','wind-component','met-level'])for(const rung of [1,2,3,4] as const){
    const skill=SKILLS.find(s=>s.id===id)!;
    const drill=skill.generate(77,rung);drill.id=`drill.${id}.r${rung}`;
    const card=toCard(drill,{seed:77}),retry=retestCard(card,{outcome:'wrong',entered:999999,slip:'Try in steps'})!;
    const def=INSTRUMENTS.find(d=>d.id===instrumentForCard(retry))!;
    assert.equal(def.scenario(0,retry).answer,def.scenario(0,card).answer,`${id} r${rung} keeps its mechanism after lowering rung`);
    const transfer=transferCard(retry,1)!;
    const expected=skill.generate(transfer.drill!.seed,rung);
    assert.deepEqual(transfer.numeric!.given,expected.given,`${id} r${rung} new inputs accompany new answer`);
  }
});

test('live support readouts independently reproduce the card calculation', async () => {
  const { SKILLS }=await import('../src/skills/index.ts');
  const indices:Record<string,number>={'isa-dev':0,'interpolate':2,'cg-shift':0,'wind-component':3,'groundspeed':2};
  for(const [id,index] of Object.entries(indices))for(const rung of [1,2,3,4] as const)for(const seed of [1,77,199]){
    const drill=SKILLS.find(s=>s.id===id)!.generate(seed,rung),card=toCard(drill,{seed});
    const def=INSTRUMENTS.find(d=>d.id===instrumentForCard(card))!,state=def.scenario(0,card).state;
    const read=Number(def.readings(state,false)[id==='isa-dev'&&state.tableStep?2:index].value.replaceAll(',',''));
    const displayRounding=id==='cg-shift'||id==='isa-dev'||id==='wind-component'?.051:.501;
    assert.ok(Math.abs(read-drill.answer)<=Math.max(drill.tolerance,displayRounding),`${id} r${rung} seed ${seed}: displayed ${read}, card ${drill.answer}`);
  }
});
