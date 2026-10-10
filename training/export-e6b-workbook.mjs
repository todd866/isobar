import { mkdir, writeFile } from 'node:fs/promises';
import { E6B_PROCEDURES, OPERATION_NAMES } from './src/instruments/e6b/procedures.ts';

const esc = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value) => Number(value.toFixed(2)).toLocaleString('en-AU');
const out = ['# E6-B workbook', '', 'Generated from `training/src/instruments/e6b/procedures.ts`. Every row below is a physical action checked by the simulated instrument; readings are taken from the resulting pose, within the stated tolerance.', '', '## How to use it', '', 'Estimate before touching the computer. The black outer scale is fixed; turn the blue disc, move the red hairline, and read at the point of action. If you miss, use the correction in the same row, then repeat the move. Keep the view orientation separate from disc alignment.', ''];
let operation = '';
for (const item of E6B_PROCEDURES) {
  if (item.operation !== operation) {
    operation = item.operation;
    out.push(`## ${OPERATION_NAMES[operation]}`, '');
  }
  out.push(`### ${item.level}: ${item.title} (${item.id})`, '', `**Scenario:** ${esc(item.scenario)}  `, `**Estimate:** ${esc(item.estimate)}  `, `**Source:** ${esc(item.source)}  `, `**Why it works:** ${esc(item.procedure[0].why)}  `, `**Answer:** ${number(item.answer.exact)} ${esc(item.answer.unit)} ± ${number(item.readingTolerance)}`, '', '| # | Exact physical action | Success check | Common wrong move | Correction |', '|---:|---|---|---|---|');
  item.procedure.forEach((step, index) => out.push(`| ${index + 1} | ${esc(step.action)} | ${esc(step.success)} | ${esc(step.wrongMove)} | ${esc(step.correction)} |`));
  out.push('');
}
out.push('## Accuracy notes', '', '- TAS uses the E6-B incompressible density-slide approximation; compressibility is not represented.', '- True altitude assumes the ISA lapse rate between station and aircraft, as stated in the ASA manual.', '- The high-speed wind slide is used for the B727 procedures. ASA p.28 confirms the 10-knot convention. The 100–1000 kt teaching range and normalized fivefold geometry are provisional: the local manual has no dimensioned accessory drawing. These are not asserted to be measured physical end marks.', '- Off-course correction follows the 1-in-60 approximation and adds the parallel and closing corrections.', '');
await mkdir(new URL('../docs/training/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/training/e6b-workbook.md', import.meta.url), `${out.join('\n')}\n`, 'utf8');
