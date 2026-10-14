/// <reference lib="webworker" />
/** Builds the close terrain mesh off the main thread; the plate keeps drawing
 * the previous mesh until this one arrives. */
import { buildSurfaceMesh, type SurfaceMeshInput } from '../lib/terrain/surface-mesh';

self.onmessage = (event: MessageEvent<{ id: number; input: SurfaceMeshInput }>) => {
  const { id, input } = event.data;
  const mesh = buildSurfaceMesh(input);
  if (!mesh) { self.postMessage({ id, mesh: null }); return; }
  self.postMessage({ id, mesh: { vertices: mesh.vertices, indices: mesh.indices, columns: mesh.columns, rows: mesh.rows } }, [mesh.vertices.buffer, mesh.indices.buffer]);
};
