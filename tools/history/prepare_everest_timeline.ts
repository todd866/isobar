/** Usage: tsx --tsconfig web/tsconfig.json tools/history/prepare_everest_timeline.ts weather.json.gz output-directory */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {historicalToChart} from '../../web/src/lib/history-chart';
import {buildEverestMinuteTrack,everestTeamWeather,EVEREST_TRACK_METHOD,EVEREST_TRACK_ANCHORS,EVEREST_CLOCK} from '../../web/src/lib/everest-timeline';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Expected weather.json.gz and output directory');
const destination=join(output,'expedition-minute.json.gz');
if(existsSync(destination))throw Error('Output already exists; use a new version directory');
const source=readFileSync(input),weather=JSON.parse(gunzipSync(source).toString());
const chart=historicalToChart(weather,{rings:[]},'everest-1953');
const records=buildEverestMinuteTrack().map(position=>{
 const estimate=everestTeamWeather(chart,position,null);
 if(!estimate)throw Error(`Missing weather at ${position.timeMs}`);
 return{...position,weather:estimate};
});
const document={schemaVersion:1,event:'everest-1953',team:['Edmund Hillary','Tenzing Norgay'],method:EVEREST_TRACK_METHOD,kind:'synthetic',resolutionSeconds:60,clock:EVEREST_CLOCK,anchors:EVEREST_TRACK_ANCHORS,sourceWeatherSHA256:createHash('sha256').update(source).digest('hex'),sourceWeatherContentSHA256:createHash('sha256').update(gunzipSync(source)).digest('hex'),weatherProvenance:weather.provenance??null,weatherTimes:weather.times,weatherGrid:weather.grid,weatherUnits:weather.units,terrainWeatherNote:'Prepared route elevation at the team; unavailable lateral terrain is held flat. Interactive DEM can refine exposure in the viewer. Minute resolution is not historical accuracy.',records};
const bytes=gzipSync(JSON.stringify(document));mkdirSync(output,{recursive:true});writeFileSync(destination,bytes);
const files=['web/src/lib/everest-timeline.ts','web/src/lib/everest.ts','web/src/lib/terrain/everest-route.json'];
const receipt={event:'everest-1953',method:EVEREST_TRACK_METHOD,records:records.length,originalWeather:input,files:[{path:'expedition-minute.json.gz',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},...files.map(file=>{const content=readFileSync(fileURLToPath(new URL('../../'+file,import.meta.url))),name=file.split('/').at(-1)!;writeFileSync(join(output,name),content);return{path:name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};})]};
writeFileSync(join(output,'manifest.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
