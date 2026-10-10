import assert from 'node:assert/strict';
import test from 'node:test';
import { skyState, type Profile, type SkyLayer } from '../src/sky/physics.ts';
import { stateLayers, stateKey } from '../src/sky/render.ts';
const options = { width: 390, height: 236, dpr: 3, dark: false, seed: 'TEST', coastKm: null };
const empty = () => skyState({ icao: 'TEST', elevationFt: 0, lat: 0, lon: 0, timeMs: 0, source: 'none', groups: [], profile: null });
const layer = (cover: SkyLayer['cover'], type: SkyLayer['type'] = 'nimbostratus'): SkyLayer => ({ type, cover, oktas: 6, baseFtAmsl: 5600, topFtAmsl: 18900, precip: 'rain', heavy: false, precipBottomFtAmsl: 0, thunder: false, source: 'both', secondary: false, change: null });
test('production geometry preserves category coverage and missing tops without nominal volume', () => {
  for (const [cover, expected] of [['FEW', 1.5/8], ['SCT', 3.5/8], ['BKN', 6/8], ['OVC', 1]] as const) {
    const state = { ...empty(), layers: [layer(cover)] };
    const [px] = stateLayers(state, options);
    assert.ok(Math.abs(px.segments.reduce((n,[a,b]) => n+b-a,0)-expected) < 1e-10);
    state.layers[0].topFtAmsl = null;
    const [missing] = stateLayers(state, options);
    assert.equal(missing.topY, missing.baseY);
    assert.equal(missing.topKnown, false);
  }
  assert.deepEqual(stateLayers({ ...empty(), layers: [{ ...layer('BKN'), topFtAmsl: NaN }] }, options), []);
});
test('report rain plus a deep locally stable column becomes Ns, never CB from depth', () => {
  const profile: Profile = { timeMs: 0, samples: [0], levels: [0,500,1000,2000,3000,4000,5000,6000,7000].map(zM => ({ hPa: 1000*Math.exp(-zM/8000), zM, tC: 20-zM*.004, rh: zM>=1000&&zM<=5000?97:35, cloudPct: null, wMs: null, windKt: 10, windFrom: 270 })) };
  const state = skyState({ icao:'TEST',elevationFt:0,lat:0,lon:0,timeMs:0,source:'METAR',groups:[{body:'9999 RA BKN035 20/15',change:null}],profile });
  assert.equal(state.layers[0].type, 'nimbostratus');
  assert.equal(state.layers[0].precip, 'rain');
  assert.equal(state.layers[0].thunder, false);
});
test('reported CB without a model retains its base and rain, never a guessed anvil', () => {
  const state=skyState({icao:'TEST',elevationFt:0,lat:0,lon:0,timeMs:0,source:'METAR',groups:[{body:'+TSRA BKN035CB',change:null}],profile:null});
  assert.equal(state.layers[0].type,'cumulonimbus');
  assert.equal(state.layers[0].topFtAmsl,null);
  assert.equal(stateLayers(state,options)[0].topKnown,false);
  assert.equal(state.freezingFt,null);
});
test('cache keys distinguish complete genus, wind height and units', () => {
  const state={...empty(),layers:[layer('BKN','cumulus')]};
  assert.notEqual(stateKey(state,options),stateKey({...state,layers:[layer('BKN','cumulonimbus')]},options));
  assert.notEqual(stateKey(state,options),stateKey(state,{...options,units:{height:'m',temp:'F',visibility:'sm'}}));
});
