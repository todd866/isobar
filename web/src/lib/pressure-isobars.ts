/** Full-resolution pressure isolines, evaluated at the displayed forecast time.
 * The CPU worker still places labels/centres; its turnaround is not the motion clock. */
export const PRESSURE_ISOBARS_GLSL = `
uniform sampler2D uPressure;
uniform int uHasPressure;
uniform float uPressureSpan;
uniform float uPressureDpr;
uniform float uCyclonePressure;
vec2 pressureTap(ivec2 cell) {
  if(uWrap==1)cell.x=int(mod(float(cell.x)+uSize.x,uSize.x));
  cell=clamp(cell,ivec2(0),ivec2(uSize)-1);
  return texelFetch(uPressure,cell,0).rg;
}
float pressureAt(vec2 cell) {
  if(cell.y<0.0||cell.y>uSize.y-1.0||(uWrap==0&&(cell.x<0.0||cell.x>uSize.x-1.0)))return -1e30;
  ivec2 p=ivec2(floor(cell));vec2 t=fract(cell);
  vec2 a=pressureTap(p),b=pressureTap(p+ivec2(1,0));
  vec2 c=pressureTap(p+ivec2(0,1)),d=pressureTap(p+ivec2(1,1));
  if(any(isnan(a))||any(isnan(b))||any(isnan(c))||any(isnan(d)))return -1e30;
  vec2 v=mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
  return mix(v.x,v.y,uBlend);
}
float pressureBand(float value,float step,float gradient) {
  float level=floor(value/step+.5)*step;
  float width=mod(level,20.0)<.001?1.35:.85;
  float distance=abs(value-level)/max(gradient,1e-6);
  return 1.0-smoothstep(max(0.0,width*uPressureDpr*.5-.5),width*uPressureDpr*.5+.5,distance);
}
vec3 pressureInk(vec3 base,float lon,float lat) {
  vec2 cell=vec2((lon-uOrigin.x)/uStep.x,(lat-uOrigin.y)/uStep.y);
  float value=pressureAt(cell);
  if(value < -1e20)return base;
  if(uCyclone.w>0.0){
    vec2 delta=vec2(mod(lon-uCyclone.x+540.0,360.0)-180.0,lat-uCyclone.y)*vec2(111.32*cos(radians(uCyclone.y)),111.132);
    float r=length(delta),q=pow(uCyclone.w/max(.001,r),uCycloneProfile.x);
    float cyclone=uCyclonePressure+(value-uCyclonePressure)*exp(-q);
    value=mix(value,cyclone,1.0-smoothstep(uCycloneProfile.y,uCycloneProfile.z,r));
  }
  float gradient=length(vec2(dFdx(value),dFdy(value)));
  float alpha=max(pressureBand(value,8.0,gradient),
    max(pressureBand(value,4.0,gradient)*smoothstep(0.0,1.0,(100.0-uPressureSpan)/28.0),
        pressureBand(value,2.0,gradient)*smoothstep(0.0,1.0,(24.0-uPressureSpan)/6.0)));
  // A constant pressure plateau has no contour edge.
  alpha*=step(1e-6,gradient);
  if(uWrap==0){float edge=min(min(cell.x,uSize.x-1.0-cell.x),min(cell.y,uSize.y-1.0-cell.y));alpha*=smoothstep(0.0,.5/abs(uStep.x),edge);}
  if(uHasTerrain==1){
    vec2 uv=vec2(mod(lon-uTerrainBox.x+720.0,360.0)/(uTerrainBox.z-uTerrainBox.x),(lat-uTerrainBox.y)/(uTerrainBox.w-uTerrainBox.y));
    if(all(greaterThanEqual(uv,vec2(0)))&&all(lessThanEqual(uv,vec2(1)))){
      vec2 ground=terrainAt(uv);
      if(ground.y>.99&&ground.x>1500.0)alpha*=.24*step(3.0,mod((gl_FragCoord.x+gl_FragCoord.y)/uPressureDpr,7.0));
    }
  }
  return mix(base,mix(vec3(73,101,119),vec3(190,208,215),uDark)/255.0,alpha);
}
`;
