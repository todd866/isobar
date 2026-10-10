import type { Aerodrome } from './model';

/** Names, elevations, runway dimensions and headings are invented. Only the
 * station/zone mapping refers to reality. Raw bulletins keep their station IDs. */
export const AERODROMES: readonly Aerodrome[] = [
  { id: 'kesler', name: 'Kesler International', station: 'YPPH', zone: 'Australia/Perth', elevationFt: 120,
    runways: [{ id: '01', headingTrueDeg: 10, lengthM: 3600 }, { id: '10', headingTrueDeg: 100, lengthM: 2900 }] },
  { id: 'varen', name: 'Varen Harbour', station: 'YSSY', zone: 'Australia/Sydney', elevationFt: 80,
    runways: [{ id: '16', headingTrueDeg: 160, lengthM: 3900 }, { id: '07', headingTrueDeg: 70, lengthM: 3100 }] },
  { id: 'dorna', name: 'Dorna Works', station: 'YMML', zone: 'Australia/Melbourne', elevationFt: 480,
    runways: [{ id: '18', headingTrueDeg: 180, lengthM: 3400 }, { id: '09', headingTrueDeg: 90, lengthM: 2800 }] },
  { id: 'belvar', name: 'Belvar Plain', station: 'YSCB', zone: 'Australia/Sydney', elevationFt: 2050,
    runways: [{ id: '17', headingTrueDeg: 170, lengthM: 3300 }, { id: '08', headingTrueDeg: 80, lengthM: 2450 }] },
  { id: 'orel', name: 'Orel Border', station: 'YHBA', zone: 'Australia/Brisbane', elevationFt: 65,
    runways: [{ id: '11', headingTrueDeg: 110, lengthM: 1750 }, { id: '02', headingTrueDeg: 20, lengthM: 1300 }] },
  { id: 'teska', name: 'Teska Club', station: 'KBFI', zone: 'America/Los_Angeles', elevationFt: 90,
    runways: [{ id: '14', headingTrueDeg: 140, lengthM: 2500 }, { id: '05', headingTrueDeg: 50, lengthM: 1100 }] },
];
