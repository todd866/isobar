/// <reference lib="webworker" />
import { contourPressure, type Polyline, type PressureCentre } from '../lib/contour';

interface RequestMessage {
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
  const result = contourPressure(data.mslp, data.nx, data.ny, data.west, data.north, data.dlon, data.dlat, 4);
  const lines: Polyline[] = result.lines;
  const centres: PressureCentre[] = result.centres;
  (self as DedicatedWorkerGlobalScope).postMessage({ id: data.id, lines, centres });
};
