/** Shared measured near/far lookup for the mesh vertices and chart material. */
export const TERRAIN_SAMPLING_GLSL = `
uniform sampler2D uFarTerrain;
uniform vec4 uFarTerrainBox;
uniform vec2 uFarTerrainTexel;
uniform int uHasFarTerrain;
vec2 terrainUV(vec2 p,vec4 box){return vec2(mod(p.x-box.x+720.0,360.0)/(box.z-box.x),(p.y-box.y)/(box.w-box.y));}
bool insideTerrain(vec2 uv){return all(greaterThanEqual(uv,vec2(0)))&&all(lessThanEqual(uv,vec2(1)));}
vec2 measuredTerrain(vec2 p){
  vec2 uv=terrainUV(p,uTerrainBox);
  vec2 near=insideTerrain(uv)?texture(uTerrain,uv).rg:vec2(0);
  vec2 farUV=terrainUV(p,uFarTerrainBox);
  vec2 far=uHasFarTerrain==1&&insideTerrain(farUV)?texture(uFarTerrain,farUV).rg:vec2(0);
  if(near.y<.99)return far.y>=.99?far:near;
  if(far.y<.99)return near;
  float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  return mix(far,near,smoothstep(0.0,.08,edge));
}
`;
