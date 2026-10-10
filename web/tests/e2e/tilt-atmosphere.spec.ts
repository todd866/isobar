import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { createTiltCamera, forwardProject, TILT_CAMERA_GLSL } from '../../src/lib/tilt-camera';

test.setTimeout(70_000);
type Cam = {centerX:number;centerY:number;halfWidth:number;halfHeight:number};
type Api = { camera():Cam; setView(lat:number,lon:number,height:number):void };
const stage = (page:Page) => page.locator('[data-api="1"]');
async function camera(page:Page) { return stage(page).evaluate(el => (el as HTMLElement & {chartApi:Api}).chartApi.camera()); }
async function open(page:Page) {
  await page.goto('/'); await page.waitForSelector('[data-isobars=true]');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage(page).evaluate(el => (el as HTMLElement & {chartApi:Api}).chartApi.setView(-31.9,116.1,.6));
  await page.waitForTimeout(350);
}
async function pixelsChanged(a:Buffer,b:Buffer) {
  const x=await sharp(a).removeAlpha().raw().toBuffer(),y=await sharp(b).removeAlpha().raw().toBuffer();
  let n=0; for(let i=0;i<x.length;i+=3) if(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2])>35)n++;
  return n/(x.length/3);
}
async function touchGesture(page:Page, points:{x:number;y:number}[], moves:{x:number;y:number}[][]) {
  const cdp=await page.context().newCDPSession(page);
  const point=(p:{x:number;y:number},id:number)=>({x:p.x,y:p.y,id, radiusX:1,radiusY:1,force:1});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points.map((p,i)=>point(p,i+1))});
  for(const frame of moves) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:frame.map((p,i)=>point(p,i+1))});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await cdp.detach();
}
async function profileFixture(page:Page) {
  await page.route('https://api.open-meteo.com/**', async route => {
    const url = new URL(route.request().url());
    if(!url.searchParams.get('hourly')?.includes('geopotential_height')) return route.continue();
    const start=Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`);
    const hourly:Record<string,unknown>={time:Array.from({length:49},(_,i)=>new Date(start+i*3600000).toISOString())};
    [1000,925,850,700,600,500,400,300,250,200].forEach((p,i)=>{
      for(const [key,value] of Object.entries({temperature:20-i*6,relative_humidity:75,cloud_cover:i===1||i===2||i===6?75:0,wind_speed:12+i*3,wind_direction:240,geopotential_height:100+i*1300})) hourly[`${key}_${p}hPa`]=Array(49).fill(value);
    });
    await route.fulfill({json:{latitude:Number(url.searchParams.get('latitude')),longitude:Number(url.searchParams.get('longitude')),elevation:30,model:'ecmwf_ifs025',hourly}});
  });
}

test('Perth: tilt, pinch, pan, lenses and return overhead retain current place and time',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await profileFixture(page);await open(page);
  const before=await camera(page), utc=await stage(page).getAttribute('data-valid-ms');
  const flat=await stage(page).screenshot();
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  const box=(await stage(page).boundingBox())!;
  await page.mouse.move(box.x+box.width*.7,box.y+box.height*.6);await page.mouse.wheel(0,160); await page.mouse.wheel(0,160);
  await expect.poll(async()=>Number(await stage(page).getAttribute('data-tilt'))).toBeGreaterThan(.2);
  expect((await camera(page)).centerX).toBeCloseTo(before.centerX, 8);
  expect((await camera(page)).centerY).toBeCloseTo(before.centerY, 8);
  expect((await camera(page)).halfHeight).toBeLessThan(before.halfHeight);
  await page.waitForTimeout(300);
  expect(await pixelsChanged(flat,await stage(page).screenshot())).toBeGreaterThan(.03);
  // Chromium trackpad pinch delivers ctrl-wheel, not ordinary scroll.
  await page.keyboard.down('Control');await page.mouse.wheel(0,-50);await page.keyboard.up('Control');
  await expect.poll(async()=>(await camera(page)).halfWidth).toBeLessThan(before.halfWidth);
  await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.62,{steps:8});await page.mouse.up();
  const moved=await camera(page);
  for(const lens of ['rain','temp','pressure']) { await page.locator(`[data-lens=${lens}]`).first().click();expect(await camera(page)).toEqual(moved); }
  expect(await stage(page).getAttribute('data-valid-ms')).toBe(utc);
  await page.getByRole('button',{name:'2D map',exact:true}).click();
  await expect(stage(page)).toHaveAttribute('data-tilt','0.0000');
  expect((await camera(page)).centerX).toBeCloseTo(moved.centerX, 8);
  expect((await camera(page)).centerY).toBeCloseTo(moved.centerY, 8);
  expect((await camera(page)).halfHeight).toBeGreaterThan(moved.halfHeight);
  expect(errors).toEqual([]);
});

test('real Wind barbs stay visible as 3D vectors while tilting the map', async ({ page }, testInfo) => {
  // Wind barbs are deliberately exposed through the phone menu. This keeps
  // the journey on the same compact control path used by a real user.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  const wind = page.getByRole('button', { name: 'Wind barbs', exact: true });
  await expect(wind).toBeVisible();
  await wind.click();
  await expect(wind).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  const map = stage(page);
  const barbCanvas = map.locator('canvas:not([data-chart-layer]):not([data-satellite-layer]):not([data-flow-layer]):not([data-traffic-layer]):not([data-atmosphere-layer]):not([aria-label])');
  await expect(barbCanvas).toHaveCount(1);
  const ink = async () => barbCanvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 24) count++;
    return count;
  });
  await expect.poll(ink, { timeout: 10_000 }).toBeGreaterThan(20);

  const before = await camera(page);
  const valid = await map.getAttribute('data-valid-ms');
  const bounds = (await map.boundingBox())!;
  await page.getByRole('button', { name: '3D map', exact: true }).click();
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .48);
  await page.mouse.wheel(0, 180);
  await expect.poll(async () => Number(await map.getAttribute('data-tilt'))).toBeGreaterThan(.2);
  const tilted = await camera(page);
  expect(tilted.centerX).toBeCloseTo(before.centerX, 8);
  expect(tilted.centerY).toBeCloseTo(before.centerY, 8);
  expect(await map.getAttribute('data-valid-ms')).toBe(valid);
  await expect.poll(ink, { timeout: 10_000 }).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath('wind-barbs-3d-phone.png') });
});

test('profile geometry, altitude marker and section use the shared forecast clock',async({page})=>{
  await profileFixture(page);await open(page);
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  await expect(page.locator('[data-atmosphere-layer]')).toHaveAttribute('data-profile-state','ready');
  await expect.poll(async()=>Number(await page.locator('[data-atmosphere-layer]').getAttribute('data-layers'))).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  await expect(page.locator('[data-atmosphere-section]')).toContainText('Illustrative profile');
  await expect(page.locator('[data-atmosphere-section]')).toContainText('↕ m/s');
  const a=await stage(page).screenshot();
  await page.getByRole('slider',{name:'Reference aircraft altitude'}).fill('10000');
  expect(await pixelsChanged(a,await stage(page).screenshot())).toBeGreaterThan(.0001);
  const utc=Number(await stage(page).getAttribute('data-valid-ms'));
  await expect(page.locator('[data-atmosphere-section] time')).toHaveAttribute('datetime',new Date(utc).toISOString());
  await page.keyboard.press('Escape');await expect(page.locator('[data-atmosphere-section]')).toHaveCount(0);
});

test('GLSL rays agree with CPU at world, regional and close terrain scales',async({page})=>{
  await page.goto('/');
  for(const [half,lat,pitch] of [[60,-30,.08],[60,0,1.2],[.3,-33.8,1],[.005,-31.9,1.2]]) {
    const c=createTiltCamera({lat,lon:150.8,halfHeightDeg:half,aspect:2,tiltRadians:pitch});
    const target={lat:lat+half*.15,lon:150.8+half*.3};
    const projected=forwardProject(c,target.lat,target.lon)!;
    const value=await page.evaluate(({source,c,x,y})=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const gl=canvas.getContext('webgl2')!;
      try { if(!gl.getExtension('EXT_color_buffer_float'))throw Error('float render target unsupported');
        const p=gl.createProgram()!;
        function shader(kind:number,s:string){const sh=gl.createShader(kind)!;gl.shaderSource(sh,s);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(sh)!);gl.attachShader(p,sh);return sh;}
        const vs=shader(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 a=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(a*2.-1.,0.,1.);}');
        const g=c.geometry,vec=(v:readonly number[])=>'vec3('+v.map(n=>n.toFixed(12)).join(',')+')';
        const fs=shader(gl.FRAGMENT_SHADER,`#version 300 es\nprecision highp float;out vec4 color;${source}\nvoid main(){float lat,lon;bool ok=variableGeo(vec2(${x.toFixed(12)},${y.toFixed(12)}),vec4(${(c.lat*Math.PI/180).toFixed(12)},${(c.lon*Math.PI/180).toFixed(12)},${c.halfHeightRadians.toFixed(12)},${c.tiltRadians.toFixed(12)}),${c.aspect.toFixed(12)},${g.curvature.toFixed(12)},${vec(g.cameraPositionNormalized)},${vec(g.forward)},${vec(g.up)},0.,lat,lon);color=vec4(degrees(lat),degrees(lon),ok?1.:0.,1.);}`);
        gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p)!);gl.useProgram(p);
        const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1,1,0,gl.RGBA,gl.FLOAT,null);
        const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);gl.viewport(0,0,1,1);gl.drawArrays(gl.TRIANGLES,0,3);
        const out=new Float32Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,out);gl.deleteFramebuffer(fb);gl.deleteTexture(tex);gl.deleteProgram(p);gl.deleteShader(vs);gl.deleteShader(fs);return Array.from(out);
      }finally{gl.getExtension('WEBGL_lose_context')?.loseContext();}
    },{source:TILT_CAMERA_GLSL,c,x:projected.x,y:projected.y});
    expect(value[2]).toBe(1);expect(value[0]).toBeCloseTo(target.lat,3);expect(value[1]).toBeCloseTo(target.lon,3);
  }
});

test('real touch intent separates pinch zoom from two-finger tilt',async({page})=>{
  await profileFixture(page); await open(page); const box=(await stage(page).boundingBox())!;
  const cx=box.x+box.width*.5, cy=box.y+box.height*.5;
  const initial=await camera(page);
  await touchGesture(page,[{x:cx-38,y:cy},{x:cx+38,y:cy}],Array.from({length:8},(_,i)=>[{x:cx-38-i*5,y:cy+i*2},{x:cx+38+i*5,y:cy+i*2}]));
  await expect.poll(async()=> (await camera(page)).halfWidth).toBeLessThan(initial.halfWidth);
  expect(Number(await stage(page).getAttribute('data-tilt'))).toBeLessThan(.01);
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  const beforeTilt=await camera(page);
  await touchGesture(page,[{x:cx-34,y:cy-30},{x:cx+34,y:cy-30}],Array.from({length:8},(_,i)=>[{x:cx-34,y:cy-30+i*8},{x:cx+34,y:cy-30+i*8}]));
  await expect.poll(async()=>Number(await stage(page).getAttribute('data-tilt'))).toBeGreaterThan(.05);
  expect((await camera(page)).halfWidth).toBeLessThan(beforeTilt.halfWidth);
});

test('timeline hold pauses and release resumes the shared forecast clock',async({page})=>{
  await profileFixture(page); await open(page); await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect.poll(async()=>Number(await stage(page).getAttribute('data-valid-ms'))).not.toBeNaN();
  await page.waitForTimeout(250); const stageBox=(await stage(page).boundingBox())!; const x=stageBox.x+stageBox.width*.5,y=stageBox.y+stageBox.height*.5;
  await page.mouse.move(x,y); await page.mouse.down(); const held=await stage(page).getAttribute('data-valid-ms'); await page.waitForTimeout(350); expect(await stage(page).getAttribute('data-valid-ms')).toBe(held);
  await page.mouse.up(); await expect.poll(async()=>await stage(page).getAttribute('data-valid-ms')).not.toBe(held);
});

test('synthetic atmospheric layers animate offline without profile requests',async({page})=>{
  let calls=0;
  await page.route('https://api.open-meteo.com/**',async route=>{
    if(new URL(route.request().url()).searchParams.get('hourly')?.includes('geopotential_height')) calls++;
    return route.abort();
  });
  await open(page);await page.getByRole('button',{name:'3D map',exact:true}).click();
  const layer=page.locator('[data-atmosphere-layer]');
  await expect(layer).toHaveAttribute('data-source','synthetic');
  await expect.poll(async()=>Number(await layer.getAttribute('data-layers'))).toBeGreaterThan(1);
  await expect.poll(async()=>Number(await layer.getAttribute('data-flows'))).toBeGreaterThan(10);
  const first=await layer.screenshot(); await page.waitForTimeout(350);
  expect(await pixelsChanged(first,await layer.screenshot())).toBeGreaterThan(.0001);
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  await expect(page.locator('[data-atmosphere-section]')).toContainText('Illustrative');
  expect(calls).toBe(0);
});

test('keyboard navigation and enlarged section remain usable after resize',async({page})=>{
  await profileFixture(page);await open(page);
  const map=stage(page);await map.locator('canvas[tabindex="0"]').focus();
  await page.keyboard.press('3');
  await page.keyboard.press('PageDown');
  await expect.poll(async()=>Number(await map.getAttribute('data-tilt'))).toBeGreaterThan(.1);
  const before=await camera(page);
  await page.keyboard.press('+');
  await expect.poll(async()=>(await camera(page)).halfWidth).toBeLessThan(before.halfWidth);
  await page.keyboard.press('ArrowRight');
  expect((await camera(page)).centerX).not.toBe(before.centerX);
  const utc=await map.getAttribute('data-valid-ms');
  await page.addStyleTag({content:'html{font-size:200% !important}'});
  await page.setViewportSize({width:1024,height:600});
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  const altitude=page.getByRole('slider',{name:'Reference aircraft altitude'});
  await altitude.scrollIntoViewIfNeeded();await altitude.focus();await page.keyboard.press('ArrowRight');
  expect(Number(await altitude.inputValue())).toBeGreaterThan(5000);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-atmosphere-section]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Atmospheric section',exact:true})).toBeFocused();
  expect(await map.getAttribute('data-valid-ms')).toBe(utc);
});


test('2D and 3D are explicit modes; overhead tilt does not leave 3D', async ({ page }, testInfo) => {
  await profileFixture(page); await open(page);
  const map = stage(page), flat = page.getByRole('button', { name: '2D map', exact: true });
  const globe = page.getByRole('button', { name: '3D map', exact: true });
  await expect(flat).toHaveAttribute('aria-pressed', 'true');
  const box = (await map.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const touchBefore = await camera(page);
  await touchGesture(page, [{x:cx-34,y:cy-30},{x:cx+34,y:cy-30}], Array.from({length:8},(_,i)=>[{x:cx-34,y:cy-30+i*8},{x:cx+34,y:cy-30+i*8}]));
  await expect(map).toHaveAttribute('data-map-mode', '2d');
  await expect(map).toHaveAttribute('data-tilt', '0.0000');
  expect(await camera(page)).toEqual(touchBefore);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 60);
  await expect(map).toHaveAttribute('data-map-mode', '2d');
  await expect(map).toHaveAttribute('data-tilt', '0.0000');
  const cameraBefore = await camera(page), timeBefore = await map.getAttribute('data-valid-ms');
  await globe.click();
  await expect(globe).toHaveAttribute('aria-pressed', 'true');
  expect((await camera(page)).halfHeight).toBeLessThan(cameraBefore.halfHeight);
  await map.locator('canvas[tabindex="0"]').focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('PageUp');
  await expect(map).toHaveAttribute('data-tilt', '0.0000');
  await expect(map).toHaveAttribute('data-map-mode', '3d');
  await expect(globe).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('PageDown');
  await expect.poll(async () => Number(await map.getAttribute('data-tilt'))).toBeGreaterThan(0);
  await flat.click();
  await expect(map).toHaveAttribute('data-map-mode', '2d');
  await expect(map).toHaveAttribute('data-tilt', '0.0000');
  for (const key of ['centerX','centerY','halfWidth','halfHeight'] as const) expect((await camera(page))[key]).toBeCloseTo(cameraBefore[key], 8);
  expect(await map.getAttribute('data-valid-ms')).toBe(timeBefore);
  await page.screenshot({ path: testInfo.outputPath('explicit-map-modes.png') });
});
