// Bundled by Playwright. This deliberately drives the production WebGL chart.
import { createGlChart, type GlView } from '../../src/lib/gl-chart';
import { globalEquirectangular } from '../../src/lib/lambert';
import { createTiltCamera, forwardProject } from '../../src/lib/tilt-camera';

function half(v:number):number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const e=Math.floor(Math.log2(v)), m=v/2**e;
  if(e < -14) return Math.round(v/2**-24);
  if(e > 15) return 0x7bff;
  return ((e+15)<<10)|Math.round((m-1)*1024);
}

function run(reverseOrder=false, ridgeEnabled=true) {
  const width=640,height=480, canvas=document.createElement('canvas');
  canvas.width=width; canvas.height=height; document.body.replaceChildren(canvas);
  const gl=canvas.getContext('webgl2'); if(!gl) throw new Error('WebGL2 unavailable');
  let original: any;
  if(reverseOrder) {
    original=WebGL2RenderingContext.prototype.bufferData;
    WebGL2RenderingContext.prototype.bufferData=function(target:number, data:any, usage:number, ...rest:any[]) {
      if(target===this.ELEMENT_ARRAY_BUFFER && data instanceof Uint32Array && data.length>10000) {
        const copy=data.slice(); for(let i=0;i+2<copy.length;i+=3)copy.set(data.subarray(data.length-i-3,data.length-i),i);
        return original.call(this,target,copy,usage,...rest);
      }
      return original.call(this,target,data,usage,...rest);
    } as any;
  }
  const chart=createGlChart(canvas);
  try {
  if(!chart) throw new Error('chart unavailable');
  chart.resize(width,height);
  const box={west:86.70,east:87.20,south:27.80,north:28.20};
  const nx=64,ny=64,data=new Uint16Array(nx*ny*2);
  for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    const lat=box.south+(y+.5)/(ny)*(box.north-box.south);
    const ridge=Math.abs(lat-28.035)<.012;
    const z=ridge && ridgeEnabled?7600:900;
    const i=(y*nx+x)*2; data[i]=half(z); data[i+1]=half(1);
  }
  chart.setTerrain({data,width:nx,height:ny,box});
  const image=document.createElement('canvas'); image.width=16;image.height=256;
  const ictx=image.getContext('2d')!; const pixels=ictx.createImageData(16,256);
  // Geographic north/far ground is blue; the intervening ridge is red.
  for(let y=0;y<256;y++)for(let x=0;x<16;x++){
    const lat=box.north-(y+.5)/256*(box.north-box.south);
    pixels.data.set(lat>28.06?[30,80,210,255]:[220,45,35,255],(y*16+x)*4);
  }
  ictx.putImageData(pixels,0,0);
  chart.setImagery(image as any,{origin:[86.95,28.0],u:[.5,2,0,0,0,0],v:[.5,0,-2.5,0,0,0],edgeUv:[.001,.001]});
  const camera=createTiltCamera({lat:27.98,lon:86.95,halfHeightDeg:.16,aspect:width/height,tiltRadians:Math.PI/180*48,bearingRadians:0});
  const view:GlView={tiltCamera:camera,centerX:86.95,centerY:27.98,halfWidth:.16*width/height,halfHeight:.16,lambert:globalEquirectangular(86.95,27.98),west:box.west,north:box.north,dlon:box.east-box.west,dlat:box.north-box.south,nx,ny,blend:0,field:'none',scale:1,offset:0,fill:0,dark:false,relief:1};
  // The first draw commits the pending terrain upload; request the plate for
  // the following draw so the captured pixels include the uploaded DEM.
  chart.draw(view); chart.requestPlate(); chart.draw(view);
  const plate=chart.takePlate(); if(!plate) throw new Error('plate was not captured');
  const far=forwardProject(camera,28.10,86.95,900); if(!far||!far.visible) throw new Error('far point not visible');
  const px=Math.max(0,Math.min(width-1,Math.round((far.x+1)*width/2))), py=Math.max(0,Math.min(height-1,Math.round((1-far.y)*height/2)));
  const at=(x:number,y:number)=>Array.from(plate.data.slice((y*width+x)*4,(y*width+x)*4+4));
  const output=document.createElement('canvas');output.width=plate.width;output.height=plate.height;
  output.getContext('2d')!.putImageData(new ImageData(plate.data,plate.width,plate.height),0,0);
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  return {width,height,pixel:[px,py],colour:at(px,py),pixels:Array.from(plate.data),png:output.toDataURL(),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
  } finally { chart?.destroy(); if(original) WebGL2RenderingContext.prototype.bufferData=original; }
}

export function runTerrainOcclusion() { return run(false); }
export function runTerrainOcclusionReversed() { return run(true); }

export function runTerrainFlat() { return run(false,false); }
