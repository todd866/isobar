import type { Card } from '../model.ts';

export type InstrumentId = 'wind' | 'atmosphere' | 'interpolation' | 'balance' | 'profile';
export type InstrumentMode = 'learn' | 'practice' | 'free' | 'how';
export type Values = Record<string, number>;
export interface Control {
  key: string; label: string; unit: string; min: number; max: number; step: number;
  tone?: 'air' | 'wind' | 'ground' | 'warm';
}
export interface Reading { label: string; value: string; unit?: string; tone?: string; }
export interface Scenario {
  state: Values;
  route: string;
  prompt: string;
  answer: number;
  tolerance: number;
  unit: string;
  estimate: string;
  watch: string;
  guided: string;
  guideKey: string;
  guideTarget: number;
  guideStart: number;
  guideTolerance: number;
  explain: string;
}
export interface DrawContext { hidden: boolean; overlay: boolean; compact: boolean; }
export interface InstrumentDefinition {
  id: InstrumentId;
  title: string;
  eyebrow: string;
  controls: Control[];
  scenario(seed: number, card?: Card): Scenario;
  draw(state: Values, context: DrawContext): string;
  readings(state: Values, hidden: boolean): Reading[];
  drag(key: string, x: number, y: number, state: Values): Values;
  how: { title: string; body: string }[];
  overlay?: string;
}
export interface MountOptions {
  /** Shared Lab selector, reattached when the instrument rebuilds its chrome. */
  picker?: HTMLElement;
  instrument?: InstrumentId;
  mode?: InstrumentMode;
  seed?: number;
  card?: Card;
}
