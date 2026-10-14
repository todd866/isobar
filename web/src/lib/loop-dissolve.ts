/** A single endpoint picture fades over the already prepared return picture.
 * Capture immediately after GL draw (its framebuffer is not preserved). */
export function createLoopDissolve(stage: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.dataset.loopDissolve = '';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none', zIndex:'3', display:'none', opacity:'0'});
  stage.appendChild(canvas);
  let captured = false;
  return {
    capture(layers: (HTMLCanvasElement | null)[]) {
      const visible = layers.filter((layer): layer is HTMLCanvasElement => {
        if (!layer || !layer.width || !layer.height) return false;
        const style = getComputedStyle(layer);
        return style.display !== 'none' && style.visibility === 'visible';
      });
      const first = visible[0];
      if (!first) return;
      canvas.width = first.width; canvas.height = first.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      for (const layer of visible) ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
      captured = true;
    },
    draw(progress: number | null) {
      canvas.style.display = captured && progress !== null ? 'block' : 'none';
      canvas.style.opacity = String(progress === null ? 0 : 1 - Math.max(0, Math.min(1, progress)));
      if (progress === null) captured = false;
    },
    destroy() { canvas.remove(); },
  };
}
