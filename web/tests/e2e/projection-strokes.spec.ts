import {test,expect} from '@playwright/test';
test.setTimeout(90000);
test('Eurasia near-overhead 3D never draws coast or isobar chords across the longitude seam',async({page},info)=>{
 await page.addInitScript(()=>{
  const positions=new WeakMap<CanvasRenderingContext2D,{x:number;y:number}>();
  const move=CanvasRenderingContext2D.prototype.moveTo,line=CanvasRenderingContext2D.prototype.lineTo;
  (window as any).__mapChords=[];
  CanvasRenderingContext2D.prototype.moveTo=function(x,y){positions.set(this,{x,y});return move.call(this,x,y);};
  CanvasRenderingContext2D.prototype.lineTo=function(x,y){
   const a=positions.get(this),width=this.canvas.getBoundingClientRect().width;
   if(a&&width>300&&this.canvas.hasAttribute('aria-label')&&Math.abs(x-a.x)>width*.8&&Math.abs(y-a.y)<20)(window as any).__mapChords.push({a,x,y,width});
   positions.set(this,{x,y});return line.call(this,x,y);
  };
 });
 await page.setViewportSize({width:1440,height:900});await page.goto('/');
 const stage=page.locator('[data-api="1"]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((el:any)=>el.chartApi.setView(30,100,90));
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 await stage.locator('canvas[tabindex="0"]').focus();
 for(let i=0;i<10;i++)await page.keyboard.press('PageUp');
 const box=(await stage.boundingBox())!;await page.mouse.move(box.x+box.width*.5,box.y+box.height*.6);
 await page.evaluate(()=>(window as any).__mapChords=[]);
 await page.mouse.wheel(0,1);await page.waitForTimeout(600);
 await page.screenshot({path:info.outputPath('eurasia-near-overhead.png')});
 const chords=await page.evaluate(()=>(window as any).__mapChords);
 await info.attach('malformed-strokes',{body:JSON.stringify(chords.slice(0,30)),contentType:'application/json'});
 expect(chords).toHaveLength(0);
});
