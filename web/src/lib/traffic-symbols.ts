/** Pure variant-D traffic geometry, classes, altitude bands and palette. */
export type AircraftClass = 'heavy' | 'narrowbody' | 'regional' | 'bizjet' | 'ga' | 'helicopter' | 'unknown';
export type VesselClass = 'tanker' | 'cargo' | 'passenger' | 'fishing' | 'sail' | 'tug';
export type TrafficSymbolClass = AircraftClass | VesselClass;
export type TrafficPoint = readonly [number, number];

/** Exact normalized polygons from web/tools/traffic-sheet/render.py (97c77ea). */
export const TRAFFIC_SHAPES: Readonly<Record<Exclude<TrafficSymbolClass, 'unknown'>, readonly TrafficPoint[]>> = {
  heavy: [[0,-1],[.13,-.77],[.14,-.3],[.88,.12],[.9,.35],[.14,.06],[.13,.69],[.4,.91],[.4,1],[0,.83],[-.4,1],[-.4,.91],[-.13,.69],[-.14,.06],[-.9,.35],[-.88,.12],[-.14,-.3],[-.13,-.77]],
  narrowbody: [[0,-1],[.1,-.76],[.1,-.28],[.7,.15],[.7,.31],[.1,.05],[.09,.7],[.29,.91],[.28,1],[0,.85],[-.28,1],[-.29,.91],[-.09,.7],[-.1,.05],[-.7,.31],[-.7,.15],[-.1,-.28],[-.1,-.76]],
  regional: [[0,-1],[.11,-.8],[.12,-.25],[.8,-.15],[.8,.06],[.11,.06],[.1,.7],[.34,.8],[.34,.94],[0,.86],[-.34,.94],[-.34,.8],[-.1,.7],[-.11,.06],[-.8,.06],[-.8,-.15],[-.12,-.25],[-.11,-.8]],
  bizjet: [[0,-1],[.1,-.6],[.1,-.05],[.6,.3],[.6,.43],[.12,.22],[.16,.55],[.11,.76],[.4,.85],[.4,1],[0,.9],[-.4,1],[-.4,.85],[-.11,.76],[-.16,.55],[-.12,.22],[-.6,.43],[-.6,.3],[-.1,-.05],[-.1,-.6]],
  ga: [[0,-1],[.1,-.8],[.1,-.35],[.9,-.35],[.9,-.12],[.1,-.12],[.07,.65],[.37,.65],[.37,.81],[0,.8],[-.37,.81],[-.37,.65],[-.07,.65],[-.1,-.12],[-.9,-.12],[-.9,-.35],[-.1,-.35],[-.1,-.8]],
  helicopter: [[0,-.75],[.22,-.52],[.22,-.02],[.08,.18],[.06,.85],[.3,.9],[.3,1],[-.3,1],[-.3,.9],[-.06,.85],[-.08,.18],[-.22,-.02],[-.22,-.52]],
  tanker: [[0,-1],[.31,-.64],[.31,.88],[-.31,.88],[-.31,-.64]],
  cargo: [[0,-1],[.36,-.53],[.36,.88],[-.36,.88],[-.36,-.53]],
  passenger: [[0,-1],[.27,-.66],[.27,.73],[.18,.91],[-.18,.91],[-.27,.73],[-.27,-.66]],
  fishing: [[0,-.88],[.36,-.34],[.3,.7],[-.3,.7],[-.36,-.34]],
  sail: [[0,-1],[.22,-.35],[.18,.65],[0,.92],[-.18,.65],[-.22,-.35]],
  tug: [[0,-.65],[.43,-.29],[.43,.47],[.26,.66],[-.26,.66],[-.43,.47],[-.43,-.29]],
} as const;

type KnownAircraftClass = Exclude<AircraftClass, 'unknown'>;
const AIRCRAFT_CLASSES: Readonly<Record<string, KnownAircraftClass>> = {
  A124:'heavy',A225:'heavy',A30B:'heavy',A310:'heavy',A332:'heavy',A333:'heavy',A338:'heavy',A339:'heavy',A342:'heavy',A343:'heavy',A345:'heavy',A346:'heavy',A359:'heavy',A35K:'heavy',A388:'heavy',B742:'heavy',B743:'heavy',B744:'heavy',B748:'heavy',B762:'heavy',B763:'heavy',B764:'heavy',B772:'heavy',B773:'heavy',B77L:'heavy',B77W:'heavy',B788:'heavy',B789:'heavy',B78X:'heavy',C17:'heavy',IL96:'heavy',MD11:'heavy',
  A318:'narrowbody',A319:'narrowbody',A320:'narrowbody',A321:'narrowbody',A20N:'narrowbody',A21N:'narrowbody',B731:'narrowbody',B732:'narrowbody',B733:'narrowbody',B734:'narrowbody',B735:'narrowbody',B736:'narrowbody',B737:'narrowbody',B738:'narrowbody',B739:'narrowbody',B38M:'narrowbody',B39M:'narrowbody',B3XM:'narrowbody',B752:'narrowbody',B753:'narrowbody',C919:'narrowbody',
  AN12:'regional',AT43:'regional',AT44:'regional',AT45:'regional',AT46:'regional',AT72:'regional',AT75:'regional',AT76:'regional',B190:'regional',BE20:'regional',BE30:'regional',BE99:'regional',C130:'regional',C295:'regional',CRJ1:'regional',CRJ2:'regional',CRJ7:'regional',CRJ9:'regional',CRJX:'regional',DH8A:'regional',DH8B:'regional',DH8C:'regional',DH8D:'regional',DHC6:'regional',E120:'regional',E170:'regional',E190:'regional',E195:'regional',E290:'regional',E295:'regional',E75L:'regional',E75S:'regional',F100:'regional',F50:'regional',F70:'regional',JS31:'regional',P28A:'regional',P28B:'regional',P28R:'regional',P28T:'regional',PC12:'regional',SF34:'regional',SW4:'regional',
  C25A:'bizjet',C25B:'bizjet',C25C:'bizjet',C25M:'bizjet',C510:'bizjet',C525:'bizjet',C550:'bizjet',C560:'bizjet',C56X:'bizjet',C650:'bizjet',C680:'bizjet',C700:'bizjet',C750:'bizjet',CL30:'bizjet',CL35:'bizjet',CL60:'bizjet',E35L:'bizjet',E55P:'bizjet',GL5T:'bizjet',GLF4:'bizjet',GLF5:'bizjet',GLF6:'bizjet',GLEX:'bizjet',H25B:'bizjet',LJ35:'bizjet',LJ45:'bizjet',LJ60:'bizjet',PC24:'bizjet',PRM1:'bizjet',
  BE23:'ga',BE33:'ga',BE35:'ga',BE36:'ga',BE55:'ga',BE58:'ga',BE76:'ga',BE77:'ga',C150:'ga',C152:'ga',C162:'ga',C172:'ga',C177:'ga',C182:'ga',C185:'ga',C206:'ga',C207:'ga',C208:'ga',C210:'ga',DA20:'ga',DA40:'ga',DA42:'ga',DA50:'ga',PA18:'ga',PA23:'ga',PA24:'ga',PA30:'ga',PA32:'ga',PA34:'ga',PA38:'ga',PA44:'ga',PA46:'ga',SR20:'ga',SR22:'ga',
  AS50:'helicopter',AS55:'helicopter',AS65:'helicopter',B06:'helicopter',B407:'helicopter',B412:'helicopter',B429:'helicopter',B430:'helicopter',B505:'helicopter',EC20:'helicopter',EC30:'helicopter',EC35:'helicopter',EC45:'helicopter',EC55:'helicopter',R22:'helicopter',R44:'helicopter',R66:'helicopter',S76:'helicopter',S92:'helicopter',
};

/** Exact ICAO type lookup; only whitespace/case normalization is applied. */
export function aircraftClass(type: string): AircraftClass {
  return typeof type === 'string' ? AIRCRAFT_CLASSES[type.trim().toUpperCase()] ?? 'unknown' : 'unknown';
}

export function vesselClass(aisType: number | null | undefined): VesselClass {
  if (typeof aisType !== 'number' || !Number.isInteger(aisType)) return 'tug';
  if (aisType === 30) return 'fishing';
  if (aisType === 36 || aisType === 37) return 'sail';
  if (aisType >= 60 && aisType <= 69) return 'passenger';
  if (aisType >= 70 && aisType <= 79) return 'cargo';
  if (aisType >= 80 && aisType <= 89) return 'tanker';
  return 'tug';
}

export function altitudeBand(ft: number | null | undefined): 0 | 1 | 2 | 3 | null {
  if (typeof ft !== 'number' || !Number.isFinite(ft) || ft < 0) return null;
  if (ft < 2_000) return 0;
  if (ft < 10_000) return 1;
  if (ft < 30_000) return 2;
  return 3;
}

export const TRAFFIC_PALETTES = {
  light: { levels: ['#839aa3','#607f91','#3f627d','#234665'], air:'#284e6b', ship:'#746349', dot_air:'#567d91', dot_ship:'#9a8261', halo:'#f7f6ed', muted:'#646b70', sea:'#e9eff4' },
  dark: { levels: ['#94a8b0','#a5becc','#bfd8e6','#e2eef5'], air:'#bdd8e8', ship:'#e2bd86', dot_air:'#86aabd', dot_ship:'#b99d70', halo:'#26333c', muted:'#b4b9b9', sea:'#232f3e' },
} as const;

export function trafficAltitudeShade(ft: number | null | undefined, dark = false): string {
  const palette = dark ? TRAFFIC_PALETTES.dark : TRAFFIC_PALETTES.light;
  const band = altitudeBand(ft);
  return band == null ? palette.air : palette.levels[band];
}
