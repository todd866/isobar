import type { InstrumentDefinition, Values } from './types.ts';
import { ffAt } from '../skills/lib.ts';
import { bilinear, interpolate } from './physics.ts';
import { clamp, handle, line, n, text } from './svg.ts';
const result=(s:Values)=>bilinear(s.weightFrac,s.rowFrac,[0,100],[0,100],[[s.a,s.b],[s.c,s.d]]);
const numeric=(s:string)=>Number(s.replace(/−/g,'-').match(/[+-]?\d+(?:\.\d+)?/)?.[0]??0);
const unit=(s:Values)=>s.kind===1?'kg':'kg/h';
export const interpolationInstrument:InstrumentDefinition={
  id:'interpolation',title:'Interpolation ruler',eyebrow:'BRACKET → FRACTION → DIFFERENCE',overlay:'Worked arithmetic',
  controls:[
    {key:'weightFrac',label:'Weight fraction',unit:'%',min:0,max:100,step:1,tone:'wind'},
    {key:'rowFrac',label:'Row fraction',unit:'%',min:0,max:100,step:1,tone:'ground'},
  ],
  scenario(seed,card){
    const i=Math.abs(seed)%4,w0=66+i*2,l0=300+i*10;
    const state:Values={weightFrac:20+(Math.abs(seed)*17)%61,rowFrac:i%2?50:0,w0,w1:w0+2,l0,l1:l0+10,
      a:ffAt(l0,w0*1000)!,b:ffAt(l0,(w0+2)*1000)!,c:ffAt(l0+10,w0*1000)!,d:ffAt(l0+10,(w0+2)*1000)!,kind:0};
    const table=card?.figure?.table,spans=table?.spans;
    if(spans?.length){
      const first=spans[0],second=spans.length>=3?spans[1]:first,last=spans.at(-1)!;
      Object.assign(state,{a:first.low,b:first.high,c:second.low,d:second.high,weightFrac:first.fraction*100,rowFrac:spans.length>=3?last.fraction*100:0,w0:numeric(first.from),w1:numeric(first.to),kind:table?.unit==='kg'?1:0,
        l0:spans.length>=3?numeric(last.from):numeric(table?.rows[table.used[0]?.[0]??0]?.label??'0'),
        l1:spans.length>=3?numeric(last.to):numeric(table?.rows[table.used[0]?.[0]??0]?.label??'0'),
        temp:table?.corner==='Temp'?1:0});
    }else if(table?.used.length){
      const [r,c]=table.used[0],low=table.rows[r]?.cells[c];
      if(low!=null){const other=table.rows[r]?.cells[c+1]??low;Object.assign(state,{a:low,b:other,c:low,d:other,weightFrac:0,rowFrac:0,w0:numeric(table.columns[c]),w1:numeric(table.columns[c+1]??table.columns[c]),l0:numeric(table.rows[r].label),l1:numeric(table.rows[r].label),kind:table.unit==='kg'?1:0,temp:table.corner==='Temp'?1:0});}
    }
    return {state,route:table?`Your drill · ${table.title}`:['Sydney → Perth · YSSY–YPPH','Sydney → Melbourne · YSSY–YMML','Perth → Adelaide · YPPH–YPAD','Sydney → Brisbane · YSSY–YBBN'][i]+' · B727 M 0.80 table',
      prompt:`Interpolate the highlighted ${state.kind===1?'fuel':'fuel flow'}.`,answer:card?.numeric?.value??result(state),tolerance:card?.numeric?.tolerance??1,unit:unit(state),
      estimate:'Estimate first: the answer must lie between the bracketing cells. Closer to which end?',
      watch:'Orange finds the fraction across each weight row. Teal takes the same fraction between the two row results.',
      guided:'Move the orange weight cursor to 50%. Half the weight interval means half the fuel difference.',guideKey:'weightFrac',guideStart:0,guideTarget:50,guideTolerance:1,
      explain:card?.numeric?card.numeric.method:'Use lower value + fraction × (upper − lower). For two dimensions, interpolate across both rows, then between those results. Never extrapolate past the table.'};
  },
  draw(s,c){
    const f=s.weightFrac/100,g=s.rowFrac/100,x=205+240*f,y=150+110*g;
    const low=interpolate(f,0,1,s.a,s.b),high=interpolate(f,0,1,s.c,s.d);
    let out=text(30,27,s.kind===1?'B727 · CLIMB FUEL':'B727 · M 0.80 FUEL FLOW','muted label')+text(570,27,unit(s),'muted','end');
    out+=text(205,69,n(s.w0)+' t','wind','middle')+text(445,69,n(s.w1)+' t','wind','middle');
    out+=line(205,91,445,91,'ruler')+line(205,91,x,91,'vector wind');
    for(let i=0;i<=10;i++)out+=line(205+24*i,85,205+24*i,97,'compass-tick');
    out+=handle(x,91,'weightFrac','Weight fraction cursor','wind');
    out+=text(70,156,s.temp?`ISA ${n(s.l0)}`:`FL${n(s.l0)}`,'ground','middle')+text(70,266,s.temp?`ISA ${n(s.l1)}`:`FL${n(s.l1)}`,'ground','middle');
    out+=`<rect x="136" y="116" width="384" height="72" rx="9" class="table-bracket"/><rect x="136" y="226" width="384" height="72" rx="9" class="table-bracket"/>`;
    [[205,150,s.a],[445,150,s.b],[205,260,s.c],[445,260,s.d]].forEach(([xx,yy,v])=>{out+=text(xx,yy+7,n(v),'table-cell','middle');});
    out+=line(x,187,x,225,'connector wind')+line(544,150,544,260,'ruler')+line(544,150,544,y,'vector ground');
    out+=handle(544,y,'rowFrac','Row fraction cursor','ground');
    out+=text(328,213,c.hidden?'Bracket both dimensions':`${n(low)} → ${n(high)}`,'ground','middle');
    out+=text(328,329,`${n(s.w0+(s.w1-s.w0)*f,2)} t · ${s.temp?'ISA ':'FL'}${n(s.l0+(s.l1-s.l0)*g,1)}`,'label','middle');
    if(c.overlay&&!c.hidden)out+=text(300,366,`${n(s.a)} + ${n(f,2)} × (${n(s.b)} − ${n(s.a)}) = ${n(low)}`,'wind','middle');
    else out+=text(300,366,c.hidden?'Where between the cells?':`${n(s.weightFrac)}% across · ${n(s.rowFrac)}% between rows`,'muted','middle');
    return out;
  },
  readings(s,h){return[{label:'Weight difference',value:h?'?':n(s.b-s.a),unit:unit(s),tone:'wind'},{label:'Difference × fraction',value:h?'?':n((s.b-s.a)*s.weightFrac/100,1),unit:unit(s),tone:'wind'},{label:'Interpolated',value:h?'?':n(result(s)),unit:unit(s),tone:'ground'}];},
  drag(key,x,y,s){if(key==='weightFrac')return {...s,weightFrac:clamp((x-205)/240*100,0,100)};if(key==='rowFrac')return {...s,rowFrac:clamp((y-150)/110*100,0,100)};return s;},
  how:[
    {title:'Keep the units apart',body:'The weight interval answers how far across the table you are. Its fraction has no units. Multiply that fraction by the difference in fuel flow, then add it to the lower cell.'},
    {title:'Single, then double',body:'At an exact row, only interpolate weight. Between rows, do weight on both rows first, then interpolate those results by the row fraction. The four cells surround your point; the cursor never leaves them.'},
    {title:'The model table',body:'These are the trainer’s generated B727 handbook values. Rounding the published cells means table interpolation can differ slightly from evaluating the continuous performance model directly. Missing cells are not zero and cannot form a valid bracket.'},
  ],
};
