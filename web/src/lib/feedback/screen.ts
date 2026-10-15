/** Called synchronously just after the map repaints, before WebGL discards its buffer.
 * No preserveDrawingBuffer and no permission-based screen capture. DOM is omitted. */
export function captureMap(stage: HTMLElement): string | null {
  try {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(1, 1440 / rect.width, 1000 / rect.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = getComputedStyle(stage).backgroundColor || '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let count = 0;
    const layers = [...stage.querySelectorAll('canvas')].sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
    for (const layer of layers) {
      const style = getComputedStyle(layer);
      if (!layer.width || !layer.height || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      if (typeof layer.checkVisibility === 'function' && !layer.checkVisibility()) continue;
      const box = layer.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      ctx.globalAlpha = Number(getComputedStyle(layer).opacity);
      ctx.drawImage(layer, (box.x - rect.x) * scale, (box.y - rect.y) * scale, box.width * scale, box.height * scale); count++;
    }
    if (!count) return null;
    for (const quality of [.82, .65, .45, .25]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.startsWith('data:image/jpeg;base64,') && (data.length - 23) * 3 / 4 <= 400_000) return data.slice(23);
    }
  } catch { /* Tainted or unavailable canvas: retain state without an image. */ }
  return null;
}
