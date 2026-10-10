/** Original teaching checks for the four concepts introduced by OD's engine.
 * Numbers are stipulated exercises, not aircraft performance or legal minima. */
import type { Seed } from './learn-bank.ts';

const base = { level: 'commercial' as const, rules: 'both' as const, claim: 'mechanism' as const,
  sourceId: 'od-teaching', picture: 'map', caption: 'Operational Decision worksheet' };
export const dispatchSeeds: Seed[] = [
  { ...base, concept: 'fpl.fuel-plan', strands: ['numbers'], section: 'Usable fuel ledger; stipulated exercise components',
    stem: 'The teaching flight needs 600 kg taxi, 5,900 kg trip, 300 kg contingency, 1,250 kg alternate, 500 kg holding and 1,500 kg final reserve. What usable fuel covers the ledger?',
    options: ['10,050 kg', '8,550 kg', '8,800 kg', '9,550 kg'],
    explanation: 'Add all six required components: 600 + 5,900 + 300 + 1,250 + 500 + 1,500 = 10,050 kg. Holding and final reserve are separate allocations. Actual requirements depend on the operation and Code edition.' },
  { ...base, concept: 'perf.landing-distance', strands: ['operations'], section: 'Fictional dispatch distance worksheet',
    stem: 'An invented teaching sheet gives a 2,000 m dry dispatch requirement and a wet factor of 1.15. The available runway is 2,200 m. With other factors stipulated as 1, does it fit?',
    options: ['No: the wet requirement is 2,300 m', 'Yes: 2,000 m is less than 2,200 m', 'Yes: divide by 1.15 to shorten the requirement', 'Yes: landing weight never affects the calculation'],
    explanation: '2,000 × 1.15 = 2,300 m, exceeding the available runway by 100 m. These are original teaching dispatch numbers, not real AFM data or statutory landing factors.' },
  { ...base, concept: 'sys.mel-dispatch', strands: ['operations'], section: 'Fictional MEL; combined conditions',
    stem: 'The teaching MEL permits an inoperative APU only with external power, external air and the dispatch procedure complete. External air is unavailable. Can this deferral release the flight?',
    options: ['No: every condition must be satisfied', 'Yes: two conditions out of three are enough', 'Yes: the captain can waive any condition', 'Yes: adding fuel replaces the missing air supply'],
    explanation: 'The conditions apply together. A permission with an unmet condition does not authorise dispatch. This invented item teaches the logic; real dispatch uses the applicable approved MEL.' },
  ...(['aus', 'us'] as const).map((rules): Seed => ({ ...base, level: 'student', rules, concept: 'law.vfr-minima',
    strands: [rules === 'aus' ? 'rules-aus' : 'rules-us'], section: 'Class C VMC worksheet; all stipulated limits',
    stem: `In the ${rules.toUpperCase()} Code exercise, visibility meets the stated Class C minimum, but vertical separation from cloud does not. Is the VMC check satisfied?`,
    options: ['No: visibility and cloud separation must both meet the stated limits', 'Yes: visibility alone decides VMC', 'Yes: a current medical waives cloud separation', 'Yes: more fuel changes the cloud-clearance minimum'],
    explanation: 'Check every applicable visibility and cloud-clearance limit for the airspace, altitude and edition. Passing one does not offset failing another. This is the Code worksheet, not a general statement of all VFR exceptions.' })),
];
