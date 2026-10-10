import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import { installTrainingFiles } from './training-files';
const shots=path.resolve(import.meta.dirname,'../../../build/qa/reports');
// Uses the normal locally built Next server. All account/report APIs are mocked.
for(const theme of ['light','dark'] as const) test(`Reports controls and viewport: ${theme}`,async({page})=>{
 let status='active';let unavailable=false;
 if(process.env.ISOBAR_E2E_FILES==='1') await installTrainingFiles(page.context());
 else await page.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.route('**/api/**',route=>route.fulfill({json:{}}));
 await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{id:'user-1',email:'pilot@example.test'}}}));
 await page.route('**/api/billing',route=>route.fulfill({json:{enabled:true,paid:false,plan:null,status:null}}));
 await page.route('**/api/account/data',route=>route.fulfill({json:{docs:{}}}));
 await page.route('**/api/reports',async route=>{
  if(unavailable)return route.fulfill({status:503,json:{error:'unavailable'}});
  if(route.request().method()==='GET')return route.fulfill({json:{subscriptions:[{id:'r1',kind:'recurring',schedule:'0 6 * * *',timezone:'Australia/Perth',places:[{name:'Perth'}],status,nextRunAt:'2026-10-09T22:00:00Z'}]}});
  const action=route.request().postDataJSON().action;status=action==='pause'?'paused':action==='resume'?'active':'cancelled';return route.fulfill({json:{ok:true,line:`Report ${status}.`}});
 });
 await page.setViewportSize({width:1280,height:720});await page.emulateMedia({colorScheme:theme});
 await page.addInitScript(mode=>localStorage.setItem('isobar-theme',mode),theme);
 await page.goto('/download');await page.locator('[data-account-button="in"]:visible').click();
 await expect(page.locator('[data-billing-row]')).toBeVisible();
 await page.getByRole('button',{name:'Reports',exact:true}).click();
 await expect(page.locator('[data-report-id="r1"]')).toBeVisible();
 await expect(page.getByText('06:00 Perth',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
 await expect(page.locator('[data-reports] [role="status"]')).toHaveText('Report paused.');
 await page.getByRole('button',{name:'Resume',exact:true}).click();
 fs.mkdirSync(shots,{recursive:true});
 const helper=path.join(os.homedir(),'Projects/.ux-authoring/viewport-fit.mjs');
 for(const [name,viewport] of Object.entries({laptop:{width:1280,height:720},phone:{width:390,height:844},landscape:{width:844,height:390}})){
  await page.setViewportSize(viewport);await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeInViewport();
  if(fs.existsSync(helper)){
   const {assertViewport}=await import(pathToFileURL(helper).href);
   await assertViewport(page,{documentY:'allow',primary:[{selector:'[data-reports]',fit:'visible',minWidth:240,minHeight:48}],controls:[{selector:'[data-report-id="r1"] button',minWidth:35,minHeight:30}],screenshotPath:path.join(shots,`${name}-${theme}.png`)});
  }else{expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:path.join(shots,`${name}-${theme}.png`)});}
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{const sizes=[...document.querySelectorAll<HTMLElement>('[data-reports] *')].map(el=>({el,size:parseFloat(getComputedStyle(el).fontSize)}));for(const {el,size} of sizes)el.style.fontSize=`${size*2}px`;});
 await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:path.join(shots,`phone-large-text-${theme}.png`)});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('[data-reports] [role="status"]')).toHaveText('Report cancelled.');
 await page.keyboard.press('Escape');await expect(page.locator('[data-account-sheet]')).toHaveCount(0);
 await page.locator('[data-account-button="in"]:visible').click();unavailable=true;await page.getByRole('button',{name:'Reports',exact:true}).click();
 await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();unavailable=false;await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.locator('[data-report-id="r1"]')).toBeVisible();
});
