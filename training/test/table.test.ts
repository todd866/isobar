/** The handbook table: structure in the markup, and layout in a real
 * (headless) DOM at desktop and phone widths: never clipped, numbers right
 * aligned in tabular figures, the group header spanning its columns. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { judge, retestCard } from '../src/adaptive.ts';
import { sources } from '../src/catalog.ts';
import { drillCards } from '../src/skills/index.ts';
import { numberLine, renderTable } from '../src/table.ts';
import { renderShell, type RenderInput } from '../src/view.ts';
import type { Card } from '../src/model.ts';
import { chromePath, launch } from '../tools/browser.mjs';

const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const bank = drillCards();

function card(id: string): Card {
  const found = bank.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function count(html: string, needle: RegExp): number {
  return html.match(needle)?.length ?? 0;
}

test('the fuel-flow table is a captioned handbook table with a spanning weight header', () => {
  const table = card('drill.table-cell.r1').figure!.table!;
  const html = renderTable(table, { used: false, slip: false });
  assert.ok(html.includes('<caption>Table 3.1 · M 0.80 fuel flow · kg/h</caption>'));
  assert.ok(html.includes(`<th scope="colgroup" colspan="${table.columns.length}" class="group">Gross weight (t)</th>`));
  assert.ok(html.includes('<th scope="col" rowspan="2" class="corner">FL</th>'));
  assert.equal(count(html, /<th scope="col" class="col/g), table.columns.length);
  assert.equal(count(html, /<th scope="row">FL\d{3}<\/th>/g), table.rows.length);
  assert.equal(count(html, /<td class="n/g), table.rows.length * table.columns.length);
  assert.ok(table.rows.length >= 3 && table.columns.length >= 3, 'a window of the table, not one line');
  assert.equal(html.includes('fuel flow kg/h</td>'), false, 'no stray unit row');
  assert.equal(count(html, / used/g), 0, 'nothing marked before the answer');
  const marked = renderTable(table, { used: true, slip: false });
  assert.equal(count(marked, /class="n used"/g), table.used.length);
  assert.ok(marked.includes('class="col on"'), 'the used column header is marked');
  assert.ok(marked.includes('<tr class="on">'), 'the used row is marked');
});

test('the number line marks the fraction and hides the result until solved', () => {
  const span = card('drill.interpolate.r1').figure!.table!.spans![0]!;
  const open = numberLine(span, 0, 'kg/h', false);
  assert.ok(open.includes('½'));
  assert.ok(open.includes('>?</text>'));
  const done = numberLine(span, 0, 'kg/h', true);
  assert.equal(done.includes('>?</text>'), false);
  assert.ok(done.includes(Math.round(span.result).toLocaleString('en-AU')));
});

test('stems never narrate the layout', () => {
  for (const item of bank) {
    assert.equal(/\b(beside|below|above|on the (left|right)|shown here)\b/i.test(item.stem), false, item.id);
  }
});

function shell(item: Card, patch: Partial<RenderInput> = {}): string {
  return renderShell({
    page: 'review',
    mode: 'performance',
    card: item,
    phase: 'ask',
    selected: null,
    done: 0,
    due: 1,
    profileDue: 0,
    retentionPct: 0,
    streak: 0,
    snapshot: null,
    sources,
    cards: bank,
    overlay: 'none',
    flagDraft: '',
    flagged: false,
    shortcuts: [],
    ...patch,
  });
}

interface Layout {
  pageOverflow: number;
  tables: { fits: boolean; inCard: boolean; right: boolean; tabular: boolean; groupSpan: boolean; caption: string }[];
  side: boolean;
  deadArea: number;
}

const browserPath = chromePath();

test('the table fits without clipping at 1280 and 390 wide, light and dark', { skip: browserPath ? false : 'no headless Chromium', timeout: 60_000 }, async () => {
  const browser = await launch();
  assert.ok(browser);
  const start = card('drill.interpolate.r1');
  const miss = judge(start, String(start.numeric!.diagnoses[0]!.value), 1_000);
  const cases: [string, string][] = [
    ['ask', shell(start)],
    ['retest', shell(retestCard(start, miss)!)],
    ['double', shell(card('drill.interpolate.r2'), { phase: 'revealed', selected: String(card('drill.interpolate.r2').numeric!.value) })],
    ['climb', shell(card('drill.interpolate.r4'), { phase: 'revealed', selected: '1' })],
    ['descent', shell(card('drill.table-cell.r2'))],
    ['winds', shell(card('drill.met-level.r3'), { phase: 'revealed' })],
    ...[1, 2, 3, 4].map((rung): [string, string] => [`cg${rung}`, shell(card(`drill.cg-shift.r${rung}`), { phase: 'revealed' })]),
  ];
  try {
    for (const [width, height] of [[1280, 820], [390, 844]] as const) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height } });
        for (const [name, html] of cases) {
          await page.setContent(`<!DOCTYPE html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html, body, #app { height: 100%; margin: 0; } ${css}</style></head><body><div id="app" class="trainer" data-theme="${theme}">${html}</div></body></html>`);
          const layout = await page.evaluate((): Layout => {
            const cardBox = document.querySelector('.review-card')!.getBoundingClientRect();
            const tables = Array.from(document.querySelectorAll('table.hb')).map((table) => {
              const wrap = table.parentElement!;
              const box = table.getBoundingClientRect();
              const cols = Array.from(table.querySelectorAll('th.col')).map((th) => th.getBoundingClientRect());
              const group = table.querySelector('th.group')!.getBoundingClientRect();
              const cells = Array.from(table.querySelectorAll('td.n, th.col'));
              return {
                fits: wrap.scrollWidth <= wrap.clientWidth + 1,
                inCard: box.left >= cardBox.left - 0.5 && box.right <= cardBox.right + 0.5,
                right: cells.every((cell) => getComputedStyle(cell).textAlign === 'right'),
                tabular: getComputedStyle(table).fontVariantNumeric.includes('tabular-nums'),
                groupSpan: Math.abs(group.left - cols[0]!.left) < 1.5 && Math.abs(group.right - cols.at(-1)!.right) < 1.5,
                caption: table.querySelector('caption')!.textContent ?? '',
              };
            });
            const stem = document.querySelector('.stem')!.getBoundingClientRect();
            const figure = document.querySelector('.figure')!.getBoundingClientRect();
            const head = document.querySelector('.prompt-head')!.getBoundingClientRect();
            const body = document.querySelector('.prompt-body')!.getBoundingClientRect();
            const pad = parseFloat(getComputedStyle(document.querySelector('.review-card')!).paddingBottom);
            const content = Math.max(figure.bottom, body.bottom, head.bottom);
            return {
              pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
              tables,
              side: figure.left >= stem.right,
              deadArea: cardBox.bottom - pad - content,
            };
          });
          const where = `${name} ${width} ${theme}`;
          assert.ok(layout.pageOverflow <= 0, `${where}: page scrolls sideways by ${layout.pageOverflow}px`);
          assert.equal(layout.tables.length, 1, where);
          for (const table of layout.tables) {
            assert.ok(table.fits, `${where}: table clipped or scrolling`);
            assert.ok(table.inCard, `${where}: table outside the card`);
            assert.ok(table.right, `${where}: numbers not right-aligned`);
            assert.ok(table.tabular, `${where}: not tabular figures`);
            assert.ok(table.groupSpan, `${where}: group header does not span the columns`);
            assert.ok(/^(Table \d\.\d · .+ · (kg\/h|kg)|RSWT · Forecast winds|Loading · Moments)$/.test(table.caption), `${where}: caption “${table.caption}”`);
          }
          assert.equal(layout.side, width >= 1000, `${where}: figure ${layout.side ? 'beside' : 'below'} the stem`);
          assert.ok(layout.deadArea < 24, `${where}: ${Math.round(layout.deadArea)}px of empty card`);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('forecast winds keep raw samples in a captioned table and mark only on support or reveal', () => {
  for (const rung of [1, 2, 3, 4]) {
    const item = card(`drill.met-level.r${rung}`);
    const table = item.figure!.table!;
    const html = shell(item);
    assert.ok(html.includes('<caption>RSWT · Forecast winds</caption>'));
    assert.ok(html.includes('colspan="2" class="group">Wind</th>'));
    assert.ok(table.rows.some((row) => row.cells[1] === 35), 'raw 35 kt must not silently become 40');
    assert.equal(count(html, /class="n used"/g), 0);
    assert.equal(count(shell(item, { phase: 'revealed' }), /class="n used"/g), 2);
    const retest = retestCard(item, judge(item, '', 1000))!;
    assert.equal(count(shell(retest), /class="n used"/g), 2);
  }
});

test('every computed moment cell is gated by an existing step and reveals independently', () => {
  for (const rung of [1, 2, 3, 4]) {
    const item = card(`drill.cg-shift.r${rung}`);
    const table = item.figure!.table!;
    const computed = table.computed!;
    const ids = new Set(item.numeric!.steps!.map((step) => step.id));
    for (const cell of computed) assert.ok(ids.has(cell.step), `${item.id}: orphaned ${cell.step}`);
    const before = renderTable(table, { used: true, slip: false });
    assert.equal(count(before, /aria-label="calculate"/g), computed.length);
    const first = computed[0]!.step;
    const oneDone = renderTable(table, { used: true, slip: false, stepSolved: (id) => id === first });
    assert.equal(count(oneDone, /aria-label="calculate"/g), computed.filter((cell) => cell.step !== first).length);
    assert.equal(count(renderTable(table, { used: true, slip: false, revealed: true }), /aria-label="calculate"/g), 0);
  }
});
