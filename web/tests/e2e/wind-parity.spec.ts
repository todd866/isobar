import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';

const contract=JSON.parse(readFileSync(path.resolve('../Tests/fixtures/wind-visual-contract.json'),'utf8'));
let script:string;
test.beforeAll(async()=>{
  script=(await build({entryPoints:['tests/e2e/wind-parity-browser.ts'],bundle:true,write:false,format:'iife',globalName:'WindParity',platform:'browser'})).outputFiles[0].text;
});
test('shared native/browser surface-wind visual contract',async({page},info)=>{
  test.setTimeout(120000);
  await page.setViewportSize({width:640,height:600});
  // No network, clocks or test renderer: the production layer draws actual pixels.
  await page.goto('about:blank');await page.addScriptTag({content:script});
  const rows:any[]=[];
  for(const scene of contract.scenes){
    const row=await page.evaluate(({scene,contract})=>(window as any).WindParity.runWindScene(scene,contract),{scene,contract});
    for(const phase of ['before','after'])writeFileSync(info.outputPath(`${scene.id}-${phase}.png`),Buffer.from(row[`${phase}PNG`].split(',')[1],'base64'));
    delete row.beforePNG;delete row.afterPNG;rows.push(row);
    const blank=scene.u===null||Math.hypot(scene.u,scene.v)<2.5;
    if(blank){expect(row.inkFraction,scene.id).toBe(0);expect(row.drawn,scene.id).toBe(0)}
    else {
      expect(row.inkFraction,`${scene.id}: visible wind`).toBeGreaterThan(contract.limits.minInkFraction);
      expect(row.inkFraction,`${scene.id}: clutter`).toBeLessThan(contract.limits.maxInkFraction);
      expect(row.occupiedTiles,`${scene.id}: coverage`).toBeGreaterThanOrEqual(contract.limits.minOccupiedTiles);
      if(scene.reduced)expect(row.motionFraction,scene.id).toBe(0);
      else expect(row.motionFraction,`${scene.id}: actual pixel motion`).toBeGreaterThan(contract.limits.minMotionFraction);
      expect(row.motionFraction,`${scene.id}: flicker`).toBeLessThan(contract.limits.maxMotionFraction);
      expect(row.maxSegmentPx,`${scene.id}: rods/seams`).toBeLessThanOrEqual(contract.limits.maxSegmentPx);
    }
  }
  writeFileSync(info.outputPath('web-contract.json'),JSON.stringify(rows,null,2));
  if(process.env.ISOBAR_WIND_PARITY_OUT){mkdirSync(process.env.ISOBAR_WIND_PARITY_OUT,{recursive:true});writeFileSync(path.join(process.env.ISOBAR_WIND_PARITY_OUT,'web-contract.json'),JSON.stringify(rows,null,2))}
  // The joint release command provides the report from the native production view.
  if(process.env.ISOBAR_NATIVE_WIND_REPORT){
    const native=JSON.parse(readFileSync(process.env.ISOBAR_NATIVE_WIND_REPORT,'utf8'));
    expect(native.map((r:any)=>r.id).sort()).toEqual(rows.map(r=>r.id).sort());
    for(const row of rows){const other=native.find((n:any)=>n.id===row.id);
      if(row.inkFraction===0){expect(other.inkFraction,row.id).toBe(0);continue}
      expect(other.inkFraction/row.inkFraction,`${row.id}: native/web visual weight`).toBeGreaterThan(1/contract.limits.maxInkRatio);
      expect(other.inkFraction/row.inkFraction,`${row.id}: native/web visual weight`).toBeLessThan(contract.limits.maxInkRatio);
      expect(other.occupiedTiles,row.id).toBeGreaterThanOrEqual(contract.limits.minOccupiedTiles);
      if(row.id==='reduced')expect(other.motionFraction).toBe(0);
      else expect(other.motionFraction,`${row.id}: native is animated too`).toBeGreaterThan(contract.limits.minMotionFraction);
    }
  }
});
