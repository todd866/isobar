import { windInstrument } from './wind.ts';
import { atmosphereInstrument } from './atmosphere.ts';
import { interpolationInstrument } from './interpolation.ts';
import { balanceInstrument } from './balance.ts';
import { profileInstrument } from './profile.ts';
import type { InstrumentDefinition } from './types.ts';

/** Pure definitions are also usable by cards, tests and future E6-B comparisons. */
export const INSTRUMENTS: InstrumentDefinition[] = [
  windInstrument, atmosphereInstrument, interpolationInstrument, balanceInstrument, profileInstrument,
];
