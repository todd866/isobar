import {cycloneScalar, type CycloneState} from './historical-cyclone';
export interface PressureGrid {nx:number;ny:number;west:number;north:number;step:number;wrapsLongitude:boolean}
/** Same bilinear endpoint field as the GPU, for keeping numbers on its lines. */
export function pressureTextureSample(values:Float32Array, grid:PressureGrid, t:number, lon:number, lat:number, storm?:CycloneState|null):number|null {
  let x=(lon-grid.west)/grid.step;const y=(grid.north-lat)/grid.step;
  if(grid.wrapsLongitude)x=((x%grid.nx)+grid.nx)%grid.nx;
  if(x<0||x>grid.nx-1&&!grid.wrapsLongitude||y<0||y>grid.ny-1)return null;
  const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
  const tap=(a:number,b:number)=>{
    a=grid.wrapsLongitude?a%grid.nx:Math.min(grid.nx-1,a);b=Math.min(grid.ny-1,b);
    const i=(b*grid.nx+a)*2;return values[i]*(1-t)+values[i+1]*t;
  };
  const a=tap(ix,iy),b=tap(ix+1,iy),c=tap(ix,iy+1),d=tap(ix+1,iy+1);
  if(![a,b,c,d].every(Number.isFinite))return null;
  const value=(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
  return storm?cycloneScalar(storm,lon,lat,value,'mslp'):value;
}

/** Reattach an old label candidate to today's level, not yesterday's worker
 * geometry. Ambiguous/flat/missing neighbourhoods suppress the candidate. */
export function pressureLabelPoint(lon:number,lat:number,level:number,sample:(lon:number,lat:number)=>number|null) {
  const h=.01;
  for(let i=0;i<10;i++){
    const value=sample(lon,lat);
    if(value==null)return null;
    if(Math.abs(value-level)<.001)return{lon,lat};
    const e=sample(lon+h,lat),w=sample(lon-h,lat),n=sample(lon,lat+h),s=sample(lon,lat-h);
    if(e==null||w==null||n==null||s==null)return null;
    const dx=(e-w)/(2*h),dy=(n-s)/(2*h),length=dx*dx+dy*dy;
    if(length<1e-10)return null;
    const error=value-level, scale=Math.min(1,.5/(Math.abs(error)/Math.sqrt(length)));
    lon-=error*dx/length*scale;lat-=error*dy/length*scale;
  }
  return null;
}
