import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_FOR_NAVIGATION, parseCifp, type Airport, type Leg } from '../../src/lib/procedures/arinc424';

/**
 * Hand-written 132-column records. Column numbers are the ones verified
 * against FAA CIFP cycle 2610 (see the table in arinc424.ts). Values are
 * education-only fixtures, not a published procedure.
 */
function record(parts: Array<[number, string]>): string {
  const chars = Array.from({ length: 132 }, () => ' ');
  for (const [start, value] of parts) {
    for (let i = 0; i < value.length; i += 1) {
      const at = start - 1 + i;
      if (at < 0 || at >= 132) throw new Error(`column ${start} overflows with ${value}`);
      chars[at] = value[i] ?? ' ';
    }
  }
  return chars.join('');
}

function terminal(subsection: string, parts: Array<[number, string]>): string {
  return record([[1, 'S'], [2, 'USA'], [5, 'P'], [7, 'KDEN'], [11, 'K2'], [13, subsection], ...parts]);
}

function waypoint(ident: string, lat: string, lon: string, variation = 'E0080'): string {
  return terminal('C', [
    [14, ident],
    [20, 'K2'],
    [22, '0'],
    [27, 'W'],
    [33, lat],
    [42, lon],
    [75, variation],
  ]);
}

interface LegSpec {
  kind: 'D' | 'E' | 'F';
  ident: string;
  routeType: string;
  transition: string;
  sequence: string;
  fix?: string;
  fixRegion?: string;
  fixSection?: string;
  continuation?: string;
  description?: string;
  turn?: string;
  rnp?: string;
  path?: string;
  navaid?: string;
  navaidRegion?: string;
  navaidSection?: string;
  arc?: string;
  theta?: string;
  rho?: string;
  course?: string;
  distance?: string;
  altitudeDescription?: string;
  altitude1?: string;
  altitude2?: string;
  speed?: string;
  verticalAngle?: string;
  center?: string;
  centerRegion?: string;
  centerSection?: string;
  qualifier1?: string;
  qualifier2?: string;
  applicationType?: string;
  note?: string;
  serviceCode?: string;
}

function procedure(spec: LegSpec): string {
  const parts: Array<[number, string]> = [
    [14, spec.ident],
    [20, spec.routeType],
    [21, spec.transition],
    [27, spec.sequence],
    [39, spec.continuation ?? '0'],
  ];
  if (spec.fix) parts.push([30, spec.fix], [35, spec.fixRegion ?? 'K2'], [37, spec.fixSection ?? 'PC']);
  if (spec.applicationType) parts.push([40, spec.applicationType]);
  if (spec.description) parts.push([40, spec.description]);
  if (spec.turn) parts.push([44, spec.turn]);
  if (spec.rnp) parts.push([45, spec.rnp]);
  if (spec.path) parts.push([48, spec.path]);
  if (spec.navaid) parts.push([51, spec.navaid], [55, spec.navaidRegion ?? 'K2']);
  if (spec.arc) parts.push([57, spec.arc]);
  if (spec.theta) parts.push([63, spec.theta]);
  if (spec.rho) parts.push([67, spec.rho]);
  if (spec.course) parts.push([71, spec.course]);
  if (spec.distance) parts.push([75, spec.distance]);
  if (spec.navaidSection) parts.push([79, spec.navaidSection]);
  if (spec.altitudeDescription) parts.push([83, spec.altitudeDescription]);
  if (spec.altitude1) parts.push([85, spec.altitude1]);
  if (spec.altitude2) parts.push([90, spec.altitude2]);
  if (spec.speed) parts.push([100, spec.speed]);
  if (spec.verticalAngle) parts.push([103, spec.verticalAngle]);
  if (spec.center) parts.push([107, spec.center], [113, spec.centerRegion ?? 'K2'], [115, spec.centerSection ?? 'PC']);
  if (spec.qualifier1) parts.push([119, spec.qualifier1]);
  if (spec.qualifier2) parts.push([120, spec.qualifier2]);
  if (spec.note) parts.push([41, spec.note]);
  if (spec.serviceCode) parts.push([89, spec.serviceCode]);
  return terminal(spec.kind, parts);
}

const FIXTURE = [
  terminal('A', [
    [14, 'DEN'],
    [22, '0'],
    [33, 'N39514200'],
    [42, 'W104402340'],
    [52, 'E0080'],
    [57, '05434'],
    [94, 'DENVER INTL'],
    [129, '2610'],
  ]),
  terminal('G', [
    [14, 'RW16L'],
    [22, '0'],
    [23, '12000'],
    [28, '1630'],
    [33, 'N39510000'],
    [42, 'W104410000'],
    [67, '05380'],
  ]),
  waypoint('JEEPR', 'N39500000', 'W104500000'),
  waypoint('JOBOB', 'N39480000', 'W104480000'),
  waypoint('LEETS', 'N39460000', 'W104460000'),
  waypoint('TAILR', 'N39470000', 'W104470000'),
  waypoint('CFMDN', 'N39450000', 'W104450000', 'E0085'),
  waypoint('SIGNS', 'S33400000', 'E151200000', 'E0120'),
  record([
    [1, 'S'],
    [2, 'USA'],
    [5, 'EA'],
    [7, 'ENRT'],
    [14, 'LIMEX'],
    [20, 'K2'],
    [22, '0'],
    [27, 'W'],
    [33, 'N40000000'],
    [42, 'W105000000'],
    [75, 'E0140'],
  ]),
  record([
    [1, 'S'],
    [2, 'USA'],
    [5, 'D'],
    [14, 'DEN'],
    [20, 'K2'],
    [22, '0'],
    [23, '11790'],
    [33, 'N39520000'],
    [42, 'W104400000'],
    [75, 'E0080'],
  ]),
  record([
    [1, 'S'],
    [2, 'USA'],
    [5, 'DB'],
    [14, 'QQ'],
    [20, 'K2'],
    [22, '0'],
    [23, '03560'],
    [33, 'N39530000'],
    [42, 'W104390000'],
    [75, 'E0075'],
  ]),
  // RNAV (RNP) Y: transition, then final with IF / TF / RF and a continuation.
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'A',
    transition: 'JEEPR',
    sequence: '010',
    fix: 'JEEPR',
    description: 'E  A',
    path: 'IF',
    altitudeDescription: '+',
    altitude1: '10000',
    speed: '210',
    qualifier1: 'F',
  }),
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'A',
    transition: 'JEEPR',
    sequence: '020',
    fix: 'JOBOB',
    description: 'EE B',
    path: 'TF',
    altitudeDescription: 'B',
    altitude1: '08000',
    altitude2: 'FL180',
    qualifier1: 'F',
  }),
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'H',
    transition: '     ',
    sequence: '010',
    fix: 'LEETS',
    description: 'E  I',
    path: 'IF',
    qualifier1: 'F',
    qualifier2: 'S',
  }),
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'H',
    transition: '     ',
    sequence: '020',
    fix: 'LEETS',
    description: 'E  F',
    path: 'TF',
    altitudeDescription: '@',
    altitude1: '07000',
    qualifier1: 'F',
  }),
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'H',
    transition: '     ',
    sequence: '030',
    fix: 'TAILR',
    description: 'EY  ',
    turn: 'R',
    rnp: '010',
    path: 'RF',
    arc: '002900',
    theta: '2625',
    course: '0824',
    distance: '0091',
    altitudeDescription: 'V',
    altitude1: '05820',
    altitude2: '07000',
    center: 'CFMDN',
    qualifier1: 'F',
  }),
  procedure({
    kind: 'F',
    ident: 'H16LY',
    routeType: 'H',
    transition: '     ',
    sequence: '030',
    fix: 'TAILR',
    continuation: '2',
    applicationType: 'W',
    note: 'RF CENTER',
    serviceCode: 'A010',
    qualifier1: 'F',
  }),
  // ILS with a hold-in-lieu (HF) and a course-to-fix onto the runway.
  procedure({
    kind: 'F',
    ident: 'I16L',
    routeType: 'A',
    transition: 'TSHNR',
    sequence: '010',
    fix: 'JOBOB',
    description: 'E  A',
    turn: 'R',
    path: 'HF',
    navaid: 'QQ',
    navaidSection: 'DB',
    course: '1630',
    distance: 'T010',
  }),
  procedure({
    kind: 'F',
    ident: 'I16L',
    routeType: 'I',
    transition: '     ',
    sequence: '010',
    fix: 'RW16L',
    fixSection: 'PG',
    description: 'GY M',
    path: 'CF',
    navaid: 'DEN',
    navaidSection: 'D ',
    theta: '2509',
    rho: '0115',
    course: '1630',
    distance: '0105',
    altitudeDescription: '-',
    altitude1: '05400',
    verticalAngle: '-300',
  }),
  procedure({
    kind: 'F',
    ident: 'I16L',
    routeType: 'I',
    transition: '     ',
    sequence: '020',
    path: 'CA',
    description: '  M ',
    course: '1630',
    altitudeDescription: '+',
    altitude1: '05934',
  }),
  // SID: course-to-altitude, then direct to a fix in the southern hemisphere.
  procedure({
    kind: 'D',
    ident: 'BAYLR6',
    routeType: '4',
    transition: 'RW16L',
    sequence: '010',
    path: 'CA',
    course: '1630',
    altitudeDescription: '+',
    altitude1: '05934',
  }),
  procedure({
    kind: 'D',
    ident: 'BAYLR6',
    routeType: '4',
    transition: 'RW16L',
    sequence: '020',
    fix: 'SIGNS',
    path: 'DF',
  }),
  // STAR leg to an enroute fix, with a flight-level "at or below".
  procedure({
    kind: 'E',
    ident: 'AALLE4',
    routeType: '4',
    transition: 'LIMEX',
    sequence: '010',
    fix: 'LIMEX',
    fixSection: 'EA',
    path: 'IF',
    altitudeDescription: '-',
    altitude1: 'FL230',
  }),
  // Remaining altitude-description letters, one leg each.
  ...[
    ['010', 'G', '04000', '02500'],
    ['020', 'H', '05000', '03000'],
    ['030', 'I', '03500', '02800'],
    ['040', 'J', '06000', '04500'],
    ['050', 'X', '02400', '03000'],
    ['060', 'Y', 'FL190', '10000'],
    ['070', 'C', '', '08000'],
  ].map(([sequence, altitudeDescription, altitude1, altitude2]) =>
    procedure({
      kind: 'F',
      ident: 'DSC',
      routeType: 'R',
      transition: 'TABLE',
      sequence: sequence ?? '010',
      path: 'TF',
      altitudeDescription,
      altitude1,
      altitude2,
    }),
  ),
  'TOO SHORT',
  record([[1, 'T'], [5, 'P'], [7, 'KDEN'], [13, 'A']]),
].join('\n');

function airport(): Airport {
  const parsed = parseCifp(FIXTURE);
  expect(parsed).toHaveLength(1);
  return parsed[0] as Airport;
}

function leg(procedureIdent: string, transitionId: string, sequence: number): Leg {
  const procedure = airport().procedures.find((item) => item.ident === procedureIdent);
  const transition = procedure?.transitions.find((item) => item.id === transitionId);
  const found = transition?.legs.find((item) => item.sequence === sequence);
  if (!found) throw new Error(`missing ${procedureIdent} ${transitionId} ${sequence}`);
  return found;
}

describe('ARINC 424 CIFP parser', () => {
  it('labels the parse as education only', () => {
    expect(NOT_FOR_NAVIGATION).toBe('Education only. Not for navigation.');
    expect(airport().notForNavigation).toBe(NOT_FOR_NAVIGATION);
  });

  it('converts hemisphere-first DMS to decimal degrees', () => {
    const den = airport();
    expect(den.ident).toBe('KDEN');
    expect(den.lat).toBeCloseTo(39 + 51 / 60 + 42 / 3600, 8);
    expect(den.lon).toBeCloseTo(-(104 + 40 / 60 + 23.4 / 3600), 8);
    expect(den.elevationFt).toBe(5434);
    expect(den.magneticVariation).toEqual({ direction: 'E', degrees: 8 });
    expect(den.cycle).toBe('2610');

    const runway = den.runways.find((item) => item.ident === 'RW16L');
    expect(runway?.lengthFt).toBe(12000);
    expect(runway?.bearingMagneticDeg).toBeCloseTo(163, 5);
    expect(runway?.elevationFt).toBe(5380);
    expect(runway?.lat).toBeCloseTo(39 + 51 / 60, 8);
    expect(runway?.lon).toBeCloseTo(-(104 + 41 / 60), 8);

    const south = leg('BAYLR6', 'RW16L', 20).fix;
    expect(south?.lat).toBeCloseTo(-(33 + 40 / 60), 8);
    expect(south?.lon).toBeCloseTo(151 + 20 / 60, 8);
    expect(south?.magneticVariation).toEqual({ direction: 'E', degrees: 12 });
  });

  it('groups transitions and resolves an RNAV approach with IF, TF and RF legs', () => {
    const rnp = airport().procedures.find((item) => item.ident === 'H16LY');
    expect(rnp?.kind).toBe('APPROACH');
    expect(rnp?.transitions.map((item) => [item.id, item.routeType, item.routeQualifier1])).toEqual([
      ['JEEPR', 'A', 'F'],
      ['', 'H', 'F'],
    ]);

    const iaf = leg('H16LY', 'JEEPR', 10);
    expect(iaf.pathTerminator).toBe('IF');
    expect(iaf.flags).toEqual({ iaf: true, faf: false, map: false });
    expect(iaf.speedLimitKt).toBe(210);
    expect(iaf.fix).toMatchObject({ ident: 'JEEPR', region: 'K2', section: 'P', subsection: 'C' });
    expect(iaf.fix?.lat).toBeCloseTo(39 + 50 / 60, 8);
    expect(iaf.fix?.lon).toBeCloseTo(-(104 + 50 / 60), 8);

    const between = leg('H16LY', 'JEEPR', 20);
    expect(between.pathTerminator).toBe('TF');
    expect(between.altitude).toMatchObject({
      description: 'B',
      altitude1Ft: 8000,
      altitude2Ft: 18000,
      altitude1FlightLevel: null,
      altitude2FlightLevel: 180,
    });

    const faf = leg('H16LY', '', 20);
    expect(faf.flags.faf).toBe(true);
    expect(faf.altitude).toMatchObject({ description: '@', altitude1Ft: 7000, altitude2Ft: null });

    const rf = leg('H16LY', '', 30);
    expect(rf.pathTerminator).toBe('RF');
    expect(rf.turnDirection).toBe('R');
    expect(rf.rnpNm).toBeCloseTo(0.1, 5);
    expect(rf.arcRadiusNm).toBeCloseTo(2.9, 5);
    expect(rf.thetaDeg).toBeCloseTo(262.5, 5);
    expect(rf.magneticCourseDeg).toBeCloseTo(82.4, 5);
    expect(rf.distanceNm).toBeCloseTo(9.1, 5);
    expect(rf.holdTimeMin).toBeNull();
    expect(rf.altitude).toMatchObject({
      description: 'V',
      altitude1Ft: 5820,
      altitude2Ft: 7000,
    });
    expect(rf.centerFix).toMatchObject({ ident: 'CFMDN', section: 'P', subsection: 'C' });
    expect(rf.centerFix?.lat).toBeCloseTo(39 + 45 / 60, 8);
    expect(rf.centerFix?.lon).toBeCloseTo(-(104 + 45 / 60), 8);
    expect(rf.centerFix?.magneticVariation).toEqual({ direction: 'E', degrees: 8.5 });
    expect(rf.continuations).toEqual([
      { number: 2, applicationType: 'W', note: 'RF CENTER', serviceCodes: ['A010'] },
    ]);
    expect(rnp?.transitions.find((item) => item.id === '')?.legs).toHaveLength(3);
  });

  it('parses an ILS hold-in-lieu, runway fix and navaids', () => {
    const hold = leg('I16L', 'TSHNR', 10);
    expect(hold.pathTerminator).toBe('HF');
    expect(hold.turnDirection).toBe('R');
    expect(hold.magneticCourseDeg).toBeCloseTo(163, 5);
    expect(hold.holdTimeMin).toBeCloseTo(1, 5);
    expect(hold.holdDistanceNm).toBeNull();
    expect(hold.distanceNm).toBeNull();
    expect(hold.recommendedNavaid).toMatchObject({ ident: 'QQ', section: 'D', subsection: 'B' });
    expect(hold.recommendedNavaid?.lat).toBeCloseTo(39 + 53 / 60, 8);
    expect(hold.recommendedNavaid?.magneticVariation).toEqual({ direction: 'E', degrees: 7.5 });

    const final = leg('I16L', '', 10);
    expect(final.pathTerminator).toBe('CF');
    expect(final.flags.map).toBe(true);
    expect(final.verticalAngleDeg).toBeCloseTo(-3, 5);
    expect(final.thetaDeg).toBeCloseTo(250.9, 5);
    expect(final.rhoNm).toBeCloseTo(11.5, 5);
    expect(final.distanceNm).toBeCloseTo(10.5, 5);
    expect(final.altitude).toMatchObject({ description: '-', altitude1Ft: 5400 });
    expect(final.fix?.lat).toBeCloseTo(39 + 51 / 60, 8);
    expect(final.fix?.ident).toBe('RW16L');
    expect(final.recommendedNavaid).toMatchObject({ ident: 'DEN', section: 'D', subsection: '' });
    expect(final.recommendedNavaid?.lon).toBeCloseTo(-(104 + 40 / 60), 8);

    const missed = leg('I16L', '', 20);
    expect(missed.pathTerminator).toBe('CA');
    expect(missed.flags.map).toBe(true);
    expect(missed.fix).toBeNull();
  });

  it('parses a SID course-to-altitude and direct leg, and a STAR flight level', () => {
    const den = airport();
    expect(den.procedures.map((item) => [item.kind, item.ident])).toEqual([
      ['SID', 'BAYLR6'],
      ['STAR', 'AALLE4'],
      ['APPROACH', 'DSC'],
      ['APPROACH', 'H16LY'],
      ['APPROACH', 'I16L'],
    ]);

    const climb = leg('BAYLR6', 'RW16L', 10);
    expect(climb.pathTerminator).toBe('CA');
    expect(climb.fix).toBeNull();
    expect(climb.magneticCourseDeg).toBeCloseTo(163, 5);
    expect(climb.altitude).toMatchObject({ description: '+', altitude1Ft: 5934, altitude2Ft: null });

    const direct = leg('BAYLR6', 'RW16L', 20);
    expect(direct.pathTerminator).toBe('DF');
    expect(direct.altitude).toBeNull();
    expect(direct.distanceNm).toBeNull();

    const star = leg('AALLE4', 'LIMEX', 10);
    expect(star.fix).toMatchObject({ ident: 'LIMEX', section: 'E', subsection: 'A' });
    expect(star.fix?.lat).toBeCloseTo(40, 8);
    expect(star.fix?.lon).toBeCloseTo(-105, 8);
    expect(star.fix?.magneticVariation).toEqual({ direction: 'E', degrees: 14 });
    expect(star.altitude).toMatchObject({
      description: '-',
      altitude1Ft: 23000,
      altitude1FlightLevel: 230,
      altitude2Ft: null,
    });
  });

  it('parses the altitude description letters and does not turn a blank into zero', () => {
    const cases: Array<[number, string, number | null, number | null, number | null, number | null]> = [
      [10, 'G', 4000, 2500, null, null],
      [20, 'H', 5000, 3000, null, null],
      [30, 'I', 3500, 2800, null, null],
      [40, 'J', 6000, 4500, null, null],
      [50, 'X', 2400, 3000, null, null],
      [60, 'Y', 19000, 10000, 190, null],
      [70, 'C', null, 8000, null, null],
    ];
    for (const [sequence, description, altitude1Ft, altitude2Ft, altitude1FlightLevel, altitude2FlightLevel] of cases) {
      expect(leg('DSC', 'TABLE', sequence).altitude).toEqual({
        description,
        altitude1Ft,
        altitude2Ft,
        altitude1FlightLevel,
        altitude2FlightLevel,
      });
    }
    expect(leg('H16LY', '', 10).altitude).toBeNull();
    expect(leg('H16LY', '', 10).speedLimitKt).toBeNull();
  });
});

function cachedCifp(): string | undefined {
  const root = path.join(os.homedir(), '.cache', 'isobar-cifp');
  const manifestPath = path.join(root, 'manifest.json');
  if (existsSync(manifestPath)) {
    const cached = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { cifp?: string }).cifp;
    if (cached && existsSync(cached)) return cached;
  }
  const extracted = path.join(root, 'extracted', '261001', 'FAACIFP18');
  return existsSync(extracted) ? extracted : undefined;
}

describe('cached FAA CIFP', () => {
  const cifpPath = cachedCifp();

  it.skipIf(!cifpPath)('resolves KDEN procedures from the extracted FAACIFP18', () => {
    const text = readFileSync(cifpPath as string, 'utf8');
    const den = parseCifp(text, { airports: ['KDEN'] }).find((item) => item.ident === 'KDEN');
    expect(den?.notForNavigation).toBe(NOT_FOR_NAVIGATION);
    expect(den?.lat).toBeCloseTo(39 + 51 / 60 + 42 / 3600, 6);
    expect(den?.lon).toBeCloseTo(-(104 + 40 / 60 + 23.4 / 3600), 6);
    expect(den?.elevationFt).toBe(5434);
    expect(den?.magneticVariation).toEqual({ direction: 'E', degrees: 8 });
    expect(den?.runways.some((item) => item.ident === 'RW16L' && item.lat)).toBe(true);
    const procedures = den?.procedures ?? [];
    expect(procedures.length).toBeGreaterThan(10);
    const rnp = procedures.find((item) => item.kind === 'APPROACH' && item.ident.replace(/\s/g, '').startsWith('H16L'));
    expect(rnp).toBeTruthy();
    const rnpLegs = (rnp?.transitions ?? []).flatMap((item) => item.legs);
    expect(rnpLegs.some((item) => item.altitude && (item.altitude.altitude1Ft ?? 0) > 0)).toBe(true);
    const allLegs = procedures.flatMap((item) => item.transitions.flatMap((transition) => transition.legs));
    // KDEN's RNP Z runway 16L has no RF leg in cycle 2610. The RF legs are on other approaches.
    expect(allLegs.some((item) => item.pathTerminator === 'RF' && item.centerFix?.lat != null)).toBe(true);
    expect(allLegs.some((item) => item.holdTimeMin === 1)).toBe(true);
    expect(allLegs.some((item) => item.continuations.some((continuation) => continuation.applicationType === 'W'))).toBe(true);
  });
});
