import {test,expect} from '@playwright/test';
test('D-Day shares the map clock, camera and on-demand layer controls',async({page})=>{
 test.setTimeout(90_000);
 await page.setViewportSize({width:1280,height:720});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/history?event=dday&date=1944-06-06&hour=6');
 const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 const labels=()=>stage.evaluate((e:any)=>e.chartApi.labels() as {text:string;x:number;y:number;w:number;h:number}[]);
 await expect.poll(async()=>(await labels()).some(l=>l.text==='Omaha Beach')).toBe(true);
 await expect.poll(async()=>(await labels()).some(l=>l.text==='USS Texas')).toBe(true);
 const camera=await stage.evaluate((e:any)=>e.chartApi.camera());
 await page.getByRole('button',{name:'Data sources',exact:true}).click();
 await page.getByLabel('Ships',{exact:true}).uncheck();
 await expect.poll(async()=>(await labels()).some(l=>l.text.startsWith('USS '))).toBe(false);
 await page.getByLabel('Ships',{exact:true}).check();
 await page.getByRole('button',{name:'Data sources',exact:true}).click();
 await page.getByLabel('Historical day',{exact:true}).selectOption('1944-06-05');
 await expect.poll(async()=>(await labels()).some(l=>l.text==='Omaha Beach')).toBe(false);
 expect(await stage.evaluate((e:any)=>e.chartApi.camera())).toEqual(camera);
 await page.getByLabel('Historical day',{exact:true}).selectOption('1944-06-06');
 await expect.poll(async()=>(await labels()).some(l=>l.text==='Omaha Beach')).toBe(true);
 for(const size of [{width:390,height:844},{width:844,height:390}]){
  await page.setViewportSize(size);
  await expect.poll(()=>stage.evaluate(e=>e.getBoundingClientRect().right<=innerWidth)).toBe(true);
  const placed=await labels();
  for(let i=0;i<placed.length;i++)for(let j=i+1;j<placed.length;j++){
   const a=placed[i],b=placed[j];expect(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h,`${a.text} / ${b.text}`).toBe(false);
  }
 }
 expect(errors).toEqual([]);
});
