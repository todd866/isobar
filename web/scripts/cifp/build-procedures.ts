/**
 * Education only. Not for navigation.
 *
 * Turn the extracted FAACIFP18 file into one JSON file per allow-listed airport.
 * Output goes to web/public/procedures/, which is gitignored.
 *
 *   node scripts/cifp/fetch-cifp.mjs
 *   npx tsx scripts/cifp/build-procedures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_FOR_NAVIGATION,
  parseCifp,
  type Airport,
  type AltitudeConstraint,
  type Leg,
  type Procedure,
} from '../../src/lib/procedures/arinc424.ts';

const AIRPORTS = ['KDEN', 'KJAC', 'KASE', 'KEGE', 'KSEA', 'KSFO', 'KBOS', 'KLAX'];
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const outDir = path.join(webRoot, 'public', 'procedures');

interface Manifest {
  cifp?: string;
  cycle?: string;
  url?: string;
}

function manifest(): Manifest {
  const manifestPath = path.join(os.homedir(), '.cache', 'isobar-cifp', 'manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

function altitudeText(altitude: AltitudeConstraint | null): string {
  if (!altitude) return '';
  const part = (feet: number | null, flightLevel: number | null): string => {
    if (feet == null) return '';
    return flightLevel != null ? `FL${flightLevel}` : `${feet} ft`;
  };
  return [altitude.description, part(altitude.altitude1Ft, altitude.altitude1FlightLevel), part(altitude.altitude2Ft, altitude.altitude2FlightLevel)]
    .filter((part) => part !== '')
    .join(' ');
}

function approachTitle(ident: string): string {
  const code = ident.replace(/\s+/g, '');
  const match = /^([A-Z])(\d{2}[LCR]?)-?([A-Z])?$/.exec(code);
  if (!match) return code;
  const family: Record<string, string> = {
    H: 'RNAV (RNP)',
    R: 'RNAV (GPS)',
    I: 'ILS or LOC',
    L: 'LOC',
    V: 'VOR',
    N: 'NDB',
    X: 'LDA',
    P: 'GPS',
  };
  const name = family[match[1] ?? ''] ?? match[1] ?? code;
  const suffix = match[3] ? ` ${match[3]}` : '';
  return `${name}${suffix} RWY ${match[2]}`;
}

function legLine(leg: Leg): string {
  const fix = leg.fix?.ident ?? leg.centerFix?.ident ?? '';
  const bits = [
    String(leg.sequence).padStart(3, '0'),
    leg.pathTerminator.padEnd(2, ' '),
    fix.padEnd(5, ' '),
    altitudeText(leg.altitude),
    leg.speedLimitKt != null ? `${leg.speedLimitKt} kt` : '',
    leg.verticalAngleDeg != null ? `${leg.verticalAngleDeg.toFixed(2)}°` : '',
    leg.holdTimeMin != null ? `${leg.holdTimeMin} min hold` : '',
    leg.pathTerminator === 'RF' && leg.centerFix ? `center ${leg.centerFix.ident}` : '',
  ];
  return bits.filter((bit) => bit !== '').join(' ');
}

function countKind(airport: Airport, kind: Procedure['kind']): number {
  return airport.procedures.filter((procedure) => procedure.kind === kind).length;
}

function sample(airport: Airport, cycle: string): string {
  const approaches = airport.procedures.filter((procedure) => procedure.kind === 'APPROACH');
  const code = (procedure: Procedure) => procedure.ident.replace(/\s+/g, '');
  const preferred =
    approaches.find((procedure) => code(procedure) === 'H16LY') ??
    approaches.find((procedure) => code(procedure).startsWith('H16L')) ??
    approaches.find((procedure) => procedure.transitions.some((transition) => transition.routeType === 'H' || transition.routeQualifier1 === 'F'));
  const rnp = approaches.filter((procedure) => procedure.transitions.some((transition) => transition.routeType === 'H' || transition.routeQualifier1 === 'F'));
  const lines = [
    '# CIFP sample',
    '',
    NOT_FOR_NAVIGATION,
    '',
    `FAA CIFP cycle ${cycle || 'unknown'}. ARINC 424-18 FAACIFP18. Education only, not for navigation.`,
    '',
    `KDEN procedures: ${airport.procedures.length} (${countKind(airport, 'SID')} SID, ${countKind(airport, 'STAR')} STAR, ${countKind(airport, 'APPROACH')} approach). Runways: ${airport.runways.length}.`,
    '',
  ];
  if (!approaches.some((procedure) => code(procedure) === 'H16LY')) {
    lines.push('No procedure ident H16LY (RNAV (RNP) Y RWY 16L) is in this cycle.');
  }
  if (rnp.length) {
    lines.push(`RNAV (RNP) idents: ${rnp.map((procedure) => `${code(procedure)} ${approachTitle(procedure.ident)}`).join(', ')}.`);
    lines.push('');
  }
  if (preferred) {
    lines.push(`## ${code(preferred)} — ${approachTitle(preferred.ident)}`);
    lines.push('');
    for (const transition of preferred.transitions) {
      const label = transition.id || '(final)';
      lines.push(`Transition ${label} route ${transition.routeType || '-'}`);
      for (const leg of transition.legs) {
        if (!leg.altitude && leg.pathTerminator !== 'RF' && leg.holdTimeMin == null) continue;
        lines.push(legLine(leg));
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function main(): void {
  const cached = manifest();
  if (!cached.cifp) throw new Error('CIFP manifest has no extracted file. Run scripts/cifp/fetch-cifp.mjs');
  const text = readFileSync(cached.cifp, 'utf8');
  const airports = parseCifp(text, { airports: AIRPORTS });
  mkdirSync(outDir, { recursive: true });
  const found = new Set<string>();
  for (const airport of airports) {
    found.add(airport.ident);
    const payload = {
      notForNavigation: NOT_FOR_NAVIGATION,
      source: 'FAA CIFP (ARINC 424-18)',
      datasetCycle: cached.cycle ?? null,
      airport,
    };
    writeFileSync(path.join(outDir, `${airport.ident}.json`), `${JSON.stringify(payload)}\n`);
    const legs = airport.procedures.reduce((sum, procedure) => sum + procedure.transitions.reduce((inner, transition) => inner + transition.legs.length, 0), 0);
    console.log(`${airport.ident} ${airport.procedures.length} procedures, ${legs} legs`);
  }
  const missing = AIRPORTS.filter((ident) => !found.has(ident));
  if (missing.length) console.log(`missing: ${missing.join(', ')}`);
  const denver = airports.find((airport) => airport.ident === 'KDEN');
  if (denver) writeFileSync(path.join(here, 'SAMPLE.md'), sample(denver, cached.cycle ?? ''));
}

main();
