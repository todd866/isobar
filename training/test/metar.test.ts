import assert from 'node:assert/strict';
import test from 'node:test';
import { convectiveCloud } from '../src/live.ts';

const ypph = 'METAR SPECI YPPH 061141Z 12007KT 9999 VCTS FEW035CB SCT069 BKN115 20/17 Q1015 RETS RESHRA';

test('a buried CB layer leads the datum', () => {
  const shown = convectiveCloud(ypph, 'FEW035CB/SCT069/BKN115');
  assert.equal(shown.hazard, 'VCTS');
  assert.equal(shown.lead, 'CB 3,500');
  assert.equal(shown.rest, 'SCT069 · BKN115');
  assert.equal(shown.lead.includes('FEW'), false);
});

test('the native convective datum stays in order', () => {
  const shown = convectiveCloud(ypph, 'CB 3,500 · SCT069 · BKN115', 'VCTS');
  assert.equal(shown.hazard, 'VCTS');
  assert.equal(shown.lead, 'CB 3,500');
  assert.equal(shown.rest, 'SCT069 · BKN115');
});

test('overhead thunder outranks vicinity and recent weather', () => {
  const shown = convectiveCloud('METAR YPPH 061200Z 12010KT 4000 TSRA FEW012CB RETS', 'FEW012CB');
  assert.equal(shown.hazard, 'TS');
  assert.equal(shown.lead, 'CB 1,200');
});

test('towering cumulus leads without a thunderstorm', () => {
  const shown = convectiveCloud('METAR YPPH 061200Z 18008KT 9999 FEW020TCU', 'FEW020TCU');
  assert.equal(shown.hazard, 'TCU');
  assert.equal(shown.lead, 'TCU 2,000');
  assert.equal(shown.rest, '');
});

test('an ordinary layer is unchanged', () => {
  const shown = convectiveCloud('METAR YPPH 062230Z 20007KT 9999 FEW013 14/13 Q1016', 'FEW013', '');
  assert.equal(shown.hazard, '');
  assert.equal(shown.lead, '');
  assert.equal(shown.rest, 'FEW013');
});
