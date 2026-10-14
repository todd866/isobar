import {expect,it} from 'vitest';
import {hazeOpacity} from '../../src/lib/terrain/haze';
it('keeps nearby terrain clear and distant regional terrain gently hazed',()=>{
 const rad=Math.PI/180;
 expect(hazeOpacity(500,.1*rad)).toBe(0);
 expect(hazeOpacity(100000,.1*rad)).toBeGreaterThan(.5);
 expect(hazeOpacity(1000000,2*rad)).toBeGreaterThan(.1);
 expect(hazeOpacity(1000000,2*rad)).toBeLessThan(.8);
 expect(hazeOpacity(1000000,2*rad)).toBeGreaterThan(hazeOpacity(10000,2*rad));
});
