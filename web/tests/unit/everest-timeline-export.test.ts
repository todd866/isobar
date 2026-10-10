import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
it('exports all minutes with individual synthetic provenance and original source metadata',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const dir=mkdtempSync(join(tmpdir(),'everest-minute-'));
 try{
 const times=['1953-05-28T00:00Z','1953-05-29T23:00Z'],provenance={provider:'test source',dataset:'test reanalysis',source:'https://example.com/data',license:'test',retrieved_at:'2026-10-10T00:00Z'};
 const weather={schema_version:1,product:'isobar-historical-weather',grid:{nx:2,ny:2,latitudes:[29,27],longitudes:[86,88],step_degrees:2},times,provenance,units:{u:'knots',v:'knots',pressure_msl:'hPa'},frames:times.map(time=>({time,pressure_msl:[1010,1010,1010,1010],u:[10,10,10,10],v:[0,0,0,0]}))};
 const input=join(dir,'weather.json.gz');writeFileSync(input,gzipSync(JSON.stringify(weather)));
 execFileSync(resolve(root,'node_modules/.bin/tsx'),['--tsconfig',resolve(root,'tsconfig.json'),resolve(root,'../tools/history/prepare_everest_timeline.ts'),input,join(dir,'out')],{timeout:15000,stdio:'pipe'});
 const output=JSON.parse(gunzipSync(readFileSync(join(dir,'out/expedition-minute.json.gz'))).toString());
 expect(output.records).toHaveLength(2880);expect(output.weatherProvenance).toEqual(provenance);
 for(const record of output.records){expect(record.provenance.kind).toBe('synthetic');expect(record.provenance.from.timeMs).toBeLessThanOrEqual(record.timeMs);expect(record.provenance.to.timeMs).toBeGreaterThanOrEqual(record.timeMs);expect(record.weather).not.toBeNull();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
