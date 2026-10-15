import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMap } from '../../src/lib/feedback/screen';
afterEach(() => vi.unstubAllGlobals());
function fixture(data = 'data:image/jpeg;base64,/9j/2Q==') {
  const ctx = { fillStyle: '', globalAlpha: 1, fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: vi.fn(() => data) };
  const layer = { width: 800, height: 600, getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  const stage = { getBoundingClientRect: layer.getBoundingClientRect, querySelectorAll: () => [layer] };
  vi.stubGlobal('document', { createElement: () => canvas });
  vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: '#fff', display: 'block', visibility: 'visible', opacity: '1', zIndex: '0' }));
  return { stage: stage as unknown as HTMLElement, canvas, ctx };
}
describe('feedback canvas capture', () => {
  it('works without checkVisibility and produces a bounded JPEG', () => {
    const f = fixture(); expect(captureMap(f.stage)).toBe('/9j/2Q==');
    expect(f.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(f.canvas.width).toBe(800);
  });
  it('keeps screen null when encoding fails or cannot meet the size cap', () => {
    const f = fixture('data:image/jpeg;base64,' + 'a'.repeat(600_000));
    expect(captureMap(f.stage)).toBeNull(); expect(f.canvas.toDataURL).toHaveBeenCalledTimes(4);
    f.canvas.toDataURL.mockImplementation(() => { throw new Error('tainted'); });
    expect(captureMap(f.stage)).toBeNull();
  });
});
