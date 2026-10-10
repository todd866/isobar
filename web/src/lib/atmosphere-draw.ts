/** Formal representative column. Horizontal shape is illustrative; heights are AMSL. */
import { mapProject, type Camera, type Lambert } from './lambert';
import type { AtmosphereProfile } from './atmosphere-profile';

export interface AtmosphereDrawing {
  profile: AtmosphereProfile;
  lat: number; lon: number;
  aircraftM: number;
  geo: Lambert; camera: Camera;
  width: number; height: number; dark: boolean;
}

/** A small, deterministic envelope, not a forecast footprint or a convective-cell diagnosis. */
export function drawAtmosphere(ctx: CanvasRenderingContext2D, input: AtmosphereDrawing): { layers: number; flows: number } {
  const { profile, lat, lon, camera, geo, width, height, dark } = input;
  const screen = (east: number, north: number, z: number) => {
    const p = mapProject(geo, camera, lat + north / 111132, lon + east / (111320 * Math.max(.1, Math.cos(lat * Math.PI / 180))), z);
    return p && { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
  };
  const ground = profile.terrainM;
  const foot = screen(0, 0, ground ?? 0);
  if (!foot || foot.x < -width || foot.x > 2 * width || foot.y < -height || foot.y > 2 * height) return { layers: 0, flows: 0 };
  const ink = dark ? '#d4e5ec' : '#334f60';
  const cloud = dark ? 'rgba(203,221,227,.24)' : 'rgba(255,255,255,.76)';
  const radius = 4500;
  let drawn = 0, flows = 0;
  const line = (a: ReturnType<typeof screen>, b: ReturnType<typeof screen>) => {
    if (!a || !b) return;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  line(foot, screen(0, 0, Math.max(input.aircraftM, ...profile.layers.map(l => l.topM), 3000)));
  ctx.setLineDash([]);
  // Back-to-front horizontal faces and sides. No displaced footprint/photographic cloud texture.
  for (const layer of profile.layers) {
    const bottom = [], top = [];
    for (let i = 0; i < 40; i++) {
      const angle = i / 40 * Math.PI * 2;
      const east = Math.cos(angle) * radius, north = Math.sin(angle) * radius * .6;
      bottom.push(screen(east, north, layer.baseM));
      top.push(screen(east * .85, north * .85, layer.topM));
    }
    if (bottom.some(p => !p) || top.some(p => !p)) continue;
    ctx.fillStyle = cloud; ctx.strokeStyle = dark ? 'rgba(218,236,241,.48)' : 'rgba(88,122,143,.45)';
    ctx.beginPath();
    bottom.forEach((p, i) => { if (i === 0) ctx.moveTo(p!.x, p!.y); else ctx.lineTo(p!.x, p!.y); });
    ctx.closePath(); ctx.stroke();
    // The camera tilts from the south; the southern half is the near wall.
    for (let i = 20; i < 40; i++) {
      const next = (i + 1) % 40;
      const a = bottom[i]!, b = bottom[next]!, c = top[next]!, d = top[i]!;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); top.forEach((p, i) => { if (i === 0) ctx.moveTo(p!.x, p!.y); else ctx.lineTo(p!.x, p!.y); });
    ctx.closePath(); ctx.fill(); ctx.stroke(); drawn++;
  }
  // Horizontal and vertical vectors always come from the same pressure level.
  for (const level of profile.levels.filter((_, i) => i % 2 === 0)) {
    if (ground != null && level.heightM < ground) continue;
    if (level.windKt == null || level.windFromDeg == null) continue;
    const angle = level.windFromDeg * Math.PI / 180;
    const u = -Math.sin(angle) * level.windKt * .514444;
    const v = -Math.cos(angle) * level.windKt * .514444;
    const duration = 180;
    const w = level.verticalVelocityMs;
    const a = screen(-radius * 1.3, 0, level.heightM);
    const b = screen(-radius * 1.3 + u * duration, v * duration, level.heightM + (w ?? 0) * duration);
    if (!a || !b) continue;
    ctx.strokeStyle = w == null ? (dark ? '#a8b7bf' : '#667b86') : w > .001 ? '#bf752f' : w < -.001 ? '#277b9a' : ink;
    ctx.lineWidth = 1.5; line(a, b);
    const bearing = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath(); ctx.moveTo(b.x - 4 * Math.cos(bearing - .55), b.y - 4 * Math.sin(bearing - .55)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - 4 * Math.cos(bearing + .55), b.y - 4 * Math.sin(bearing + .55)); ctx.stroke();
    flows++;
  }
  const plane = screen(0, 0, input.aircraftM);
  if (plane) {
    // Physical 11 m span nearby; at distance this is explicitly an altitude marker.
    const wing = screen(5.5, 0, input.aircraftM);
    const span = wing ? Math.hypot(wing.x - plane.x, wing.y - plane.y) * 2 : 0;
    const scale = Math.max(12, span) / 24;
    ctx.save(); ctx.translate(plane.x, plane.y); ctx.scale(scale, scale);
    ctx.fillStyle = dark ? '#f3b971' : '#99541e'; ctx.strokeStyle = dark ? '#20313d' : '#fff'; ctx.lineWidth = 2 / scale;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(2, -2); ctx.lineTo(12, 1); ctx.lineTo(12, 3); ctx.lineTo(2, 2); ctx.lineTo(1, 8); ctx.lineTo(5, 10); ctx.lineTo(-5, 10); ctx.lineTo(-1, 8); ctx.lineTo(-2, 2); ctx.lineTo(-12, 3); ctx.lineTo(-12, 1); ctx.lineTo(-2, -2); ctx.closePath(); ctx.stroke(); ctx.fill(); ctx.restore();
  }
  ctx.restore();
  return { layers: drawn, flows };
}
