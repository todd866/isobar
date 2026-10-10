import { classifyLayer, coverageFraction, coverageSegments, precipitationBands } from './rules.mjs';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => x * x * (3 - 2 * x);
const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy);
  return (hash(ix, iy) * (1 - u) + hash(ix + 1, iy) * u) * (1 - v)
    + (hash(ix, iy + 1) * (1 - u) + hash(ix + 1, iy + 1) * u) * v;
}
function fbm(x, y) {
  let value = 0, weight = 0.5;
  for (let octave = 0; octave < 5; octave++) {
    value += weight * noise(x, y); x = x * 2.03 + 13; y = y * 2.03 + 7; weight *= 0.5;
  }
  return value;
}
function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c;
}
export function yForFt(ft, height) {
  if (typeof ft !== 'number' || !Number.isFinite(ft)) return null;
  return height - 22 - (height - 36) * Math.log1p(Math.max(0, ft) / 5000) / Math.log(10);
}

/** Shared outline: style changes texture, never meteorological geometry. */
function silhouette(genus, w, h, seed) {
  const p = new Path2D();
  if (genus === 'cumulonimbus') {
    // Thin spreading ice anvil above a lobed convective column, flat rain base.
    p.moveTo(0, h * .08); p.bezierCurveTo(w * .13, h * .04, w * .2, h * .06, w * .29, h * .03);
    p.bezierCurveTo(w * .45, h * .015, w * .55, 0, w * .67, 0);
    p.bezierCurveTo(w * .83, h * .035, w * .93, h * .015, w, h * .02);
    p.bezierCurveTo(w * .93, h * .15, w * .72, h * .14, w * .62, h * .18);
    p.bezierCurveTo(w * .73, h * .22, w * .69, h * .33, w * .64, h * .34);
    p.bezierCurveTo(w * .79, h * .35, w * .78, h * .48, w * .68, h * .5);
    p.bezierCurveTo(w * .8, h * .56, w * .77, h * .68, w * .73, h * .71);
    p.bezierCurveTo(w * .89, h * .72, w * .82, h * .88, w, h * .95);
    p.lineTo(w, h); p.lineTo(0, h); p.lineTo(0, h * .95);
    p.bezierCurveTo(w * .04, h * .84, w * .13, h * .83, w * .23, h * .85);
    p.bezierCurveTo(w * .15, h * .67, w * .33, h * .64, w * .29, h * .57);
    p.bezierCurveTo(w * .2, h * .51, w * .26, h * .4, w * .37, h * .4);
    p.bezierCurveTo(w * .3, h * .29, w * .39, h * .21, w * .46, h * .2);
    p.bezierCurveTo(w * .32, h * .18, w * .07, h * .17, 0, h * .08); p.closePath(); return p;
  }
  if (genus === 'cumulus' || genus === 'towering-cumulus') {
    p.moveTo(0, h); p.bezierCurveTo(0, h * .6, w * .1, h * .46, w * .2, h * .61);
    p.bezierCurveTo(w * .13, h * .14, w * .35, h * .06, w * .4, h * .29);
    p.bezierCurveTo(w * .4, -h * .08, w * .7, -h * .05, w * .72, h * .38);
    p.bezierCurveTo(w * .88, h * .24, w * .92, h * .58, w * .9, h * .64);
    p.bezierCurveTo(w, h * .61, w, h * .84, w, h); p.closePath(); return p;
  }
  p.moveTo(0, h * .24);
  for (let x = 2; x < w - 2; x += 2) p.lineTo(x, h * (.045 + .08 * noise(x / 43 + seed, 5) + .035 * noise(x / 9, seed)));
  p.quadraticCurveTo(w, h * .12, w, h * .3); p.lineTo(w, h * .9);
  p.quadraticCurveTo(w, h, w - 3, h); p.lineTo(3, h); p.quadraticCurveTo(0, h, 0, h * .87); p.closePath(); return p;
}

function cirrus(ctx, x, y, w, h, dark, flat) {
  ctx.save(); ctx.translate(x, y);
  for (let i = 0; i < (flat ? 4 : 22); i++) {
    const t = i / (flat ? 4 : 22);
    ctx.strokeStyle = dark ? `rgba(217,224,230,${flat ? .72 : .16})` : `rgba(251,253,255,${flat ? .95 : .25})`;
    ctx.lineWidth = flat ? 1.25 : .8 + t * .8;
    ctx.beginPath(); ctx.moveTo(w * t * .12, h * (.7 + t * .2));
    ctx.bezierCurveTo(w * .35, h * (1 - t * .4), w * .6, h * .65, w * (.85 + t * .15), h * t * .35); ctx.stroke();
  }
  ctx.restore();
}

function procedural(ctx, genus, x, y, w, h, dark, seed) {
  if (genus === 'cirrus') return cirrus(ctx, x, y, w, h, dark, false);
  const bitmap = canvas(w * 1.5, h * 1.5), b = bitmap.getContext('2d'), pixels = b.createImageData(bitmap.width, bitmap.height);
  const sheet = genus === 'nimbostratus' || genus === 'stratus';
  const puffs = genus === 'cumulonimbus' ? [
    [.5, .072, .5, .085], // thin spreading anvil
    [.54, .26, .14, .19], [.45, .43, .18, .2], [.57, .55, .2, .2],
    [.47, .7, .22, .28], [.25, .87, .24, .14], [.72, .88, .27, .13],
  ] : [[.19, .77, .2, .24], [.38, .48, .25, .43], [.62, .36, .24, .36], [.81, .7, .19, .32]];
  for (let py = 0; py < bitmap.height; py++) for (let px = 0; px < bitmap.width; px++) {
    const u = px / bitmap.width, v = py / bitmap.height;
    const n = fbm(u * (sheet ? 3 : 6) + seed, v * (sheet ? 8 : 5));
    const detail = fbm(u * 14 + seed, v * 17);
    let density = 0, normal = 0;
    if (sheet) {
      const top = .025 + .035 * noise(u * 8 + seed, 1);
      density = Math.min((v - top) * 12, (1 - v) * 30, u * 22, (1 - u) * 22);
    } else {
      density = -1;
      let normalWeight = 0;
      for (const [cx, cy, rx, ry] of puffs) {
        const d = 1 - ((u - cx) / rx) ** 2 - ((v - cy) / ry) ** 2;
        density = Math.max(density, d);
        const weight = Math.exp(d * 5); normalWeight += weight; normal += -(v - cy) / ry * weight;
      }
      normal /= Math.max(.000001, normalWeight);
      density += (detail - .45) * .48;
      // Condensation boundary clips every lobe to the same flat base.
      density = Math.min(density * 3, (1 - v) * 40, u * 70, (1 - u) * 70);
    }
    // Upper surfaces catch light; the broad flat base stays darker. Ns texture
    // stretches horizontally, so depth never turns a stable deck into turrets.
    let light = 238 - v * (sheet ? 96 : 73) + (n - .48) * (sheet ? 75 : 100) + (detail - .48) * 22 + normal * 24;
    light -= 17 * smooth(clamp((v - .78) / .22));
    if (dark) light = light * .68 + 5;
    const i = (py * bitmap.width + px) * 4;
    pixels.data[i] = clamp(light, 0, 255); pixels.data[i + 1] = clamp(light + 2, 0, 255);
    pixels.data[i + 2] = clamp(light + 4, 0, 255);
    pixels.data[i + 3] = 255 * smooth(clamp(density));
  }
  b.putImageData(pixels, 0, 0);
  ctx.drawImage(bitmap, x, y, w, h);
}

function flat(ctx, genus, x, y, w, h, dark, seed) {
  if (genus === 'cirrus') return cirrus(ctx, x, y, w, h, dark, true);
  ctx.save(); ctx.translate(x, y); const shape = silhouette(genus, w, h, seed);
  ctx.fillStyle = dark ? '#aeb8bf' : '#f1f3f2'; ctx.fill(shape);
  ctx.save(); ctx.clip(shape); ctx.fillStyle = dark ? '#7c8992' : '#bcc7cc';
  ctx.fillRect(0, h * .8, w, h * .2); ctx.restore();
  ctx.strokeStyle = dark ? '#d1d9dd' : '#526c7b'; ctx.lineWidth = 1; ctx.stroke(shape);
  if (genus === 'nimbostratus') {
    ctx.strokeStyle = dark ? '#7d8c96' : '#b0bec5'; ctx.lineWidth = .8;
    for (const v of [.31, .48, .65]) {
      ctx.beginPath(); ctx.moveTo(w * .06, h * v); ctx.bezierCurveTo(w * .37, h * (v - .04), w * .7, h * (v + .04), w * .96, h * v); ctx.stroke();
    }
  }
  ctx.restore();
}

export async function loadSprites() {
  const load = async (name) => { const im = new Image(); im.src = globalThis.CLOUD_SPRITES?.[name] || `./assets/${name}.webp`; await im.decode(); return im; };
  const [atlas, stratus, nimbostratus] = await Promise.all([load('painted-atlas'), load('stratus'), load('nimbostratus')]);
  return prepareSprites({ atlas, stratus, nimbostratus });
}
const spriteCrops = {
  cumulus: [840, 98, 696, 355], cumulonimbus: [0, 533, 768, 442], cirrus: [813, 597, 710, 343],
};
export function prepareSprites(raw) {
  const sprites = {};
  for (const genus of ['stratus', 'nimbostratus', 'cumulus', 'cumulonimbus', 'cirrus']) {
    const image = raw[genus] || raw.atlas, crop = spriteCrops[genus] || [0, 0, image.width, image.height];
    const temp = canvas(crop[2], crop[3]), ctx = temp.getContext('2d'); ctx.drawImage(image, ...crop, 0, 0, temp.width, temp.height);
    const data = ctx.getImageData(0, 0, temp.width, temp.height).data;
    let x0 = temp.width, y0 = temp.height, x1 = 0, y1 = 0;
    // Normalize significant alpha extents, so atlas padding does not silently
    // turn BKN into SCT or move the visible base away from its reported height.
    for (let y = 0; y < temp.height; y++) for (let x = 0; x < temp.width; x++) if (data[(y * temp.width + x) * 4 + 3] >= 32) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < x0 || y1 < y0) throw new Error(`Empty cloud sprite: ${genus}`);
    const trimmed = canvas(x1 - x0 + 1, y1 - y0 + 1); trimmed.getContext('2d').drawImage(temp, x0, y0, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    sprites[genus] = trimmed;
  }
  return sprites;
}
function painted(ctx, sprites, genus, x, y, w, h, dark) {
  ctx.save(); ctx.filter = dark ? 'brightness(0.72)' : 'none';
  // A Cu sprite may stretch into TCU; it must never acquire a CB anvil.
  const image = sprites[genus === 'towering-cumulus' ? 'cumulus' : genus];
  if (image) ctx.drawImage(image, x, y, w, h);
  ctx.restore();
}

function segmentsFor(layer, genus, index) {
  // Cover says how much of the section is filled, not a count of objects. One
  // broad Ns bank preserves stratiform character; a Cb has one coherent anvil.
  if (genus === 'nimbostratus' || genus === 'cumulonimbus' || genus === 'towering-cumulus') {
    const f = coverageFraction(layer.cover); return f == null ? [] : [{ start: (1 - f) / 2, end: (1 + f) / 2 }];
  }
  return coverageSegments(layer.cover, index + 5);
}

/** Style-independent geometry also makes missing-data rendering testable. */
export function sceneGeometry(scene) {
  return scene.layers.flatMap((layer, i) => {
    if (typeof layer.baseFt !== 'number' || !Number.isFinite(layer.baseFt) || layer.baseFt < 0) return [];
    if (layer.topFt != null && (typeof layer.topFt !== 'number' || !Number.isFinite(layer.topFt) || layer.topFt <= layer.baseFt)) return [];
    const genus = classifyLayer(layer, scene.profile).genus, segments = segmentsFor(layer, genus, i);
    if (!segments.length) return [];
    return [{ layer, genus, segments, i, kind: layer.topFt == null || genus === 'unknown' ? 'reported-base' : 'cloud',
      precipitation: precipitationBands(layer, scene.freezingFt), anvil: genus === 'cumulonimbus' && layer.topFt != null }];
  });
}

function rain(ctx, layer, segments, scene, width, height, dark) {
  const left = 42, span = width - left - 12;
  for (const band of precipitationBands(layer, scene.freezingFt)) {
    const top = yForFt(band.topFt, height), bottom = yForFt(band.baseFt, height);
    ctx.save(); ctx.strokeStyle = dark ? '#a9c3d0' : '#4b7e97'; ctx.globalAlpha = .5; ctx.lineWidth = .8;
    for (const segment of segments) {
      // Shafts fall below the cloudy portion. CB's narrow core rains; anvil
      // overhang doesn't become an equally wide rain curtain.
      const cb = layer.reportedType === 'CB'; const inset = cb ? (segment.end - segment.start) * .27 : 0;
      const x0 = left + (segment.start + inset) * span, x1 = left + (segment.end - inset) * span;
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, dark ? '#91a5b447' : '#617d9640'); gradient.addColorStop(1, '#7897b000');
      ctx.fillStyle = gradient; ctx.fillRect(x0, top, x1 - x0, bottom - top);
      ctx.beginPath();
      for (let x = x0 + 4; x < x1 - 3; x += 9) for (let y = top + 3 + (x % 7); y < bottom - 4; y += 12) {
        if (band.phase === 'snow') {
          ctx.moveTo(x - 1.5, y); ctx.lineTo(x + 1.5, y); ctx.moveTo(x, y - 1.5); ctx.lineTo(x, y + 1.5);
        } else if (band.phase === 'rain') { ctx.moveTo(x, y); ctx.lineTo(x - 2, Math.min(y + 6, bottom)); }
        else { ctx.moveTo(x, y); ctx.lineTo(x, y + 1); } // unknown phase: neutral dots, never rain/snow glyphs
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Prepare once. All visible draws are one cached bitmap copy. */
export function prepareScene(scene, style, width, height, dark, sprites, dpr = 2) {
  const output = canvas(width * dpr, height * dpr), ctx = output.getContext('2d'); ctx.scale(dpr, dpr);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, dark ? '#142638' : '#5587b1'); sky.addColorStop(1, dark ? '#354b5c' : '#d9e7ef');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
  ctx.font = '10px ui-monospace, SFMono-Regular, monospace'; ctx.textBaseline = 'middle';
  for (const ft of [0, 5000, 10000, 20000, 40000]) {
    const y = yForFt(ft, height); ctx.fillStyle = dark ? '#b2c5d2' : '#264a64';
    ctx.textAlign = 'right'; ctx.fillText(ft === 0 ? '0' : `${ft / 1000}k`, 33, y);
    ctx.strokeStyle = dark ? '#ffffff12' : '#18374d18'; ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(width - 10, y); ctx.stroke();
  }
  const classified = sceneGeometry(scene);
  for (const { layer, segments } of classified) rain(ctx, layer, segments, scene, width, height, dark);
  for (const { layer, genus, i, segments, kind } of classified.toSorted((a, b) => b.layer.baseFt - a.layer.baseFt)) {
    const bottom = yForFt(layer.baseFt, height);
    for (const segment of segments) {
      const x = 42 + segment.start * (width - 54), w = (segment.end - segment.start) * (width - 54);
      if (kind === 'reported-base') {
        ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#a6b7c1'; ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x + w, bottom); ctx.stroke(); ctx.restore(); continue;
      }
      const top = yForFt(layer.topFt, height), h = bottom - top;
      if (style === 'procedural') procedural(ctx, genus, x, top, w, h, dark, i + 5);
      else if (style === 'painted') painted(ctx, sprites, genus, x, top, w, h, dark);
      else flat(ctx, genus, x, top, w, h, dark, i + 5);
    }
  }
  if (typeof scene.freezingFt === 'number' && Number.isFinite(scene.freezingFt)) {
    const y = yForFt(scene.freezingFt, height); ctx.save(); ctx.strokeStyle = dark ? '#b7daeb' : '#436d85';
    ctx.setLineDash([4, 4]); ctx.lineWidth = .75; ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(width - 12, y); ctx.stroke(); ctx.restore();
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace'; ctx.textAlign = 'right';
    const label = `0 °C · ${(scene.freezingFt / 1000).toFixed(1)}k`;
    const tw = ctx.measureText(label).width; ctx.fillStyle = dark ? '#213c50e8' : '#dceaf3e8'; ctx.fillRect(width - tw - 18, y - 14, tw + 8, 12);
    ctx.fillStyle = dark ? '#e0edf4' : '#234b64'; ctx.fillText(label, width - 14, y - 8);
  }
  const ground = yForFt(0, height); ctx.fillStyle = dark ? '#343d32' : '#c4c7ab'; ctx.fillRect(40, ground, width - 50, 8);
  ctx.fillStyle = dark ? '#b1c0c8' : '#335267'; ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'left'; ctx.fillText('ft AMSL', 6, height - 6); ctx.fillText('W', 42, height - 6);
  ctx.textAlign = 'right'; ctx.fillText('E', width - 12, height - 6); ctx.textAlign = 'center'; ctx.fillText('40 NM', width / 2, height - 6);
  return output;
}
