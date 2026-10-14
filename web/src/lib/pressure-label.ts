import {cycloneScalar, type CycloneState} from './historical-cyclone';
export interface PressureGrid {nx:number;ny:number;west:number;north:number;step:number;wrapsLongitude:boolean}
/** Same bilinear endpoint field as the GPU, for keeping numbers on its lines. */
export function pressureTextureSample(values:Float32Array, grid:PressureGrid, t:number, lon:number, lat:number, storm?:CycloneState|null):number|null {
  let x=(lon-grid.west)/grid.step;const y=(grid.north-lat)/grid.step;
  if(grid.wrapsLongitude)x=((x%grid.nx)+grid.nx)%grid.nx;
  if(x<0||x>grid.nx-1&&!grid.wrapsLongitude||y<0||y>grid.ny-1)return null;
  const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
  const ix1=grid.wrapsLongitude?(ix+1)%grid.nx:Math.min(grid.nx-1,ix+1);
  const iy1=Math.min(grid.ny-1,iy+1), row0=iy*grid.nx, row1=iy1*grid.nx;
  const ia=(row0+ix)*2,ib=(row0+ix1)*2,ic=(row1+ix)*2,id=(row1+ix1)*2, left=1-t;
  const a=values[ia]*left+values[ia+1]*t,b=values[ib]*left+values[ib+1]*t;
  const c=values[ic]*left+values[ic+1]*t,d=values[id]*left+values[id+1]*t;
  if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(c)||!Number.isFinite(d))return null;
  const value=(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
  return storm?cycloneScalar(storm,lon,lat,value,'mslp'):value;
}

/** Reattach an old label candidate to today's level, not yesterday's worker
 * geometry. Ambiguous/flat/missing neighbourhoods suppress the candidate. */
export function pressureLabelPoint(lon:number,lat:number,level:number,sample:(lon:number,lat:number)=>number|null) {
  // A 256 min/s clock can outrun the worker by several degrees. Keep Newton
  // steps bounded, but allow stale anchors to reach the current line.
  const h=.01;
  for(let i=0;i<16;i++){
    const value=sample(lon,lat);
    if(value==null)return null;
    if(Math.abs(value-level)<.001)return{lon,lat};
    const e=sample(lon+h,lat),w=sample(lon-h,lat),n=sample(lon,lat+h),s=sample(lon,lat-h);
    if(e==null||w==null||n==null||s==null)return null;
    const dx=(e-w)/(2*h),dy=(n-s)/(2*h),length=dx*dx+dy*dy;
    if(length<1e-10)return null;
    const error=value-level, scale=Math.min(1,2/(Math.abs(error)/Math.sqrt(length)));
    lon-=error*dx/length*scale;lat-=error*dy/length*scale;
  }
  return null;
}
