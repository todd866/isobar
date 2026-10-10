import { storyShift } from './shifts';
import type { Meter, Outcome, Sitting } from './types';

export function quotaLedger(outcomes: readonly Pick<Outcome, 'onTime' | 'heldBad'>[], quota: number) {
  const onTime = outcomes.filter(o => o.onTime).length;
  const held = outcomes.filter(o => o.heldBad).length;
  const score = onTime - held;
  return { onTime, held, score, quota, met: score >= quota };
}

function strandWord(strand: string): string {
  if (strand === 'rules-aus' || strand === 'rules-us') return 'rules';
  return strand;
}

/** End-of-shift instruments. One row each: dossiers, correct, citations, quota, strands. */
export function shiftMeters(s: Sitting): Meter[] {
  const script = storyShift(s.shift);
  const filed = s.outcomes.length;
  const correct = s.outcomes.filter(o => o.correct).length;
  const citations = s.outcomes.filter(o => o.citation).length;
  const quota = quotaLedger(s.outcomes, script.quota);
  const assessed = [...new Set(s.cases.map(c => c.strand))];
  const improved = assessed.filter(strand => {
    const before = s.strandBefore[strand];
    const after = s.strandAfter[strand];
    return before != null && after != null && after > before;
  });
  const names = [...new Set(improved.map(strandWord))];
  const gauge = (n: number, d: number) => d <= 0 ? 0 : Math.max(0, Math.min(1, n / d));
  return [
    { id: 'dossiers', symbol: '▤', value: String(filed), datum: 'filed', gauge: filed ? 1 : 0, tone: 'flat', title: 'Dossiers filed this shift' },
    { id: 'correct', symbol: '✓', value: String(correct), datum: 'correct', gauge: gauge(correct, filed), tone: correct === filed && filed ? 'ok' : 'warn', title: 'Correct stamps' },
    { id: 'citations', symbol: '§', value: String(citations), datum: 'citations', gauge: gauge(citations, filed), tone: citations ? 'bad' : 'ok', title: 'Ministry citations' },
    {
      id: 'quota', symbol: '◷', value: String(quota.score), datum: quota.held ? `of ${quota.quota} on time · held ${quota.held}` : `of ${quota.quota} on time`,
      gauge: gauge(quota.score, quota.quota), tone: quota.met ? 'ok' : 'warn',
      title: 'On-time releases, minus a held departure in bad weather',
    },
    {
      id: 'strands', symbol: names.length ? '↑' : '·', value: String(names.length), datum: names.length ? `${names.join(' · ')} up` : 'flat',
      gauge: gauge(names.length, assessed.length), tone: names.length ? 'ok' : 'flat',
      title: names.length ? names.map(name => {
        const strand = assessed.find(item => strandWord(item) === name);
        if (!strand) return name;
        const before = s.strandBefore[strand] ?? 0;
        const after = s.strandAfter[strand] ?? before;
        return `${name} ${after > before ? '+' : ''}${(after - before).toFixed(2)}`;
      }).join(' · ') : 'No strand moved',
    },
  ];
}
