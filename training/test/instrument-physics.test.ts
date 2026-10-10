import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRCRAFT, BALANCE, isaTemperatureK } from '../src/b727/model.ts';
import { atmosphere, balance, bilinear, interpolate, profile, ROUTES, vector, windTriangle } from '../src/instruments/physics.ts';

const near = (a: number, b: number, e = 1e-8) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);

test('vector uses screen north and closes cardinal directions', () => {
  assert.deepEqual(vector(0, 10), { x: 0, y: -10 });
  assert.deepEqual(vector(90, 10), { x: 10, y: 0 });
  for (const bearing of [0, 37, 90, 180, 271]) near(Math.hypot(...Object.values(vector(bearing, 42))), 42);
});

test('wind triangle resolves calm, headwind and crosswind', () => {
  const calm = windTriangle({ tas: 120, track: 0, windFrom: 0, windSpeed: 0 });
  near(calm.heading, 0); near(calm.groundspeed, 120); near(calm.drift, 0);
  const head = windTriangle({ tas: 120, track: 0, windFrom: 0, windSpeed: 30 });
  near(head.heading, 0); near(head.groundspeed, 90); near(head.headwind, 30);
  const cross = windTriangle({ tas: 120, track: 0, windFrom: 90, windSpeed: 60 });
  near(cross.groundspeed, Math.sqrt(120 ** 2 - 60 ** 2));
  assert.ok(Math.abs(cross.drift) > 20 && Math.abs(cross.drift) < 35);
  assert.equal(windTriangle({ tas: 0, track: 0, windFrom: 0, windSpeed: 10 }).feasible, false);
  const right = windTriangle({ tas: 100, track: 0, windFrom: 60, windSpeed: 50 });
  const left = windTriangle({ tas: 100, track: 0, windFrom: 300, windSpeed: 50 });
  near(right.drift, -left.drift);
  assert.equal(windTriangle({ tas: 100, track: 0, windFrom: 90, windSpeed: 120 }).feasible, false);
  assert.ok(windTriangle({ tas: 100, track: 0, windFrom: 0, windSpeed: 150 }).groundspeed < 0, 'a stronger headwind has no forward progress');
});

test('atmosphere separates QNH from a second altimeter setting', () => {
  const std = atmosphere({ level: 10000, oat: -10, qnh: 1013.25 });
  near(std.pressureAltitude, 10000); near(std.isa, -4.8, 0.2);
  assert.ok(std.densityAltitude < std.pressureAltitude);
  const cold = atmosphere({ level: 5000, oat: -20, qnh: 1013.25, setting: 1003.25 });
  assert.ok(cold.coldError > 0);
  assert.ok(cold.correction < 0, 'high setting to low actual QNH lowers true altitude');
  const sameSetting = atmosphere({ level: 5000, oat: -5, qnh: 1000, setting: 1013.25 });
  near(sameSetting.pressureAltitude, pressureAltitudeForTest(5000, 1013.25));
  const isa = atmosphere({ level: 5000, oat: isaTemperatureK(5000) - 273.15, qnh: 1013.25, fieldElevation: 1000 });
  near(isa.coldError, 0, 1e-8);
});

function pressureAltitudeForTest(level: number, setting: number): number { return level + (1013.25 - setting) * 27; }

test('single and double interpolation hit corners and centre exactly', () => {
  near(interpolate(0, 0, 10, 20, 40), 20); near(interpolate(10, 0, 10, 20, 40), 40); near(interpolate(5, 0, 10, 20, 40), 30);
  near(bilinear(5, 5, [0, 10], [0, 10], [[0, 10], [20, 30]]), 15);
  near(bilinear(0, 10, [0, 10], [0, 10], [[0, 10], [20, 30]]), 20);
});

test('balance uses the B727 real envelope and capacities', () => {
  const within = balance({ passengers: [20, 20, 20, 10, 5], cargo: [1000, 500, 600, 500], fuel: 12000 });
  assert.equal(within.status, 'within');
  assert.ok(within.forward < within.aft && within.cg >= within.forward && within.cg <= within.aft);
  const hold = balance({ passengers: [0, 0, 0, 0, 0], cargo: [BALANCE.compartments[1].maxKg + 1, 0, 0, 0], fuel: 0 });
  assert.equal(hold.status, 'capacity');
  const heavy = balance({ passengers: [36, 36, 30, 30, 30], cargo: [0, 0, 0, 0], fuel: AIRCRAFT.fuel.usableWithAuxKg });
  assert.equal(heavy.status, 'overweight');
});

test('profile exposes the 2/3 climb, half descent and 3x rule', () => {
  const p = profile({ weight: 70000, level: 310, isaDeviation: 0, climbWind: 20, descentWind: { speedKt: 10, direction: 'headwind' }, distance: 800, arrivalAltitude: 1500 });
  near(p.climbWindLevel, 31000 * 2 / 3); near(p.descentWindLevel, (31000 + 1500) / 2); near(p.threeRuleNm, (31000 - 1500) / 1000 * 3);
  assert.ok(p.climbMinutes > 0 && p.descentMinutes > 0 && p.toc > 0 && p.tod < 800);
});

test('routes are real coordinates with derived geodesy', () => {
  const r = ROUTES['YSSY-YPPH'];
  assert.ok(r && r.distanceNm > 1500 && r.distanceNm < 1900);
  assert.ok(r.trackTrue > 200 && r.trackTrue < 300);
});

test('wind vectors close at arbitrary bearings and reject no forward progress', () => {
  for (const track of [0, 37, 180, 359]) for (const from of [0, 80, 190, 325]) {
    const r=windTriangle({tas:140,track,windFrom:from,windSpeed:40});
    const a=vector(r.heading,140),w=vector(from+180,40),g=vector(track,r.groundspeed);
    near(a.x+w.x,g.x);near(a.y+w.y,g.y);
  }
  const cross=windTriangle({tas:120,track:0,windFrom:90,windSpeed:60});
  near(cross.heading,30);near(cross.drift,-30);
  assert.equal(windTriangle({tas:100,track:0,windFrom:90,windSpeed:101}).feasible,false);
  assert.equal(windTriangle({tas:100,track:0,windFrom:0,windSpeed:100}).feasible,false);
  assert.equal(windTriangle({tas:100,track:0,windFrom:0,windSpeed:120}).feasible,false);
});

test('altimeter pressure and temperature effects remain separate', () => {
  const isaOat=15-.0065*10000*.3048;
  const a=atmosphere({level:10000,oat:isaOat,qnh:1013.25,setting:1013.25});
  near(a.isaDeviation,0);near(a.trueAltitude,10000);near(a.coldError,0);
  const low=atmosphere({level:10000,oat:isaOat,qnh:993.25,setting:1013.25});
  near(low.pressureAltitude,a.pressureAltitude);near(low.trueAltitude,10000-20*27);
  const cold=atmosphere({level:10000,oat:isaOat-20,qnh:1013.25});
  near(cold.trueAltitude,10000*(288.15-20)/288.15);near(cold.coldError,10000-cold.trueAltitude);
  const field=atmosphere({level:1000,fieldElevation:1000,oat:-20,qnh:1013.25});
  near(field.trueAltitude,1000);
});

test('asymmetric double interpolation exposes axis transposition', () => {
  near(bilinear(2,3,[0,8],[0,10],[[10,50],[110,230]]),56);
});

test('load transfer conserves mass and changes moment by mass times arm', () => {
  const a=balance({passengers:[0,0,0,0,0],cargo:[1000,0,0,0],fuel:0});
  const b=balance({passengers:[0,0,0,0,0],cargo:[0,0,0,1000],fuel:0});
  near(a.weight,AIRCRAFT.weights.basicWeightKg+1000);near(a.weight,b.weight);
  near(b.moment-a.moment,1000*(30.5-12));
  near(b.cg-a.cg,1000*(30.5-12)/a.weight/AIRCRAFT.wing.macM*100);
  near(b.index-a.index,1000*(30.5-12)/500);
  assert.equal(balance({passengers:[37],cargo:[],fuel:0}).status,'capacity');
  assert.equal(balance({passengers:[.5],cargo:[],fuel:0}).status,'capacity');
  assert.equal(balance({passengers:[NaN],cargo:[],fuel:0}).status,'capacity');
  assert.ok(Number.isNaN(balance({passengers:[],cargo:[],fuel:32141}).cg));
  assert.equal(balance({passengers:[36,36,30,30,30],cargo:[2300,1800,1850,1800],fuel:0}).status,'overweight');
});

test('profile wind correction is exactly wind times elapsed time', () => {
  const input={weight:70000,landingWeight:60000,level:310,isaDeviation:0,distance:800,climbWind:0,descentWind:0};
  const calm=profile(input),tail=profile({...input,climbWind:30,descentWind:60});
  near(tail.climbNm-calm.climbNm,30*calm.climbMinutes/60);
  near(tail.descentNm-calm.descentNm,60*calm.descentMinutes/60);
  near(tail.tod,800-tail.descentNm);
  assert.equal(profile({...input,distance:10}).feasible,false);
  assert.equal(profile({...input,arrivalAltitude:-1000}).feasible,false);
  assert.equal(profile({...input,landingWeight:NaN}).feasible,false);
  assert.equal(profile({...input,landingWeight:71000}).feasible,false);
  assert.equal(profile({...input,level:Infinity}).feasible,false);
});
