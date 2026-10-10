import { describe,it,expect,vi } from 'vitest';
import { nextOccurrence,parseSchedule } from '../../src/lib/reports/schedule';
import { signReportToken,verifyReportToken } from '../../src/lib/reports/tokens';
import { commandSchema,sendAfter,verifiedRecipient } from '../../src/lib/reports/policy';
import { renderReport,resendDelivery } from '../../src/lib/reports/email';
import { reportPoint } from '../../src/lib/reports/deep-link';
const secret='reports-test-secret-at-least-32-characters';
const next=(cron:string,zone:string,after:string)=>nextOccurrence(cron,zone,new Date(after)).toISOString();
describe('report local schedules',()=>{
 it('daily Perth is six local, strictly after the last due instant',()=>{
  expect(next('0 6 * * *','Australia/Perth','2026-10-09T21:59:59Z')).toBe('2026-10-09T22:00:00.000Z');
  expect(next('0 6 * * *','Australia/Perth','2026-10-09T22:00:00Z')).toBe('2026-10-10T22:00:00.000Z');
 });
 it('Sydney six follows both DST transitions, never fixed UTC offsets',()=>{
  expect(next('0 6 * * *','Australia/Sydney','2026-10-02T21:00:00Z')).toBe('2026-10-03T19:00:00.000Z');
  expect(next('0 6 * * *','Australia/Sydney','2026-04-04T19:00:00Z')).toBe('2026-04-04T20:00:00.000Z');
 });
 it('skips nonexistent Sydney wall times and runs repeated time once',()=>{
  expect(next('30 2 * * *','Australia/Sydney','2026-10-03T00:00:00Z')).toBe('2026-10-04T15:30:00.000Z');
  expect(next('30 2 * * *','Australia/Sydney','2026-04-04T15:30:00Z')).toBe('2026-04-05T16:30:00.000Z');
 });
 it('weekly and half-hour zones work without a scheduler dependency',()=>{
  expect(next('0 6 * * 1,5','Australia/Perth','2026-10-09T22:00:00Z')).toBe('2026-10-11T22:00:00.000Z');
  expect(next('0 6 * * *','Australia/Adelaide','2026-10-09T00:00:00Z')).toBe('2026-10-09T19:30:00.000Z');
 });
 it('rejects unbounded cron and invented zones',()=>{
  for(const bad of ['* * * * *','60 6 * * *','0 24 * * *','0 6 1 * *']) expect(()=>parseSchedule(bad)).toThrow();
  expect(()=>next('0 6 * * *','Australia/Unknown','2026-10-09T00:00:00Z')).toThrow();
 });
});
describe('report authority and rendering',()=>{
 it('binds signed tokens to purpose, subscription version, id and expiry',()=>{
  const until=new Date('2026-10-10T00:00:00Z'), now=new Date('2026-10-09T00:00:00Z');
  const token=signReportToken(secret,'hold','run',1,until);
  expect(verifyReportToken(token,secret,'hold','run',1,now)).toBe(true);
  for(const [purpose,id,version] of [['preview','run',1],['hold','other',1],['hold','run',2]] as const) expect(verifyReportToken(token,secret,purpose,id,version,now)).toBe(false);
  expect(verifyReportToken(token,secret,'hold','run',1,until)).toBe(false);
  expect(verifyReportToken(token+'x',secret,'hold','run',1,now)).toBe(false);
  const unsub=signReportToken(secret,'unsubscribe','sub',2);
  expect(verifyReportToken(unsub,secret,'unsubscribe','sub',2,new Date('2040-01-01'))).toBe(true);
 });
 it('never accepts a typed recipient or privileges, and requires verified email',()=>{
  for(const field of ['recipient','email','userId','tier','autoApprove']) expect(commandSchema.safeParse({action:'list',[field]:'attacker'}).success).toBe(false);
  expect(verifiedRecipient({email:'pilot@example.test',emailVerified:null})).toBeNull();
  expect(verifiedRecipient({email:'pilot@example.test',emailVerified:new Date()})).toBe('pilot@example.test');
 });
 it('gates late recurring and immediate reports from actual notification time',()=>{
  const now=new Date('2026-10-09T06:00:00Z');
  expect(+sendAfter(now,now,'recurring')-+now).toBe(300_000);
  expect(+sendAfter(now,now,'once')-+now).toBe(120_000);
  expect(sendAfter(new Date(+now+1_200_000),now,'recurring')).toEqual(new Date(+now+1_200_000));
 });
 it('escapes hostile markup and deep links to real point/time without remote images',()=>{
  const due=new Date('2026-10-09T06:00:00Z'), place={name:'Trigg',lat:-31.877,lon:115.751};
  const report=renderReport('<script>alert(1)</script>\nWind 15 kt',[place],due);
  expect(report.html).not.toContain('<script>');expect(report.html).toContain('&lt;script&gt;');
  expect(report.html).toContain('Open in isobar.md'); expect(report.text).toContain('time=2026-10-09T06%3A00%3A00.000Z');
  expect(reportPoint(new URLSearchParams())).toBeNull();expect(reportPoint(new URLSearchParams('lat=&lon=0'))).toBeNull();
  expect(reportPoint(new URLSearchParams('lat=-31.877&lon=115.751'))).toEqual({lat:place.lat,lon:place.lon});
 });
 it('sends only to server-selected address with Resend idempotency and one-click headers',async()=>{
  const fetchMock=vi.fn(async()=>Response.json({id:'mail-1'}));
  const send=resendDelivery({RESEND_API_KEY:'mock-key',EMAIL_FROM:'Isobar <reports@isobar.test>'},fetchMock as typeof fetch);
  await send({to:'verified@isobar.test',subject:'Weather',html:'<p>Weather</p>',text:'Weather',replyTo:'reports@isobar.test',headers:{'List-Unsubscribe':'<https://isobar.md/api/reports/unsubscribe/sub?t=signed>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}},'stable-key');
  const call=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
  expect(JSON.parse(call[1].body as string).to).toEqual(['verified@isobar.test']);
  expect(new Headers(call[1].headers).get('Idempotency-Key')).toBe('stable-key');
  expect(call[1].redirect).toBe('error');
 });
});
