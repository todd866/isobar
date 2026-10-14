import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {build} from 'esbuild';

let script:string;
test.beforeAll(async()=>{script=(await build({entryPoints:['tests/e2e/terrain-occlusion-browser.ts'],bundle:true,write:false,format:'iife',globalName:'TerrainOcclusion',platform:'browser'})).outputFiles[0].text;});

test('near ridge occludes far ground independently of triangle draw order',async({page},info)=>{
  test.setTimeout(120000); await page.setViewportSize({width:640,height:480}); await page.goto('about:blank'); await page.addScriptTag({content:script});
  const normal=await page.evaluate(()=>(window as any).TerrainOcclusion.runTerrainOcclusion());
  const flat=await page.evaluate(()=>(window as any).TerrainOcclusion.runTerrainFlat());
  const reversed=await page.evaluate(()=>(window as any).TerrainOcclusion.runTerrainOcclusionReversed());
  for(const [name,result] of Object.entries({normal,flat,reversed}))writeFileSync(info.outputPath(`${name}.png`),Buffer.from((result as any).png.split(',')[1],'base64'));
  writeFileSync(info.outputPath('renderer.json'),JSON.stringify({renderer:normal.renderer,pixel:normal.pixel,normal:normal.colour,flat:flat.colour,reversed:reversed.colour}));
  if(!process.env.ISOBAR_E2E_SOFTWARE)expect(normal.renderer).toMatch(/Apple|Metal/);
  expect(normal.error,'antialias resolve is valid on the opaque chart canvas').toBe(0);
  expect(normal.offscreen, 'terrain is drawn into the antialias target').toBe(true);
  expect(normal.samples, 'terrain is single-sampled (Metal shades every MSAA sample)').toBeLessThanOrEqual(1);
  expect(flat.colour[2], 'far ground should be blue without the ridge').toBeGreaterThan(flat.colour[0]+60);
  expect(normal.colour[0], 'near red ridge must occlude the blue far ground').toBeGreaterThan(normal.colour[2]+60);
  expect(reversed.colour[0]).toBeGreaterThan(reversed.colour[2]+60);
  let changed=0;
  for(let i=0;i<normal.pixels.length;i+=4)if(Math.abs(normal.pixels[i]-reversed.pixels[i])+Math.abs(normal.pixels[i+1]-reversed.pixels[i+1])+Math.abs(normal.pixels[i+2]-reversed.pixels[i+2])>12)changed++;
  expect(changed/(normal.width*normal.height),'terrain visibility depends on draw order').toBeLessThan(.001);
});

test('overlay lines subdivide and break behind a nearer ridge',async({page})=>{
 await page.goto('about:blank');await page.addScriptTag({content:script});
 const result=await page.evaluate(()=>(window as any).TerrainOcclusion.runTerrainLines());
 expect(result.farHidden).toBe(true);expect(result.nearVisible).toBe(true);expect(result.samples).toBeGreaterThan(2);
 const overlay=await page.evaluate(()=>(window as any).TerrainOcclusion.runTerrainOverlay());
 expect(overlay.hidden).toBe(0);expect(overlay.visible).toBeGreaterThan(5);
});
