import {test,expect} from '@playwright/test';
for(const [event,date,label] of [
 ['sydney-hobart-1998','1998-12-27','Bass Strait'],
 ['shackleton-1916','1916-04-24','James Caird'],
 ['gallipoli-1915','1915-04-25','Anzac Cove'],
])test(`${event} opens its own dated weather and shared scene`,async({page})=>{
 test.setTimeout(90_000);
 await page.setViewportSize({width:1280,height:720});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/history?event=${event}`);
 const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await expect(page.getByLabel('Historical day',{exact:true})).toHaveValue(date);
 const labels=()=>stage.evaluate((e:any)=>e.chartApi.labels() as {text:string}[]);
 await expect.poll(async()=>(await labels()).some(l=>l.text===label)).toBe(true);
 if(event==='gallipoli-1915')await expect.poll(async()=>(await labels()).some(l=>l.text==='River Clyde · V Beach')).toBe(true);
 await page.getByRole('button',{name:'Data sources',exact:true}).click();
 const control=page.getByLabel(event==='shackleton-1916'?'Ships':event==='gallipoli-1915'?'Military':'Routes',{exact:true});
 await control.uncheck();await expect.poll(async()=>(await labels()).some(l=>l.text===label)).toBe(false);
 await control.check();await page.getByRole('button',{name:'Data sources',exact:true}).click();
 await expect.poll(async()=>(await labels()).some(l=>l.text===label)).toBe(true);
 if(event==='shackleton-1916'){await page.setViewportSize({width:844,height:390});await expect.poll(async()=>(await labels()).some(l=>l.text==='James Caird')).toBe(true);}
 await page.getByRole('button',{name:'3D map',exact:true}).click();await expect(stage).toHaveAttribute('data-map-mode','3d');
 await page.getByRole('button',{name:'2D map',exact:true}).click();await expect(stage).toHaveAttribute('data-map-mode','2d');
 expect(errors).toEqual([]);
});
