import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { solveHeading, solveWind } from './src/instruments/e6b/wind.ts';

const heading = (id: string, tc: number, tas: number, windFrom: number, windKt: number) => ({
  id, kind: 'heading', input: { tc, tas, windFrom, windKt }, expected: solveHeading(tc, tas, windFrom, windKt),
});
const wind = (id: string, th: number, tc: number, tas: number, gs: number) => ({
  id, kind: 'wind', input: { th, tc, tas, gs }, expected: solveWind(th, tc, tas, gs),
});

const cases = [
  heading('calm', 0, 100, 270, 0),
  heading('direct-headwind', 90, 120, 90, 35),
  heading('direct-tailwind', 90, 120, 270, 35),
  heading('direct-crosswind-right', 0, 120, 90, 30),
  heading('direct-crosswind-left', 0, 120, 270, 30),
  heading('wrap-near-360', 359, 140, 10, 25),
  heading('wrap-near-000', 1, 140, 350, 25),
  heading('quartering-headwind', 225, 180, 270, 70),
  heading('quartering-tailwind', 225, 180, 90, 70),
  heading('strong-tailwind', 180, 100, 0, 160),
  heading('headwind-no-forward', 0, 100, 0, 100),
  heading('crosswind-no-solution', 0, 100, 90, 100),
  heading('crosswind-over-tas', 0, 100, 90, 120),
  heading('headwind-over-tas', 0, 100, 0, 140),
  heading('crosswind-left-no-forward', 0, 100, 270, 100),
  heading('crosswind-boundary-tail', 0, 100, 150, 200),
  heading('invalid-tas', 0, 0, 90, 20),
  wind('find-calm', 90, 90, 120, 120),
  wind('find-headwind', 90, 90, 120, 85),
  wind('find-tailwind', 90, 90, 120, 155),
  wind('find-crosswind', 10, 0, 100, 100),
  wind('find-wrap', 359, 1, 140, 130),
  wind('find-quartering', 220, 180, 180, 210),
  wind('find-zero-gs', 0, 0, 100, 0),
] as const;

const output = JSON.stringify({ schema: 1, cases }, null, 2) + '\n';
writeFileSync(join(import.meta.dirname, '..', 'Tests/fixtures/e6b/wind.json'), output);
