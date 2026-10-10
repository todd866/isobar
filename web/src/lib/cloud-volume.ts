/** Optional low-resolution ray-marched 3D cloud layer. No camera-facing sprites. */
import type { TiltedCamera } from './tilt-navigation';
import type { TiltCamera } from './tilt-camera';
import type { CloudDensityTexture } from './cloud-density';
import { cachedAtmosphereSliceDepthGrid, sampleAtmosphereSliceDepth } from './atmosphere-slice-depth';
const R=6371000, RAD=Math.PI/180;
export function cloudWorldPoint(camera:TiltCamera,lat:number,lon:number,height:number):[number,number,number]{
  const k=Math.max(.001,camera.geometry.curvature),re=R/k,p=k*lat*RAD,p0=k*camera.lat*RAD,l=k*((lon-camera.lon+540)%360-180)*RAD;
  const n=[Math.cos(p)*Math.sin(l),Math.sin(p)*Math.cos(p0)-Math.cos(p)*Math.cos(l)*Math.sin(p0),Math.cos(p)*Math.cos(l)*Math.cos(p0)+Math.sin(p)*Math.sin(p0)];
  return [n[0]*(re+height),n[1]*(re+height),re*(n[2]-1)+n[2]*height];
}
export function cloudWorldBounds(camera:TiltCamera,data:CloudDensityTexture){
  const b=data.bounds,min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const lat of [b.south,(b.south+b.north)/2,b.north])for(const lon of [b.west,(b.west+b.east)/2,b.east])for(const h of [b.minHeight,b.maxHeight]){
    const p=cloudWorldPoint(camera,lat,lon,h);for(let i=0;i<3;i++){min[i]=Math.min(min[i],p[i]-100);max[i]=Math.max(max[i],p[i]+100);}
  }return {min,max};
}
const VERT=`#version 300 es
in vec2 position;out vec2 clip;void main(){clip=position;gl_Position=vec4(position,0,1);}`;
const FRAG=`#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 clip;out vec4 colour;
uniform sampler3D volume;uniform sampler2D ground;uniform sampler2D depthMap;
uniform vec4 box;uniform vec2 heights;uniform vec3 eye;uniform vec3 forward;uniform vec3 up;
uniform vec3 minimum;uniform vec3 maximum;uniform vec3 lightStep;uniform vec4 camera;uniform vec2 projection;
uniform vec4 slice;uniform vec2 sliceSize;
uniform float dark;uniform float inspection;
const float R=6371000.0;
vec3 geographical(vec3 p){
 float k=camera.z,re=R/k,r=length(p+vec3(0,0,re));
 vec3 n=(p+vec3(0,0,re))/r;float p0=k*camera.x;
 float lat=asin(clamp(n.y*cos(p0)+n.z*sin(p0),-1.0,1.0))/k;
 float lon=camera.y+atan(n.x,n.z*cos(p0)-n.y*sin(p0))/k;
 float h=(dot(p,p)+2.0*re*p.z)/(r+re);
 return vec3(degrees(lon),degrees(lat),h);
}
vec3 uvw(vec3 g){return vec3((g.xy-box.xy)/(box.zw-box.xy),(g.z-heights.x)/(heights.y-heights.x));}
float sliceWeight(vec2 lonLat){
 if(slice.w<.5)return 1.0;
 float east=mod(lonLat.x-slice.y+540.0,360.0)-180.0;
 east*=111320.0*cos(radians(slice.x));
 float north=(lonLat.y-slice.x)*111132.0;
 float s=sin(slice.z),c=cos(slice.z);
 float across=east*c-north*s,depth=east*s+north*c;
 if(abs(across)>sliceSize.x||abs(depth)>sliceSize.y)return 0.0;
 float widthFade=smoothstep(0.0,1.0,(sliceSize.x-abs(across))/(sliceSize.x*.25));
 float depthFade=smoothstep(0.0,1.0,(sliceSize.y-abs(depth))/(sliceSize.y*.25));
 return min(widthFade,depthFade);
}
float hash3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);}
float density(vec3 uv){if(any(lessThan(uv,vec3(0)))||any(greaterThan(uv,vec3(1))))return 0.0;float d=texture(volume,uv).r;
 // Fine world-anchored erosion adds volume detail without moving its wave envelope.
 vec3 world=vec3(mix(box.x,box.z,uv.x)*98000.0,mix(box.y,box.w,uv.y)*111132.0,mix(heights.x,heights.y,uv.z));
 float n=.65*noise3(world/190.0)+.35*noise3(world/75.0);
 return max(0.0,d-(1.0-n)*.16)*sliceWeight(uv.xy*vec2(box.z-box.x,box.w-box.y)+box.xy);}
void main(){
 vec3 right=normalize(cross(forward,up));
 vec3 ray=normalize(forward+right*(clip.x*projection.x*projection.y)+up*(clip.y*projection.x));
 vec3 safeRay=mix(vec3(.000001),ray,greaterThan(abs(ray),vec3(.000001)));
 vec3 a=(minimum-eye)/safeRay,b=(maximum-eye)/safeRay;
 float enter=max(0.0,max(max(min(a.x,b.x),min(a.y,b.y)),min(a.z,b.z)));
 float leave=min(80000.0,min(min(max(a.x,b.x),max(a.y,b.y)),max(a.z,b.z)));
 vec2 depthUv=clip*.5+.5;vec2 texel=1.0/vec2(textureSize(depthMap,0));
 float depth=texture(depthMap,depthUv).r;
 depth=min(depth,min(texture(depthMap,depthUv+vec2(texel.x,0)).r,texture(depthMap,depthUv-vec2(texel.x,0)).r));
 depth=min(depth,min(texture(depthMap,depthUv+vec2(0,texel.y)).r,texture(depthMap,depthUv-vec2(0,texel.y)).r));
 leave=min(leave,depth/max(.01,dot(ray,forward)));
 if(leave<=enter){colour=vec4(0);return;}
 float stepLength=(leave-enter)/96.0;vec4 sum=vec4(0);
 for(int i=0;i<96;i++){
   float distance=enter+(float(i)+.5)*stepLength;
   vec3 g=geographical(eye+ray*distance),uv=uvw(g);
   if(sliceWeight(g.xy)>0.0&&all(greaterThanEqual(uv.xy,vec2(0)))&&all(lessThanEqual(uv.xy,vec2(1)))&&g.z<texture(ground,uv.xy).r+8.0)break;
   float d=density(uv);
   if(d>.005){
     float shade=exp(-1.2*(density(uv+lightStep*.5)+density(uv+lightStep)+density(uv+lightStep*2.0)+density(uv+lightStep*4.0)));
     vec3 light=mix(vec3(.57,.63,.7),vec3(.98,.985,1),shade)*mix(1.0,.58,dark);
     float alpha=1.0-exp(-d*stepLength*.0022);
     alpha*=1.0-inspection*.6*exp(-distance/5000.0);
     sum.rgb+=(1.0-sum.a)*alpha*light;sum.a+=(1.0-sum.a)*alpha;
     if(sum.a>.985)break;
   }
 }
 colour=sum;
}`;
export interface CloudVolumeLayer {
 setData(data:CloudDensityTexture):void;
 draw(camera:TiltedCamera,width:number,height:number,dark:boolean,inspection:number):void;
 clear():void;
 destroy():void;
}
export function createCloudVolumeLayer(canvas:HTMLCanvasElement):CloudVolumeLayer|null {
 const context=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});if(!context)return null;
 const gl:WebGL2RenderingContext=context;
 const shaders:WebGLShader[]=[];let program:WebGLProgram|null=null;
 try {
  for(const [type,source] of [[gl.VERTEX_SHADER,VERT],[gl.FRAGMENT_SHADER,FRAG]] as const){const shader=gl.createShader(type)!;shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)??'Cloud shader failed');}
  program=gl.createProgram()!;for(const shader of shaders)gl.attachShader(program,shader);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Cloud shader link failed');
 }catch(error){for(const shader of shaders)gl.deleteShader(shader);if(program)gl.deleteProgram(program);throw error;}
 for(const shader of shaders)gl.deleteShader(shader);
 gl.useProgram(program);const vao=gl.createVertexArray(),buffer=gl.createBuffer();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
 const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
 const textures=[gl.createTexture(),gl.createTexture(),gl.createTexture()];
 const locations=new Map<string,WebGLUniformLocation|null>();const loc=(name:string)=>{if(!locations.has(name))locations.set(name,gl.getUniformLocation(program!,name));return locations.get(name)!;};
 let data:CloudDensityTexture|null=null,lastCamera='',lastDraw='';
 let revision=0;
 const clear=()=>{lastDraw='';gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);};
 function textureParameters(target:number,filter:number){gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(target===gl.TEXTURE_3D)gl.texParameteri(target,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);}
 return {
  setData(next){data=next;revision++;lastCamera='';gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_3D,textures[0]);gl.texImage3D(gl.TEXTURE_3D,0,gl.R8,next.width,next.height,next.depth,0,gl.RED,gl.UNSIGNED_BYTE,next.density);textureParameters(gl.TEXTURE_3D,gl.LINEAR);
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,textures[1]);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,next.terrainSize,next.terrainSize,0,gl.RED,gl.FLOAT,next.terrain);textureParameters(gl.TEXTURE_2D,gl.NEAREST);
  },
  draw(view,width,height,dark,inspection){const camera=view.tiltCamera;if(!camera||!data||camera.geometry.curvature<.001){clear();return;}
   // Half CSS resolution, capped independently of devicePixelRatio.
   const scale=Math.min(.5,640/Math.max(1,width));const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);gl.useProgram(program);gl.bindVertexArray(vao);
   const sliceConfig=view.slice;
   const sliceKey=sliceConfig?[sliceConfig.lat,sliceConfig.lon,sliceConfig.bearingRadians,sliceConfig.halfWidthM,sliceConfig.halfDepthM,sliceConfig.baseM]:[];
   const key=[camera.lat,camera.lon,camera.halfHeightDeg,camera.aspect,camera.tiltRadians,camera.bearingRadians,camera.targetElevationM,...sliceKey].join(':');
   const drawKey=[key,w,h,dark,inspection,revision].join(':');
   if(drawKey===lastDraw)return;
   if(key!==lastCamera){
    const pixels=new Float32Array(48*32);const sliceDepth=sliceConfig&&view.surface?cachedAtmosphereSliceDepthGrid(view,sliceConfig):null;
    for(let y=0;y<32;y++)for(let x=0;x<48;x++){
      if(sliceDepth){pixels[y*48+x]=sampleAtmosphereSliceDepth(sliceDepth,2*(x+.5)/48-1,(y+.5)/16-1);continue;}
      const hit=view.surface?.unproject((x+.5)/24-1,(y+.5)/16-1);const p=hit?view.surface?.project(hit.lat,hit.lon):null;pixels[y*48+x]=p&&p.visible&&Number.isFinite(p.depth)?Math.max(0,p.depth):1e8;
    }
    gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,textures[2]);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,48,32,0,gl.RED,gl.FLOAT,pixels);textureParameters(gl.TEXTURE_2D,gl.NEAREST);lastCamera=key;
   }
   const bounds=cloudWorldBounds(camera,data),b=data.bounds,g=camera.geometry;
   gl.uniform1i(loc('volume'),0);gl.uniform1i(loc('ground'),1);gl.uniform1i(loc('depthMap'),2);
   gl.uniform3f(loc('lightStep'),-360/((b.east-b.west)*111320*Math.max(.01,Math.cos((b.north+b.south)*.5*RAD))),180/((b.north-b.south)*111132),420/(b.maxHeight-b.minHeight));
   gl.uniform4f(loc('box'),b.west,b.south,b.east,b.north);gl.uniform2f(loc('heights'),b.minHeight,b.maxHeight);
   gl.uniform4f(loc('slice'),sliceConfig?.lat??0,sliceConfig?.lon??0,sliceConfig?.bearingRadians??0,sliceConfig?1:0);gl.uniform2f(loc('sliceSize'),sliceConfig?.halfWidthM??1,sliceConfig?.halfDepthM??1);
   gl.uniform3f(loc('eye'),...g.cameraPositionM);gl.uniform3f(loc('forward'),...g.forward);gl.uniform3f(loc('up'),...g.up);
   gl.uniform3fv(loc('minimum'),bounds.min);gl.uniform3fv(loc('maximum'),bounds.max);
   gl.uniform4f(loc('camera'),camera.lat*RAD,camera.lon*RAD,g.curvature,0);gl.uniform2f(loc('projection'),g.tangentHalfHeight,camera.aspect);
   gl.uniform1f(loc('dark'),dark?1:0);gl.uniform1f(loc('inspection'),Math.max(0,Math.min(1,inspection)));
   clear();gl.drawArrays(gl.TRIANGLES,0,3);lastDraw=drawKey;
  },clear,
  destroy(){for(const t of textures)gl.deleteTexture(t);gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);gl.deleteProgram(program);}
 };
}
