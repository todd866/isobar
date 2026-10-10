import { mapUnproject } from './lambert';
/**
 * Translucent geostationary infrared under the isobars. Cold tops are the
 * bright pixels of the GIBS clean-infrared PNG. Forecast times fade that
 * picture out and, when the export has `tcc`, draw model cloud instead.
 */

import { blendReady, chartFrame, type LoadedChart } from './chart-store';
import { cameraBounds, sampleBlended, type GeoBounds, type ScalarGrid } from './flow';
import { frameBlend } from './interpolate';
import { unproject, type Camera, type Lambert } from './lambert';
import {
  buildCoverageMesh,
  modelCloudAlpha,
  satelliteGate,
  shiftInterval,
  tilesCovering,
  type GibsTile,
  type SatellitePicture,
} from './satellite';

export interface SatelliteDraw {
  enabled: boolean;
  chart: LoadedChart;
  minute: number;
  nowMs: number;
  geo: Lambert;
  camera: Camera;
  dark: boolean;
  cssWidth: number;
  cssHeight: number;
}

const COLS = 28;
const ROWS = 20;

export interface SatelliteLayer {
  /** 'model', or 'Satellite 14:10Z' with the picture's observation time, or null. */
  draw(input: SatelliteDraw): string | null;
  destroy(): void;
}

export function legendLabel(gate: SatellitePicture): string | null {
  if (gate.legend === 'Satellite') return gate.observedIso ? `Satellite ${gate.observedIso.slice(11, 16)}Z` : 'Satellite';
  return gate.legend;
}

export function createSatelliteLayer(canvas: HTMLCanvasElement): SatelliteLayer {
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let indexBuffer: WebGLBuffer | null = null;
  let satTex: WebGLTexture | null = null;
  let modelTex: WebGLTexture | null = null;
  const atlas = document.createElement('canvas');
  atlas.width = 1024;
  atlas.height = 512;
  const modelCanvas = document.createElement('canvas');
  const cache = new Map<string, HTMLImageElement | 'error' | 'loading'>();
  let inflight = 0;
  let atlasKey = '';
  let modelKey = '';
  let showing = false;
  const verts = new Float32Array((COLS + 1) * (ROWS + 1) * 4);
  const index = buildIndex();

  function context(): WebGL2RenderingContext | null {
    if (gl) return gl;
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;
    program = link(gl);
    buffer = gl.createBuffer();
    indexBuffer = gl.createBuffer();
    satTex = gl.createTexture();
    modelTex = gl.createTexture();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    blank(gl, satTex);
    blank(gl, modelTex);
    return gl;
  }

  function ensureTiles(tiles: GibsTile[]) {
    for (const tile of tiles) {
      if (cache.has(tile.url) || inflight >= 4) continue;
      inflight += 1;
      cache.set(tile.url, 'loading');
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        inflight -= 1;
        cache.set(tile.url, image);
        atlasKey = '';
      };
      image.onerror = () => {
        inflight -= 1;
        cache.set(tile.url, 'error');
      };
      image.src = tile.url;
    }
  }

  function paintAtlas(tiles: GibsTile[], bounds: GeoBounds) {
    const ctx = atlas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, atlas.width, atlas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, atlas.width, atlas.height);
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
      const mid = (bounds.west + bounds.east) / 2;
      for (const tile of tiles) {
        const image = cache.get(tile.url);
        if (!(image instanceof HTMLImageElement)) continue;
        const shifted = shiftInterval(tile.west, tile.east, mid);
        const west = shifted.west;
        const east = shifted.east;
        const x = ((west - bounds.west) / lonSpan) * atlas.width;
      const y = ((bounds.north - tile.north) / latSpan) * atlas.height;
      const w = ((east - west) / lonSpan) * atlas.width;
      const h = ((tile.north - tile.south) / latSpan) * atlas.height;
      ctx.drawImage(image, x, y, w, h);
    }
  }

  function paintModel(chart: LoadedChart, blend: { i0: number; i1: number; t: number }, grid: ScalarGrid) {
    const w = Math.min(grid.nx, 160);
    const h = Math.min(grid.ny, 110);
    modelCanvas.width = w;
    modelCanvas.height = h;
    const ctx = modelCanvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(w, h);
    const a = chartFrame(chart, 'tcc', blend.i0);
    const b = chartFrame(chart, 'tcc', blend.i1);
    for (let y = 0; y < h; y += 1) {
      const lat = grid.north - (y + 0.5) * (grid.dlat * (grid.ny - 1)) / h;
      for (let x = 0; x < w; x += 1) {
        const lon = grid.west + (x + 0.5) * (grid.dlon * (grid.nx - 1)) / w;
        const cover = sampleBlended(a, b, blend.t, lon, lat, grid);
        const alpha = Math.round(modelCloudAlpha(cover ?? Number.NaN) / 0.55 * 255);
        const p = (y * w + x) * 4;
        image.data[p] = 240;
        image.data[p + 1] = 243;
        image.data[p + 2] = 246;
        image.data[p + 3] = alpha;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  return {
    destroy() {
      if (!gl) return;
      if (program) gl.deleteProgram(program);
      if (buffer) gl.deleteBuffer(buffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      if (satTex) gl.deleteTexture(satTex);
      if (modelTex) gl.deleteTexture(modelTex);
      gl = null;
    },
    draw(input) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!input.enabled) {
        if (canvas.dataset.satellite !== 'off') canvas.dataset.satellite = 'off';
        if (showing && gl) {
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          showing = false;
        }
        return null;
      }
      showing = true;
      const { manifest } = input.chart;
      const validMs = Date.parse(manifest.run) + (manifest.forecastHours[0] * 60 + input.minute) * 60_000;
      const hasModel = !!manifest.variables.tcc;
      const gate = satelliteGate(validMs, input.nowMs, hasModel);
      const bounds = cameraBounds(input.geo, input.camera);
      const rendering = context();
      if (canvas.dataset.satellite !== 'on') canvas.dataset.satellite = 'on';
      if (!rendering || !program || !buffer || !satTex || !modelTex || !bounds) return legendLabel(gate);

      rendering.viewport(0, 0, Math.max(1, Math.round(input.cssWidth * dpr)), Math.max(1, Math.round(input.cssHeight * dpr)));
      rendering.disable(rendering.DEPTH_TEST);
      rendering.enable(rendering.BLEND);
      rendering.blendFunc(rendering.ONE, rendering.ONE_MINUS_SRC_ALPHA);
      rendering.clearColor(0, 0, 0, 0);
      rendering.clear(rendering.COLOR_BUFFER_BIT);
      rendering.useProgram(program);

      if (gate.request && gate.timeIso && gate.satelliteAlpha > 0.02) {
        const tiles = tilesCovering(bounds, gate.timeIso);
        ensureTiles(tiles);
        const key = `${gate.timeIso}:${bounds.west.toFixed(1)}:${bounds.east.toFixed(1)}:${bounds.south.toFixed(1)}:${bounds.north.toFixed(1)}:${tiles.map((tile) => cache.get(tile.url) instanceof HTMLImageElement ? '1' : '0').join('')}`;
        if (key !== atlasKey) {
          paintAtlas(tiles, bounds);
          uploadCanvas(rendering, satTex, atlas);
          atlasKey = key;
        }
        drawMesh(rendering, program, buffer, input, bounds, satTex, gate.satelliteAlpha * (input.dark ? 0.78 : 1), 0);
      }

      if (gate.modelAlpha > 0.02 && hasModel) {
        const blend = frameBlend(manifest.forecastHours, manifest.forecastHours[0] * 60 + input.minute);
        const spec = manifest.variables.tcc;
        if (blend && spec && blendReady(input.chart, 'tcc', blend.i0, blend.i1)) {
          const grid: ScalarGrid = {
            nx: manifest.nx,
            ny: manifest.ny,
            west: manifest.west,
            north: manifest.north,
            dlon: (manifest.east - manifest.west) / (manifest.nx - 1),
            dlat: (manifest.north - manifest.south) / (manifest.ny - 1),
            wraps: manifest.wrapsLongitude,
            fill: spec.fill,
            scale: spec.scale,
            offset: spec.offset,
          };
          const key = `${blend.i0}:${blend.i1}:${blend.t.toFixed(2)}`;
          if (key !== modelKey) {
            paintModel(input.chart, blend, grid);
            uploadCanvas(rendering, modelTex, modelCanvas);
            modelKey = key;
          }
          const box = { west: grid.west, east: grid.west + grid.dlon * (grid.nx - 1), south: grid.north - grid.dlat * (grid.ny - 1), north: grid.north };
          drawMesh(rendering, program, buffer, input, box, modelTex, gate.modelAlpha * (input.dark ? 0.85 : 1), 1);
        }
      }
      return legendLabel(gate);
    },
  };

  function drawMesh(
    rendering: WebGL2RenderingContext,
    prog: WebGLProgram,
    buf: WebGLBuffer,
    input: SatelliteDraw,
    box: GeoBounds,
    texture: WebGLTexture,
    alpha: number,
    model: number,
  ) {
    const mesh = buildCoverageMesh(COLS, ROWS, (clipX, clipY) => {
      const point = mapUnproject(input.geo, input.camera, clipX, clipY);
      return point ? { lon: point.lon, lat: point.lat } : null;
    }, box);
    if (!mesh.indices.length) return;
    rendering.bindBuffer(rendering.ARRAY_BUFFER, buf);
    rendering.bufferData(rendering.ARRAY_BUFFER, mesh.positions, rendering.DYNAMIC_DRAW);
    rendering.bindBuffer(rendering.ELEMENT_ARRAY_BUFFER, indexBuffer);
    rendering.bufferData(rendering.ELEMENT_ARRAY_BUFFER, mesh.indices, rendering.DYNAMIC_DRAW);
    rendering.enableVertexAttribArray(0);
    rendering.vertexAttribPointer(0, 2, rendering.FLOAT, false, 16, 0);
    rendering.enableVertexAttribArray(1);
    rendering.vertexAttribPointer(1, 2, rendering.FLOAT, false, 16, 8);
    rendering.activeTexture(rendering.TEXTURE0);
    rendering.bindTexture(rendering.TEXTURE_2D, texture);
    rendering.uniform1i(rendering.getUniformLocation(prog, 'uTex'), 0);
    rendering.uniform1f(rendering.getUniformLocation(prog, 'uAlpha'), alpha);
    rendering.uniform1i(rendering.getUniformLocation(prog, 'uModel'), model);
    rendering.uniform1i(rendering.getUniformLocation(prog, 'uDark'), input.dark ? 1 : 0);
    rendering.drawElements(rendering.TRIANGLES, mesh.indices.length, rendering.UNSIGNED_SHORT, 0);
  }
}

function fillMesh(verts: Float32Array, geo: Lambert, camera: Camera, box: GeoBounds) {
  let k = 0;
  for (let y = 0; y <= ROWS; y += 1) {
    const clipY = -1 + (2 * y) / ROWS;
    for (let x = 0; x <= COLS; x += 1) {
      const clipX = -1 + (2 * x) / COLS;
      const point = mapUnproject(geo, camera, clipX, clipY);
      let u = -1;
      let v = -1;
      if (point) {
        let lon = point.lon;
        const mid = (box.west + box.east) / 2;
        while (lon - mid > 180) lon -= 360;
        while (mid - lon > 180) lon += 360;
        u = (lon - box.west) / (box.east - box.west);
        v = (point.lat - box.south) / (box.north - box.south);
      }
      verts[k++] = clipX;
      verts[k++] = clipY;
      verts[k++] = u;
      verts[k++] = v;
    }
  }
}

function buildIndex(): Uint16Array {
  const out = new Uint16Array(COLS * ROWS * 6);
  let k = 0;
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const i = y * (COLS + 1) + x;
      out[k++] = i;
      out[k++] = i + 1;
      out[k++] = i + COLS + 1;
      out[k++] = i + 1;
      out[k++] = i + COLS + 2;
      out[k++] = i + COLS + 1;
    }
  }
  return out;
}

function blank(gl: WebGL2RenderingContext, texture: WebGLTexture | null) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function uploadCanvas(gl: WebGL2RenderingContext, texture: WebGLTexture, source: HTMLCanvasElement) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

const VERT = `#version 300 es
layout(location=0) in vec2 aClip;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aClip, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
uniform int uModel;
uniform int uDark;
in vec2 vUv;
out vec4 oColor;
void main() {
  if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
  vec4 t = texture(uTex, vUv);
  float a;
  vec3 rgb;
  if (uModel == 1) {
    a = t.a * uAlpha;
    rgb = vec3(0.93, 0.95, 0.97);
  } else {
    float luma = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
    // GIBS clean IR is colour-enhanced: the coldest, tallest tops are coloured
    // (blue through red), not white. Treat any saturated pixel as the coldest cloud.
    float sat = max(max(t.r, t.g), t.b) - min(min(t.r, t.g), t.b);
    float cold = smoothstep(0.18, 0.35, sat);
    float cloud = max(smoothstep(0.20, 0.88, luma), cold);
    float bright = max(luma, cold);
    if (uDark == 1) {
      a = cloud * uAlpha * 0.62;
      rgb = mix(vec3(0.76, 0.81, 0.85), vec3(1.0), bright);
    } else {
      // On the pale light chart white cloud vanishes: grey cloud, darker where
      // thick and cold, reads like a satellite picture printed on paper.
      a = cloud * uAlpha * 0.55;
      rgb = mix(vec3(0.60, 0.66, 0.73), vec3(0.38, 0.44, 0.52), bright);
    }
  }
  if (a < 0.012) discard;
  oColor = vec4(rgb * a, a);
}
`;

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
