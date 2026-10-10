/// <reference lib="webworker" />
import {cycloneContours} from '../lib/cyclone-contours';
import type {CycloneState} from '../lib/historical-cyclone';
import {sampleFrame} from '../lib/point/ground';
import { smoothGrid, contourPressure, type Polyline, type PressureCentre } from '../lib/contour';

interface RequestMessage {
  cyclone?: CycloneState|null;
  id: number;
  mslp: Float32Array;
  nx: number;
  ny: number;
  west: number;
  north: number;
  dlon: number;
  dlat: number;
}

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  const data = event.data;
  let result = contourPressure(data.mslp, data.nx, data.ny, data.west, data.north, data.dlon, data.dlat, 4);
  const environment=data.cyclone?smoothGrid(smoothGrid(data.mslp,data.nx,data.ny,true),data.nx,data.ny,true):data.mslp;
  if(data.cyclone)result=cycloneContours(result,data.cyclone,(lon,lat)=>sampleFrame(environment,{nx:data.nx,ny:data.ny,west:data.west,north:data.north,south:data.north+(data.ny-1)*data.dlat,step:data.dlon,wrapsLongitude:Math.abs(data.nx*data.dlon-360)<1e-6},lon,lat));
  const lines: Polyline[] = result.lines;
  const centres: PressureCentre[] = result.centres;
  (self as DedicatedWorkerGlobalScope).postMessage({ id: data.id, lines, centres });
};
