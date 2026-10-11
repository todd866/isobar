/// <reference lib="webworker" />
import {cycloneContours} from '../lib/cyclone-contours';
import type {CycloneState} from '../lib/historical-cyclone';
import {sampleMonotoneBicubic} from '../lib/cyclone-environment';
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
  const wrapsLongitude = Math.abs(data.nx * data.dlon - 360) < 1e-6;
  if (data.cyclone) {
    const environment = smoothGrid(smoothGrid(data.mslp, data.nx, data.ny, wrapsLongitude), data.nx, data.ny, wrapsLongitude);
    const grid = { values: environment, nx: data.nx, ny: data.ny, west: data.west, north: data.north, step: data.dlon, wrapsLongitude };
    result = cycloneContours(result, data.cyclone, (lon, lat) => sampleMonotoneBicubic(grid, lon, lat), grid);
  }
  const lines: Polyline[] = result.lines;
  const centres: PressureCentre[] = result.centres;
  (self as DedicatedWorkerGlobalScope).postMessage({ id: data.id, lines, centres });
};
