/** Visual data follows the generated numbers through retests and transfers. */
import type { FigureDiagram } from '../figure.ts';
import type { Drill } from './types.ts';

export function diagramFor(drill: Omit<Drill, 'id'>): FigureDiagram | undefined {
  const g = drill.given;
  if (['wind-component', 'groundspeed', 'zone-time', 'zone-fuel'].includes(drill.skill) && g.windFromDeg != null) {
    const track = ((g.trackDeg! + (g.variationEast ?? 0)) % 360 + 360) % 360;
    const tas = g.tasKt ?? (g.mach != null ? g.mach * Math.sqrt(1.4 * 287.05287 * (g.oatC! + 273.15)) / 0.514444 : undefined);
    return { kind: 'wind', track, from: g.windFromDeg, speed: g.windKt!, ...(tas != null ? { tas } : {}) };
  }
  if (drill.skill === 'etp' || drill.skill === 'pnr') {
    const isEtp = drill.skill === 'etp';
    return {
      kind: 'route', point: isEtp ? 'ETP' : 'PNR', distance: drill.answer,
      end: isEtp ? g.distNm ?? g.d1! + g.d2! : Math.ceil(drill.answer / 100) * 100 + 100,
      ...(g.d1 != null ? { boundary: g.d1 } : {}),
      endLabel: isEtp ? 'Destination' : 'Route →',
    };
  }
  return undefined;
}
