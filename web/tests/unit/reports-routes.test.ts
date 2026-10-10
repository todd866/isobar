import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({auth:vi.fn(),service:{hold:vi.fn(),preview:vi.fn(),unsubscribe:vi.fn(),trust:vi.fn(),command:vi.fn(),list:vi.fn()}}));
vi.mock('../../src/lib/server/auth',()=>({auth:mocks.auth}));
vi.mock('../../src/lib/reports/server',()=>({reports:()=>mocks.service}));
import {GET as preview,POST as hold} from '../../src/app/reports/[id]/route';
import {GET as unsubscribePage,POST as unsubscribe} from '../../src/app/api/reports/unsubscribe/[id]/route';
import {GET as list,POST as command} from '../../src/app/api/reports/route';
import {POST as trust} from '../../src/app/api/reports/trust/route';
const context={params:Promise.resolve({id:'run'})};
const req=(method='POST',body='',origin='https://isobar.md')=>new Request('https://isobar.md/reports/run?a=hold&t=signed',{method,headers:{origin,'content-type':'application/x-www-form-urlencoded'},...(method==='POST'?{body}:{})});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('ISOBAR_OWNER_EMAIL','owner@example.test');vi.stubEnv('ISOBAR_REPORTS_ENABLED','1');vi.stubEnv('AUTH_SECRET','auth-secret');vi.stubEnv('DATABASE_URL','postgres://db.example.test/isobar');vi.stubEnv('RESEND_API_KEY','resend-key');vi.stubEnv('EMAIL_FROM','Isobar <reports@example.test>');vi.stubEnv('ISOBAR_REPORT_SENDER_IDENTITY','Isobar · Perth WA');});
describe('signed report action boundaries',()=>{
 it('authenticates before exposing rollout availability',async()=>{
  vi.stubEnv('ISOBAR_REPORTS_ENABLED','0');
  mocks.auth.mockResolvedValue(null);expect((await list()).status).toBe(401);
  mocks.auth.mockResolvedValue({user:{id:'alice'}});
  const response=await list();expect(response.status).toBe(200);expect(await response.json()).toEqual({enabled:false,subscriptions:[]});
  expect(mocks.service.list).not.toHaveBeenCalled();
 });
 it.each([
  ['explicit flag', { ISOBAR_REPORTS_ENABLED: '0' }],
  ['sender identity', { ISOBAR_REPORT_SENDER_IDENTITY: '' }],
 ])('returns unavailable without %s configuration',async(_label,patch)=>{
  for(const [key,value] of Object.entries(patch)) vi.stubEnv(key,value);
  mocks.auth.mockResolvedValue({user:{id:'alice'}});
  const response=await list();expect(response.status).toBe(200);expect(await response.json()).toEqual({enabled:false,subscriptions:[]});
  expect(mocks.service.list).not.toHaveBeenCalled();
 });
 it('signed hold and preview links still require the exact owner session',async()=>{
  for(const email of [null,'other@example.test','owner+alias@example.test']){
   mocks.auth.mockResolvedValue(email?{user:{id:'other',email}}:null);
   expect((await preview(req('GET'),context)).status).toBe(401);
   expect((await hold(req(),context)).status).toBe(403);
  }
  expect(mocks.service.preview).not.toHaveBeenCalled();expect(mocks.service.hold).not.toHaveBeenCalled();
 });
 it('GET cannot hold; authenticated same-origin POST can, and foreign POST cannot',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner',email:'owner@example.test'}});
  mocks.service.preview.mockResolvedValue({html:'<p>Forecast</p>',status:'awaiting-owner',subscriptionId:'sub',subscription:{user:{email:'pilot@example.test'},autoApprove:false}});
  expect((await preview(req('GET'),context)).status).toBe(200);expect(mocks.service.hold).not.toHaveBeenCalled();
  expect((await hold(req('POST','','https://attacker.test'),context)).status).toBe(403);
  mocks.service.hold.mockResolvedValue(true);expect((await hold(req(),context)).status).toBe(200);expect(mocks.service.hold).toHaveBeenCalledWith('run','signed');
 });
 it('one-click unsubscribe accepts a signed POST without a session, never scanner GET',async()=>{
  await unsubscribePage(req('GET'));expect(mocks.service.unsubscribe).not.toHaveBeenCalled();
  mocks.service.unsubscribe.mockResolvedValue(true);
  expect((await unsubscribe(req('POST','List-Unsubscribe=One-Click'),context)).status).toBe(200);
  expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.service.unsubscribe).toHaveBeenCalledWith('run','signed');
 });
 it('account mutations bind to session user and reject unauthenticated access',async()=>{
  mocks.auth.mockResolvedValue(null);expect((await list()).status).toBe(401);
  mocks.auth.mockResolvedValue({user:{id:'alice'}});mocks.service.command.mockResolvedValue({ok:true});
  await command(new Request('https://isobar.md/api/reports',{method:'POST',headers:{origin:'https://isobar.md'},body:JSON.stringify({action:'pause',id:'subscription'})}));
  expect(mocks.service.command).toHaveBeenCalledWith('alice',{action:'pause',id:'subscription'});
 });
 it('only owner can set future auto-approval',async()=>{
  mocks.auth.mockResolvedValue({user:{email:'other@example.test'}});expect((await trust(req('POST','id=sub&autoApprove=true'))).status).toBe(403);
  mocks.auth.mockResolvedValue({user:{email:'owner@example.test'}});expect((await trust(req('POST','id=sub&autoApprove=true'))).status).toBe(200);
  expect(mocks.service.trust).toHaveBeenCalledExactlyOnceWith('sub',true);
 });
});

it('account resume cannot bypass the chat watcher with new instructions',async()=>{
 mocks.auth.mockResolvedValue({user:{id:'alice'}});
 const response=await command(new Request('https://isobar.md/api/reports',{method:'POST',headers:{origin:'https://isobar.md'},body:JSON.stringify({action:'resume',id:'sub',instructions:'unwatched instructions'})}));
 expect(response.status).toBe(400);expect(mocks.service.command).not.toHaveBeenCalled();
});
