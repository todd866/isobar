/** Operational Decision is a teaching simulation, never a dispatch system. */
import type { LearnRules, Strand } from '../../../../training/src/levels';
import type { AircraftId, RunwayState } from './manual';
import type { ProfileSeries } from '../sky/physics';

export type Edition = LearnRules;
export type { Strand };
export type Operation = 'private' | 'charter' | 'airline';
export interface Aerodrome {
  id: string; name: string; station: string; zone: string;
  elevationFt: number;
  runways: { id: string; headingTrueDeg: number; lengthM: number }[];
}
export interface WeatherReport {
  station: string;
  source: '/data/aviation.json' | '/api/aviation';
  capturedAt: string;
  metar: { raw: string; time: string } | null;
  taf: { raw: string; issue: string; from: string; to: string } | null;
  profile: ProfileSeries | null;
}
export interface Runway {
  id: string; headingTrueDeg: number; lengthM: number; state: RunwayState;
  contaminationMm: number; inspected: boolean;
}
export interface Alternate {
  aerodrome: Aerodrome; weather: WeatherReport; distanceNm: number;
  runway: Runway;
  /** Published fictional approach card; weather always retains the real source. */
  minima: { ceilingFt: number; visibilityM: number };
}
export interface CrewDocument {
  id: string; licence: 'student' | 'private' | 'commercial' | 'atp';
  aircraftRatings: AircraftId[]; instrumentRated: boolean;
  medical: { class: 1 | 2 | 3; validUntil: string };
  flightReviewValidUntil: string;
  /** Logged events, not a precomputed "current" answer. */
  landings: { at: string; night: boolean; fullStop: boolean }[];
  takeoffs: { at: string; night: boolean }[];
}
export interface DutyRoster {
  /** Scope deliberately excludes extensions, augmented crews and FRMS. */
  scheme: 'private' | 'au-basic' | 'us-117' | 'us-135';
  startUtc: string; startLocalHour: number; acclimatised: boolean;
  endUtc: string; sectors: number; flightMinutes: number;
  priorRestHours: number; sleepOpportunityHours: number; freeHoursLast168: number;
}
export interface TechnicalLog {
  defects: ('antiIce' | 'onePack' | 'autopilot' | 'apu')[];
  melAuthorised: boolean; placarded: boolean;
  externalPower: boolean; externalAir: boolean;
  /** Original teaching limits, not a real MEL approval. */
  dispatchProcedureComplete: boolean;
}
export interface Dossier {
  id: string; edition: Edition; shift: number;
  /** Original question; the documents carry the quoted weather and all inputs. */
  question: string;
  target: { decreeIds: string[]; strand: Strand; difficulty: number };
  aircraft: AircraftId; operation: Operation;
  departure: Aerodrome; destination: Aerodrome;
  departureWeather: WeatherReport; destinationWeather: WeatherReport;
  alternatives: Alternate[];
  plan: {
    rules: 'VFR' | 'IFR'; night: boolean;
    departureUtc: string; arrivalUtc: string;
    distanceNm: number; cruiseLevel: number; headwindKt: number;
    fuelKg: number; holdingMinutes: number; alternateId: string | null;
    dryOperatingKg: number; takeoffFlap: number; landingFlap: number;
    departureRunway: Runway; arrivalRunway: Runway;
    landingMinima: { ceilingFt: number; visibilityM: number };
    alternateMinima: { ceilingFt: number; visibilityM: number };
    instrumentApproach: boolean;
    /** Airspace C below 10,000 ft is the only VMC exercise in v1. */
    cloudClearance: { aboveFt: number; belowFt: number; horizontalM: number };
    plannedDensityAltitudeFt: number;
    cloudExposure: boolean;
  };
  documents: {
    crew: CrewDocument[]; duty: DutyRoster;
    technicalLog: TechnicalLog;
    maintenanceRelease: { validUntil: string; nextInspectionHours: number; airframeHours: number; endorsedDefects: string[]; signed: boolean };
    passengerManifest: { names: string[]; passengerMassKg: number; baggageKg: number; paid: boolean };
    notams: { id: string; aerodromeId: string; from: string; to: string; runwayId: string; closed: boolean; acknowledged: boolean }[];
  };
  pressure: { kind: 'captain' | 'ministry' | 'quota' | 'none'; line: string; rebelHook: 'border-diversion' | 'manifest-note' | null };
}
export type Decision = { stamp: 'RELEASE' } | { stamp: 'REFUSE' } | {
  stamp: 'AMEND'; alternate?: string; fuel?: number; delay?: number;
};
export interface RuleResult { status: 'pass' | 'fail' | 'unavailable' | 'blocked'; detail: string; blockedBy?: string }
export interface RealRule { document: string; section: string; url: string; verified: string; scope: string }
export interface DecisionNode { id: string; question: string; yes: string; no: string }
export interface RuleVariant {
  parameters: Readonly<Record<string, number | string | boolean>>;
  check: (dossier: Dossier) => RuleResult;
  realRule: RealRule[]; citation: string; reason: string; decisionTree: DecisionNode[];
  /** Set when this edition runs the US teaching check instead of its own numbers. */
  reuses?: 'us';
}
export interface Decree {
  id: string; title: string; shiftIntroduced: number; conceptId: string;
  strand: Exclude<Strand, 'rules-aus' | 'rules-us' | 'rules-easa' | 'rules-ca'> | 'rules';
  au: RuleVariant; us: RuleVariant; easa: RuleVariant; ca: RuleVariant;
}
export interface Evidence {
  conceptId: string; strand: Strand; difficulty: number; correct: boolean;
  responseMs: number; rules: Edition; dossierId: string; decreeId: string;
}
