/**
 * Post-process antialiasing (FXAA) for the WebGL2 plate's 3D passes.
 *
 * Multisampling looked like the obvious fix for jagged terrain silhouettes,
 * but Chrome's Metal backend shades every sample of a multisample target: the
 * plate's terrain material cost 4x per frame (49 ms against 6 ms, Apple M5).
 * FXAA shades each pixel once, then smooths luminance edges in one cheap
 * full-screen pass. The target owns a colour texture and a depth renderbuffer;
 * resolve() draws into the default framebuffer, so readback paths see the
 * finished picture.
 */
export interface PostAntialias {
  /** False when WebGL2 cannot provide a complete target. */
  readonly supported: boolean;
  /** Bind the offscreen target (cleared) and set the viewport. False means draw directly. */
  begin(width: number, height: number): boolean;
  /** Filter the offscreen picture into the default framebuffer. */
  resolve(): void;
  destroy(): void;
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){vUv=aPos*.5+.5;gl_Position=vec4(aPos,0,1);}`;

// FXAA 3.11 "console" variant (Lottes), constants from the reference preset.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 oColor;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
void main(){
  vec3 m=texture(uScene,vUv).rgb;
  float lNW=luma(texture(uScene,vUv+vec2(-1,-1)*uTexel).rgb),lNE=luma(texture(uScene,vUv+vec2(1,-1)*uTexel).rgb);
  float lSW=luma(texture(uScene,vUv+vec2(-1,1)*uTexel).rgb),lSE=luma(texture(uScene,vUv+vec2(1,1)*uTexel).rgb),lM=luma(m);
  float lo=min(lM,min(min(lNW,lNE),min(lSW,lSE))),hi=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
  if(hi-lo<max(.0312,hi*.125)){oColor=vec4(m,1);return;}
  vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));
  float reduce=max((lNW+lNE+lSW+lSE)*(.25/8.),1./128.);
  dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),vec2(-8),vec2(8))*uTexel;
  vec3 a=.5*(texture(uScene,vUv+dir*(1./3.-.5)).rgb+texture(uScene,vUv+dir*(2./3.-.5)).rgb);
  vec3 b=a*.5+.25*(texture(uScene,vUv-dir*.5).rgb+texture(uScene,vUv+dir*.5).rgb);
  float lb=luma(b);
  oColor=vec4(lb<lo||lb>hi?a:b,1);
}`;

export function createPostAntialias(gl: WebGL2RenderingContext): PostAntialias {
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let buffer: WebGLBuffer | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  let color: WebGLTexture | null = null;
  let depth: WebGLRenderbuffer | null = null;
  let width = 0, height = 0, active = false, disposed = false, failed = false;
  let texelLocation: WebGLUniformLocation | null = null, sceneLocation: WebGLUniformLocation | null = null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
    return shader;
  };
  const ensureProgram = () => {
    if (program || failed) return !!program;
    const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const next = vs && fs ? gl.createProgram() : null;
    if (next && vs && fs) { gl.attachShader(next, vs); gl.attachShader(next, fs); gl.linkProgram(next); }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (!next || !gl.getProgramParameter(next, gl.LINK_STATUS)) { if (next) gl.deleteProgram(next); failed = true; return false; }
    program = next;
    texelLocation = gl.getUniformLocation(program, 'uTexel');
    sceneLocation = gl.getUniformLocation(program, 'uScene');
    vao = gl.createVertexArray(); buffer = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return true;
  };
  const releaseTarget = () => {
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    if (color) gl.deleteTexture(color);
    if (depth) gl.deleteRenderbuffer(depth);
    framebuffer = null; color = null; depth = null; width = 0; height = 0; active = false;
  };

  return {
    get supported() { return !disposed && !failed; },
    begin(nextWidth, nextHeight) {
      active = false;
      if (disposed || failed || !Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || !ensureProgram()) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return false; }
      const w = Math.max(1, Math.floor(nextWidth)), h = Math.max(1, Math.floor(nextHeight));
      if (!framebuffer || w !== width || h !== height) {
        releaseTarget();
        framebuffer = gl.createFramebuffer(); color = gl.createTexture(); depth = gl.createRenderbuffer();
        if (!framebuffer || !color || !depth) { releaseTarget(); failed = true; gl.bindFramebuffer(gl.FRAMEBUFFER, null); return false; }
        gl.bindTexture(gl.TEXTURE_2D, color);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { releaseTarget(); failed = true; gl.bindFramebuffer(gl.FRAMEBUFFER, null); return false; }
        width = w; height = h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      active = true;
      return true;
    },
    resolve() {
      if (!active || disposed || !program || !color) return;
      active = false;
      // The depth samples are never read again; a tiled GPU can skip storing them.
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.uniform1i(sceneLocation, 0);
      gl.uniform2f(texelLocation, 1 / width, 1 / height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    destroy() {
      if (disposed) return;
      releaseTarget();
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      program = null; vao = null; buffer = null; disposed = true;
    },
  };
}
