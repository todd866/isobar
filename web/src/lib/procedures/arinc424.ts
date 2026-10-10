/**
 * Education-only parser for FAA CIFP records (ARINC 424-18, file FAACIFP18).
 * Not for navigation.
 *
 * Column numbers are 1-based and inclusive. They were checked against
 * FAACIFP18 in CIFP_261001 (KDEN, plus EA / D / DB rows), and against the
 * FAA "CIFP Readme" volume 2610 shipped in that zip (effective 1 October 2026).
 * The readme says the file follows ARINC 424-18, with 424-19 applied to the
 * procedure identifier (5.9/5.10, columns 14–19), route type (5.7, column 20)
 * and route qualifier 1 (5.7, column 119). It also names waypoint type column
 * 27 (5.42), navaid frequency columns 23–27 (5.34), and waypoint descriptor 3
 * (5.17).
 *
 * Where a common 424-18 transcription disagrees with this file, the file wins.
 * Those cases are marked "file" below.
 *
 * | Record | Columns | Field |
 * | --- | --- | --- |
 * | all | 1 | Record type. `S` standard. |
 * | all | 5 | Section. `P` airport, `E` enroute, `D` navaid. |
 * | P* | 6 | Blank. Subsection is column 13. |
 * | P* | 7–10 | Airport ICAO ident. |
 * | P* | 11–12 | ICAO region (`K2`, …). |
 * | P* | 13 | Subsection. `A` airport, `G` runway, `C` waypoint, `D` SID, `E` STAR, `F` approach. |
 * | PA | 22 | Continuation. `0` / `1` / blank is the primary. |
 * | PA | 33–41, 42–51 | Latitude, longitude. File: hemisphere first, `Nddmmsshh` / `Wdddmmsshh`. |
 * | PA | 52–56 | Magnetic variation `Hdddd`, tenths of a degree (`E0080` = 8.0° E). |
 * | PA | 57–61 | Airport elevation, feet. |
 * | PA | 129–132 | Cycle on that record. The readme says unchanged rows keep an older cycle. |
 * | PG | 14–18 | Runway ident (`RW16L`, `RW07`). |
 * | PG | 23–27 | Length, feet. |
 * | PG | 28–31 | Magnetic bearing, tenths of a degree. |
 * | PG | 33–51 | Threshold latitude / longitude, same packing as PA. |
 * | PG | 67–71 | Threshold elevation, feet. |
 * | PC, EA | 14–18 | Waypoint ident. |
 * | PC, EA | 19 | Blank in this file. |
 * | PC, EA | 20–21 | ICAO region. File: not columns 19–20 (`K2` would be read as ` K`). |
 * | PC, EA | 22 | Continuation. |
 * | PC, EA | 27 | Waypoint type. Readme: `R` ground, `W` satellite, `C` both. |
 * | PC, EA | 33–51 | Latitude / longitude. |
 * | PC, EA | 75–79 | Dynamic magnetic variation, same packing as PA 52–56. |
 * | D, DB | 6 | Blank for VHF, `B` for NDB. |
 * | D, DB | 14–17 | Navaid ident. |
 * | D, DB | 20–21 | ICAO region. Continuation is column 22, not 20. |
 * | D, DB | 23–27 | Frequency. Readme. Not copied into the model. |
 * | D, DB | 33–51 | Latitude / longitude. If blank, DME latitude 56–64 and longitude 65–74. |
 * | D, DB | 75–79 | Magnetic variation. |
 * | PD, PE, PF | 14–19 | Procedure ident. Readme. |
 * | PD, PE, PF | 20 | Route type. Readme. `H` is RNAV (RNP); qualifier 1 column 119 is then `F`. |
 * | PD, PE, PF | 21–25 | Transition ident. |
 * | PD, PE, PF | 27–29 | Sequence. |
 * | PD, PE, PF | 30–34 | Fix ident. |
 * | PD, PE, PF | 35–36 | Fix region. |
 * | PD, PE, PF | 37–38 | Fix section and subsection (`PC`, `EA`, `PG`, `D `, `DB`). |
 * | PD, PE, PF | 39 | Continuation. File: `0` or `1` is the leg; `2`–`9` continues it. |
 * | PD, PE, PF | 40–43 | Waypoint description. See flags below. |
 * | PD, PE, PF | 44 | Turn. `L`, `R`, or `E`. |
 * | PD, PE, PF | 45–47 | RNP, hundredths of a nautical mile (`010` = 0.10). |
 * | PD, PE, PF | 48–49 | Path terminator. |
 * | PD, PE, PF | 51–54, 55–56, 79–80 | Recommended navaid ident, region, section/subsection. |
 * | PD, PE, PF | 57–62 | RF arc radius, thousandths of a nautical mile. |
 * | PD, PE, PF | 63–66 | Theta, tenths of a degree. |
 * | PD, PE, PF | 67–70 | Rho, tenths of a nautical mile. |
 * | PD, PE, PF | 71–74 | Magnetic course, tenths of a degree. |
 * | PD, PE, PF | 75–78 | Route distance, tenths of a nautical mile. On HF/HA/HM a leading `T` marks tenths of minutes (`T010` = 1.0 min); otherwise tenths of a nautical mile. The `T` is the CIFP encoding of 424-18 §5.62. |
 * | PD, PE, PF | 83 | Altitude description. `+ - @ B C G H I J V X Y`. |
 * | PD, PE, PF | 84 | Blank in this file. |
 * | PD, PE, PF | 85–89, 90–94 | Altitude 1 and 2. Feet, or `FLnnn` (flight level × 100). File: not 84–88 / 89–93, which splits `07000`. |
 * | PD, PE, PF | 95–99 | Transition altitude, feet. Not stored. |
 * | PD, PE, PF | 100–102 | Speed limit, whole knots. |
 * | PD, PE, PF | 103–106 | Vertical angle, hundredths of a degree (`-300` = −3.00). |
 * | PD, PE, PF | 107–111, 113–116 | Center fix, region, section/subsection. RF legs carry the arc center here. The readme also puts the MSA center in this field when the leg is not an RF (KDEN's H16LZ FAF names RW16L). |
 * | PD, PE, PF | 119–120 | Route qualifiers. Readme: column 119 is `F` for RNAV (RNP). |
 * | PF cont. | 40 | Application type. This cycle uses `W`. |
 * | PF cont. | 41–88 | Continuation note (level-of-service text in this cycle). |
 * | PF cont. | 89–118 | Packed codes such as `A031` (letter + three digits). |
 *
 * Waypoint description, from KDEN rows in this cycle plus the readme's
 * descriptor 3: column 43 `A` initial approach fix, `F` final approach fix,
 * `I` final approach course fix, `M` missed approach; column 42 `M` missed
 * approach and `S` step-down. Column 43 `B` is kept in the raw code and is
 * not given a name here.
 *
 * Altitude letters follow ARINC 424 §5.71 as used by this file. `+` at or
 * above altitude 1. `-` at or below altitude 1. `@` at altitude 1. `B` at or
 * above altitude 1 and at or below altitude 2. `C` at or above altitude 2.
 * `G` at altitude 1, glide path at altitude 2. `H` at or above altitude 1,
 * glide path at altitude 2. `I` at the glide-path intercept in altitude 1.
 * `J` at or above the glide-path intercept in altitude 1. `V` is the
 * procedure-altitude window in the two altitude fields (both are kept; the
 * spec's "until established" wording is not re-derived). `X` at altitude 1
 * and at or below altitude 2. `Y` at or below altitude 1 and at or above
 * altitude 2. A blank description with no altitudes is null, not zero.
 * `I` and `J` are the less certain names; the letter and the numbers are
 * what the tests lock.
 */

export const NOT_FOR_NAVIGATION = 'Education only. Not for navigation.';

export interface MagneticVariation {
  direction: 'E' | 'W';
  /** Degrees, east or west as given. Tenths are preserved (8.5, not 8). */
  degrees: number;
}

export interface Fix {
  ident: string;
  region: string;
  section: string;
  subsection: string;
  lat: number | null;
  lon: number | null;
  magneticVariation: MagneticVariation | null;
}

export interface Runway {
  ident: string;
  lat: number;
  lon: number;
  bearingMagneticDeg: number | null;
  lengthFt: number | null;
  elevationFt: number | null;
}

export interface AltitudeConstraint {
  /** Raw ARINC letter. Blank when the CIFP left column 83 blank. */
  description: string;
  altitude1Ft: number | null;
  altitude2Ft: number | null;
  altitude1FlightLevel: number | null;
  altitude2FlightLevel: number | null;
}

export interface Continuation {
  number: number;
  applicationType: string;
  note: string | null;
  serviceCodes: string[];
}

export interface Leg {
  sequence: number;
  pathTerminator: string;
  fix: Fix | null;
  turnDirection: 'L' | 'R' | 'E' | null;
  recommendedNavaid: Fix | null;
  thetaDeg: number | null;
  rhoNm: number | null;
  magneticCourseDeg: number | null;
  distanceNm: number | null;
  holdTimeMin: number | null;
  holdDistanceNm: number | null;
  altitude: AltitudeConstraint | null;
  speedLimitKt: number | null;
  verticalAngleDeg: number | null;
  centerFix: Fix | null;
  arcRadiusNm: number | null;
  rnpNm: number | null;
  waypointDescription: string;
  flags: { iaf: boolean; faf: boolean; map: boolean };
  continuations: Continuation[];
}

export interface Transition {
  /** Blank when the CIFP transition field is blank (final and missed approach). */
  id: string;
  routeType: string;
  routeQualifier1: string;
  routeQualifier2: string;
  legs: Leg[];
}

export interface Procedure {
  kind: 'SID' | 'STAR' | 'APPROACH';
  ident: string;
  transitions: Transition[];
}

export interface Airport {
  ident: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  magneticVariation: MagneticVariation | null;
  /** Cycle printed on the airport record. Older than the file cycle when the row was not touched. */
  cycle: string | null;
  runways: Runway[];
  procedures: Procedure[];
  notForNavigation: typeof NOT_FOR_NAVIGATION;
}

export interface ParseOptions {
  /** ICAO idents to return. Enroute fixes and navaids are still indexed. */
  airports?: readonly string[];
}

interface StoredFix {
  ident: string;
  region: string;
  section: string;
  subsection: string;
  /** Airport that owns a terminal fix. Blank for enroute fixes and navaids. */
  airport: string;
  lat: number;
  lon: number;
  magneticVariation: MagneticVariation | null;
}

interface DraftTransition {
  id: string;
  routeType: string;
  routeQualifier1: string;
  routeQualifier2: string;
  legs: Map<number, Leg>;
}

interface DraftProcedure {
  kind: Procedure['kind'];
  ident: string;
  transitions: Map<string, DraftTransition>;
}

interface DraftAirport {
  ident: string;
  lat: number | null;
  lon: number | null;
  elevationFt: number | null;
  magneticVariation: MagneticVariation | null;
  cycle: string | null;
  runways: Runway[];
  procedures: Map<string, DraftProcedure>;
}

const KIND: Record<string, Procedure['kind']> = { D: 'SID', E: 'STAR', F: 'APPROACH' };
const KIND_ORDER: Record<Procedure['kind'], number> = { SID: 0, STAR: 1, APPROACH: 2 };

function field(line: string, start: number, end: number): string {
  return line.slice(start - 1, end);
}

function scaled(raw: string, divisor: number): number | null {
  const text = raw.trim();
  if (!text || !/^[+-]?\d+$/.test(text)) return null;
  return Number(text) / divisor;
}

function parseVariation(raw: string): MagneticVariation | null {
  const match = /^([EW])(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const direction = match[1];
  if (direction !== 'E' && direction !== 'W') return null;
  return { direction, degrees: Number(match[2]) / 10 };
}

function parseDms(raw: string, degreeDigits: number, negative: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const head = text[0] ?? '';
  const tail = text[text.length - 1] ?? '';
  let hemisphere = '';
  let digits = '';
  if (head === 'N' || head === 'S' || head === 'E' || head === 'W') {
    hemisphere = head;
    digits = text.slice(1);
  } else if (tail === 'N' || tail === 'S' || tail === 'E' || tail === 'W') {
    hemisphere = tail;
    digits = text.slice(0, -1);
  } else {
    return null;
  }
  if (!/^\d+$/.test(digits) || digits.length !== degreeDigits + 6) return null;
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2));
  const seconds = Number(digits.slice(degreeDigits + 2)) / 100;
  if (minutes >= 60 || seconds >= 60) return null;
  const value = degrees + minutes / 60 + seconds / 3600;
  return hemisphere === negative ? -value : value;
}

function parseLatitude(raw: string): number | null {
  return parseDms(raw, 2, 'S');
}

function parseLongitude(raw: string): number | null {
  return parseDms(raw, 3, 'W');
}

function parseAltitude(raw: string): { feet: number; flightLevel: number | null } | null {
  const text = raw.trim();
  if (!text) return null;
  const flightLevel = /^FL(\d{1,3})$/i.exec(text);
  if (flightLevel?.[1]) {
    const level = Number(flightLevel[1]);
    return { feet: level * 100, flightLevel: level };
  }
  if (!/^[+-]?\d+$/.test(text)) return null;
  return { feet: Number(text), flightLevel: null };
}

function flagsFor(description: string): Leg['flags'] {
  const code = description.padEnd(4, ' ');
  return {
    iaf: code[3] === 'A',
    faf: code[3] === 'F',
    map: code[2] === 'M' || code[3] === 'M',
  };
}

function turnOf(raw: string): Leg['turnDirection'] {
  const text = raw.trim();
  if (text === 'L' || text === 'R' || text === 'E') return text;
  return null;
}

class FixIndex {
  private exact = new Map<string, StoredFix>();
  private atAirport = new Map<string, StoredFix>();
  private byIdentRegionSection = new Map<string, StoredFix[]>();
  private byIdentRegion = new Map<string, StoredFix[]>();
  private byIdent = new Map<string, StoredFix[]>();

  add(fix: StoredFix | null): void {
    if (!fix) return;
    this.exact.set(`${fix.ident}|${fix.region}|${fix.section}|${fix.subsection}`, fix);
    if (fix.airport) this.atAirport.set(`${fix.airport}|${fix.ident}|${fix.section}|${fix.subsection}`, fix);
    push(this.byIdentRegionSection, `${fix.ident}|${fix.region}|${fix.section}`, fix);
    push(this.byIdentRegion, `${fix.ident}|${fix.region}`, fix);
    push(this.byIdent, fix.ident, fix);
  }

  resolve(ident: string, region: string, section: string, subsection: string, airport: string): StoredFix | null {
    const id = ident.trim();
    if (!id) return null;
    const local = airport ? this.atAirport.get(`${airport}|${id}|${section.trim()}|${subsection.trim()}`) : undefined;
    if (local) return local;
    const exact = this.exact.get(`${id}|${region.trim()}|${section.trim()}|${subsection.trim()}`);
    if (exact) return exact;
    return (
      only(this.byIdentRegionSection.get(`${id}|${region.trim()}|${section.trim()}`)) ??
      only(this.byIdentRegion.get(`${id}|${region.trim()}`)) ??
      only(this.byIdent.get(id))
    );
  }
}

function push(map: Map<string, StoredFix[]>, key: string, fix: StoredFix): void {
  const list = map.get(key);
  if (list) list.push(fix);
  else map.set(key, [fix]);
}

function only(list: StoredFix[] | undefined): StoredFix | null {
  if (!list?.length) return null;
  const first = list[0];
  if (!first) return null;
  if (list.length === 1) return first;
  const same = list.every((item) => item.lat === first.lat && item.lon === first.lon);
  return same ? first : null;
}

function located(line: string, latAt: number, lonAt: number): { lat: number; lon: number } | null {
  const lat = parseLatitude(field(line, latAt, latAt + 8));
  const lon = parseLongitude(field(line, lonAt, lonAt + 9));
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

function waypointFix(line: string, section: string, subsection: string, regionStart: number, regionEnd: number, airport: string): StoredFix | null {
  const ident = field(line, 14, 18).trim();
  const point = located(line, 33, 42);
  if (!ident || !point) return null;
  return {
    ident,
    region: field(line, regionStart, regionEnd).trim(),
    section,
    subsection,
    airport,
    lat: point.lat,
    lon: point.lon,
    magneticVariation: subsection === 'G' ? null : parseVariation(field(line, 75, 79)),
  };
}

function navaidFix(line: string, subsection: string): StoredFix | null {
  const ident = field(line, 14, 17).trim();
  const point = located(line, 33, 42) ?? located(line, 56, 65);
  if (!ident || !point) return null;
  return {
    ident,
    region: field(line, 20, 21).trim(),
    section: 'D',
    subsection,
    airport: '',
    lat: point.lat,
    lon: point.lon,
    magneticVariation: parseVariation(field(line, 75, 79)),
  };
}

function reference(index: FixIndex, ident: string, region: string, section: string, subsection: string, airport: string): Fix | null {
  if (!ident.trim()) return null;
  const found = index.resolve(ident, region, section, subsection, section.trim() === 'P' ? airport : '');
  return {
    ident: ident.trim(),
    region: region.trim(),
    section: section.trim(),
    subsection: subsection.trim(),
    lat: found?.lat ?? null,
    lon: found?.lon ?? null,
    magneticVariation: found?.magneticVariation ?? null,
  };
}

function readAltitude(line: string): AltitudeConstraint | null {
  const description = field(line, 83, 83).trim();
  const first = parseAltitude(field(line, 85, 89));
  const second = parseAltitude(field(line, 90, 94));
  if (!description && !first && !second) return null;
  return {
    description,
    altitude1Ft: first?.feet ?? null,
    altitude2Ft: second?.feet ?? null,
    altitude1FlightLevel: first?.flightLevel ?? null,
    altitude2FlightLevel: second?.flightLevel ?? null,
  };
}

function readLength(path: string, raw: string): Pick<Leg, 'distanceNm' | 'holdTimeMin' | 'holdDistanceNm'> {
  const empty = { distanceNm: null, holdTimeMin: null, holdDistanceNm: null };
  if (!raw.trim()) return empty;
  const hold = path === 'HF' || path === 'HA' || path === 'HM';
  if (hold && raw.startsWith('T') && /^\d{3}$/.test(raw.slice(1))) {
    return { distanceNm: null, holdTimeMin: Number(raw.slice(1)) / 10, holdDistanceNm: null };
  }
  const nm = scaled(raw, 10);
  if (nm == null) return empty;
  if (hold) return { distanceNm: null, holdTimeMin: null, holdDistanceNm: nm };
  return { distanceNm: nm, holdTimeMin: null, holdDistanceNm: null };
}

function readContinuation(line: string): Continuation {
  const note = field(line, 41, 88).replace(/\s+/g, ' ').trim();
  return {
    number: Number(field(line, 39, 39)),
    applicationType: field(line, 40, 40).trim(),
    note: note || null,
    serviceCodes: field(line, 89, 118).match(/[A-Z]\d{3}/g) ?? [],
  };
}

function readLeg(line: string, index: FixIndex, airport: string): Leg {
  const path = field(line, 48, 49).trim();
  const description = field(line, 40, 43);
  const length = readLength(path, field(line, 75, 78));
  return {
    sequence: Number(field(line, 27, 29)),
    pathTerminator: path,
    fix: reference(index, field(line, 30, 34), field(line, 35, 36), field(line, 37, 37), field(line, 38, 38), airport),
    turnDirection: turnOf(field(line, 44, 44)),
    recommendedNavaid: reference(index, field(line, 51, 54), field(line, 55, 56), field(line, 79, 79), field(line, 80, 80), airport),
    thetaDeg: scaled(field(line, 63, 66), 10),
    rhoNm: scaled(field(line, 67, 70), 10),
    magneticCourseDeg: scaled(field(line, 71, 74), 10),
    ...length,
    altitude: readAltitude(line),
    speedLimitKt: scaled(field(line, 100, 102), 1),
    verticalAngleDeg: scaled(field(line, 103, 106), 100),
    centerFix: reference(index, field(line, 107, 111), field(line, 113, 114), field(line, 115, 115), field(line, 116, 116), airport),
    arcRadiusNm: scaled(field(line, 57, 62), 1000),
    rnpNm: scaled(field(line, 45, 47), 100),
    waypointDescription: description,
    flags: flagsFor(description),
    continuations: [],
  };
}

function draftAirport(airports: Map<string, DraftAirport>, ident: string): DraftAirport {
  const found = airports.get(ident);
  if (found) return found;
  const created: DraftAirport = {
    ident,
    lat: null,
    lon: null,
    elevationFt: null,
    magneticVariation: null,
    cycle: null,
    runways: [],
    procedures: new Map(),
  };
  airports.set(ident, created);
  return created;
}

function attachProcedures(lines: string[], index: FixIndex, airports: Map<string, DraftAirport>): void {
  for (const raw of lines) {
    const airportIdent = field(raw, 7, 10).trim();
    const subsection = raw[12] ?? '';
    const kind = KIND[subsection];
    if (!kind || !airportIdent) continue;
    const ident = field(raw, 14, 19).trim();
    if (!ident) continue;
    const routeType = field(raw, 20, 20).trim();
    const transitionId = field(raw, 21, 25).trim();
    const sequence = Number(field(raw, 27, 29));
    const continuation = field(raw, 39, 39);
    const airport = draftAirport(airports, airportIdent);
    let procedure = airport.procedures.get(`${subsection}|${ident}`);
    if (!procedure) {
      procedure = { kind, ident, transitions: new Map() };
      airport.procedures.set(`${subsection}|${ident}`, procedure);
    }
    const transitionKey = `${routeType}|${transitionId}`;
    let transition = procedure.transitions.get(transitionKey);
    if (!transition) {
      transition = { id: transitionId, routeType, routeQualifier1: '', routeQualifier2: '', legs: new Map() };
      procedure.transitions.set(transitionKey, transition);
    }
    if (continuation >= '2' && continuation <= '9') {
      transition.legs.get(sequence)?.continuations.push(readContinuation(raw));
      continue;
    }
    const leg = readLeg(raw, index, airportIdent);
    if (!leg.pathTerminator) continue;
    transition.legs.set(sequence, leg);
    const qualifier1 = field(raw, 119, 119).trim();
    const qualifier2 = field(raw, 120, 120).trim();
    if (!transition.routeQualifier1 && qualifier1) transition.routeQualifier1 = qualifier1;
    if (!transition.routeQualifier2 && qualifier2) transition.routeQualifier2 = qualifier2;
  }
}

/**
 * Parse CIFP text into airports. Lines that are not 132-column standard
 * records are ignored. Fix coordinates come from PC, EA, D, DB and PG rows.
 * Procedures are resolved after the fix index is complete, so a leg may
 * refer to a fix that appears later in the file.
 */
export function parseCifp(text: string, options?: ParseOptions): Airport[] {
  const wanted = options?.airports ? new Set(options.airports.map((ident) => ident.trim().toUpperCase())) : null;
  const index = new FixIndex();
  const airports = new Map<string, DraftAirport>();
  const procedures: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    if (raw.length < 132 || raw[0] !== 'S') continue;
    const section = raw[4];
    const subsection6 = raw[5];
    if (section === 'E' && subsection6 === 'A') {
      index.add(waypointFix(raw, 'E', 'A', 20, 21, ''));
      continue;
    }
    if (section === 'D' && (subsection6 === ' ' || subsection6 === 'B')) {
      index.add(navaidFix(raw, subsection6 === 'B' ? 'B' : ''));
      continue;
    }
    if (section !== 'P') continue;

    const airportIdent = field(raw, 7, 10).trim();
    const subsection = raw[12] ?? '';
    const keep = Boolean(airportIdent) && (!wanted || wanted.has(airportIdent));
    if (subsection === 'C' && field(raw, 22, 22) < '2') index.add(waypointFix(raw, 'P', 'C', 20, 21, airportIdent));
    if (subsection === 'G' && field(raw, 22, 22) < '2') {
      // The runway's region is the airport region in columns 11–12.
      // Columns 20–21 are blank on PG rows.
      const runwayFix = waypointFix(raw, 'P', 'G', 11, 12, airportIdent);
      index.add(runwayFix);
      if (keep && runwayFix) {
        draftAirport(airports, airportIdent).runways.push({
          ident: runwayFix.ident,
          lat: runwayFix.lat,
          lon: runwayFix.lon,
          bearingMagneticDeg: scaled(field(raw, 28, 31), 10),
          lengthFt: scaled(field(raw, 23, 27), 1),
          elevationFt: scaled(field(raw, 67, 71), 1),
        });
      }
    }
    if (!keep) continue;
    if (subsection === 'A' && field(raw, 22, 22) < '2') {
      const point = located(raw, 33, 42);
      if (!point) continue;
      const airport = draftAirport(airports, airportIdent);
      if (airport.lat == null) {
        airport.lat = point.lat;
        airport.lon = point.lon;
        airport.elevationFt = scaled(field(raw, 57, 61), 1);
        airport.magneticVariation = parseVariation(field(raw, 52, 56));
        airport.cycle = field(raw, 129, 132).trim() || null;
      }
      continue;
    }
    if (KIND[subsection]) procedures.push(raw);
  }
  attachProcedures(procedures, index, airports);

  const parsed: Airport[] = [];
  for (const airport of airports.values()) {
    if (airport.lat == null || airport.lon == null) continue;
    if (wanted && !wanted.has(airport.ident)) continue;
    const procedures = [...airport.procedures.values()]
      .map((procedure) => ({
        kind: procedure.kind,
        ident: procedure.ident,
        transitions: [...procedure.transitions.values()]
          .map((transition) => ({
            id: transition.id,
            routeType: transition.routeType,
            routeQualifier1: transition.routeQualifier1,
            routeQualifier2: transition.routeQualifier2,
            legs: [...transition.legs.values()].sort((a, b) => a.sequence - b.sequence),
          }))
          .sort((a, b) => a.routeType.localeCompare(b.routeType) || a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ident.localeCompare(b.ident));
    parsed.push({
      ident: airport.ident,
      lat: airport.lat,
      lon: airport.lon,
      elevationFt: airport.elevationFt,
      magneticVariation: airport.magneticVariation,
      cycle: airport.cycle,
      runways: [...airport.runways].sort((a, b) => a.ident.localeCompare(b.ident)),
      procedures,
      notForNavigation: NOT_FOR_NAVIGATION,
    });
  }
  parsed.sort((a, b) => a.ident.localeCompare(b.ident));
  return parsed;
}
