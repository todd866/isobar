/** Renders the Isobar B727 Handbook (markdown) from the generated tables,
 * the worked examples and the calibration references.
 *
 *   cd training && node --experimental-strip-types src/b727/handbook.ts [out.md]
 *
 * Default output: ../docs/training/b727/handbook.md (relative to training/).
 * The handbook is a training document for the Isobar model of a Boeing
 * 727-200; it is not an operational document and copies no third-party table.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { TABLES, TABLE_CEILING_KG } from './engine.ts';
import { planAll, problems, type FlightExample } from './examples.ts';
import { referencePoints } from './references.ts';
import { PARAMETERS } from './model.ts';

type Cell = string | number | null | undefined;

const n0 = (x: Cell): string => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toLocaleString('en-AU', { maximumFractionDigits: 0 }) : x);
/** a limit weight cell: values off the top of the table are shown as above the structural limit */
const lim = (x: number | null): Cell => (x === null ? null : x >= TABLE_CEILING_KG ? '> MTOW' : x);
const n1 = (x: number): string => x.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kt = (w: number): string => `${w / 1000}`;

function table(headers: Cell[], rows: Cell[][]): string {
  const h = `| ${headers.map(n0).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---:').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(n0).join(' | ')} |`).join('\n');
  return `${h}\n${sep}\n${body}\n`;
}

function grid(title: string, rowLabel: string, rowKeys: Cell[], colKeys: Cell[], cell: (ri: number, ci: number) => Cell, note?: string): string {
  const lines = [`**${title}**`, ''];
  lines.push(table([rowLabel, ...colKeys], rowKeys.map((rk, ri) => [rk, ...colKeys.map((_, ci) => cell(ri, ci))])));
  if (note) lines.push(note, '');
  return lines.join('\n');
}

export function renderHandbook(): string {
  const L = TABLES.limitations;
  const out: string[] = [];
  const push = (...s: string[]): void => { out.push(...s); };

  push('# Isobar B727 Handbook', '');
  push(`**Isobar's own model of a ${L.aircraft} with ${L.engines}.** For training, not for operational use.`, '');
  push('This handbook is generated from `training/src/b727/model.ts` through `generate.ts` and `handbook.ts`. ' +
    'The aeroplane is a physically consistent model calibrated to public Boeing airport-planning data and to a handful of reference points, ' +
    'realistic to within about 10% of the real aircraft (Section 10). It is **not** the CASA examination handbook and reproduces none of its tables. ' +
    'The methods of table entry, rounding and flight planning follow the CASA *ATPL(A) Exam Information Book* (v2.9, October 2026), ' +
    'which is licensed CC BY 4.0 (© Civil Aviation Safety Authority); the worked procedures are attributed to it, the numbers are Isobar\'s.', '');
  push('All weights are kilograms. Levels are flight levels; distances nautical miles (ground) or nautical air miles (nam); speeds knots; fuel flows kg/h for all operating engines.', '');

  // Contents
  push('## Contents', '');
  for (const s of ['1 Limitations and speeds', '2 Climb and altitude capability', '3 Cruise', '4 Descent and holding', '5 Abnormal operations', '6 Take-off and landing performance', '7 Weight and balance', '8 Fuel policy and planning method', '9 Worked examples', '10 Calibration and references']) push(`- ${s}`);
  push('');

  // 1 Limitations
  push('## 1 Limitations and speeds', '');
  const W = L.weights;
  push(table(['Limit', 'kg'], [
    ['Maximum taxi weight', W.maxTaxiKg], ['Maximum take-off (brake release) weight', W.maxTakeoffKg],
    ['Maximum landing weight, flaps 30', W.maxLandingKg], ['Maximum landing weight, flaps 40', W.maxLandingFlaps40Kg],
    ['Maximum zero fuel weight', W.maxZeroFuelKg], ['Typical basic (operating) weight', W.basicWeightKg],
  ]));
  push('Above 2,000 ft pressure altitude the structural take-off limit reduces by ' + `${TABLES.takeoff.weightLapseAbove2000FtKgPer1000Ft} kg per 1,000 ft (tyre and brake energy).`, '');
  const F = L.fuel;
  push(table(['Fuel tank', 'Usable kg'], [
    ['Tank 1 (left wing)', F.tank1Kg], ['Tank 2 (centre)', F.tank2Kg], ['Tank 3 (right wing)', F.tank3Kg],
    ['Aft auxiliary', F.aftAuxKg], ['Forward auxiliary', F.fwdAuxKg], ['Total, basic tanks', F.usableBasicKg], ['Total, with auxiliaries', F.usableWithAuxKg],
  ]));
  push(`Fuel density for planning ${F.densityKgPerL} kg/L.`, '');
  const V = L.limits;
  push(table(['Speed limit', 'Value'], [
    ['VMO', `${V.vmoKias} KIAS`], ['MMO', `M ${V.mmo}`], ['Gear extended', `${V.gearExtendedKias} KIAS`], ['Gear operating', `${V.gearOperatingKias} KIAS`],
    ['Maximum tyre speed', `${V.maxTyreSpeedKt} kt ground speed`], ['Maximum operating altitude', `${n0(V.maxOperatingAltitudeFt)} ft`],
    ...Object.entries(V.vfeKias).map(([f, v]) => [`VFE flaps ${f}`, `${v} KIAS`]),
  ]));
  push(`Climb schedule ${L.climbSchedule.lowKias} KIAS to ${n0(L.climbSchedule.transitionFt)} ft, ${L.climbSchedule.highKias} KIAS, M ${L.climbSchedule.mach}. Descent M ${L.descentSchedule.mach}, ${L.descentSchedule.highKias} KIAS, ${L.descentSchedule.lowKias} KIAS below ${n0(L.descentSchedule.transitionFt)} ft.`, '');
  push('**Table 1.1 Take-off and landing speeds (KIAS) by weight.** V1 = VR (balanced field); V2 = 1.23 VS; VREF = 1.3 VS.', '');
  push(table(['Weight kg', 'V1/VR f5', 'V2 f5', 'V1/VR f15', 'V2 f15', 'V1/VR f25', 'V2 f25', 'VREF f30', 'VREF f40', 'VS clean'],
    L.vSpeeds.map((v) => [v.kg, v.takeoff['5'].v1, v.takeoff['5'].v2, v.takeoff['15'].v1, v.takeoff['15'].v2, v.takeoff['25'].v1, v.takeoff['25'].v2, v.vref['30'], v.vref['40'], v.stallClean])));

  // 2 Climb
  const C = TABLES.climb;
  push('## 2 Climb and altitude capability', '');
  push(`Climb from brake release at ${C.schedule.lowKias}/${C.schedule.highKias} KIAS and M ${C.schedule.mach}, maximum climb thrust. The take-off allowance (${C.takeoffAllowance.timeMin} min, ${C.takeoffAllowance.fuelKg} kg, ${C.takeoffAllowance.distNm} nm) is included.`, '');
  for (const note of C.notes) push(`- ${note}`);
  push('');
  for (const isa of [-10, 0, 10, 20]) {
    const ii = C.isaDev.indexOf(isa);
    push(grid(`Table 2.1 Climb, ISA${isa >= 0 ? '+' : ''}${isa}: time min / fuel kg / distance nam`, 'FL \\ BRW (t)', C.fl.filter((fl) => fl >= 190), C.brakeReleaseKg.map(kt), (ri, ci) => {
      const fi = C.fl.indexOf(C.fl.filter((fl) => fl >= 190)[ri]);
      const c = C.table[ii][fi][ci];
      return c ? `${c.t}/${n0(c.f)}/${c.d}` : null;
    }));
  }
  push('The full ladder, FL150 to FL390 at every 1,000 ft and ISA −10 to +20 in 5 °C steps, is in `data/climb.json`.', '');
  const A = TABLES.capability;
  const highLevels = A.fl.filter((fl) => fl >= 250);
  for (const [name, tbl] of [['M 0.80', A.m080], ['Long range cruise', A.lrc]] as const) {
    push(grid(`Table 2.5 Altitude capability, ${name}: maximum gross weight (kg) at the start of the sector`, 'FL \\ ISA', highLevels, A.isaDev.map((d) => (d >= 0 ? `+${d}` : `${d}`)), (ri, ci) => tbl[ci][A.fl.indexOf(highLevels[ri])]));
  }
  for (const note of A.notes) push(`- ${note}`);
  push('');
  push('**Table 2.6 Optimum level (LRC, ISA) by weight.**', '');
  push(table(['Weight t', ...A.optimum.weightKg.map(kt)], [['Optimum FL', ...A.optimum.fl]]));

  // 3 Cruise
  const Cr = TABLES.cruise;
  push('## 3 Cruise', '');
  for (const note of Cr.notes) push(`- ${note}`);
  push('');
  const cruiseLevels = Cr.m080.fl.filter((fl) => fl >= 250);
  push(grid('Table 3.1 Cruise M 0.80: fuel flow kg/h (three engines), ISA', 'FL \\ GW (t)', cruiseLevels, Cr.weightsKg.map(kt), (ri, ci) => Cr.m080.ff[Cr.m080.fl.indexOf(cruiseLevels[ri])][ci]));
  push(table(['FL', ...cruiseLevels], [['TAS kt (ISA)', ...cruiseLevels.map((fl) => Cr.m080.tasIsa[Cr.m080.fl.indexOf(fl)])]]));
  push(`Temperature corrections: fuel flow +${Cr.m080.corrections.ffPercentPer3C}% per 3 °C above ISA (−${Cr.m080.corrections.ffPercentPer3C}% per 3 °C below); TAS +${Cr.m080.corrections.tasKtPerC} kt per °C above ISA.`, '');
  push(grid('Table 3.2 Long range cruise: Mach / TAS kt (ISA) / fuel flow kg/h', 'FL \\ GW (t)', Cr.lrc.fl.filter((fl) => fl >= 250), Cr.weightsKg.map(kt), (ri, ci) => {
    const fi = Cr.lrc.fl.indexOf(Cr.lrc.fl.filter((fl) => fl >= 250)[ri]);
    const mach = Cr.lrc.mach[fi][ci];
    return mach === null ? null : `${mach.toFixed(2)}/${Cr.lrc.tas[fi][ci]}/${n0(Cr.lrc.ff[fi][ci])}`;
  }));
  push(grid('Table 3.2a Long range cruise below FL250 (alternate and low-level planning): Mach / TAS / fuel flow', 'FL \\ GW (t)', Cr.lrc.fl.filter((fl) => fl < 250 && fl % 20 === 10), Cr.weightsKg.map(kt), (ri, ci) => {
    const fi = Cr.lrc.fl.indexOf(Cr.lrc.fl.filter((fl) => fl < 250 && fl % 20 === 10)[ri]);
    const mach = Cr.lrc.mach[fi][ci];
    return mach === null ? null : `${mach.toFixed(2)}/${Cr.lrc.tas[fi][ci]}/${n0(Cr.lrc.ff[fi][ci])}`;
  }, 'Even levels are in `data/cruise.json`.'));
  push(grid('Table 3.3 Cruise 280 KIAS: Mach / TAS kt / fuel flow kg/h', 'FL \\ GW (t)', Cr.kias280.fl, Cr.weightsKg.map(kt), (ri, ci) => `${Cr.kias280.mach[ri][ci]?.toFixed(2)}/${Cr.kias280.tas[ri][ci]}/${n0(Cr.kias280.ff[ri][ci])}`));
  const IR = Cr.integratedRange;
  push(grid(`Table 3.4 Integrated range, M 0.80 ISA: nautical air miles from ${n0(IR.weightsKg[IR.weightsKg.length - 1])} kg to the tabulated weight`, 'GW (kg) \\ FL', IR.weightsKg, IR.fl, (ri, ci) => IR.nam[ci][ri],
    'Sector air distance = nam at start weight − nam at end weight, read at the same level. Enter with weights to the nearest 1,000 kg.'));

  // 4 Descent and holding
  const D = TABLES.descent;
  push('## 4 Descent and holding', '');
  for (const note of D.notes) push(`- ${note}`);
  push('');
  push(grid(`Table 4.1 Descent M ${D.schedule.mach}/${D.schedule.highKias}/${D.schedule.lowKias} KIAS, idle thrust, to 1,500 ft: time min / fuel kg / distance nam`, 'FL \\ LW (t)', D.fl, D.landingWeightKg.map(kt), (ri, ci) => {
    const c = D.table[ci][ri];
    return `${c.t}/${n0(c.f)}/${c.d}`;
  }, `Approach and landing allowance from 1,500 ft: ${D.approachAndLandingKg} kg, ${D.approachAndLandingMin} min.`));
  const H = TABLES.holding;
  for (const note of H.notes) push(`- ${note}`);
  push('');
  push(grid('Table 4.2 Holding, clean, 1.12 × minimum-drag speed (≥ 210 KIAS): fuel flow kg/h / TAS kt, ISA', 'FL \\ GW (t)', H.fl, H.weightsKg.map(kt), (ri, ci) => {
    const c = H.table[ri][ci];
    return c ? `${n0(c.ff)}/${c.tas}` : null;
  }, `Fuel flow +${H.corrections.ffPercentPer5C}% per 5 °C above ISA. Enter FL15 for holding at 1,500 ft.`));

  // 5 Abnormal
  const Ab = TABLES.abnormal;
  push('## 5 Abnormal operations', '');
  for (const note of Ab.notes) push(`- ${note}`);
  push('');
  push(grid('Table 5.2 One engine inoperative ceiling (FL): 100 ft/min at drift-down speed, maximum continuous thrust', 'ISA \\ GW (t)', Ab.oneInop.ceiling.isaDev.map((d) => (d >= 0 ? `+${d}` : `${d}`)), Ab.weightsKg.map(kt), (ri, ci) => Ab.oneInop.ceiling.fl[ri][ci]));
  push(grid('Table 5.3 One engine inoperative long range cruise: Mach / TAS kt (ISA) / fuel flow kg/h (two engines)', 'FL \\ GW (t)', Ab.oneInop.lrc.fl, Ab.weightsKg.map(kt), (ri, ci) => {
    const mach = Ab.oneInop.lrc.mach[ri][ci];
    return mach === null ? null : `${mach.toFixed(2)}/${Ab.oneInop.lrc.tas[ri][ci]}/${n0(Ab.oneInop.lrc.ff[ri][ci])}`;
  }));
  const Dd = Ab.oneInop.driftdown;
  push(grid('Table 5.4 Drift-down at maximum continuous thrust to 2,000 ft below the ceiling: time min / fuel kg / distance nam / level-off FL', 'From FL \\ GW (t)', Dd.fromFl, Dd.weightsKg.map(kt), (ri, ci) => {
    const c = Dd.table[ri][ci];
    return c ? `${c.t}/${n0(c.f)}/${c.d}/${c.fl}` : null;
  }));
  push(grid('Table 5.9 Holding, one engine inoperative: fuel flow kg/h / TAS kt', 'FL \\ GW (t)', H.oneInop.fl, H.weightsKg.map(kt), (ri, ci) => {
    const c = H.oneInop.table[ri][ci];
    return c ? `${n0(c.ff)}/${c.tas}` : null;
  }));
  push(grid('Table 5.10 Depressurised cruise, long range cruise: Mach / TAS kt / fuel flow kg/h', 'FL \\ GW (t)', Ab.depressurised.lrc.fl, Ab.weightsKg.map(kt), (ri, ci) => `${Ab.depressurised.lrc.mach[ri][ci]?.toFixed(2)}/${Ab.depressurised.lrc.tas[ri][ci]}/${n0(Ab.depressurised.lrc.ff[ri][ci])}`));
  push(grid('Table 5.11 Depressurised cruise, 280 KIAS at FL100: Mach / TAS kt / fuel flow kg/h', 'FL \\ GW (t)', Ab.depressurised.kias280.fl, Ab.weightsKg.map(kt), (ri, ci) => `${Ab.depressurised.kias280.mach[ri][ci]?.toFixed(2)}/${Ab.depressurised.kias280.tas[ri][ci]}/${n0(Ab.depressurised.kias280.ff[ri][ci])}`));

  // 6 Take-off and landing
  const T = TABLES.takeoff;
  push('## 6 Take-off and landing performance', '');
  for (const note of T.notes) push(`- ${note}`);
  push(`- Pressure altitude = elevation + (1013 − QNH) × 30 ft. Corrected field length = (TORA − ${T.corrections.lineUpM} m line-up) × (1 ${T.corrections.slopePerPercent < 0 ? '−' : '+'} ${Math.abs(T.corrections.slopePerPercent)} × upslope %) + ${T.corrections.headwindMPerKt} m per kt headwind, or ${T.corrections.tailwindMPerKt} m per kt tailwind. Interpolate in length, OAT and pressure altitude.`);
  push(`- Climb limit: reduce by ${T.climbLimit.tailwindKgPerKt} kg per kt of tailwind, ${n0(T.climbLimit.engineAntiIceKg)} kg with engine anti-ice on, ${n0(T.climbLimit.engineAndWingAntiIceKg)} kg with engine and wing anti-ice on.`);
  push('- `> MTOW`: the performance limit is above the structural limit; the structural limit applies.', '');
  for (const flap of T.flaps) {
    const fi = T.flaps.indexOf(flap);
    for (const pa of T.pressureAltFt) {
      const pi = T.pressureAltFt.indexOf(pa);
      push(grid(`Table 6.1 Field-length-limited brake-release weight (kg), flaps ${flap}, pressure altitude ${n0(pa)} ft`, 'OAT °C \\ length m', T.oatC, T.fieldLengthM, (ri, ci) => lim(T.fieldLimit.weightKg[fi][pi][ri][ci])));
    }
  }
  for (const flap of T.flaps) {
    const fi = T.flaps.indexOf(flap);
    push(grid(`Table 6.2 Climb-limited brake-release weight (kg), flaps ${flap}: second segment 2.7%, one engine inoperative`, 'PA ft \\ OAT °C', T.pressureAltFt, T.oatC, (ri, ci) => lim(T.climbLimit.weightKg[fi][ri][ci])));
  }
  const Ld = TABLES.landing;
  for (const note of Ld.notes) push(`- ${note}`);
  push(`- Corrected landing distance = LDA × (1 − ${Ld.corrections.slopePerPercent} × downslope %) + ${Ld.corrections.headwindMPerKt} m per kt headwind, or ${Ld.corrections.tailwindMPerKt} m per kt tailwind.`, '');
  for (const flap of Ld.flaps) {
    const fi = Ld.flaps.indexOf(flap);
    for (const surface of Ld.surfaces) {
      const si = Ld.surfaces.indexOf(surface);
      push(grid(`Table 6.4 Field-length-limited landing weight (kg), flaps ${flap}, ${surface} runway`, 'PA ft \\ length m', Ld.pressureAltFt, Ld.fieldLengthM, (ri, ci) => lim(Ld.fieldLimit.weightKg[fi][si][ri][ci])));
    }
  }
  for (const flap of Ld.flaps) {
    const fi = Ld.flaps.indexOf(flap);
    push(grid(`Table 6.5 Approach-climb-limited landing weight (kg), flaps ${flap} landing: 2.4%, one engine inoperative`, 'PA ft \\ OAT °C', Ld.pressureAltFt, Ld.oatC, (ri, ci) => lim(Ld.approachClimb.weightKg[fi][ri][ci])));
  }

  // 7 Weight and balance
  const B = TABLES.balance;
  push('## 7 Weight and balance', '');
  push(`Datum: ${B.datum} LEMAC ${B.mac.lemacM} m, MAC ${B.mac.macM} m. Index units: ${B.indexUnit.definition}. %MAC = (arm − LEMAC) ÷ MAC × 100.`, '');
  for (const note of B.notes) push(`- ${note}`);
  push('');
  push('**Table 7.1 Passenger zones and standard weights.**', '');
  push(table(['Zone', 'Rows', 'Seats', 'Arm m', 'IU per adult'], Object.entries(B.zones).map(([z, v]) => [z, v.rows, v.seats, v.armM.toFixed(1), ((B.standardWeights.adult * (v.armM - B.indexUnit.referenceArmM)) / B.indexUnit.divisor).toFixed(2)])));
  push(table(['Standard weight', 'kg'], [['Adult', B.standardWeights.adult], ['Adolescent (13–15)', B.standardWeights.adolescent], ['Child (3–12)', B.standardWeights.child], ['Infant', B.standardWeights.infant], ['Checked bag (if not weighed)', B.standardWeights.checkedBagKg], ['Extra crew member', B.extraCrewKg]]));
  push('**Table 7.2 Freight compartments.**', '');
  push(table(['Compartment', 'Hold', 'Arm m', 'Max kg', 'Volume m³', 'IU per 100 kg'], Object.entries(B.compartments).map(([c, v]) => [c, v.hold, v.armM.toFixed(1), v.maxKg, v.volumeM3.toFixed(1), ((100 * (v.armM - B.indexUnit.referenceArmM)) / B.indexUnit.divisor).toFixed(2)])));
  push(`Floor loading limit ${B.holdFloorKgPerM2} kg/m². Tank arms: wing ${B.tanks.wing.armM} m, centre ${B.tanks.centre.armM} m, aft auxiliary ${B.tanks.aftAux.armM} m, forward auxiliary ${B.tanks.fwdAux.armM} m.`, '');
  push('**Table 7.3 Centre of gravity envelope (% MAC).**', '');
  push(table(['Weight kg', 'Forward limit', 'Aft limit'], B.envelope.table.map((r) => [r.kg, r.forwardMac, r.aftMac])));
  push('**Table 7.4 Fuel index: index change for fuel on board, by the standard loading order (wing and centre equally to the wing capacity, then centre, then aft and forward auxiliaries).**', '');
  push(table(['Fuel kg', 'IU', 'Wing kg', 'Centre kg', 'Aft aux kg', 'Fwd aux kg'], B.fuelIndex.map((r) => [r.kg, r.iu.toFixed(1), r.wingKg, r.centreKg, r.aftAuxKg, r.fwdAuxKg])));
  push('**Table 7.5 Stabiliser trim units for take-off by CG.**', '');
  push(table(['CG % MAC', 'Flaps 5', 'Flaps 15', 'Flaps 25'], B.stabTrim.map((r) => [r.mac, r.flaps5.toFixed(2), r.flaps15.toFixed(2), r.flaps25.toFixed(2)])));

  // 8 Fuel policy
  const P = TABLES.fuelPolicy;
  push('## 8 Fuel policy and planning method', '');
  push(`${P.title}. Where a rule mirrors the Part 121 Manual of Standards the section is cited; otherwise it is Isobar company policy.`, '');
  push(table(['Component', 'Rule', 'Basis'], P.components.map((c) => [c.name, c.rule, c.basis])));
  push(`Aerodrome status for planning: *suitable* — ${P.aerodromeStatus.suitable} *Acceptable* — ${P.aerodromeStatus.acceptable}`, '');
  push('### Planning method (after the CASA information book)', '');
  push('1. **Climb.** Enter Table 2.1 with brake-release weight and the ISA deviation at two-thirds of the climb (nearest 5 °C). Time and distance as tabulated; fuel to the nearest kg (0.5 up). Ground distance = tabulated nam × GS ÷ TAS, using the wind at the two-thirds level.');
  push('2. **Cruise zones.** For each zone estimate the mid-zone weight (EMZW = start-zone weight − half the zone fuel), round to the nearest 1,000 kg, read the fuel flow at the met level nearest the cruise level (FL185 data applies below FL185), correct for ISA deviation to the nearest 3 °C, and iterate until the entered weight is stable. Wind to the nearest 10° and 5 kt; ground speed from the exact wind triangle.');
  push('3. **Descent.** Enter Table 4.1 with landing weight rounded to 10,000 kg (no interpolation) and the wind at half the cruise level; add the approach and landing allowance.');
  push('4. **Level.** The highest IFR level for the track whose altitude-capability weight (Table 2.5, ISA deviation nearest 5 °C) is not below the start-of-cruise weight.');
  push('5. **Reserves.** Contingency, alternate, holding and final reserve per Section 8; the alternate leg is planned as a flight from the missed approach at destination to 1,500 ft at the alternate.');
  push('6. **Critical point (ETP).** Distance from departure = D × GS_home ÷ (GS_on + GS_home) in one zone; across zones, find the zone where the time home equals the time on, using the ground speeds for the condition (normal, one engine inoperative at Table 5.3 speeds, or depressurised at FL100).');
  push('7. **PNR.** Fuel available = take-off fuel − fixed reserves − landing allowance, less the 5% variable reserve; the distance at which fuel out plus fuel back equals the fuel available, zone by zone, using kg per ground nm out and back.');
  push('8. **Cross-check.** Trip ≈ ' + L.ruleOfThumb.note, '');

  // 9 Worked examples
  push('## 9 Worked examples', '');
  push('Forecasts in these examples are invented RSWT-style columns and are labelled as such; aerodrome elevations and runway lengths are from public AIP data. Every figure is computed from the tables above by `engine.ts`; the tests round-trip them.', '');
  const flights = planAll();
  for (const x of flights) push(renderFlight(x));
  push('### 9.6 APLA-style problems', '');
  for (const p of problems()) {
    push(`**${p.id} (${p.topic}).** ${p.question}`, '');
    for (const w of p.working) push(`- ${w}`);
    push('', `*Answer:* ${p.answer}`, '');
  }

  // 10 Calibration
  push('## 10 Calibration and references', '');
  push('The model is a drag polar (CD = CD0 + ΔCD + k·CL² + compressibility rise), a flat-rated low-bypass turbofan (thrust and TSFC lapse with pressure, temperature and Mach), energy-method climb and idle-descent integration, and balanced-field and landing-distance fits. ' +
    `Key parameters: CD0 ${PARAMETERS.AERO.cd0}, Oswald e ${PARAMETERS.AERO.oswald}, static take-off thrust ${n0(PARAMETERS.ENGINE.takeoffStaticN)} N per engine flat-rated to ISA+${PARAMETERS.ENGINE.flatRatingIsaDevC}, cruise TSFC ${PARAMETERS.ENGINE.tsfcC0} kg/kN/h × (1 + ${PARAMETERS.ENGINE.tsfcMachK} M) × √θ.`, '');
  push('**Anchored** (reference points the tests hold the model to): take-off and landing field lengths (Boeing), stall and reference speeds, holding fuel flow, descent profile, an 800 nm trip and the optimum-altitude line (Dittmar extract, owner\'s copy, personal/training use, tables not reproduced), a climb and a holding sample (CASA EIB). ' +
    '**Derived** from the model with no direct reference: climb-limited take-off weights, approach-climb limits, one-engine-inoperative ceilings and drift-down, depressurised cruise, integrated range, the CG envelope, index units, fuel index and stabiliser trim, and the flaps-40 landing weight limit (an Isobar simplification).', '');
  push(table(['Group', 'Condition', 'Source', 'Reference', 'Model', 'Unit', 'Error'], referencePoints().map((r) => [r.group, r.description, r.source, n0(r.reference), n0(r.model), r.unit, `${(((r.model - r.reference) / r.reference) * 100).toFixed(1)}%`])));
  push('Known gaps: no part-power TSFC effect (one-engine holding fuel flow runs high), no one-engine continued-take-off segment in the balanced field (flaps 25 at high weight reads short), no tyre-speed or brake-energy charts, no gear-down or anti-ice cruise penalties, and the final reserve is computed from the holding table rather than fixed.', '');
  push('---', '', '© Isobar. Methods after the CASA ATPL(A) Exam Information Book v2.9 (CC BY 4.0, © Civil Aviation Safety Authority). Boeing 727 Airplane Characteristics for Airport Planning used for public calibration points. This document is for training only and must not be used for the operation of any aircraft.', '');
  return out.join('\n');
}

function renderFlight(x: FlightExample): string {
  const s = x.spec;
  const o: string[] = [];
  o.push(`### 9.${x.spec.id.slice(1)} ${s.title}`, '');
  o.push(`${s.technique === 'LRC' ? 'Long range cruise' : s.technique === 'M0.80' ? 'M 0.80' : '280 KIAS'} at FL${x.cruiseFl}${s.maxFl ? ` (level capped at FL${s.maxFl})` : ''}. Alternate ${s.alternate}, ${s.alternateDistNm} nm. Payload ${n0(s.payloadKg)} kg on a basic weight of ${n0(s.basicWeightKg)} kg; ZFW ${n0(x.zeroFuelKg)} kg; planned brake-release weight ${n0(x.brakeReleaseKg)} kg.`, '');
  if (s.notes) for (const n of s.notes) o.push(`*${n}*`, '');
  o.push('**Route**', '');
  o.push(table(['Leg to', 'Dist nm', 'Track °M', 'Var', 'Met column'], x.legs.map((l) => [l.to, l.distNm, l.trackM, `${Math.abs(l.variation)}${l.variation >= 0 ? 'E' : 'W'}`, s.grid.columns[l.metColumn].name])));
  o.push('**Forecast (invented RSWT-style columns): wind °T/kt and ISA deviation by level**', '');
  o.push(table(['Column', ...s.grid.levels.map((l) => `FL${l}`)], s.grid.columns.map((c) => [c.name, ...s.grid.levels.map((l) => `${String(c.wind[l].dirT).padStart(3, '0')}/${c.wind[l].kt} ${c.isaDev[l] >= 0 ? '+' : ''}${c.isaDev[l]}`)])));
  o.push('**Zone log**', '');
  o.push(table(['Segment', 'FL', 'ISA', 'TAS', 'Wind °M/kt', 'HDG °M', 'GS', 'Dist nm', 'ETI min', 'FF kg/h', 'Zone fuel', 'SZW', 'EMZW', 'EZW'],
    x.plan.rows.map((r) => [r.segment, r.fl, r.isaDev >= 0 ? `+${r.isaDev}` : r.isaDev, Math.round(r.tasKt), r.wind, Math.round(r.headingM), Math.round(r.gsKt), Math.round(r.distNm), n1(r.etiMin), r.fuelFlowKgPerHour === null ? '—' : Math.round(r.fuelFlowKgPerHour), Math.round(r.zoneFuelKg), Math.round(r.startZoneKg), r.emzwKg ?? '—', Math.round(r.endZoneKg)])));
  o.push(`Trip ${n0(x.plan.totalDistNm)} nm in ${Math.floor(x.plan.totalTimeMin / 60)}:${String(Math.round(x.plan.totalTimeMin % 60)).padStart(2, '0')}; burn to 1,500 ft ${n0(Math.round(x.plan.burnKg))} kg; landing weight ${n0(Math.round(x.plan.landingKg))} kg (TOC ${n0(Math.round(x.plan.tocKg))} kg, TOD ${n0(Math.round(x.plan.todKg))} kg).`, '');
  o.push('**Fuel plan**', '');
  o.push(table(['Item', 'kg', 'Basis'], x.fuel.lines.map((l) => [l.name, Math.round(l.kg), l.basis])));
  o.push(`Alternate burn from the missed approach to 1,500 ft at ${s.alternate}: ${n0(Math.round(x.alternateBurnKg))} kg plus the 350 kg approach allowance.`, '');
  o.push('**Critical points and PNR**', '');
  o.push(table(['Case', 'Level', 'TAS', 'GS on', 'GS home', 'Distance from departure nm', 'Time from departure'], x.etps.map((t) => [t.label, `FL${t.fl}`, Math.round(t.tasKt), Math.round(t.gsOnKt), Math.round(t.gsBackKt), Math.round(t.distNm), `${Math.round(t.timeFromDepartureMin)} min`])));
  o.push(`PNR: fuel available ${n0(Math.round(x.pnr.fuelAvailableKg))} kg (take-off fuel less alternate, holding, final reserve and landing allowance, ÷ 1.05 for the variable reserve) → ${x.pnr.limited ? `${n0(Math.round(x.pnr.distNm))} nm from departure (${Math.round(x.pnr.timeToPnrMin)} min)` : 'beyond the destination (the whole route is within the PNR)'}.`, '');
  o.push('**Checks**', '');
  for (const c of x.checks) o.push(`- ${c}`);
  o.push(`- Take-off at ${s.from}: ${s.departure.oatC} °C, QNH ${s.departure.qnhHpa}, ${s.departure.windKt} kt headwind, flaps ${s.departure.flap}: limit ${n0(Math.floor(x.takeoff.performanceLimitKg))} kg (${x.takeoff.limitedBy}); V1 ${x.takeoff.speeds?.v1} VR ${x.takeoff.speeds?.vr} V2 ${x.takeoff.speeds?.v2} at the limit weight.`);
  o.push(`- Landing at ${s.to}: ${s.arrival.oatC} °C, QNH ${s.arrival.qnhHpa}, ${s.arrival.windKt} kt headwind, flaps ${s.arrival.flap}, ${s.arrival.wet ? 'wet' : 'dry'}: limit ${n0(Math.floor(x.landing.performanceLimitKg))} kg (${x.landing.limitedBy}); VREF ${x.landing.vrefKt} kt.`);
  const r = x.ruleOfThumb;
  o.push(`- Rule of thumb: ${r.kgPerGroundNm.toFixed(1)} kg per ground nm and ${r.kgPerMin.toFixed(0)} kg/min against the handbook's ${TABLES.limitations.ruleOfThumb.cruiseKgPerGroundNm} kg/gnm + ${n0(TABLES.limitations.ruleOfThumb.climbExtraKg)} kg = ${n0(r.thumbTripKg)} kg (${r.differencePercent >= 0 ? '+' : ''}${r.differencePercent.toFixed(0)}% against the plan).`, '');
  return o.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('handbook.ts')) {
  const out = process.argv[2] ?? '../docs/training/b727/handbook.md';
  mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
  const md = renderHandbook();
  writeFileSync(out, md);
  console.log(`wrote ${out} (${md.length.toLocaleString('en-AU')} characters)`);
}
