/** Aerial perspective uses eye-to-fragment metres at true terrain scale. */
const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function hazeOpacity(distanceM:number,halfHeightRadians:number):number {
 return smooth(2,8,distanceM/Math.max(500,halfHeightRadians*6371000))*.85*(1-.65*smooth(.01,.12,halfHeightRadians));
}
export const TERRAIN_HAZE_GLSL=`
float hazeOpacity(float distanceM,float halfHeightRadians){
 return smoothstep(2.0,8.0,distanceM/max(500.0,halfHeightRadians*6371000.0))*.85*(1.0-.65*smoothstep(.01,.12,halfHeightRadians));
}
`;
