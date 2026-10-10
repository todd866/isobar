import {createRequire} from 'node:module';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const {assertViewport}=await import(process.env.VIEWPORT_HELPER ?? `${process.env.HOME}/Projects/.ux-authoring/viewport-fit.mjs`);
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext();const page=await context.newPage();const urls=[];const errors=[];
 page.on('request',r=>{if(r.url().includes('/history/'))urls.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1280,height:720});await page.goto(`${process.env.HISTORY_ORIGIN ?? 'http://127.0.0.1:4319'}/historical`);
 await page.waitForFunction(()=>document.querySelector('input[type=range]')?.max==='23');
 const mapButton=page.locator('[data-historical-controls]').getByRole('button',{name:'Map',exact:true});
 if(await mapButton.count()){await mapButton.click();await page.locator('dialog img').evaluate(async i=>{await i.decode()});assert(await page.locator('dialog').isVisible());await page.keyboard.press('Escape');assert(!(await page.locator('dialog').isVisible()));}
 await page.getByRole('button',{name:'Sources',exact:true}).click();
 await assertViewport(page,{primary:[{selector:'[data-historical-map]',minHeight:100}],controls:[{selector:'[aria-label="Historical hour"]'}],screenshotPath:'build/history/qa/sources.png'});
 await page.getByRole('button',{name:'Sources',exact:true}).click();
 const requests=urls.length;await context.setOffline(true);
 await page.getByRole('combobox',{name:'Available historical days',exact:true}).selectOption('1944-06-06');
 await page.waitForFunction(()=>document.querySelector('[aria-label="Historical playback controls"]')?.textContent.includes('06 Jun'));
 await page.getByRole('combobox',{name:'Available historical days',exact:true}).selectOption('1944-06-05');
 await page.waitForFunction(()=>document.querySelector('[aria-label="Historical playback controls"]')?.textContent.includes('05 Jun'));
 await page.getByRole('slider',{name:'Historical hour'}).fill('12');
 assert((await page.locator('[aria-label="Historical playback controls"]').innerText()).includes('12:00Z'));
 await page.getByRole('button',{name:'Play historical weather'}).click();await page.waitForTimeout(1100);await page.getByRole('button',{name:'Pause historical weather'}).click();
 assert(Number(await page.getByRole('slider',{name:'Historical hour'}).inputValue())>=13);
 await page.getByRole('button',{name:'Show Normandy view'}).click();await page.screenshot({path:'build/history/qa/normandy.png'});
 await page.getByRole('button',{name:'Show world view'}).click();await page.getByRole('button',{name:'Zoom in'}).click();
 if(await mapButton.count()){await mapButton.click();await page.keyboard.press('Escape');}assert.equal(urls.length,requests);
 for(const [name,width,height] of [['phone',390,844],['landscape',844,390],['short-laptop',1024,600],['large-text',390,844],['dark',1280,720]]){
  await page.setViewportSize({width,height});await page.evaluate(name=>{document.documentElement.style.fontSize=name==='large-text'?'200%':'';document.documentElement.classList.toggle('dark',name==='dark');},name);
  await assertViewport(page,{primary:[{selector:'[data-historical-map]',minHeight:80}],controls:[{selector:'[aria-label="Available historical days"]'},{selector:'[aria-label="Historical hour"]'}],screenshotPath:`build/history/qa/${name}.png`});
 }
 await context.setOffline(false);
 await page.evaluate(()=>{document.documentElement.style.fontSize='';});
 const options=await page.locator('[aria-label="Historical collection"] option').evaluateAll(nodes=>nodes.map(n=>n.value));
 for(const id of options){
   await page.getByRole('combobox',{name:'Historical collection',exact:true}).selectOption(id);
   await page.waitForFunction(()=>document.querySelector('input[type=range]')?.max==='23' && !document.body.textContent.includes('Loading archive'));
   assert.equal(await page.locator('[data-historical-page] [role=alert]').count(),0);
   if(id!=='dday')assert.equal(await page.getByRole('button',{name:'Show Normandy view'}).count(),0);
 }
 const failed=await context.newPage();let fail=true;
 await failed.route('**/history/catalog.json',route=>fail?route.abort():route.continue());
 await failed.goto(`${process.env.HISTORY_ORIGIN ?? 'http://127.0.0.1:4319'}/historical`);
 await failed.getByRole('button',{name:'Retry',exact:true}).waitFor();fail=false;
 await failed.getByRole('button',{name:'Retry',exact:true}).click();
 await failed.waitForFunction(()=>document.querySelector('input[type=range]')?.max==='23');
 await failed.close();
 assert.deepEqual(errors,[]);console.log('Playback, panels, offline reuse, large text and dark theme passed. Asset requests:',urls.length);
 await context.close();
} finally {await browser.close();}
