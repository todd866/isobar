import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assertViewport } from './viewport-fit.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../docs/design/international',import.meta.url));
const output=process.env.ISOBAR_INTERNATIONAL_QA || join(tmpdir(),'isobar-international-qa');mkdirSync(output,{recursive:true});
const check=(value,message)=>{if(!value)throw Error(message)};
const chrome=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
const errors=[],requests=[];
async function choose(page,query,region){await page.click('#place-button');await page.fill('#place-search',query);await page.locator('#place-results button').filter({hasText:region}).click()}
try{
  for(const [name,width,height] of [['laptop',1280,720],['short',1024,600],['phone',390,844],['landscape',844,390]]){
    const context=await browser.newContext({viewport:{width,height},locale:'en-GB',timezoneId:'Australia/Perth'});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});
    try{
      await page.goto(pathToFileURL(root+'/index.html').href);
      await page.click('[data-place="tokyo"]');check((await page.locator('#place-button').textContent()).includes('Tokyo'),'Japan is one tap away');
      check((await page.locator('[data-place="perth"] time').textContent()).includes('08:00'),'Perth clock correct');
      check((await page.locator('[data-place="tokyo"] time').textContent()).includes('09:00'),'Tokyo clock correct');
      await page.click('[data-place="perth"]');check((await page.locator('#place-button').textContent()).includes('Perth'),'Perth is one tap back');
      await page.click('#place-button');await page.fill('#place-search','London');
      check(await page.locator('#place-results button').count()===2,'London results must distinguish countries');
      await assertViewport(page,{primary:[{selector:'#place-dialog',minWidth:260,minHeight:150}],controls:[{selector:'#place-search',minHeight:40}],screenshotPath:`${output}/${name}-search.png`});
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('place-dialog').open);check(await page.locator('#place-button').evaluate(el=>el===document.activeElement),'search restores focus');
      await choose(page,'London','England');
      await page.locator('#time-slider').evaluate(el=>{el.value=12;el.dispatchEvent(new Event('input',{bubbles:true}))});
      const before=Number(await page.locator('#time-slider').inputValue());
      await choose(page,'Tokyo','Japan');
      check(Number(await page.locator('#time-slider').inputValue())===before,'changing city preserves selected instant');
      check((await page.locator('#local-time').textContent()).includes('21:00'),'Tokyo clock must use Tokyo, not laptop timezone');
      await assertViewport(page,{primary:[{selector:'.map-wrap',minWidth:250,minHeight:95}],controls:[{selector:'#place-button',minHeight:40},{selector:'#units-button',minHeight:40},{selector:'#time-slider',minHeight:44},{selector:'#now-button',minHeight:40}],screenshotPath:`${output}/${name}.png`});
      await page.locator('#time-slider').evaluate(el=>{el.value=0;el.dispatchEvent(new Event('input',{bubbles:true}))});
      await page.click('#units-button');await page.selectOption('#temp-units','F');await page.selectOption('#rain-units','in');await page.selectOption('#wind-units','mph');
      await assertViewport(page,{primary:[{selector:'#units-panel',minWidth:200,minHeight:110}],controls:[{selector:'#temp-units',minHeight:32}],screenshotPath:`${output}/${name}-units.png`});
      await page.keyboard.press('Escape');check(await page.locator('#units-button').evaluate(el=>el===document.activeElement),'units restores focus');
      await context.setOffline(true);await choose(page,'Auckland','New Zealand');
      check((await page.locator('#temperature').textContent()).includes('F'),'temperature units survive place switch');
      check((await page.locator('#weather-summary').textContent()).includes(' in '),'rain units survive place switch');
      await page.click('#place-button');await page.click('#pin-button');await page.keyboard.press('Escape');
      await page.reload();check((await page.locator('#place-button').textContent()).includes('Auckland'),'saved city survives reload');check(await page.locator('[data-place=auckland]').count()===1,'pinned place survives reload');
      check((await page.locator('#temperature').textContent()).includes('F'),'units survive reload');
      const original=await page.locator('#map').evaluate(el=>el.toDataURL());
      await page.click('[data-layer="temperature"]');const overlay=await page.locator('#map').evaluate(el=>el.toDataURL());check(overlay!==original,'temperature layer must change map pixels');
      await page.click('[data-layer="temperature"]');check(await page.locator('#map').evaluate(el=>el.toDataURL())===original,'layer off restores map');
      await page.click('[data-layer="rain"]');check(await page.locator('#map').evaluate(el=>el.toDataURL())!==original,'rain layer must change pixels');await page.click('[data-layer="rain"]');
      const band=await page.locator('.timeline').boundingBox();check(band.height>=80,'scrub band must be at least80px');
      await page.mouse.move(band.x+band.width*.2,band.y+10);const early=Number(await page.locator('#time-slider').inputValue());
      await page.mouse.move(band.x+band.width*.8,band.y+10);const late=Number(await page.locator('#time-slider').inputValue());check(late>early+5,'entire timeline band must scrub');
      await page.click('#now-button');check(await page.locator('#play-button').getAttribute('aria-pressed')==='true','Now resumes playback');await page.click('#play-button');
      if(name==='phone'){
        await page.evaluate(()=>document.documentElement.style.fontSize='200%');
        await assertViewport(page,{documentY:'allow',primary:[{selector:'.shell',fit:'visible',minWidth:250,minHeight:200}],screenshotPath:`${output}/phone-large-text.png`});
        await page.locator('.transport').scrollIntoViewIfNeeded();
        await assertViewport(page,{documentY:'allow',primary:[{selector:'.transport',minWidth:250,minHeight:100}],controls:[{selector:'#time-slider',minHeight:44},{selector:'#play-button',minHeight:40},{selector:'#now-button',minHeight:40}],screenshotPath:`${output}/phone-large-text-timeline.png`});
        const scale=await page.locator('.timeline-scale').boundingBox(),slider=await page.locator('#time-slider').boundingBox(),label=await page.locator('#time-label').boundingBox();
        check(scale.y+scale.height<=slider.y && slider.y+slider.height<=label.y,'enlarged timeline labels must not overlap the slider');
        await page.locator('#units-button').scrollIntoViewIfNeeded();await page.click('#units-button');
        await assertViewport(page,{documentY:'allow',primary:[{selector:'#units-panel',minWidth:200,minHeight:100}],screenshotPath:`${output}/phone-large-text-units.png`});
      }
    }finally{await context.close()}
  }
  check(!errors.length,errors.join('; '));check(!requests.length,'prototype must work without network');
  console.log('International study passed:4viewports,search,local time,preserved time/units,offline,persistence,real layer changes,broad hover,Now,and enlarged text.');
}finally{await browser.close()}
