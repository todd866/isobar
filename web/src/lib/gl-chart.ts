import { IMAGERY_MATERIAL_GLSL, type ImageryMapping } from './terrain/imagery-material';
import { TILT_CAMERA_GLSL, type TiltCamera } from './tilt-camera';
/** WebGL2 chart plate: Lambert unproject, bicubic field sample, land/sea tint. */

import { kiteBandColor, type KiteBand } from './coastal';
import { fieldBaseToGlsl, fieldStopsToGlsl, type FieldId } from './field-color';
import type { Lambert } from './lambert';

export interface GlView {
  tiltCamera?: TiltCamera;
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  lambert: Lambert;
  west: number;
  north: number;
  dlon: number;
  dlat: number;
  nx: number;
  ny: number;
  blend: number;
  field: FieldId;
  kiteBand?: KiteBand | null;
  scale: number;
  offset: number;
  fill: number;
  /** Night plate: deep blue sea, brown land (the macOS dark chart). */
  dark?: boolean;
  wrapsLongitude?: boolean;
  /** Relief strength 0–1 (terrain/terrarium.ts reliefStrength); 0 draws the flat plate. */
  relief?: number;
  /** Visual foreground cutaway while inspecting the atmosphere, 0–1. */
  cutaway?: number;
  /** 0–1 cover of the colour field over the plate. Omitted means fully covered. */
  fieldAlpha?: number;
}

/** Equirectangular elevation mosaic: RG binary16 (elevation m, coverage), rows from the south. */
export interface TerrainTexture {
  data: Uint16Array;
  width: number;
  height: number;
  box: LandBox;
}

/** Geographic box the land mask covers (the coastline's extent, wider than the data grid). */
export interface LandBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const VERT = `#version 300 es
layout(location=0) in vec2 aClip;
out vec2 vClip;
void main() {
  vClip = aClip;
  gl_Position = vec4(aClip, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D uA;
uniform usampler2D uB;
uniform sampler2D uLand;
uniform float uBlend;
uniform int uField;
uniform vec2 uKiteBand;
uniform int uKite;
uniform int uHasField;
uniform float uFieldAlpha;
uniform vec2 uOrigin;
uniform vec2 uStep;
uniform vec2 uSize;
uniform vec3 uQuant;
uniform vec4 uLandBox;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uLon0;
uniform float uN;
uniform float uF;
uniform float uRho0;
uniform float uDark;
uniform float uCutaway;
uniform int uHasImagery;
uniform int uProjection;
uniform int uWrap;
uniform sampler2D uTerrain;
uniform vec4 uTerrainBox;
uniform vec2 uTerrainTexel;
uniform float uRelief;
uniform int uHasTerrain;
uniform int uTilt;
uniform vec4 uTiltCam;
uniform float uCurvature;
uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uUp;
uniform sampler2D uWater;
uniform vec4 uWaterBox;
uniform int uHasWater;

in vec2 vClip;
out vec4 oColor;

const vec3 SEA_DAY = vec3(0.914, 0.937, 0.957);
const vec3 LAND_DAY = vec3(0.945, 0.925, 0.733);
const vec3 SEA_NIGHT = vec3(0.137, 0.184, 0.243);
const vec3 LAND_NIGHT = vec3(0.400, 0.345, 0.224);

${fieldBaseToGlsl()}

float cubic(float p0, float p1, float p2, float p3, float t) {
  float a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  float b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  float c = -0.5 * p0 + 0.5 * p2;
  float d = p1;
  return ((a * t + b) * t + c) * t + d;
}

${TILT_CAMERA_GLSL}
bool tiltedGeo(vec2 clip, float h, out float lat, out float lon) {
  return variableGeo(clip, uTiltCam, uHalf.x/uHalf.y, uCurvature, uEye, uForward, uUp, h, lat, lon);
}
bool geoOf(vec2 clip, out float lat, out float lon) {
  if (uTilt == 1) {
    if (!tiltedGeo(clip, 0.0, lat, lon)) return false;
    // A bounded height-field intersection. Elevation stays at physical scale.
    if (uHasTerrain == 1 && uCurvature > 0.05) {
      for (int i = 0; i < 4; i++) {
        vec2 uv = vec2(mod(degrees(lon)-uTerrainBox.x+720.0,360.0)/(uTerrainBox.z-uTerrainBox.x), (degrees(lat)-uTerrainBox.y)/(uTerrainBox.w-uTerrainBox.y));
        if (any(lessThan(uv,vec2(0))) || any(greaterThan(uv,vec2(1)))) break;
        vec2 dem = texture(uTerrain,uv).rg;
        if (dem.g < .95) break;
        float nextLat, nextLon;
        if (!tiltedGeo(clip, max(0.0,dem.r/dem.g), nextLat, nextLon)) break;
        lat=nextLat; lon=nextLon;
      }
    }
    lat=degrees(lat); lon=degrees(lon); return true;
  }
  float x = uCenter.x + clip.x * uHalf.x;
  float y = uCenter.y + clip.y * uHalf.y;
  if (uProjection == 1) {
    lat = y;
    lon = uLon0 + x / uF;
    return lat >= -90.0 && lat <= 90.0;
  }
  float dx = x;
  float dy = uRho0 - y;
  float theta = uN < 0.0 ? atan(-dx, -dy) : atan(dx, dy);
  float rho = (uN < 0.0 ? -1.0 : 1.0) * length(vec2(dx, dy));
  if (abs(rho) < 1e-6) return false;
  float base = uF / rho;
  if (!(base > 0.0)) return false;
  float t = pow(base, 1.0 / uN);
  lat = degrees(2.0 * atan(t) - 1.57079632679);
  lon = uLon0 + degrees(theta / uN);
  return true;
}

float tap(usampler2D tex, int x, int y) {
  if (uWrap == 1) {
    x = int(mod(mod(float(x), uSize.x) + uSize.x, uSize.x));
    y = clamp(y, 0, int(uSize.y) - 1);
  }
  if (x < 0 || y < 0 || float(x) >= uSize.x || float(y) >= uSize.y) return -1e30;
  uint raw = texelFetch(tex, ivec2(x, y), 0).r;
  if (raw == uint(uQuant.z)) return -1e30;
  return float(raw) * uQuant.x + uQuant.y;
}

float sampleField(usampler2D tex, float gx, float gy) {
  int x0 = int(floor(gx));
  int y0 = int(floor(gy));
  float tx = gx - floor(gx);
  float ty = gy - floor(gy);
  float a = tap(tex, x0, y0);
  float b = tap(tex, x0 + 1, y0);
  float c = tap(tex, x0, y0 + 1);
  float d = tap(tex, x0 + 1, y0 + 1);
  float n0 = tap(tex, x0 - 1, y0 - 1);
  float n1 = tap(tex, x0 - 1, y0);
  float n2 = tap(tex, x0 - 1, y0 + 1);
  float n3 = tap(tex, x0 - 1, y0 + 2);
  float s0 = tap(tex, x0, y0 - 1);
  float s3 = tap(tex, x0, y0 + 2);
  float t0 = tap(tex, x0 + 1, y0 - 1);
  float t3 = tap(tex, x0 + 1, y0 + 2);
  float u0 = tap(tex, x0 + 2, y0 - 1);
  float u1 = tap(tex, x0 + 2, y0);
  float u2 = tap(tex, x0 + 2, y0 + 1);
  float u3 = tap(tex, x0 + 2, y0 + 2);
  bool hole = n0 < -1e20 || n1 < -1e20 || n2 < -1e20 || n3 < -1e20
    || s0 < -1e20 || a < -1e20 || c < -1e20 || s3 < -1e20
    || t0 < -1e20 || b < -1e20 || d < -1e20 || t3 < -1e20
    || u0 < -1e20 || u1 < -1e20 || u2 < -1e20 || u3 < -1e20;
  if (!hole) {
    float c0 = cubic(n0, n1, n2, n3, ty);
    float c1 = cubic(s0, a, c, s3, ty);
    float c2 = cubic(t0, b, d, t3, ty);
    float c3 = cubic(u0, u1, u2, u3, ty);
    return cubic(c0, c1, c2, c3, tx);
  }
  // A 0.25° cell is huge at city scale. Where the 4×4 neighbourhood is missing
  // but the cell itself is present, bilinear keeps the edge from going blocky.
  if (a < -1e20 || b < -1e20 || c < -1e20 || d < -1e20) return -1e30;
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

${IMAGERY_MATERIAL_GLSL}

// Restrained hypsometric steps over the Bureau land tint: a touch deeper ochre
// in the foothills, buff in the ranges, pale stone on the high peaks.
const vec3 HILL_DAY = vec3(0.920, 0.880, 0.680);
const vec3 RANGE_DAY = vec3(0.855, 0.808, 0.690);
const vec3 PEAK_DAY = vec3(0.945, 0.940, 0.920);
const vec3 HILL_NIGHT = vec3(0.448, 0.382, 0.246);
const vec3 RANGE_NIGHT = vec3(0.470, 0.425, 0.335);
const vec3 PEAK_NIGHT = vec3(0.560, 0.550, 0.520);

vec3 hypsometric(vec3 low, float metres) {
  vec3 hill = mix(HILL_DAY, HILL_NIGHT, uDark);
  vec3 range = mix(RANGE_DAY, RANGE_NIGHT, uDark);
  vec3 peak = mix(PEAK_DAY, PEAK_NIGHT, uDark);
  vec3 c = mix(low, hill, smoothstep(40.0, 450.0, metres));
  c = mix(c, range, smoothstep(600.0, 2000.0, metres));
  return mix(c, peak, smoothstep(2400.0, 3800.0, metres));
}

// Coverage-weighted elevation: uncovered texels are (0, 0), so R/G is the mean of the covered ones.
vec2 terrainAt(vec2 uv) {
  vec2 t = texture(uTerrain, uv).rg;
  return vec2(t.g > 0.001 ? t.r / t.g : 0.0, t.g);
}

vec4 tint(int field, float value) {
  if (value < -1e20) return vec4(0.0);
${fieldStopsToGlsl('rain', 1)}
${fieldStopsToGlsl('temp', 2)}
  if (uKite == 1) {
    if (value < 0.0) return vec4(0.0);
    // Same integer knot the sheet prints. A gust that reads as the upper limit is inside.
    float shown = floor(value + 0.5);
    vec3 ink = shown < uKiteBand.x ? vec3(${kiteBandColor('below')!.map((v) => (v / 255).toFixed(8)).join(', ')})
      : shown > uKiteBand.y ? vec3(${kiteBandColor('above')!.map((v) => (v / 255).toFixed(8)).join(', ')})
      : vec3(${kiteBandColor('inside')!.map((v) => (v / 255).toFixed(8)).join(', ')});
    return vec4(ink, 0.4);
  }
  // Light speed tint. The moving streaks carry the wind; this only hints at strength.
${fieldStopsToGlsl('wind', 3)}
  return vec4(0.0);
}

void main() {
  float lat;
  float lon;
  vec3 SEA = mix(SEA_DAY, SEA_NIGHT, uDark);
  vec3 LANDC = mix(LAND_DAY, LAND_NIGHT, uDark);
  float fieldNeutral = (uField == 1 || uField == 2) ? uFieldAlpha : 0.0;
  SEA = mix(SEA, mix(FIELD_SEA_DAY, FIELD_SEA_NIGHT, uDark), fieldNeutral);
  LANDC = mix(LANDC, mix(FIELD_LAND_DAY, FIELD_LAND_NIGHT, uDark), fieldNeutral);
  if (!geoOf(vClip, lat, lon)) {
    vec3 sky = mix(vec3(.83,.89,.93),vec3(.035,.065,.10),uDark);
    oColor = vec4(uTilt == 1 ? sky : SEA, 1.0);
    return;
  }
  float sampleLon = lon;
  if (uWrap == 1) {
    sampleLon = uOrigin.x + mod(mod(sampleLon - uOrigin.x, 360.0) + 360.0, 360.0);
  }
  float lu = (sampleLon - uLandBox.x) / (uLandBox.z - uLandBox.x);
  float lv = (lat - uLandBox.y) / (uLandBox.w - uLandBox.y);
  float land = 0.0;
  if (lu >= 0.0 && lv >= 0.0 && lu <= 1.0 && lv <= 1.0) land = texture(uLand, vec2(lu, lv)).r;
  float landF = smoothstep(0.35, 0.65, land);
  vec3 landColour = LANDC;
  if (uHasTerrain == 1 && uRelief > 0.0) {
    float tu = mod(mod(lon - uTerrainBox.x, 360.0) + 360.0, 360.0) / (uTerrainBox.z - uTerrainBox.x);
    float tv = (lat - uTerrainBox.y) / (uTerrainBox.w - uTerrainBox.y);
    if (tu >= 0.0 && tu <= 1.0 && tv >= 0.0 && tv <= 1.0) {
      vec2 uv = vec2(tu, tv);
      vec2 here = terrainAt(uv);
      if (here.y > 0.001) {
        // Land and sea from the DEM where it has data (sea is 0 m; land below
        // sea level is still land), the coastline mask elsewhere.
        float demLand = smoothstep(0.25, 1.0, abs(here.x));
        landF = mix(landF, demLand, here.y * clamp(uRelief * 3.0, 0.0, 1.0));
        vec2 e = terrainAt(uv + vec2(uTerrainTexel.x, 0.0));
        vec2 w = terrainAt(uv - vec2(uTerrainTexel.x, 0.0));
        vec2 n = terrainAt(uv + vec2(0.0, uTerrainTexel.y));
        vec2 s = terrainAt(uv - vec2(0.0, uTerrainTexel.y));
        float cover = min(min(e.y, w.y), min(n.y, s.y));
        float dx = uTerrainTexel.x * (uTerrainBox.z - uTerrainBox.x) * 111320.0 * max(cos(radians(lat)), 0.05);
        float dy = uTerrainTexel.y * (uTerrainBox.w - uTerrainBox.y) * 110574.0;
        // Coarse texels flatten slopes; exaggerate with texel size so relief reads at every zoom.
        float exaggeration = clamp(sqrt(dy / 100.0), 1.5, 8.0);
        float gx = (e.x - w.x) / (2.0 * dx) * exaggeration;
        float gy = (n.x - s.x) / (2.0 * dy) * exaggeration;
        vec3 normal = normalize(vec3(-gx, -gy, 1.0));
        // Multi-directional light (azimuth 225/270/315/360°, 45° up): soft, no single harsh shadow side.
        float shade = 0.15 * max(dot(normal, vec3(-0.5, -0.5, 0.7071)), 0.0)
          + 0.25 * max(dot(normal, vec3(-0.7071, 0.0, 0.7071)), 0.0)
          + 0.40 * max(dot(normal, vec3(-0.5, 0.5, 0.7071)), 0.0)
          + 0.20 * max(dot(normal, vec3(0.0, 0.7071, 0.7071)), 0.0);
        // Oblique distant pixels can span many DEM texels. Fade unresolved
        // relief contrast instead of amplifying alternating slope samples.
        float footprint=max(length(dFdx(uv)/uTerrainTexel),length(dFdy(uv)/uTerrainTexel));
        float resolved=uTilt==1?1.0-smoothstep(2.0,10.0,footprint):1.0;
        float delta = (shade - 0.7071) * uRelief * cover * mix(1.0, 0.45, fieldNeutral) * resolved;
        vec3 tinted = mix(LANDC, hypsometric(LANDC, here.x), uRelief * here.y * mix(1.0, 0.25, fieldNeutral));
        float darken = mix(0.75, 0.9, uDark);
        float lighten = mix(0.4, 0.25, uDark);
        landColour = tinted * (1.0 + darken * min(delta, 0.0)) + (vec3(1.0) - tinted) * lighten * max(delta, 0.0);
      }
    }
  }
  if (uHasWater == 1) {
    float wu = (sampleLon - uWaterBox.x) / (uWaterBox.z - uWaterBox.x);
    float wv = (lat - uWaterBox.y) / (uWaterBox.w - uWaterBox.y);
    if (wu >= 0.0 && wu <= 1.0 && wv >= 0.0 && wv <= 1.0 && texture(uWater, vec2(wu, wv)).r > 0.5) landF = 0.0;
  }
  vec3 base = mix(SEA, landColour, landF);
  if (uHasImagery == 1) {
    vec4 photo=imageryColour(lon,lat);
    // The source already contains cast shadows; avoid shading it twice.
    vec3 photographic=photo.rgb*mix(1.0,.55,uDark);
    base=mix(base,photographic,photo.a);
  }
  if (uTilt == 1) {
    // Local aerial perspective suppresses unresolved distant relief, without
    // altering elevations or weather fields. Global overview remains unchanged.
    vec2 delta=vec2(mod(radians(lon)-uTiltCam.y+3.14159265,6.2831853)-3.14159265,radians(lat)-uTiltCam.x);
    delta.x*=cos(uTiltCam.x);
    float range=length(delta)*6371000.0;
    float haze=smoothstep(2.0,8.0,range/max(500.0,uTiltCam.z*6371000.0))*.85*(1.0-smoothstep(.004,.02,uTiltCam.z));
    base=mix(base,mix(vec3(.83,.89,.93),vec3(.035,.065,.10),uDark),haze);
  }
  if (uHasField == 1 && uField != 0) {
    float gx = (sampleLon - uOrigin.x) / uStep.x;
    float gy = (lat - uOrigin.y) / uStep.y;
    // Keep the exact polar sample; tap() repeats boundary neighbours only.
    float a = sampleField(uA, gx, gy);
    float b = sampleField(uB, gx, gy);
    if (a > -1e20 && b > -1e20) {
      vec4 colour = tint(uField, mix(a, b, uBlend));
      // The field fades out over the last half degree of the data grid; the camera keeps that edge off screen.
      float edge = min(gy, uSize.y - 1.0 - gy);
      if (uWrap == 0) edge = min(edge, min(gx, uSize.x - 1.0 - gx));
      float cover = uWrap == 1 ? 1.0 : smoothstep(0.0, 2.0, edge);
      base = mix(base, colour.rgb, colour.a * cover * uFieldAlpha);
    }
  }
  // A soft foreground window reveals overlaid air; DEM sampling stays intact.
  float window = (1.0-smoothstep(-0.85, 0.2, vClip.y)) * exp(-vClip.x*vClip.x*1.5) * uCutaway;
  base = mix(base, mix(vec3(.83,.89,.93),vec3(.035,.065,.10),uDark), window*.96);
  oColor = vec4(base, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'shader compile failed';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

export interface GlChart {
  draw(view: GlView): void;
  setLand(pixels: Uint8Array, width: number, height: number, box: LandBox): void;
  /** Water mask, row 0 at the south. Null clears it. Lakes force sea after the DEM. */
  setWater(pixels: Uint8Array | null, width: number, height: number, box: LandBox): void;
  setFrames(a: Uint16Array | null, b: Uint16Array | null, nx: number, ny: number): void;
  /** Elevation mosaic for relief; null clears it (flat plate). */
  setTerrain(terrain: TerrainTexture | null): void;
  setImagery(image: ImageBitmap | null, mapping?: ImageryMapping): void;
  /** How many mosaics have finished uploading. */
  terrainEpoch(): number;
  /** Ask the next draw to keep a top-left RGBA copy of the plate. */
  requestPlate(): void;
  takePlate(): { width: number; height: number; data: Uint8ClampedArray } | null;
  resize(width: number, height: number): void;
  destroy(): void;
}

export function createGlChart(canvas: HTMLCanvasElement): GlChart | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;
  return mountChart(gl, canvas);
}

function mountChart(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GlChart | null {
  const program = gl.createProgram();
  if (!program) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texA = gl.createTexture();
  const texB = gl.createTexture();
  const texLand = gl.createTexture();
  const texWater = gl.createTexture();
  let texImagery = gl.createTexture();
  let imagery: ImageryMapping | null = null;
  // Front texture is drawn; a new mosaic fills the back one a slice per frame, then they swap.
  let texTerrain = gl.createTexture();
  let texTerrainBack = gl.createTexture();
  const uniformLocations = new Map<string, WebGLUniformLocation | null>();
  const loc = (name: string) => {
    if (!uniformLocations.has(name)) uniformLocations.set(name, gl.getUniformLocation(program, name));
    return uniformLocations.get(name)!;
  };

  function uploadField(texture: WebGLTexture | null, data: Uint16Array | null, nx: number, ny: number) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (!data) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([65535]));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, nx, ny, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  uploadField(texA, null, 1, 1);
  uploadField(texB, null, 1, 1);
  gl.bindTexture(gl.TEXTURE_2D, texLand);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, texWater);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  for (const texture of [texTerrain, texTerrainBack]) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.HALF_FLOAT, new Uint16Array(2));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  let terrain: { box: LandBox; width: number; height: number } | null = null;
  let pending: (TerrainTexture & { row: number }) | null = null;
  /** Texels uploaded per frame: a large mosaic never stalls one frame. */
  const UPLOAD_TEXELS = 600_000;
  let terrainEpoch = 0;
  let wantPlate = false;
  let plate: { width: number; height: number; data: Uint8ClampedArray } | null = null;

  function uploadTerrainSlice() {
    if (!pending) return;
    const next = pending;
    gl.bindTexture(gl.TEXTURE_2D, texTerrainBack);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (next.row === 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, next.width, next.height, 0, gl.RG, gl.HALF_FLOAT, null);
    const rows = Math.max(1, Math.min(next.height - next.row, Math.floor(UPLOAD_TEXELS / next.width)));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, next.row, next.width, rows, gl.RG, gl.HALF_FLOAT, next.data.subarray(next.row * next.width * 2, (next.row + rows) * next.width * 2));
    next.row += rows;
    if (next.row < next.height) return;
    [texTerrain, texTerrainBack] = [texTerrainBack, texTerrain];
    terrain = { box: { ...next.box }, width: next.width, height: next.height };
    pending = null;
    terrainEpoch += 1;
  }

  let hasField = 0;
  gl.bindTexture(gl.TEXTURE_2D, texImagery);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  let hasWater = 0;
  let landBox: LandBox = { west: 0, south: 0, east: 1, north: 1 };
  let waterBox: LandBox = { west: 0, south: 0, east: 1, north: 1 };
  let size = { nx: 1, ny: 1 };

  return {
    resize(width: number, height: number) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    },
    setLand(pixels: Uint8Array, width: number, height: number, box: LandBox) {
      landBox = { west: box.west, south: box.south, east: box.east, north: box.north };
      gl.bindTexture(gl.TEXTURE_2D, texLand);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    },
    setWater(pixels, width, height, box) {
      waterBox = { west: box.west, south: box.south, east: box.east, north: box.north };
      hasWater = pixels && width > 1 && height > 1 ? 1 : 0;
      gl.bindTexture(gl.TEXTURE_2D, texWater);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (!pixels || !hasWater) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },
    setImagery(image, mapping) {
      imagery = image && mapping ? mapping : null;
      if(!imagery){gl.deleteTexture(texImagery);texImagery=gl.createTexture();}
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, texImagery);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (image && mapping) {
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
        gl.generateMipmap(gl.TEXTURE_2D);
      } else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,imagery?gl.LINEAR_MIPMAP_LINEAR:gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
    },
    setTerrain(next: TerrainTexture | null) {
      if (!next) {
        terrain = null;
        pending = null;
        return;
      }
      // A newer mosaic replaces one still uploading; the first slice goes up now.
      pending = { ...next, row: 0 };
      uploadTerrainSlice();
    },
    setFrames(a: Uint16Array | null, b: Uint16Array | null, nx: number, ny: number) {
      size = { nx, ny };
      hasField = a && b ? 1 : 0;
      uploadField(texA, a, nx, ny);
      uploadField(texB, b, nx, ny);
    },
    draw(view: GlView) {
      uploadTerrainSlice();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texLand);
      gl.uniform1i(loc('uA'), 0);
      gl.uniform1i(loc('uB'), 1);
      gl.uniform1i(loc('uLand'), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, texTerrain);
      gl.uniform1i(loc('uTerrain'), 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, texWater);
      gl.uniform1i(loc('uWater'), 4);
      gl.uniform1i(loc('uHasWater'), hasWater);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D,texImagery);
      gl.uniform1i(loc('uImagery'),5);
      gl.uniform1i(loc('uHasImagery'),imagery?1:0);
      if(imagery){
        gl.uniform2fv(loc('uImageryOrigin'),imagery.origin);
        gl.uniform2fv(loc('uImageryEdge'),imagery.edgeUv);
        gl.uniform3fv(loc('uImageryU0'),imagery.u.slice(0,3));gl.uniform3fv(loc('uImageryU1'),imagery.u.slice(3));
        gl.uniform3fv(loc('uImageryV0'),imagery.v.slice(0,3));gl.uniform3fv(loc('uImageryV1'),imagery.v.slice(3));
      }
      gl.uniform4f(loc('uWaterBox'), waterBox.west, waterBox.south, waterBox.east, waterBox.north);
      gl.uniform1i(loc('uHasTerrain'), terrain ? 1 : 0);
      gl.uniform1f(loc('uRelief'), terrain ? Math.max(0, Math.min(1, view.relief ?? 0)) : 0);
      if (terrain) {
        gl.uniform4f(loc('uTerrainBox'), terrain.box.west, terrain.box.south, terrain.box.east, terrain.box.north);
        gl.uniform2f(loc('uTerrainTexel'), 1 / terrain.width, 1 / terrain.height);
      }
      gl.uniform1f(loc('uBlend'), view.blend);
      gl.uniform1i(loc('uKite'), view.field === 'wind' && view.kiteBand ? 1 : 0);
      gl.uniform2f(loc('uKiteBand'), view.kiteBand?.min ?? 15, view.kiteBand?.max ?? 25);
      gl.uniform1i(loc('uField'), view.field === 'rain' ? 1 : view.field === 'temp' ? 2 : view.field === 'wind' ? 3 : 0);
      gl.uniform1i(loc('uHasField'), hasField);
      gl.uniform1f(loc('uFieldAlpha'), view.fieldAlpha == null ? 1 : Math.max(0, Math.min(1, view.fieldAlpha)));
      gl.uniform2f(loc('uOrigin'), view.west, view.north);
      gl.uniform2f(loc('uStep'), view.dlon, view.dlat);
      gl.uniform2f(loc('uSize'), size.nx, size.ny);
      gl.uniform3f(loc('uQuant'), view.scale, view.offset, view.fill);
      gl.uniform4f(loc('uLandBox'), landBox.west, landBox.south, landBox.east, landBox.north);
      gl.uniform1i(loc('uTilt'), view.tiltCamera ? 1 : 0);
      if (view.tiltCamera) {
        const c = view.tiltCamera, g = c.geometry;
        gl.uniform4f(loc('uTiltCam'), c.lat * Math.PI/180, c.lon * Math.PI/180, c.halfHeightRadians, c.tiltRadians);
        gl.uniform1f(loc('uCurvature'), g.curvature);
        gl.uniform3f(loc('uEye'), ...g.cameraPositionNormalized);
        gl.uniform3f(loc('uForward'), ...g.forward);
        gl.uniform3f(loc('uUp'), ...g.up);
      }
      gl.uniform2f(loc('uCenter'), view.centerX, view.centerY);
      gl.uniform2f(loc('uHalf'), view.halfWidth, view.halfHeight);
      gl.uniform1f(loc('uLon0'), view.lambert.lon0);
      gl.uniform1f(loc('uN'), view.lambert.n);
      gl.uniform1f(loc('uF'), view.lambert.F);
      gl.uniform1f(loc('uRho0'), view.lambert.rho0);
      gl.uniform1f(loc('uDark'), view.dark ? 1 : 0);
      gl.uniform1f(loc('uCutaway'), Math.max(0,Math.min(1,view.cutaway??0)));
      gl.uniform1i(loc('uProjection'), view.lambert.projection === 'equirectangular' ? 1 : 0);
      gl.uniform1i(loc('uWrap'), view.wrapsLongitude ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (wantPlate) {
        const width = canvas.width;
        const height = canvas.height;
        const raw = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const data = new Uint8ClampedArray(raw.length);
        const row = width * 4;
        for (let y = 0; y < height; y += 1) data.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        plate = { width, height, data };
        wantPlate = false;
      }
    },
    terrainEpoch() { return terrainEpoch; },
    requestPlate() { wantPlate = true; },
    takePlate() {
      const shot = plate;
      plate = null;
      return shot;
    },
    destroy() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteTexture(texA);
      gl.deleteTexture(texB);
      gl.deleteTexture(texLand);
      gl.deleteTexture(texWater);
      gl.deleteTexture(texImagery);
      gl.deleteTexture(texTerrain);
      gl.deleteTexture(texTerrainBack);
    },
  };
}
