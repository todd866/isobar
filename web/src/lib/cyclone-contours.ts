import {contourPressure,type Polyline,type PressureCentre} from './contour';
import {cycloneScalar,cycloneShape,cycloneProfile,type CycloneState} from './historical-cyclone';
/** Keep whole outside paths and split crossings; never bridge hidden vertices. */
export function clipCycloneLines(lines:Polyline[],s:CycloneState,inside:boolean){
 const result:Polyline[]=[],radius=cycloneProfile(s).blendEndKm;
 const sx=111.32*Math.cos(s.lat*Math.PI/180),sy=111.132;
 for(const line of lines){
  let xs:number[]=[],ys:number[]=[],cut=false;
  const parts:Polyline[]=[];
  const flush=()=>{if(xs.length>1)parts.push({level:line.level,closed:false,lon:Float32Array.from(xs),lat:Float32Array.from(ys)});xs=[];ys=[];};
  for(let i=1;i<line.lon.length;i++){
   const lon=line.lon[i-1],lat=line.lat[i-1],dlon=line.lon[i]-lon,dlat=line.lat[i]-lat;
   const ax=(lon-s.lon)*sx,ay=(lat-s.lat)*sy,dx=dlon*sx,dy=dlat*sy;
   const aa=dx*dx+dy*dy,bb=2*(ax*dx+ay*dy),cc=ax*ax+ay*ay-radius*radius,disc=bb*bb-4*aa*cc;
   const splits=[0,1];
   if(aa>0&&disc>0)for(const t of [(-bb-Math.sqrt(disc))/(2*aa),(-bb+Math.sqrt(disc))/(2*aa)])if(t>0&&t<1)splits.push(t);
   splits.sort((a,b)=>a-b);
   for(let j=1;j<splits.length;j++){
    const a=splits[j-1],b=splits[j],mid=(a+b)/2,keep=(Math.hypot(ax+dx*mid,ay+dy*mid)<=radius)===inside;
    if(keep){if(!xs.length){xs.push(lon+dlon*a);ys.push(lat+dlat*a);}xs.push(lon+dlon*b);ys.push(lat+dlat*b);}
    else{cut=true;flush();}
   }
  }flush();
  result.push(...(!cut?[line]:parts));
 }return result;
}
export function cycloneContours(base:{lines:Polyline[];centres:PressureCentre[]},s:CycloneState,background:(lon:number,lat:number)=>number|null){
 const radius=cycloneProfile(s).blendEndKm;
 const n=129,span=radius/111.132*1.2,west=s.lon-span/Math.cos(s.lat*Math.PI/180),north=s.lat+span,dx=2*span/Math.cos(s.lat*Math.PI/180)/(n-1),dy=2*span/(n-1);
 const values=new Float32Array(n*n);
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){const lon=west+x*dx,lat=north-y*dy;values[y*n+x]=cycloneScalar(s,lon,lat,background(lon,lat),'mslp')??NaN;}
 const local=contourPressure(values,n,n,west,north,dx,-dy,4,null,false);
 return{lines:[...clipCycloneLines(base.lines,s,false),...clipCycloneLines(local.lines,s,true)],centres:[...base.centres.filter(p=>cycloneShape(s,p.lon,p.lat).r>radius),{kind:'L' as const,lon:s.lon,lat:s.lat,hpa:Math.round(s.pressureHpa),prominence:Math.max(0,(background(s.lon,s.lat)??s.pressureHpa)-s.pressureHpa)}]};
}
