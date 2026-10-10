// Design fixtures, not current CYLW weather. All heights are ft AMSL in this
// synthetic sea-level section. Supplemental tops/profile values are explicit.
export const skies = [
  {
    id: 'rain-deck', title: 'A · BKN 5,600–18,900 · rain', freezingFt: 4000,
    profile: { capeJkg: 0, levels: [{ heightFt: 5600, tempC: -1 }, { heightFt: 18900, tempC: -19 }] },
    layers: [{ baseFt: 5600, topFt: 18900, cover: 'BKN', precipitating: true }],
  },
  {
    id: 'fair-cu', title: 'B · FEW030 SCT045 · fair-weather Cu', freezingFt: 11000,
    profile: { capeJkg: 180, levels: [{ heightFt: 3000, tempC: 14 }, { heightFt: 4500, tempC: 10.5 }, { heightFt: 6500, tempC: 6 }] },
    layers: [{ baseFt: 3000, topFt: 4200, cover: 'FEW' }, { baseFt: 4500, topFt: 6500, cover: 'SCT' }],
  },
  {
    id: 'cb-anvil', title: 'C · CB · anvil FL380 · rain shaft', freezingFt: 10500,
    profile: { capeJkg: 1400, levels: [{ heightFt: 4000, tempC: 12 }, { heightFt: 12000, tempC: -5 }] },
    layers: [{ baseFt: 4000, topFt: 38000, cover: 'BKN', reportedType: 'CB', precipitating: true }],
  },
  {
    id: 'stratus-cirrus', title: 'D · OVC008 + SCT250', freezingFt: 7000,
    profile: { capeJkg: 0, levels: [{ heightFt: 800, tempC: 11 }, { heightFt: 1800, tempC: 10 }, { heightFt: 25000, tempC: -33 }, { heightFt: 28000, tempC: -39 }] },
    layers: [{ baseFt: 800, topFt: 1800, cover: 'OVC' }, { baseFt: 25000, topFt: 28000, cover: 'SCT' }],
  },
];
export const styles = [
  { id: 'procedural', title: '1 · Procedural fBm' },
  { id: 'painted', title: '2 · Painted sprites' },
  { id: 'flat', title: '3 · Bureau chart' },
];
