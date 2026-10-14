import {mapProject, mapUnproject, type Camera, type Lambert} from './lambert';
import {type DrawnLabel, type LabelBox, DAY_INK, NIGHT_INK} from './overlay';
import {formatIsobar, type UnitSpec} from './units';
import {createAnimatedPressureLabelState, updateAnimatedPressureLabels, paintAnimatedPressureLabels, type AnimatedPressureLabelCandidate, type AnimatedPressureLabel} from './animated-pressure-labels';

/** Labels have their own cheap per-frame surface; coast/town placement stays cached. */
export function createPressureLabelLayer(after: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.dataset.pressureLabels = '';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none'});
  after.after(canvas);
  let state = createAnimatedPressureLabelState(), serial = 0;
  let candidates: AnimatedPressureLabelCandidate[] = [], labels: AnimatedPressureLabel[] = [];
  const placementMisses = new Map<string, number>();
  return {
    canvas,
    place(boxes: DrawnLabel[], levels: number[], geo: Lambert, camera: Camera, width: number, height: number, units: UnitSpec) {
      const unused = new Set(state.labels.keys());
      const fresh = boxes.flatMap(box => {
        const kind = /^[HL] /.test(box.text) ? 'centre' : 'isobar';
        const level = kind === 'isobar' ? levels.find(level => formatIsobar(level, units) === box.text) : undefined;
        if (kind === 'isobar' && level === undefined) return [];
        const x = box.x + box.w/2, y = box.y + (kind === 'centre' ? 26 : box.h/2);
        const point = mapUnproject(geo, camera, x/width*2-1, 1-y/height*2);
        if (!point) return [];
        let key: string | undefined, distance = Infinity;
        for (const id of unused) {
          const old = state.labels.get(id)!;
          if (old.kind !== kind || (kind === 'isobar' ? old.level !== level : old.text[0] !== box.text[0])) continue;
          const projected = mapProject(geo,camera,old.lat,old.lon);
          if (!projected) continue;
          const d = Math.hypot((projected.x+1)*width/2-x,(1-projected.y)*height/2-y);
          if (kind === 'centre' && d > 80) continue;
          if (d < distance) { distance=d; key=id; }
        }
        if (key) unused.delete(key); else key = String(++serial);
        return [{...box,key,kind: kind as 'isobar' | 'centre',level,lon:point.lon,lat:point.lat}];
      });
      const replacement = (old: AnimatedPressureLabelCandidate) => fresh.some((next) => {
        if (next.kind !== old.kind) return false;
        if (next.kind === 'isobar' && next.level !== old.level) return false;
        if (next.kind === 'centre' && next.text[0] !== old.text[0]) return false;
        const a = mapProject(geo, camera, old.lat!, old.lon!);
        const b = mapProject(geo, camera, next.lat!, next.lon!);
        if (!a || !b) return false;
        return Math.hypot((a.x - b.x) * width / 2, (a.y - b.y) * height / 2) < 100;
      });
      const retained = candidates.filter((old) => {
        if (fresh.some((next) => next.key === old.key) || replacement(old)) {
          placementMisses.delete(old.key!);
          return false;
        }
        const misses = placementMisses.get(old.key!) ?? 0;
        if (misses >= 2) { placementMisses.delete(old.key!); return false; }
        placementMisses.set(old.key!, misses + 1);
        return true;
      });
      candidates = [...fresh, ...retained];
    },
    draw(geo: Lambert, camera: Camera, width: number, height: number, dpr: number, sample: ((lon:number,lat:number)=>number|null)|undefined, step: number, dark: boolean, units: UnitSpec, avoid: LabelBox[], enabled: boolean) {
      const w=Math.round(width*dpr),h=Math.round(height*dpr);
      if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
      const ctx=canvas.getContext('2d');if(!ctx)return;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
      if(!enabled){labels=[];return;}
      const frame=updateAnimatedPressureLabels(state,candidates,{geo,camera,width,height,pressureSample:sample,pressureStep:step,avoid,formatPressure:hpa=>formatIsobar(hpa,units)});
      state=frame.state;labels=frame.labels;
      paintAnimatedPressureLabels(ctx,labels,dark?NIGHT_INK:DAY_INK);
    },
    labels: () => labels,
    reset() {state=createAnimatedPressureLabelState();candidates=[];labels=[];placementMisses.clear();},
    destroy() {canvas.remove();},
  };
}
