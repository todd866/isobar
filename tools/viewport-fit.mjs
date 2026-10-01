/** Geometry checks for an existing Playwright Page. No browser, network, or login setup. */
export const VIEWPORTS = Object.freeze({
  laptop: { width: 1366, height: 768 },
  shortLaptop: { width: 1280, height: 640 },
  phone: { width: 390, height: 844 },
  smallPhone: { width: 360, height: 640 },
  phoneLandscape: { width: 844, height: 390 },
});

function targets(value, kind) {
  if (!Array.isArray(value)) throw new TypeError(`${kind} must be an array of targets.`);
  return value.map((target) => {
    const t = typeof target === 'string' ? { selector: target } : { ...target };
    if (!t.selector || typeof t.selector !== 'string') throw new TypeError(`${kind} target needs a CSS selector.`);
    if (!['full', 'visible'].includes(t.fit ?? 'full')) throw new TypeError(`${t.selector}: fit must be full or visible.`);
    for (const key of ['minWidth', 'minHeight']) {
      if (t[key] != null && (!Number.isFinite(t[key]) || t[key] <= 0)) throw new TypeError(`${t.selector}: ${key} must be positive.`);
    }
    return { kind, label: t.label ?? t.selector, selector: t.selector, fit: t.fit ?? 'full', minWidth: t.minWidth ?? 1, minHeight: t.minHeight ?? 1 };
  });
}

/**
 * Measure without scrolling or changing the page. CSS selectors may match several
 * elements: every match is checked. Call only after the app and images are ready.
 * The returned JSON deliberately omits URLs, text content, cookies, and image data.
 */
export async function auditViewport(page, options = {}) {
  const primary = targets(options.primary ?? [], 'primary');
  const controls = targets(options.controls ?? [], 'control');
  if (!primary.length) throw new TypeError('Declare at least one primary surface.');
  const documentY = options.documentY ?? 'forbid';
  if (!['allow', 'forbid'].includes(documentY)) throw new TypeError('documentY must be allow or forbid.');
  const tolerance = options.tolerance ?? 1;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('tolerance must be nonnegative.');

  const report = await page.evaluate(({ targets, documentY, tolerance }) => {
    const round = n => Math.round(n * 100) / 100;
    const rect = r => ({ x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) });
    const intersect = (a, b) => {
      const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
      const right = Math.max(left, Math.min(a.right, b.right)), bottom = Math.max(top, Math.min(a.bottom, b.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const root = document.documentElement, body = document.body;
    const rootStyle = getComputedStyle(root);
    // With visible root overflow, HTML body overflow propagates to the viewport.
    // Otherwise the body can clip descendants at its own box, like a normal ancestor.
    const bodyOverflowPropagates = root.tagName === 'HTML' && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible';
    const documentSize = {
      width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0),
      height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0),
      scrollX, scrollY,
    };
    const failures = [];
    const fail = (code, label, detail) => failures.push({ code, label, detail });
    if (documentSize.width > innerWidth + tolerance) fail('document-overflow-x', 'document', `${documentSize.width}px wide in a ${innerWidth}px viewport.`);
    if (documentY === 'forbid' && documentSize.height > innerHeight + tolerance) fail('document-overflow-y', 'document', `${documentSize.height}px high in a ${innerHeight}px viewport. The working surface requires scrolling.`);
    if (documentY === 'forbid' && (Math.abs(scrollY) > tolerance || Math.abs(scrollX) > tolerance)) fail('document-scrolled', 'document', `Already scrolled to (${scrollX}, ${scrollY}); test the initial view too.`);
    const measurements = [];
    for (const target of targets) {
      let matches;
      try { matches = [...document.querySelectorAll(target.selector)]; }
      catch { fail('invalid-selector', target.label, 'Not a valid CSS selector.'); continue; }
      if (!matches.length) { fail('missing-target', target.label, 'No elements matched.'); continue; }
      for (const [index, element] of matches.entries()) {
        const label = matches.length === 1 ? target.label : `${target.label} [${index + 1}/${matches.length}]`;
        const bounds = element.getBoundingClientRect();
        let visible = intersect(bounds, viewport);
        const clips = [];
        let hidden = !element.getClientRects().length;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) hidden = true;
          if (ancestor === element || ancestor === root || (ancestor === body && bodyOverflowPropagates)) continue;
          const clipX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
          const clipY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
          if (!clipX && !clipY) continue;
          const a = ancestor.getBoundingClientRect();
          // Use client area, excluding borders and scrollbars. Scale for ordinary CSS transforms.
          const sx = ancestor.offsetWidth ? a.width / ancestor.offsetWidth : 1;
          const sy = ancestor.offsetHeight ? a.height / ancestor.offsetHeight : 1;
          const left = a.left + ancestor.clientLeft * sx, top = a.top + ancestor.clientTop * sy;
          let clientWidth = ancestor.clientWidth * sx, clientHeight = ancestor.clientHeight * sy;
          // In quirks mode body.clientHeight/Width may report the viewport instead
          // of its own clipping box. Cap that special case at the actual padding box.
          if (ancestor === body && document.compatMode === 'BackCompat') {
            clientWidth = Math.min(clientWidth, a.width - (parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)) * sx);
            clientHeight = Math.min(clientHeight, a.height - (parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)) * sy);
          }
          const clip = { left: clipX ? left : -Infinity, right: clipX ? left + clientWidth : Infinity, top: clipY ? top : -Infinity, bottom: clipY ? top + clientHeight : Infinity };
          const next = intersect(visible, clip);
          if (next.width < visible.width - tolerance || next.height < visible.height - tolerance) clips.push({ tag: ancestor.tagName.toLowerCase(), overflowX: style.overflowX, overflowY: style.overflowY });
          visible = next;
        }
        if (hidden) visible = { left: bounds.left, top: bounds.top, right: bounds.left, bottom: bounds.top, width: 0, height: 0 };
        measurements.push({ ...target, index, matches: matches.length, rect: rect(bounds), visibleRect: rect(visible), clips, hidden });
        if (hidden || visible.width <= 0 || visible.height <= 0) fail('invisible-target', label, 'No visible area in the current viewport.');
        if (target.fit === 'full' && (visible.width < bounds.width - tolerance || visible.height < bounds.height - tolerance)) fail('clipped-target', label, `Visible ${round(visible.width)}×${round(visible.height)}px of ${round(bounds.width)}×${round(bounds.height)}px${clips.length ? ' (ancestor clipping)' : ' (outside viewport)'}.`);
        if (visible.width + tolerance < target.minWidth || visible.height + tolerance < target.minHeight) fail('target-too-small', label, `Visible ${round(visible.width)}×${round(visible.height)}px; requires at least ${target.minWidth}×${target.minHeight}px.`);
      }
    }
    return { passed: failures.length === 0, viewport: { width: innerWidth, height: innerHeight }, document: documentSize, documentY, tolerance, measurements, failures };
  }, { targets: [...primary, ...controls], documentY, tolerance });

  // This is explicit opt-in: screenshots can contain private content. Never fullPage.
  if (options.screenshotPath) await page.screenshot({ path: options.screenshotPath, fullPage: false, animations: 'disabled' });
  return report;
}

export async function assertViewport(page, options) {
  const report = await auditViewport(page, options);
  if (!report.passed) {
    const error = new Error(`Viewport check failed (${report.viewport.width}×${report.viewport.height}):\n${report.failures.map(f => `- ${f.label}: ${f.detail} [${f.code}]`).join('\n')}`);
    error.name = 'ViewportFitError';
    error.report = report;
    throw error;
  }
  return report;
}
