import { MISSIONS } from './missions.ts';
import { componentTable, exercisesFor, OPERATION_NAMES, type Operation } from './procedures.ts';
import type { E6BRecord } from './skills.ts';
import type { Highlight } from './demos.ts';

/** The short, interruptible first contact shown before the first lesson. */
/** `brief` is the phone line: one short instruction; the full text opens on tap. */
export const FIRST_CONTACT: ReadonlyArray<{ title: string; text: string; brief: string; highlight: Highlight[]; angle: number }> = [
  { title: 'Turn either ring', text: 'Drag the black ring or the blue disc to turn it against the other. The red handle moves the hairline.', brief: 'Drag a ring to turn it.', highlight: [{ kind: 'scale', scale: 'outer', value: 60 }], angle: 0 },
  { title: 'Turn the blue disc', text: 'Drag blue. Align blue below black to set a ratio; pinch to look closer.', brief: 'Drag blue to set a ratio.', highlight: [{ kind: 'scale', scale: 'middle', value: 60 }], angle: 15 },
  { title: 'Read at the hairline', text: 'Drag the red teaching hairline, or Shift-scroll. Read black above blue at this line; estimate first to place the decimal.', brief: 'Drag the red handle; read at the line.', highlight: [{ kind: 'index', id: 'rate' }], angle: 0 },
  { title: 'Windows are special views', text: 'Pressure altitude and temperature meet in a window. Set them carefully, then read the answer at the index.', brief: 'Windows set altitude and temperature.', highlight: [{ kind: 'scale', scale: 'pa-as', value: 5_000 }, { kind: 'scale', scale: 'temp-as', value: 0 }], angle: -25 },
];

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const stateSymbol: Record<'new' | 'learning' | 'fluent', string> = { new: '○', learning: '◐', fluent: '●' };
const stateLabel = (state: 'new' | 'learning' | 'fluent'): string => `${stateSymbol[state]} ${state[0].toUpperCase()}${state.slice(1)}`;
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Compact launch surface. It contains only links/buttons represented as data
 * attributes; the instrument controller owns event delegation and navigation.
 */
export function homeHtml(record: E6BRecord & { curriculum?: Record<string, { stage: 'watch' | 'guided' | 'solo' | 'done'; solved: string[] }> }): string {
  const operations = Object.keys(OPERATION_NAMES) as Operation[];
  const nextOp = operations.find(op => (record.curriculum?.[op]?.solved.length ?? 0) < 3) ?? operations[0];
  const first = exercisesFor(nextOp).find(e => !record.curriculum?.[nextOp]?.solved.includes(e.id)) ?? exercisesFor(nextOp)[0];
  const nextText = OPERATION_NAMES[nextOp];
  const exerciseRows = operations.map((operation) => {
    const exercises = exercisesFor(operation);
    if (!exercises.length) return '';
    const progress=record.curriculum?.[operation];
    const state=!progress?'new':progress.solved.length>=3?'fluent':'learning';
    const buttons = exercises.map((exercise) => `<button class="e6b-exercise e6b-level-${exercise.level}" data-pick="exercise:${esc(exercise.id)}" title="${esc(exercise.scenario)}" aria-label="${esc(exercise.title)}: ${exercise.level}">${exercise.level==='easy'?'1':exercise.level==='intermediate'?'2':'3'}${record.curriculum?.[operation]?.solved.includes(exercise.id)?' ✓':''}</button>`).join('');
    return `<li class="e6b-skill" data-skill="${operation}"><div class="e6b-skill-head"><span>${esc(OPERATION_NAMES[operation])}</span><span class="e6b-state e6b-state-${state}">${stateLabel(state)}</span></div><div class="e6b-exercises">${buttons}</div></li>`;
  }).join('');
  const missionButtons = MISSIONS.map((mission) => `<button class="e6b-mission" data-pick="mission:${esc(mission.id)}"><strong>${esc(mission.title)}</strong></button>`).join('');
  const dailyButton = `<button class="e6b-daily" data-pick="src:daily"><strong>Daily set</strong><span>6 mixed exercises · ${record.daily?.day === today() ? `${record.daily.done}/${record.daily.set.length} done` : 'ready to start'}</span></button>`;
  return `<div class="e6b-launch" aria-label="E6-B flight computer training">
    <header class="e6b-launch-head"><h1>E6-B</h1></header>
    <button class="e6b-continue" data-pick="exercise:${esc(first.id)}"><strong>Continue learning</strong><span>${esc(nextText)}</span><b>→</b></button>
    <section class="e6b-launch-actions" aria-label="Practice choices">${dailyButton}<div class="e6b-missions"><h2>Missions</h2>${missionButtons}</div></section>
    <section class="e6b-curriculum"><div class="e6b-section-head"><h2>Curriculum</h2><span>${operations.length} skills</span></div><ul>${exerciseRows}</ul></section>
  </div>`;
}

type Curriculum = { curriculum?: Record<string, { stage: 'watch' | 'guided' | 'solo' | 'done'; solved: string[] }> };

/** The exercise the learner should do next: the first unsolved one of the first
 * operation not yet fluent. */
export function nextExercise(record: E6BRecord & Curriculum): { id: string; operation: Operation; index: number; count: number } {
  const operations = Object.keys(OPERATION_NAMES) as Operation[];
  const op = operations.find(o => (record.curriculum?.[o]?.solved.length ?? 0) < 3) ?? operations[0];
  const list = exercisesFor(op);
  const first = list.find(e => !record.curriculum?.[op]?.solved.includes(e.id)) ?? list[0];
  return { id: first.id, operation: op, index: list.indexOf(first), count: list.length };
}

/** Phone start screen after a finished exercise: one line, the next exercise. */
export function homeLineHtml(record: E6BRecord & Curriculum): string {
  const n = nextExercise(record);
  return `<button class="e6b-next" data-pick="exercise:${esc(n.id)}"><span class="g" aria-hidden="true">▶</span><span>${esc(OPERATION_NAMES[n.operation])}</span><span class="n">${n.index + 1}/${n.count}</span></button>`;
}

/** One line for the problem on a phone: the numbers and what to find, without
 * the setting ("Busselton coastal navigation exercise:"). The full scenario
 * stays in the tooltip and the accessible name. */
export function problemLine(text: string): string {
  let t = text.trim();
  const colon = t.indexOf(': ');
  if (colon > 0 && colon < 60 && !/\d/.test(t.slice(0, colon).replace(/leg \d+$/, ''))) t = t.slice(colon + 2);
  return t
    .replace(/\.?\s*Find (.+?)\.?$/, ' → $1')
    .replace(/\bground speed\b/g, 'GS').replace(/\belapsed time\b/g, 'time')
    .replace(/\bwind (\d+)°T\/(\d+) kt/g, 'W/V $1/$2').replace(/\bwind (\d)/g, 'W/V $1').replace(/ and /g, ', ').replace(/\s+\(.*?\)/g, '');
}

type TableField = 'head' | 'cross';
const tableValue = (speed: number, angle: number, field: TableField): string => {
  const value = componentTable(speed, angle, field);
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;
};

/** Generated teaching table; values are computed equivalents, not a scan claim. */
export function componentTableSvg(speed: number, angle: number, active: 'head' | 'cross' | null): string {
  const speedLo = Math.floor(speed / 10) * 10;
  const speedHi = speedLo + 10;
  const angleAbs = Math.abs(angle)>90?180-Math.abs(angle):Math.abs(angle);
  const angleLo = Math.floor(angleAbs / 10) * 10;
  const angleHi = Math.min(90, angleLo + 10);
  // Magnify the four entries used for this calculation. A full ten-column
  // table reduced to a phone turns the figures into unreadable dots.
  const cols = [...new Set([angleLo, angleHi])], rows = [speedLo, speedHi];
  const cellW = 294; const cellH = 178; const x0 = 136; const y0 = 224;
  const parts: string[] = [`<text class="table-title" x="30" y="66">Wind components</text><text class="table-note" x="30" y="120">Bracket ${speed} kt at ${angleAbs}°</text><text class="table-note" x="30" y="162">Head / cross · generated table extract</text>`];
  parts.push(`<text class="table-axis" x="30" y="${y0 - 24}">kt</text>`);
  cols.forEach((column, i) => parts.push(`<text class="table-axis" x="${x0 + i * cellW + 76}" y="${y0 - 24}">${column}°</text>`));
  rows.forEach((row, r) => {
    const y = y0 + r * cellH;
    parts.push(`<text class="table-axis" x="30" y="${y + 100}">${row}</text>`);
    cols.forEach((column, c) => {
      const x = x0 + c * cellW;
      const selected = active && (row === speedLo || row === speedHi) && (column === angleLo || column === angleHi);
      const h = tableValue(row, column, 'head'); const cross = tableValue(row, column, 'cross');
      parts.push(`<g class="table-cell${selected ? ` table-cell-active table-cell-active-${active}` : ''}" transform="translate(${x} ${y})"><rect width="${cellW - 10}" height="${cellH - 10}" rx="12"/><text class="table-head" x="20" y="65">Head ${h}</text><text class="table-cross" x="20" y="125">Cross ${cross}</text></g>`);
    });
  });
  return parts.join('');
}
