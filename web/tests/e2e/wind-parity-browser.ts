// Bundled by the test runner only. Exercises the production Canvas renderer.
import { createFlowLayer } from '../../src/lib/flow-layer';
import { globalEquirectangular } from '../../src/lib/lambert';
import { withTilt } from '../../src/lib/tilt-navigation';
import type { LoadedChart } from '../../src/lib/chart-store';

export function runWindScene(scene: any, contract: any) {
  const canvas = document.createElement('canvas');
  canvas.width = scene.width; canvas.height = scene.height;
  document.body.replaceChildren(canvas);
  document.body.style.cssText = `margin:0;background:${scene.dark?'#15232c':'#e8f0f4'}`;
  const pixels = scene.width * scene.height;
  const cells = 360 * 181;
  const component = (axis:'u'|'v') => Uint16Array.from({length:cells},(_,i)=>{
    const lon=i%360-180,lat=90-Math.floor(i/360),dx=(lon-116)*Math.cos(-32*Math.PI/180),dy=lat+32;
    let value=scene[axis];
    if(scene.pattern==='gap'&&Math.abs(dx)<3&&Math.abs(dy)<3)value=null;
    if(scene.pattern==='shear'&&axis==='v')value=Math.max(-12,Math.min(12,dy*.5));
    if(scene.pattern==='circulation'){const r=Math.max(.1,Math.hypot(dx,dy));value=(axis==='u'?dy:-dx)/r*12;}
    return value===null?65535:Math.round((value/(scene.units==='knots'?.514444:1)+80)*100);
  });
  const chart = { manifest: { nx:360,ny:181,west:-180,east:179,north:90,south:-90,wrapsLongitude:true,
    run:'2026-10-11T00:00:00Z', forecastHours:[0], variables:{
      u10:{scale:.01,offset:-80,fill:65535,units:scene.units??'m/s'},v10:{scale:.01,offset:-80,fill:65535,units:scene.units??'m/s'} } },
    packed:{u10:component('u'),v10:component('v')},state:{u10:new Uint8Array([1]),v10:new Uint8Array([1])},
  } as unknown as LoadedChart;
  const ppd=scene.zoom*Math.min(scene.width/360,scene.height/180);
  const input={chart,minute:0,geo:globalEquirectangular(scene.longitude,scene.latitude),
    camera:{centerX:0,centerY:scene.latitude,halfWidth:scene.width/2/ppd,halfHeight:scene.height/2/ppd},
    cssWidth:scene.width,cssHeight:scene.height,dt:contract.dt,dark:scene.dark,windLens:scene.windLens,reduced:scene.reduced};
  input.camera=withTilt(input.geo,input.camera,scene.pitch??0);
  const layer=createFlowLayer(canvas)!;
  const ctx=canvas.getContext('2d')!;
  let maxSegmentPx=0;
  const move=ctx.moveTo.bind(ctx), curve=ctx.bezierCurveTo.bind(ctx);let sx=0,sy=0;
  ctx.moveTo=(x,y)=>{sx=x;sy=y;move(x,y)};
  ctx.bezierCurveTo=(a,b,c,d,x,y)=>{maxSegmentPx=Math.max(maxSegmentPx,Math.hypot(x-sx,y-sy));curve(a,b,c,d,x,y)};
  const draw=(seconds:number)=>{for(let i=0;i<Math.round(seconds/input.dt);i++)layer.draw(input)};
  const alpha=()=>Uint8Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data.filter((_,i)=>i%4===3));
  try {
    draw(contract.warmupSeconds); const before=alpha(), beforePNG=canvas.toDataURL();
    maxSegmentPx=0;draw(contract.motionSeconds);const after=alpha(), afterPNG=canvas.toDataURL();
    const tiles=new Set<number>();let ink=0,diff=0;
    for(let i=0;i<pixels;i++){
      if(after[i]>=16){ink++;tiles.add(Math.floor((i%scene.width)/scene.width*4)+4*Math.floor(Math.floor(i/scene.width)/scene.height*4))}
      diff+=Math.abs(before[i]-after[i]);
    }
    return {id:scene.id,inkFraction:ink/pixels,occupiedTiles:tiles.size,motionFraction:diff/255/pixels,
      drawn:layer.sample().drawn,maxSegmentPx,beforePNG,afterPNG};
  } finally {layer.destroy()}
}
