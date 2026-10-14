import { describe, expect, it } from 'vitest';
import { createPostAntialias } from '../../src/lib/post-antialias';

describe('post antialias target', () => {
  function mockGl(status = 12) {
    const calls: string[] = []; let id = 1;
    const gl = new Proxy({
      FRAMEBUFFER: 5, FRAMEBUFFER_COMPLETE: 12, COLOR_ATTACHMENT0: 8, DEPTH_ATTACHMENT: 9, TEXTURE_2D: 1, RENDERBUFFER: 2,
      COMPILE_STATUS: 1, LINK_STATUS: 2, VERTEX_SHADER: 3, FRAGMENT_SHADER: 4, TRIANGLES: 4,
      getShaderParameter: () => true, getProgramParameter: () => true,
      checkFramebufferStatus: () => status,
      createFramebuffer: () => ({ id: id++ }), createTexture: () => ({ id: id++ }), createRenderbuffer: () => ({ id: id++ }),
      createProgram: () => ({ id: id++ }), createShader: () => ({ id: id++ }), createVertexArray: () => ({ id: id++ }), createBuffer: () => ({ id: id++ }),
      getUniformLocation: () => ({}),
    } as Record<string, unknown>, { get(target, key: string) { if (key in target) return target[key]; return (...args: unknown[]) => { calls.push(`${key}:${args.length}`); return undefined; }; } });
    return { gl: gl as unknown as WebGL2RenderingContext, calls };
  }
  it('renders offscreen once per size and filters into the default framebuffer', () => {
    const { gl, calls } = mockGl();
    const target = createPostAntialias(gl);
    expect(target.begin(640, 400)).toBe(true);
    target.resolve();
    expect(calls.filter(c => c.startsWith('texStorage2D')).length).toBe(1);
    expect(calls).toContain('drawArrays:3');
    expect(target.begin(640, 400)).toBe(true);
    expect(calls.filter(c => c.startsWith('texStorage2D')).length).toBe(1);
    target.begin(800, 400);
    expect(calls.filter(c => c.startsWith('texStorage2D')).length).toBe(2);
    target.destroy();
    expect(target.supported).toBe(false);
  });
  it('falls back to direct drawing when the framebuffer is incomplete', () => {
    const { gl } = mockGl(0);
    const target = createPostAntialias(gl);
    expect(target.begin(640, 400)).toBe(false);
    expect(target.supported).toBe(false);
  });
});
