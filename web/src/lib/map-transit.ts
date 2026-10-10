/** One-use same-tab camera handoff between the two data modes. */
export interface MapTransit {lat:number;lon:number;halfHeight:number;degreesPerPixel?:number;pitch:number;bearingRadians?:number;threeD:boolean;target:string;savedAt:number;pin?:{lat:number;lon:number};event?:string;date?:string;hour?:number}
export const MAP_TRANSIT_KEY='isobar.map-transit';
export function parseMapTransit(raw:string|null,target:string,now=Date.now()):MapTransit|null {
  try {const v=JSON.parse(raw??'null');
    if(!v||v.target!==target||![v.lat,v.lon,v.halfHeight,v.pitch,v.savedAt].every(Number.isFinite)||now-v.savedAt<0||now-v.savedAt>300000||Math.abs(v.lat)>90||Math.abs(v.lon)>180||v.halfHeight<=0||v.halfHeight>180||v.pitch<0||v.pitch>Math.PI/2||typeof v.threeD!=='boolean')return null;
    if(v.bearingRadians!==undefined&&(!Number.isFinite(v.bearingRadians)||Math.abs(v.bearingRadians)>Math.PI))return null;
    if(v.degreesPerPixel!==undefined&&(!Number.isFinite(v.degreesPerPixel)||v.degreesPerPixel<=0||v.degreesPerPixel>2))return null;
    if(v.pin&&(!Number.isFinite(v.pin.lat)||!Number.isFinite(v.pin.lon)||Math.abs(v.pin.lat)>90||Math.abs(v.pin.lon)>180))return null;
    if(v.event!==undefined&&typeof v.event!=='string'||v.date!==undefined&&typeof v.date!=='string'||v.hour!==undefined&&(!Number.isInteger(v.hour)||v.hour<0||v.hour>23))return null;
    return v;
  }catch{return null;}
}
