import { skies } from './fixtures.mjs';
import { classifyLayer, coverageFraction } from '../../training/src/sky/cloud-rules.ts';
export const scenes = skies.map(scene => {
  const layers = scene.layers.map(l => {
    const genus = classifyLayer(l,scene.profile).genus;
    return {type:genus==='towering-cumulus'?'towering':genus,baseFtAmsl:l.baseFt,topFtAmsl:l.topFt,cover:l.cover,oktas:coverageFraction(l.cover)*8,
      precip:l.precipitating?'rain':'none',heavy:genus==='cumulonimbus',precipBottomFtAmsl:l.precipitating?0:null,
      thunder:genus==='cumulonimbus',source:'both',secondary:false,change:null};
  });
  return { id:scene.id, title:scene.title, icao:'TEST',timeMs:0,source:'METAR',elevationFt:0,layers,
    freezingFt:scene.freezingFt,freezingAllFt:[scene.freezingFt],minus20Ft:22000,
    icing:layers.filter(l=>l.type!=='cirrus'&&l.topFtAmsl>scene.freezingFt).map(l=>({baseFt:Math.max(l.baseFtAmsl,scene.freezingFt),topFt:Math.min(l.topFtAmsl,22000)})),
    obscuration:null,winds:[],surface:null,parcel:null,sun:{elevationDeg:40,azimuthDeg:270},hasProfile:true,notes:[] };
});
