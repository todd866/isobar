/**
 * Where LOCAL takes its units. Rectangles, first match wins; borders are
 * approximate. `source` is the authority for the row, not UI copy.
 * Unknown points fall through to ICAO defaults that match the AUS preset.
 */

export type PressureUnit = 'hPa' | 'inHg';
export type TempUnit = 'C' | 'F';
export type HeightUnit = 'ft' | 'm';
export type VisUnit = 'km' | 'sm';
export type RainUnit = 'mm' | 'in';
export type FlightLevelStyle = 'ft' | 'metric';

/** [south, north, west, east] in degrees. West > east wraps the dateline. */
export type RegionBox = [number, number, number, number];

export interface RegionRow {
  id: string;
  name: string;
  boxes: RegionBox[];
  pressure: PressureUnit;
  temp: TempUnit;
  height: HeightUnit;
  visibility: VisUnit;
  rain: RainUnit;
  flightLevel: FlightLevelStyle;
  /** Geopotential feet. At or above this, labels are flight levels. */
  transitionFt: number;
  /** The unit system itself is not solid. */
  uncertain: boolean;
  /** A single national transition altitude is not solid. */
  transitionUncertain: boolean;
  source: string;
}

const FT = 1 / 0.3048;

/** Checked in order. Specific boxes before the broad ones they sit inside. */
export const REGIONS: readonly RegionRow[] = [
  {
    id: 'us',
    name: 'United States',
    boxes: [
      [18.8, 22.3, -160.4, -154.7],
      [54.5, 71.6, -169, -141],
      [55.0, 60.6, -141, -130],
    ],
    pressure: 'inHg', temp: 'F', height: 'ft', visibility: 'sm', rain: 'in',
    flightLevel: 'ft', transitionFt: 18000,
    uncertain: false, transitionUncertain: false,
    source: 'FAA AIM 7-2-1: transition altitude 18,000 ft MSL. METAR altimeter is inches of mercury (A2992). The US preset also shows °F, statute miles and inches of rain; wind stays knots and height stays feet.',
  },
  {
    id: 'ca',
    name: 'Canada',
    boxes: [
      [49.0, 83.5, -141.0, -52.6],
      [43.5, 49.0, -83.0, -74.2],
    ],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'sm', rain: 'mm',
    flightLevel: 'ft', transitionFt: 18000,
    uncertain: false, transitionUncertain: false,
    source: 'Transport Canada AIM RAC: transition altitude 18,000 ft ASL. Canadian METARs report altimeter in hectopascals, temperature in °C, visibility in statute miles and wind in knots. Public rain is millimetres (Environment Canada). Pressure follows the METAR, not US inches.',
  },
  {
    id: 'us',
    name: 'United States',
    boxes: [[24.4, 49.5, -125.0, -66.8]],
    pressure: 'inHg', temp: 'F', height: 'ft', visibility: 'sm', rain: 'in',
    flightLevel: 'ft', transitionFt: 18000,
    uncertain: false, transitionUncertain: false,
    source: 'FAA AIM 7-2-1: transition altitude 18,000 ft MSL. METAR altimeter is inches of mercury (A2992). The US preset also shows °F, statute miles and inches of rain; wind stays knots and height stays feet. Checked after Canada so the Great Lakes stay on hectopascals.',
  },
  {
    id: 'nz',
    name: 'New Zealand',
    boxes: [[-47.5, -34.1, 166.2, 178.7]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 13000,
    uncertain: false, transitionUncertain: false,
    source: 'AIP New Zealand ENR 1.7: transition altitude 13,000 ft. Same display family as Australia: hPa, °C, knots, feet, kilometres, millimetres.',
  },
  {
    id: 'au',
    name: 'Australia',
    boxes: [[-44.2, -10.0, 112.0, 153.8]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 10000,
    uncertain: false, transitionUncertain: false,
    source: 'AIP Australia ENR 1.7: transition altitude 10,000 ft. METAR QNH is hPa, temperature °C, wind knots, visibility metres (shown as kilometres). Rain is millimetres.',
  },
  {
    id: 'ie',
    name: 'Ireland',
    boxes: [[51.4, 54.5, -10.6, -6.0]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 5000,
    uncertain: false, transitionUncertain: false,
    source: 'IAA AIP ENR 1.7: transition altitude 5,000 ft. hPa, °C, knots, feet, kilometres, millimetres.',
  },
  {
    id: 'gb',
    name: 'United Kingdom',
    boxes: [[49.9, 60.9, -8.2, 1.8]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 3000,
    uncertain: false, transitionUncertain: false,
    source: 'UK AIP ENR 1.7: transition altitude generally 3,000 ft AMSL; higher inside some TMAs (London TMA 6,000 ft). Millibars and hectopascals are the same unit, so the number is not converted.',
  },
  {
    id: 'eu',
    name: 'Europe',
    boxes: [[35.5, 71.5, -11, 30]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 5000,
    uncertain: false, transitionUncertain: true,
    source: 'European METARs and AIP practice: hPa, °C, knots, feet, kilometres, millimetres. There is no single European transition altitude; 5,000 ft is only the display threshold and is marked uncertain.',
  },
  {
    id: 'kp',
    name: 'North Korea',
    boxes: [[37.6, 43.1, 124.1, 130.8]],
    pressure: 'hPa', temp: 'C', height: 'm', visibility: 'km', rain: 'mm',
    flightLevel: 'metric', transitionFt: Math.round(3000 * FT),
    uncertain: true, transitionUncertain: true,
    source: 'No public AIP was checked for this row. Historically metric, in the Soviet pattern. Metres and metric flight levels are used, and the row is marked uncertain.',
  },
  {
    id: 'mn',
    name: 'Mongolia',
    boxes: [[41.5, 52.2, 87.7, 119.9]],
    pressure: 'hPa', temp: 'C', height: 'm', visibility: 'km', rain: 'mm',
    flightLevel: 'metric', transitionFt: Math.round(3000 * FT),
    uncertain: true, transitionUncertain: true,
    source: 'Mongolia Civil Aviation Authority AIP was not available for this change. Historically metric. Metres and metric flight levels are used, and the row is marked uncertain.',
  },
  {
    id: 'tw',
    name: 'Taiwan',
    boxes: [[21.9, 25.4, 119.9, 122.1]],
    pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
    flightLevel: 'ft', transitionFt: 11000,
    uncertain: true, transitionUncertain: true,
    source: 'ROC AIP uses feet and hPa rather than Chinese metric flight levels. Transition altitude is treated as 11,000 ft and was not re-checked against the current AIP, so the row is uncertain.',
  },
  {
    id: 'cn',
    name: 'China',
    boxes: [
      [18.0, 42.5, 73.5, 125.0],
      [42.5, 53.6, 115.0, 135.0],
    ],
    pressure: 'hPa', temp: 'C', height: 'm', visibility: 'km', rain: 'mm',
    flightLevel: 'metric', transitionFt: Math.round(3000 * FT),
    uncertain: false, transitionUncertain: true,
    source: 'CAAC: altitudes and flight levels are in metres; QNH is hPa. S0920 is standard pressure altitude 9,200 m (tens of metres). Transition altitude is published per aerodrome, commonly 3,000 m; that single national figure is uncertain. Wind stays knots.',
  },
  {
    id: 'ru',
    name: 'Russia',
    boxes: [[50, 82, 30, 180]],
    pressure: 'hPa', temp: 'C', height: 'm', visibility: 'km', rain: 'mm',
    flightLevel: 'metric', transitionFt: Math.round(3000 * FT),
    uncertain: true, transitionUncertain: true,
    source: 'Russia adopted feet flight levels with RVSM on 17 November 2011; some terminal altitudes stayed metric. This row still shows metres and metric flight levels, and it is marked uncertain.',
  },
];

export const ICAO_REGION: RegionRow = {
  id: 'icao',
  name: 'ICAO',
  boxes: [],
  pressure: 'hPa', temp: 'C', height: 'ft', visibility: 'km', rain: 'mm',
  flightLevel: 'ft', transitionFt: 10000,
  uncertain: false, transitionUncertain: false,
  source: 'Unknown region: ICAO-style defaults matching the AUS preset (hPa, °C, knots, feet, flight levels above 10,000 ft, kilometres, millimetres).',
};

function inBox(lat: number, lon: number, [south, north, west, east]: RegionBox): boolean {
  if (lat < south || lat > north) return false;
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east;
}

/** Region containing this point. Unknown, or an invalid coordinate, is the ICAO fallback. */
export function regionAt(lat: number, lon: number): RegionRow {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return ICAO_REGION;
  const lonN = ((lon + 180) % 360 + 360) % 360 - 180;
  for (const row of REGIONS) {
    if (row.boxes.some((box) => inBox(lat, lonN, box))) return row;
  }
  return ICAO_REGION;
}
