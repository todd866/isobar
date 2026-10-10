import {test,expect} from '@playwright/test';

for(const phone of [false,true]) test(`shared teaching atmosphere: ${phone?'phone':'laptop'}`,async({page},info)=>{
  test.setTimeout(150000);
  await page.setViewportSize(phone?{width:390,height:844}:{width:1280,height:800});
  await page.addInitScript(()=>localStorage.setItem('isobar.place','perth'));
  await page.goto('/');
  const stage=page.locator('[data-api="1"]');
  await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage.evaluate((e:any)=>e.chartApi.setView(-31.95,115.86,.12));
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  const flow=page.locator('[data-atmosphere-layer]');
  const time=await stage.getAttribute('data-valid-ms');
  for(const model of ['sea-breeze','thunderstorm','mountain-wave']){
    const location=model==='sea-breeze'?[-31.95,115.86]:model==='thunderstorm'?[-33.73,150.3]:[-33.6,150.25];
    await stage.evaluate((e:any,p:number[])=>e.chartApi.setView(p[0],p[1],.12),location);
    await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
    await page.getByRole('combobox',{name:'Atmosphere model',exact:true}).selectOption(model);
    await page.getByRole('checkbox',{name:'Clouds',exact:true}).check();
    await expect(flow).toHaveAttribute('data-scenario',model);
    await expect.poll(async()=>Number(await flow.getAttribute('data-flows'))).toBeGreaterThan(4);
    await expect(flow).toHaveAttribute('data-clouds','on',{timeout:45000});
    await expect(flow).toHaveAttribute('data-rendered-scenario',model);
    expect(Number(await flow.getAttribute('data-build-ms'))).toBeLessThan(500);
    await expect(stage).toHaveAttribute('data-valid-ms',time!);
    expect(Number(await flow.getAttribute('data-profile-time'))).toBe(Number(time));
    const {assertViewport}=await import('../../../tools/viewport-fit.mjs');
    await assertViewport(page,{primary:[{selector:'[data-api="1"]',minWidth:250,minHeight:180}],controls:[{selector:'[aria-label="Atmosphere model"]',minHeight:30},{selector:'[aria-label="Close atmospheric section"]',minHeight:30}]});
    const panel=(await page.locator('[data-atmosphere-section]').boundingBox())!,mode=(await page.getByRole('button',{name:'3D map',exact:true}).boundingBox())!;
    expect(panel.x+panel.width).toBeLessThanOrEqual(mode.x);
    await page.screenshot({path:info.outputPath(`${model}-section.png`)});
    await page.getByRole('button',{name:'Frame atmosphere',exact:true}).click();
    await expect.poll(async()=>{const points=JSON.parse(await flow.getAttribute('data-column-projection')||'[]');return points.length===2&&points.every((p:any)=>p&&Math.abs(p.x)<.7&&Math.abs(p.y)<.73);}).toBe(true);
    await page.getByRole('button',{name:'Close atmospheric section',exact:true}).click();
    const anchor=await flow.getAttribute('data-anchor');
    const box=(await stage.boundingBox())!;
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.5);
    await page.mouse.wheel(90,60);
    await page.waitForTimeout(600);
    await expect(flow).toHaveAttribute('data-anchor',anchor!);
    await expect(stage).toHaveAttribute('data-valid-ms',time!);
    await page.screenshot({path:info.outputPath(`${model}-orbit.png`)});
    await page.mouse.wheel(-90,-60);
    await page.waitForTimeout(400);
    await page.getByRole('button',{name:'Terrain and atmosphere slice',exact:true}).click();
    await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
    await page.getByRole('slider',{name:'Slice position',exact:true}).fill('25');
    await expect.poll(async()=>await flow.evaluate(e=>(e as HTMLElement).dataset.renderedSlice===(e as HTMLElement).dataset.sliceKey)).toBe(true);
    await page.waitForTimeout(500);
    await page.screenshot({path:info.outputPath(`${model}-slice.png`)});
    await page.getByRole('button',{name:'Terrain and atmosphere slice',exact:true}).click();
  }
  if(phone){
    await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
    const {assertViewport}=await import('../../../tools/viewport-fit.mjs');
    for(const [label,w,h,enlarged] of [['small',360,640,false],['landscape',844,390,false],['large-text',390,844,true]] as const){
      await page.setViewportSize({width:w,height:h});
      await page.evaluate(big=>document.documentElement.style.fontSize=big?'200%':'',enlarged);
      await page.waitForTimeout(350);
      await assertViewport(page,{primary:[{selector:'[data-api="1"]',minWidth:200,minHeight:120}],controls:[{selector:'[aria-label="Atmosphere model"]',minHeight:30},{selector:'[aria-label="Close atmospheric section"]',minHeight:30}]});
      await page.screenshot({path:info.outputPath(`${label}.png`)});
    }
    await page.evaluate(()=>document.documentElement.style.fontSize='');
    await page.getByRole('button',{name:'Close atmospheric section',exact:true}).click();
  }
  await page.getByRole('button',{name:'2D map',exact:true}).click();
  await expect(flow).toHaveCount(0);
});


test('delayed atmosphere work cannot restore a prior model, location or forecast time',async({page},info)=>{
  test.setTimeout(120000);
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      set onmessage(fn:((this:Worker,ev:MessageEvent)=>any)|null){super.onmessage=fn?(event)=>setTimeout(()=>fn.call(this,event),900):null;}
    } as typeof Worker;
  });
  await page.goto('/');const stage=page.locator('[data-api="1"]');await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage.evaluate((e:any)=>e.chartApi.setView(-31.95,115.86,.12));
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  await page.getByRole('checkbox',{name:'Clouds',exact:true}).check();
  const models=page.getByRole('combobox',{name:'Atmosphere model',exact:true});
  await models.selectOption('sea-breeze');await models.selectOption('thunderstorm');
  await page.getByRole('button',{name:'Close atmospheric section',exact:true}).click();
  const flow=page.locator('[data-atmosphere-layer]');const anchor=await flow.getAttribute('data-anchor');
  const box=(await stage.boundingBox())!;
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.7);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.75,{steps:6});await page.mouse.up();
  await expect(flow).toHaveAttribute('data-anchor',anchor!);
  const timeline=page.getByRole('slider',{name:'Forecast time'});await timeline.focus();await page.keyboard.press('End');
  await expect(flow).toHaveAttribute('data-scenario','thunderstorm');
  await page.setViewportSize({width:640,height:720});
  await expect.poll(async()=>(await flow.getAttribute('data-cloud-time'))===(await flow.getAttribute('data-field-time'))).toBe(true);
  await expect(flow).toHaveAttribute('data-clouds','on',{timeout:45000});
  await expect(flow).toHaveAttribute('data-rendered-scenario','thunderstorm');
  const bounds=JSON.parse((await flow.getAttribute('data-cloud-bounds'))!);expect(bounds.maxHeight-bounds.minHeight).toBe(13000);
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  await page.getByRole('button',{name:'Frame atmosphere',exact:true}).click();
  await expect.poll(async()=>{const points=JSON.parse(await flow.getAttribute('data-column-projection')||'[]');return points.length===2&&points.every((p:any)=>p&&Math.abs(p.x)<.7&&Math.abs(p.y)<.73);}).toBe(true);
  await page.screenshot({path:info.outputPath('late-work-final.png')});
});


test('teaching flow survives the detailed-worker zoom boundary with clouds off',async({page},info)=>{
 await page.goto('/');const stage=page.locator('[data-api="1"]');await expect(stage).toBeVisible();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((e:any)=>e.chartApi.setView(-31.95,115.86,.3));
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 const flow=page.locator('[data-atmosphere-layer]');
 for(const zoom of [.34,.36,.34]){
  await stage.evaluate((e:any,z:number)=>e.chartApi.setView(-31.95,115.86,z),zoom);
  await expect(flow).toHaveAttribute('data-clouds','off');
  await expect.poll(async()=>Number(await flow.getAttribute('data-flows'))).toBeGreaterThan(0);
  await page.screenshot({path:info.outputPath(`boundary-${zoom}.png`)});
 }
 const renderers=await page.locator('canvas').evaluateAll(canvases=>canvases.flatMap(canvas=>{const gl=(canvas as HTMLCanvasElement).getContext('webgl2');if(!gl)return[];const ext=gl.getExtension('WEBGL_debug_renderer_info');return [ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)];}));
 await info.attach('GPU renderer',{body:JSON.stringify(renderers),contentType:'application/json'});
 expect(renderers.some(name=>/Metal/.test(name))).toBe(true);
});
