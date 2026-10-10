import { esc } from '../html.ts';
import { INSTRUMENTS } from './registry.ts';
export { INSTRUMENTS } from './registry.ts';
import { advanceLesson, beginLesson, type Lesson, type LessonEvent } from './steps.ts';
import { clamp, n } from './svg.ts';
import type { Control, InstrumentMode, MountOptions, Values } from './types.ts';
export type { InstrumentId, MountOptions } from './types.ts';
import { instrumentForCard } from './support.ts';
export { instrumentForCard } from './support.ts';

/** All five instruments are bundled offline. mount owns listeners/animation;
 * destroy cancels them, including an in-flight worked example. No global timer. */
export function mount(host: HTMLElement, opts: MountOptions = {}): { destroy(): void } {
  let def = INSTRUMENTS.find(d=>d.id===opts.instrument) ?? INSTRUMENTS[0];
  let mode: InstrumentMode = opts.mode ?? 'learn';
  let seed=opts.seed ?? 0, scenario=def.scenario(seed,instrumentForCard(opts.card??null)===def.id?opts.card:undefined), values={...scenario.state};
  let lesson:Lesson=beginLesson(mode==='practice'), overlay=false, zoom=1;
  let frame=0, animation=0, destroyed=false, watching=false, watchDone=false, changed=false;
  const abort=new AbortController(), signal=abort.signal;
  const pointers=new Map<number,{x:number;y:number}>();
  let dragKey:string|null=null, pinchDistance=0, pinchZoom=1, dragStart:Values={};
  host.classList.add('instrument-host');
  function setValue(key:string,value:number):void {
    const control=def.controls.find(c=>c.key===key);
    if(!control || !Number.isFinite(value) || (['guided','scaffold'].includes(lesson.phase) && mode!=='free' && mode!=='how' && key!==scenario.guideKey))return;
    values[key]=clamp(Math.round(value/control.step)*control.step,control.min,control.max);
    changed=true;requestPaint();
  }
  function outputHidden():boolean {return (mode==='learn'||mode==='practice') && ['estimate','solo'].includes(lesson.phase);}
  function readonly():boolean {return watching || ((mode==='learn'||mode==='practice')&&['estimate','solo','complete'].includes(lesson.phase));}
  function controlValue(c:Control):string {
    if(c.key==='passengerZone')return ['A','B','C','D','E'][Math.round(values[c.key])]??'A';
    if(c.key==='cargoHold')return ['1','2','4','5'][Math.round(values[c.key])]??'1';
    return n(values[c.key], c.step===.1?1:c.step<1?2:0);
  }
  function build():void {
    cancelAnimationFrame(animation);watching=false;
    host.innerHTML=`<section class="instrument" data-instrument-id="${def.id}" aria-label="${esc(def.title)}">
      <header class="i-header"><div class="i-name"><span class="i-eyebrow">${esc(def.eyebrow)}</span><select data-i-select aria-label="Instrument">${INSTRUMENTS.map(d=>`<option value="${d.id}"${d===def?' selected':''}>${esc(d.title)}</option>`).join('')}</select></div>
      <nav class="i-modes" aria-label="Instrument mode">${(['learn','practice','free','how'] as const).map(m=>`<button type="button" data-i-mode="${m}" aria-pressed="${m===mode}">${{learn:'Learn',practice:'Practice',free:'Free play',how:'How it works'}[m]}</button>`).join('')}</nav></header>
      <div class="i-stage"><div class="i-visual"><svg class="i-svg" viewBox="0 0 600 410" role="group" aria-label="${esc(def.title)} interactive diagram"><g data-i-drawing></g></svg><div class="i-graphic-tools">${def.overlay?`<button data-i-overlay aria-pressed="${overlay}">${esc(def.overlay)}</button>`:''}<button data-i-reset title="Reset this instrument">Reset</button></div></div><aside class="i-coach" aria-label="Instrument coaching"></aside></div>
      <div class="i-controls" role="group" aria-label="Instrument inputs">${def.controls.map(c=>`<label class="i-control ${c.tone??''}" data-i-control="${c.key}"><span>${esc(c.label)}</span><output>${esc(controlValue(c))} <small>${esc(c.unit)}</small></output><input type="range" data-i-input="${c.key}" aria-label="${esc(c.label)}" min="${c.min}" max="${c.max}" step="${c.step}" value="${values[c.key]}"></label>`).join('')}</div>
      <div class="i-readouts" aria-label="Instrument readouts"></div>
      <footer class="i-foot"><span>${esc(scenario.route)}</span><button class="i-short-controls" data-i-controls-toggle aria-expanded="false">Controls</button><button data-i-help aria-expanded="false" >Input help</button></footer><div class="i-input-help" hidden>Drag the coloured handles. Two-finger scroll over a handle or slider adjusts it. Pinch the diagram to zoom; Reset restores the view. Tab to a handle, then use arrow keys; Shift makes a larger step. Sliders work with touch and keyboard.</div>
    </section>`;
    if (opts.picker) host.querySelector('.i-name')!.replaceChildren(opts.picker);
    paint();coach();
  }
  function paint():void {
    if(destroyed)return;
    frame=0;
    const root=host.querySelector<HTMLElement>('.instrument')!;root.dataset.mode=mode;root.dataset.lessonPhase=lesson.phase;
    const focused=host.querySelector('.i-svg')?.contains(document.activeElement)?(document.activeElement as HTMLElement)?.dataset.handle:null;
    const drawing=host.querySelector('[data-i-drawing]');
    if(drawing){drawing.innerHTML=def.draw(values,{hidden:outputHidden(),overlay,compact:host.clientWidth<640});drawing.setAttribute('transform',`translate(${300*(1-zoom)} ${205*(1-zoom)}) scale(${zoom})`);}
    if(focused)(host.querySelector(`[data-handle="${focused}"]`) as SVGElement|null)?.focus({preventScroll:true});
    host.querySelectorAll<HTMLElement>('[data-handle]').forEach(el=>{const c=def.controls.find(c=>c.key===el.dataset.handle);const guided=(mode==='learn'||mode==='practice')&&['guided','scaffold'].includes(lesson.phase);el.classList.toggle('i-guide-handle',guided&&el.dataset.handle===scenario.guideKey);el.setAttribute('aria-disabled',String(readonly()||(guided&&el.dataset.handle!==scenario.guideKey)));if(c){el.setAttribute('role','slider');el.setAttribute('aria-valuemin',String(c.min));el.setAttribute('aria-valuemax',String(c.max));el.setAttribute('aria-valuenow',String(values[c.key]));}if(c)el.setAttribute('aria-label',`${c.label}: ${controlValue(c)} ${c.unit}. Arrow keys or scroll to adjust.`);});
    host.querySelectorAll<HTMLElement>('[data-i-control]').forEach(el=>{
      const c=def.controls.find(c=>c.key===el.dataset.iControl)!;
      const input=el.querySelector('input')!;input.value=String(values[c.key]);input.disabled=readonly() || (['guided','scaffold'].includes(lesson.phase) && mode!=='free' && mode!=='how' && c.key!==scenario.guideKey);input.setAttribute('aria-valuetext',`${controlValue(c)} ${c.unit}`);
      el.querySelector('output')!.innerHTML=`${esc(controlValue(c))} <small>${esc(c.unit)}</small>`;
      el.classList.toggle('i-target',(mode==='learn'||mode==='practice')&&['guided','scaffold'].includes(lesson.phase)&&c.key===scenario.guideKey);
    });
    host.querySelector('.i-readouts')!.innerHTML=def.readings(values,outputHidden()).map(r=>`<div class="i-readout ${r.tone??''}"><span>${esc(r.label)}</span><strong>${esc(r.value)} <small>${esc(r.unit??'')}</small></strong></div>`).join('');
  }
  function requestPaint():void {if(!frame)frame=requestAnimationFrame(paint);}
  function coach():void {
    const el=host.querySelector('.i-coach')!;
    if(mode==='how'){
      el.innerHTML=`<div class="i-how">${def.how.map((p,i)=>`<section><span class="i-step-number">${i+1}</span><h2>${esc(p.title)}</h2><p>${esc(p.body)}</p></section>`).join('')}</div>`;return;
    }
    if(mode==='free'){
      el.innerHTML=`<div class="i-free"><span class="i-step-number">↔</span><h2>Change one thing.</h2><p>${esc(scenario.explain)}</p><span class="i-hint">Drag a coloured handle or scroll over a control.</span></div>`;return;
    }
    const phase=lesson.phase;
    const title={estimate:'Estimate first',watch:'Watch the mechanism',guided:'Your turn',solo:'Now solve it',scaffold:'One part at a time',complete:'Solved'}[phase];
    const prompt={estimate:scenario.estimate,watch:scenario.watch,guided:scenario.guided,solo:scenario.prompt,scaffold:'Only the highlighted control is active. '+scenario.guided,complete:scenario.explain}[phase];
    const number={estimate:1,watch:2,guided:3,solo:4,scaffold:3,complete:4}[phase];
    let action='';
    if(phase==='estimate'||phase==='solo')action=`<form class="i-answer" data-i-answer><label><span class="sr-only">${phase==='estimate'?'Estimate':'Answer'} in ${esc(scenario.unit)}</span><input data-i-entry inputmode="decimal" autocomplete="off" aria-label="${phase==='estimate'?'Estimate':'Answer'} in ${esc(scenario.unit)}" required><span>${esc(scenario.unit)}</span></label><button class="i-primary" type="submit">${phase==='estimate'?'Try estimate':'Check answer'}</button></form>`;
    if(phase==='watch')action=`<button class="i-primary" data-i-watch>${watchDone?'↻ Watch again':'▶ Watch'}</button><button data-i-next ${watchDone?'':'disabled'}>I see it →</button>`;
    if(phase==='guided'||phase==='scaffold')action='<button class="i-primary" data-i-check>Check position</button>';
    if(phase==='complete')action=`<p class="i-comparison">Your estimate ${n(lesson.estimate??0)} · result ${n(scenario.answer,scenario.unit==='% MAC'?1:0)} ${esc(scenario.unit)}</p><button class="i-primary" data-i-new>Next problem →</button>`;
    el.innerHTML=`<div class="i-lesson" data-phase="${phase}"><div class="i-step-heading"><span class="i-step-number">${number}</span><span>${mode==='practice'?'Practice':'Learn'} · ${esc(title)}</span></div><p class="i-prompt">${esc(prompt)}</p>${action}<p class="i-feedback" role="status">${esc(lesson.feedback)}</p></div>`;
  }
  function resetScenario():void {scenario=def.scenario(seed,seed===(opts.seed??0)&&instrumentForCard(opts.card??null)===def.id?opts.card:undefined);values={...scenario.state};lesson=beginLesson(mode==='practice');changed=false;watchDone=false;zoom=1;build();}
  function dispatch(event:LessonEvent):void {
    const old=lesson.phase;lesson=advanceLesson(lesson,event);
    if(old!==lesson.phase){
      changed=false;
      if(lesson.phase==='scaffold')overlay=true;
      if(['guided','scaffold'].includes(lesson.phase))values={...scenario.state,[scenario.guideKey]:scenario.guideStart};
      else values={...scenario.state};
    }
    paint();coach();
    (host.querySelector('[data-i-entry]') as HTMLInputElement|null)?.focus({preventScroll:true});
  }
  function animate():void {
    if(watching)return;
    watching=true;watchDone=false;const start=performance.now(),duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:2200;
    const from=scenario.guideStart,to=scenario.guideTarget;
    const tick=(now:number)=>{
      if(destroyed)return;
      const fraction=duration?clamp((now-start)/duration,0,1):1;
      const control=def.controls.find(c=>c.key===scenario.guideKey)!;
      const current=from+(to-from)*(fraction*fraction*(3-2*fraction));
      values[scenario.guideKey]=clamp(Math.round(current/control.step)*control.step,control.min,control.max);paint();
      if(fraction<1)animation=requestAnimationFrame(tick);
      else {watching=false;watchDone=true;paint();coach();}
    };
    animation=requestAnimationFrame(tick);
  }
  host.addEventListener('click',e=>{
    const t=e.target as HTMLElement;
    const m=t.closest<HTMLElement>('[data-i-mode]')?.dataset.iMode as InstrumentMode|undefined;
    if(m){mode=m;resetScenario();return;}
    if(t.closest('[data-i-controls-toggle]')){const panel=host.querySelector('.instrument')!;panel.classList.toggle('i-controls-open');t.closest('button')!.setAttribute('aria-expanded',String(panel.classList.contains('i-controls-open')));}
    if(t.closest('[data-i-overlay]')){overlay=!overlay;t.closest('button')!.setAttribute('aria-pressed',String(overlay));requestPaint();}
    if(t.closest('[data-i-reset]'))resetScenario();
    if(t.closest('[data-i-watch]'))animate();
    if(t.closest('[data-i-next]')&&watchDone)dispatch({type:'watched'});
    if(t.closest('[data-i-check]'))dispatch({type:'manipulated',correct:changed&&Math.abs(values[scenario.guideKey]-scenario.guideTarget)<=scenario.guideTolerance});
    if(t.closest('[data-i-new]')){seed++;resetScenario();}
    if(t.closest('[data-i-help]')){const help=host.querySelector<HTMLElement>('.i-input-help')!;help.hidden=!help.hidden;t.closest('button')!.setAttribute('aria-expanded',String(!help.hidden));}
  },{signal});
  host.addEventListener('change',e=>{const t=e.target as HTMLSelectElement;if(t.matches('[data-i-select]')){def=INSTRUMENTS.find(d=>d.id===t.value)!;resetScenario();}},{signal});
  host.addEventListener('input',e=>{const t=e.target as HTMLInputElement;if(t.matches('[data-i-entry]'))t.setCustomValidity('');if(t.dataset.iInput&&!readonly())setValue(t.dataset.iInput,Number(t.value));},{signal});
  host.addEventListener('submit',e=>{
    if(!(e.target as HTMLElement).matches('[data-i-answer]'))return;e.preventDefault();
    const input=host.querySelector<HTMLInputElement>('[data-i-entry]')!,raw=input.value.trim(),value=Number(raw.replace(/,/g,''));
    if(!raw||!Number.isFinite(value)){input.setCustomValidity('Enter a number.');input.reportValidity();return;}input.setCustomValidity('');
    dispatch(lesson.phase==='estimate'?{type:'estimate',value}:{type:'answer',value,answer:scenario.answer,tolerance:scenario.tolerance});
  },{signal});
  host.addEventListener('keydown',e=>{
    const t=e.target as HTMLElement;
    if(e.key==='Escape'){host.querySelector('.instrument')?.classList.remove('i-controls-open');const toggle=host.querySelector<HTMLButtonElement>('[data-i-controls-toggle]');toggle?.setAttribute('aria-expanded','false');toggle?.focus();return;}
    const key=t.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    if(!key||readonly())return;
    const c=def.controls.find(c=>c.key===key);if(!c)return;
    const sign=['ArrowUp','ArrowRight'].includes(e.key)?1:['ArrowDown','ArrowLeft'].includes(e.key)?-1:0;
    if(sign){e.preventDefault();setValue(key,values[key]+sign*c.step*(e.shiftKey?10:1));}
  },{signal});
  host.addEventListener('wheel',e=>{
    const t=e.target as HTMLElement,svg=t.closest('.i-svg');
    if(e.ctrlKey&&svg){e.preventDefault();zoom=clamp(zoom*Math.exp(-e.deltaY*.005),.8,1.7);requestPaint();return;}
    const key=t.closest<HTMLElement>('[data-handle]')?.dataset.handle??t.closest<HTMLElement>('[data-i-control]')?.dataset.iControl;
    if(!key||readonly())return;const c=def.controls.find(c=>c.key===key);if(!c)return;
    e.preventDefault();setValue(key,values[key]+Math.sign(e.deltaX||-e.deltaY)*c.step*(e.shiftKey?10:1));
  },{signal,passive:false});
  host.addEventListener('pointerdown',e=>{
    const t=e.target as HTMLElement,svg=t.closest<SVGSVGElement>('.i-svg');if(!svg)return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});svg.setPointerCapture(e.pointerId);
    if(pointers.size===2){const [a,b]=[...pointers.values()];pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);pinchZoom=zoom;dragKey=null;return;}
    dragKey=readonly()?null:t.closest<HTMLElement>('[data-handle]')?.dataset.handle??null;
    if(dragKey){e.preventDefault();dragStart={...values};}
  },{signal});
  host.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===2){const [a,b]=[...pointers.values()];if(pinchDistance)zoom=clamp(pinchZoom*Math.hypot(a.x-b.x,a.y-b.y)/pinchDistance,.8,1.7);requestPaint();return;}
    if(!dragKey||readonly()||(['guided','scaffold'].includes(lesson.phase)&&mode!=='free'&&mode!=='how'&&dragKey!==scenario.guideKey))return;
    const svg=host.querySelector<SVGSVGElement>('.i-svg')!,point=svg.createSVGPoint();point.x=e.clientX;point.y=e.clientY;
    const matrix=svg.getScreenCTM();if(!matrix)return;const p=point.matrixTransform(matrix.inverse());
    const dragged=def.drag(dragKey,(p.x-300*(1-zoom))/zoom,(p.y-205*(1-zoom))/zoom,dragStart);
    values=(mode==='learn'||mode==='practice')&&['guided','scaffold'].includes(lesson.phase)?{...values,[scenario.guideKey]:dragged[scenario.guideKey]}:dragged;
    for(const c of def.controls){if(Number.isFinite(values[c.key]))values[c.key]=clamp(Math.round(values[c.key]/c.step)*c.step,c.min,c.max);}
    changed=true;requestPaint();
  },{signal});
  const release=(e:PointerEvent)=>{pointers.delete(e.pointerId);dragKey=null;pinchDistance=0;};
  host.addEventListener('pointerup',release,{signal});host.addEventListener('pointercancel',release,{signal});
  // Safari trackpads emit gesture events rather than ctrl-wheel for pinch.
  let gestureZoom=1;
  host.addEventListener('gesturestart',e=>{if((e.target as HTMLElement).closest('.i-svg')){e.preventDefault();gestureZoom=zoom;}},{signal,passive:false});
  host.addEventListener('gesturechange',e=>{if((e.target as HTMLElement).closest('.i-svg')){e.preventDefault();zoom=clamp(gestureZoom*((e as Event & {scale:number}).scale??1),.8,1.7);requestPaint();}},{signal,passive:false});
  if(opts.card?.drill?.stage==='retest'){lesson={...lesson,phase:'scaffold',misses:1,feedback:''};overlay=true;values={...scenario.state,[scenario.guideKey]:scenario.guideStart};}
  build();
  return {destroy(){destroyed=true;abort.abort();cancelAnimationFrame(frame);cancelAnimationFrame(animation);pointers.clear();host.replaceChildren();}};
}
