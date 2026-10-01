(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    image: $('#map-image'), video: $('#map-video'), play: $('#play-toggle'), state: $('#map-state'), retry: $('#retry'), time: $('#time'),
    timeLabel: $('#time-label'), times: $('#times'), timeline: $('.timeline'), title: $('#map-title'), note: $('#map-note'), updated: $('#updated'),
    chart: $('#chart'), empty: $('#chart-empty'), reading: $('#detail-reading'), detail: $('#detail-panel'), mapFrame: $('#map-frame'),
    layers: $('#layers-menu'), layersButton: $('#layers-button'), download: $('#download'),
    downloadLink: $('#download-link'), dialogDownload: $('#dialog-download'), downloadCopy: $('#download-copy')
  };
  const state = { manifest: null, frames: [], index: 0, overlay: 'none', detail: null, images: new Map(), pending: new Map(), animation: null, videoCache: new Map(), playbackMode: 'manual', movieIntent: 0 };
  const MAX_PRELOAD = 4;
  const queue = [];
  function showDownload(release) {
    if (!release || typeof release.url !== 'string' || typeof release.label !== 'string') return false;
    let url;
    try { url = new URL(release.url); } catch { return false; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
        !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.(?:dmg|zip)$/.test(url.pathname)) return false;
    els.dialogDownload.href = url.href;
    els.dialogDownload.textContent = 'Download Isobar';
    els.dialogDownload.hidden = false;
    els.downloadCopy.textContent = release.label;
    $('#install-open').textContent = url.pathname.endsWith('.dmg') ? 'Open the downloaded disk image.' : 'Open the downloaded ZIP file.';
    $('#install-steps').hidden = false;
    $('#download-ready').hidden = false;
    return true;
  }
  async function loadDownload() {
    // Installing the app must not depend on the weather feed being available.
    try {
      const response = await fetch('./release.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        try { showDownload(await response.json()); }
        catch { /* Invalid release content must not resurrect an old download. */ }
        // A preparation/withdrawal state also overrides an older manifest.
        return true;
      }
    } catch { /* The forecast manifest can also carry the release pointer. */ }
    return false;
  }
  let activeRequests = 0, mapRevision = 0;
  function drain() {
    while (activeRequests < MAX_PRELOAD && queue.length) {
      activeRequests++;
      queue.shift()().finally(() => { activeRequests--; drain(); });
    }
  }

  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const isTime = (value) => typeof value === 'string' && !Number.isNaN(new Date(value).valueOf());
  const formatTime = (value, withDay = true) => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      weekday: withDay ? 'short' : undefined,
      day: 'numeric',
      month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Perth'
    }).format(date);
  };
  const formatHour = (value) => {
    const timestamp = new Date(value).valueOf();
    if (Number.isNaN(timestamp)) return '—';
    const date = new Date(Math.round(timestamp / 3600000) * 3600000);
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Perth' }).format(date);
  };
  const assetURL = (path) => {
    if (typeof path !== 'string' || !path) return null;
    try {
      const url = new URL(path, new URL('./data/', location.href));
      return url.href.startsWith(new URL('./data/', location.href).href) ? url.href : null;
    } catch { return null; }
  };
  const requestedMapURL = (frame) => assetURL(frame.maps[state.overlay === 'none' ? 'pressure' : state.overlay]);
  const frameURL = (frame) => requestedMapURL(frame) || assetURL(frame.maps.pressure);
  const movieSpan = (animation) => Math.max(.001, animation.duration - 1 / animation.fps);
  const movieDate = (animation, seconds) => new Date(animation.validFrom +
    Math.max(0, Math.min(1, seconds / movieSpan(animation))) * (animation.validTo - animation.validFrom));
  const ambientRate = (animation) => Math.max(.25, Math.min(1, animation.duration / 120));
  const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const forecastNow = (animation) => Math.max(animation.validFrom, Math.min(animation.validTo, Date.now()));
  const movieTimeForDate = (animation, date) => Math.max(0, Math.min(movieSpan(animation),
    (date - animation.validFrom) / Math.max(1, animation.validTo - animation.validFrom) * movieSpan(animation)));
  function animationForOverlay() {
    const key = state.overlay === 'none' ? 'pressure' : state.overlay;
    const candidate = state.manifest?.animations?.[key] || (key === 'pressure' ? state.manifest?.animation : null);
    if (!candidate || (candidate.layer && candidate.layer !== key)) return null;
    const url = assetURL(candidate.src), from = Date.parse(candidate.validFrom), to = Date.parse(candidate.validTo);
    if (!url || !Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
        !isNumber(candidate.durationSeconds) || candidate.durationSeconds <= 0 || candidate.durationSeconds > 120) return null;
    return { url, validFrom: from, validTo: to, duration: candidate.durationSeconds, fps: [24, 25, 30, 50, 60].includes(candidate.fps) ? candidate.fps : 30, playing: false, ready: false };
  }
  function videoEntry(animation) {
    let entry = state.videoCache.get(animation.url);
    if (entry) { state.videoCache.delete(animation.url); state.videoCache.set(animation.url, entry); return entry; }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'none'; video.hidden = true;
    video.setAttribute('aria-label', 'Animated weather forecast');
    entry = { video, sourceUrl: animation.url, blobUrl: null, fetchController: null, ready: false, promise: null };
    video.dataset.source = animation.url;
    const sync = () => {
      const current = state.animation;
      if (els.video !== video || !current?.ready) return;
      syncTimeline(movieDate(current, video.currentTime));
    };
    video.addEventListener('timeupdate', sync);
    video.addEventListener('seeked', sync);
    video.addEventListener('ended', () => {
      if (els.video !== video || !state.animation) return;
      if (Date.now() < state.animation.validTo) { resetToNow(); return; }
      state.animation.playing = false; updatePlayButton();
    });
    video.addEventListener('error', () => {
      entry.ready = false;
      if (els.video !== video || !state.animation) return;
      video.pause(); state.animation.playing = false;
      if (state.animation.ready) {
        state.animation.ready = false; setStaticMapVisible(true); renderMap();
        els.note.textContent = 'Animation unavailable · try Play again'; els.note.hidden = false;
      }
      updatePlayButton();
    });
    state.videoCache.set(animation.url, entry);
    while (state.videoCache.size > 4) {
      const [key, old] = state.videoCache.entries().next().value;
      old.fetchController?.abort();
      old.video.pause(); old.video.removeAttribute('src'); old.video.load(); old.video.remove();
      if (old.blobUrl) URL.revokeObjectURL(old.blobUrl);
      state.videoCache.delete(key);
    }
    return entry;
  }
  function selectAnimation() {
    els.video.pause();
    if (state.animation) state.animation.playing = false;
    state.movieIntent = (state.movieIntent || 0) + 1;
    state.animation = animationForOverlay();
    const next = state.animation;
    els.time.step = next ? '0.001' : '1';
    if (next) {
      const entry = videoEntry(next);
      if (els.video !== entry.video) {
        els.video.hidden = true; els.video.removeAttribute('id'); els.video.remove();
        entry.video.id = 'map-video'; $('#map-frame').append(entry.video); els.video = entry.video;
      }
      next.ready = entry.ready;
      if (entry.ready) next.duration = entry.video.duration;
      entry.video.dataset.source = next.url;
    }
    setStaticMapVisible(true); updatePlayButton();
  }
  function setStaticMapVisible(visible) {
    els.image.hidden = !visible; els.video.hidden = visible;
  }
  async function startAnimation(mode = 'manual', date = null) {
    const candidate = state.animation;
    if (!candidate) return;
    const intent = state.movieIntent = (state.movieIntent || 0) + 1;
    candidate.playPending = true;
    els.video.pause(); candidate.playing = false;
    els.play.textContent = 'Preparing…';
    state.playbackMode = mode;
    try {
      const video = await ensureAnimation(candidate);
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      let current = date === null ? targetMovieTime(candidate) : movieTimeForDate(candidate, date);
      if (current >= movieSpan(candidate) - .001) current = mode === 'ambient' ? movieTimeForDate(candidate, forecastNow(candidate)) : 0;
      video.currentTime = current;
      video.playbackRate = ambientRate(candidate);
      setStaticMapVisible(false); els.state.hidden = true; els.note.hidden = true;
      await video.play();
      if (state.animation !== candidate || intent !== state.movieIntent) { video.pause(); candidate.playing = false; return; }
      candidate.playing = true; updatePlayButton();
    } catch {
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      state.playbackMode = 'manual'; setStaticMapVisible(true); renderMap(); els.note.textContent = 'Animation unavailable · try Play again'; els.note.hidden = false; updatePlayButton();
    } finally { if (state.movieIntent === intent) candidate.playPending = false; }
  }
  async function resetToNow() {
    if (!state.animation) return;
    await startAnimation('ambient', forecastNow(state.animation));
  }
  function updatePlayButton() {
    els.play.disabled = !state.animation;
    els.play.textContent = state.animation?.playing ? 'Pause' : 'Play';
    els.play.setAttribute('aria-label', state.animation?.playing ? 'Pause forecast animation' : 'Play forecast animation');
  }
  function syncTimeline(date) {
    if (!state.frames.length) return;
    const target = new Date(date).valueOf();
    state.forecastTime = target;
    let closest = 0, distance = Infinity;
    state.frames.forEach((frame, index) => { const d = Math.abs(Date.parse(frame.time) - target); if (d < distance) { distance = d; closest = index; } });
    state.index = closest;
    const first = state.animation?.validFrom ?? Date.parse(state.frames[0].time);
    const last = state.animation?.validTo ?? Date.parse(state.frames[state.frames.length - 1].time);
    els.time.value = Math.max(0, Math.min(1, (target - first) / (last - first))) * Math.max(1, state.frames.length - 1);
    els.timeLabel.textContent = formatHour(date);
    els.times.innerHTML = state.frames.map((frame, i) => `<span${i === closest ? ' class="current"' : ''}>${formatHour(frame.time)}</span>`).join('');
    drawChart();
  }
  async function ensureAnimation(candidate) {
    const entry = videoEntry(candidate), video = entry.video;
    if (!entry.ready) {
      if (!entry.promise) entry.promise = (async () => {
        entry.fetchController?.abort();
        const controller = new AbortController(); entry.fetchController = controller;
        let response;
        try {
          response = await fetch(entry.sourceUrl, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`Animation unavailable (${response.status})`);
          const blob = await response.blob();
          if (controller.signal.aborted) throw new DOMException('Animation fetch aborted', 'AbortError');
          const blobUrl = URL.createObjectURL(blob);
          if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
          entry.blobUrl = blobUrl;
          video.src = blobUrl;
          video.preload = 'auto';
          await new Promise((resolve, reject) => {
            const cleanup = () => { clearTimeout(timeout); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed); };
            const ready = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error('Animation could not be decoded')); };
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Animation preparation timed out')); }, 30000);
            video.addEventListener('loadeddata', ready, { once: true });
            video.addEventListener('error', failed, { once: true });
            video.load();
          });
          entry.ready = true;
        } catch (error) {
          entry.ready = false;
          if (entry.blobUrl) { URL.revokeObjectURL(entry.blobUrl); entry.blobUrl = null; }
          video.removeAttribute('src'); video.load();
          throw error;
        } finally {
          if (entry.fetchController === controller) entry.fetchController = null;
        }
      })().finally(() => { entry.promise = null; });
      await entry.promise;
    }
    candidate.ready = true; candidate.duration = video.duration;
    return video;
  }
  function targetMovieTime(candidate) {
    const target = state.forecastTime ?? Date.parse(state.frames[state.index].time);
    return Math.max(0, Math.min(movieSpan(candidate), (target-candidate.validFrom) / (candidate.validTo-candidate.validFrom) * movieSpan(candidate)));
  }
  async function playAnimation() {
    const candidate = state.animation;
    if (!candidate) return;
    if (candidate.playing) {
      els.video.pause(); candidate.playing = false; state.playbackMode = 'manual';
      syncTimeline(movieDate(candidate, els.video.currentTime)); updatePlayButton(); return;
    }
    await startAnimation('manual');
  }
  async function seekAnimation(value) {
    const candidate = state.animation;
    if (!candidate) { setIndex(Math.round(Number(value))); return; }
    state.playbackMode = 'manual';
    const intent = state.movieIntent = (state.movieIntent || 0) + 1;
    // A slider choice supersedes an in-flight ambient preparation. Release its
    // gate so the next explicit Play remains available after the seek settles.
    candidate.playPending = false;
    const fraction = Math.max(0, Math.min(1, Number(value) / Math.max(1, state.frames.length - 1)));
    const rawDate = candidate.validFrom + fraction * (candidate.validTo - candidate.validFrom);
    const snappedDate = Math.max(candidate.validFrom, Math.min(candidate.validTo, Math.round(rawDate / 3600000) * 3600000));
    els.video.pause(); candidate.playing = false; updatePlayButton();
    try {
      const video = await ensureAnimation(candidate);
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      video.playbackRate = ambientRate(candidate);
      video.currentTime = movieTimeForDate(candidate, snappedDate);
      syncTimeline(movieDate(candidate, video.currentTime));
      setStaticMapVisible(false); els.state.hidden = true;
    } catch {
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      setIndex(Math.round(Number(value))); els.note.textContent = 'Animation unavailable · try Play again'; els.note.hidden = false;
    }
  }

  function imageFor(url) {
    if (!url) return Promise.reject(new Error('No map asset'));
    if (state.images.has(url)) return Promise.resolve(state.images.get(url));
    if (state.pending.has(url)) return state.pending.get(url);
    const request = new Promise((resolve, reject) => {
      queue.push(() => new Promise((finished) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = async () => { try { await image.decode(); state.images.set(url, image); resolve(image); } catch(error) { reject(error); } finally { state.pending.delete(url); finished(); } };
      image.onerror = () => { state.pending.delete(url); reject(new Error('Map could not be loaded')); finished(); };
      image.src = url;
      }));
    });
    state.pending.set(url, request);
    drain();
    return request;
  }

  function preload(indices) {
    const urls = [...new Set(indices.map((index) => state.frames[index]).filter(Boolean).map(frameURL).filter(Boolean))];
    urls.forEach((url) => imageFor(url).catch(() => {}));
  }

  async function renderMap() {
    const revision = ++mapRevision;
    const frame = state.frames[state.index];
    if (!frame) return;
    const unavailable = state.overlay !== 'none' && !requestedMapURL(frame);
    const label = {none:'Pressure · hPa',temperature:'Temperature · °C',rain:'Rain · previous 24h ≥1 mm',wind:'Wind · knots'}[unavailable ? 'none' : state.overlay];
    els.title.textContent = label;
    els.note.textContent = unavailable ? `${{rain:'24h rain',temperature:'Temperature',wind:'Wind'}[state.overlay]} unavailable` : '';
    els.note.hidden = !unavailable;
    els.retry.hidden = true;
    els.state.hidden = false;
    els.state.textContent = 'Loading map…';
    try {
      const image = await imageFor(frameURL(frame));
      if (revision !== mapRevision) return;
      // Reuse the decoded element itself. Reassigning its URL to a different
      // element can issue a second request when the browser cache is disabled.
      if (els.image !== image) { els.image.replaceWith(image); els.image=image; image.id='map-image'; }
      els.image.alt = `${label} forecast map for ${formatTime(frame.time)}`;
      els.image.classList.add('ready');
      els.state.hidden = true;
      preload(state.frames.map((_, index) => index));
      if (!navigator.connection?.saveData) {
        for(const next of state.frames) for(const path of Object.values(next.maps)) imageFor(assetURL(path)).catch(()=>{});
      }
    } catch {
      if (revision !== mapRevision) return;
      els.image.classList.remove('ready');
      els.state.textContent = 'Map unavailable';
      els.retry.hidden = false;
    }
  }

  function hours() { return state.manifest?.points?.hours || []; }
  function nearestPoint(time) {
    let best = null; let distance = Infinity;
    hours().forEach((point) => {
      if (!isTime(point.time)) return;
      const candidate = Math.abs(new Date(point.time) - new Date(time));
      if (candidate < distance) { distance = candidate; best = point; }
    });
    return distance <= 30 * 60 * 1000 ? best : null;
  }

  function drawChart() {
    if (!state.detail) { els.detail.hidden = true; return; }
    els.detail.hidden = false;
    const rect = els.chart.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    const width = Math.max(1, rect.width); const height = Math.max(1, rect.height);
    els.chart.width = width * ratio; els.chart.height = height * ratio;
    const context = els.chart.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    const key = state.detail === 'rain' ? 'rain' : state.detail === 'temperature' ? 'temp' : state.detail === 'wind' ? 'windKt' : 'waveHeight';
    const values = hours().map((point) => isNumber(point[key]) ? point[key] : null);
    const present = values.filter((value) => value !== null);
    if (!present.length) { els.empty.hidden = false; els.reading.textContent = 'No detail in this forecast'; return; }
    els.empty.hidden = true;
    const maxima = state.detail === 'wind' ? [...present, ...hours().map(p => p.gustKt).filter(isNumber)] : present;
    const low = state.detail === 'temperature' ? Math.floor(Math.min(...present) - 1) : 0;
    const high = Math.max(low + 1, Math.ceil(Math.max(...maxima) + (state.detail === 'temperature' ? 1 : 0)));
    const span = high - low;
    const textScale=parseFloat(getComputedStyle(document.documentElement).fontSize)/16;
    const pad = { left: 48*textScale, right: 12, top: 15*textScale, bottom: 28*textScale };
    const timedHours = hours().map((point) => isTime(point.time) ? new Date(point.time).valueOf() : null);
    const firstTime = Math.min(...timedHours.filter((value) => value !== null));
    const lastTime = Math.max(...timedHours.filter((value) => value !== null));
    const xTime = (time) => pad.left + (width - pad.left - pad.right) * ((time - firstTime) / Math.max(1, lastTime - firstTime));
    const x = (index) => xTime(timedHours[index] ?? firstTime);
    const y = (value) => pad.top + (height - pad.top - pad.bottom) * (1 - (value - low) / span);
    const colorName = state.detail === 'temperature' ? 'temp' : state.detail === 'wind' ? 'wind' : state.detail === 'surf' ? 'surf' : 'rain';
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--${colorName}`).trim();
    context.font = `${11*textScale}px system-ui,sans-serif`; context.fillStyle = '#7b878f'; context.strokeStyle = '#dce3e7'; context.lineWidth = 1;
    for (let tick = 0; tick < 3; tick += 1) {
      const yPos = pad.top + (height - pad.top - pad.bottom) * tick / 2;
      const value = high - (high - low) * tick / 2;
      context.beginPath(); context.moveTo(pad.left, yPos + .5); context.lineTo(width - pad.right, yPos + .5); context.stroke();
      const suffix = state.detail === 'temperature' ? '°' : state.detail === 'rain' ? ' mm' : state.detail === 'wind' ? ' kt' : ' m';
      context.fillText(`${state.detail === 'rain' || state.detail === 'surf' ? value.toFixed(1) : Math.round(value)}${suffix}`, 3, yPos + 4);
    }
    context.strokeStyle = color; context.lineWidth = 2.5; context.lineJoin = 'round'; context.beginPath();
    let penDown = false;
    values.forEach((value, index) => { if (value === null || timedHours[index] === null) { penDown = false; return; } if (index && timedHours[index]-timedHours[index-1]>3600000*1.5) penDown=false; if (state.detail === 'rain') { context.fillStyle=color; context.fillRect(x(index)-2,y(value),4,y(0)-y(value)); } else if (penDown) context.lineTo(x(index), y(value)); else context.moveTo(x(index), y(value)); penDown = true; });
    context.stroke();
    if (state.detail === 'wind') {
      const gustValues = hours().map((point) => isNumber(point.gustKt) ? point.gustKt : null);
      context.strokeStyle = color; context.globalAlpha = .35; context.setLineDash([3, 3]); context.beginPath();
      let gustPen = false;
      gustValues.forEach((value, index) => { if (value === null || timedHours[index] === null) { gustPen = false; return; } if (index && timedHours[index]-timedHours[index-1]>3600000*1.5) gustPen=false; if (gustPen) context.lineTo(x(index), y(value)); else context.moveTo(x(index), y(value)); gustPen = true; });
      context.stroke(); context.setLineDash([]); context.globalAlpha = 1;
      context.fillStyle = color;
      hours().forEach((point, index) => {
        if (index % Math.max(1,Math.ceil(hours().length/Math.max(1,(width-70)/32))) || !isNumber(point.windKt) || !isNumber(point.windFrom) || point.windKt <= 0) return;
        const length = 7 + Math.min(8, point.windKt * .35); const angle = (point.windFrom + 90) * Math.PI / 180;
        const cx = x(index); const cy = y(point.windKt);
        context.save(); context.translate(cx, cy); context.rotate(angle); context.beginPath(); context.moveTo(0, 0); context.lineTo(length, 0); context.lineTo(length - 4, -3); context.moveTo(length, 0); context.lineTo(length - 4, 3); context.stroke(); context.restore();
      });
    }
    context.fillStyle = '#7b878f'; context.font = `${11*textScale}px system-ui,sans-serif`;
    [0, Math.floor((hours().length - 1) / 2), hours().length - 1].forEach((index) => { if (index < 0 || timedHours[index] === null) return; const label=formatHour(hours()[index].time); context.fillText(label, Math.min(width-context.measureText(label).width,Math.max(pad.left, x(index)-20)),height-7); });
    const selectedIndex = hours().findIndex((point) => isTime(point.time) && Math.abs(new Date(point.time) - new Date(state.frames[state.index].time)) <= 30 * 60 * 1000);
    if (selectedIndex >= 0) { context.strokeStyle = '#8b979d'; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x(selectedIndex), pad.top); context.lineTo(x(selectedIndex), height - pad.bottom); context.stroke(); context.setLineDash([]); }
    const point = nearestPoint(state.frames[state.index].time); const unit = state.detail === 'temperature' ? '°C' : state.detail === 'rain' ? 'mm · preceding hour' : state.detail === 'wind' ? 'kt' : 'm waves';
    if (!point) { els.reading.textContent = 'No point forecast for this time'; return; }
    const current = isNumber(point[key]) ? point[key] : null; let extra = '';
    if (state.detail === 'wind' && isNumber(point.gustKt)) extra = ` · gust ${Math.round(point.gustKt)} kt`;
    if (state.detail === 'surf' && isNumber(point.swellPeriod)) extra = ` · swell ${point.swellPeriod.toFixed(0)}s`;
    els.reading.textContent = current === null ? 'No reading for this time' : `${current.toFixed(state.detail === 'rain' || state.detail === 'surf' ? 1 : 0)} ${unit}${extra}`;
  }

  function setIndex(index) {
    if (!state.frames.length) return;
    state.index = Math.max(0, Math.min(state.frames.length - 1, index));
    state.forecastTime = Date.parse(state.frames[state.index].time);
    els.time.value = state.index; els.timeLabel.textContent = formatHour(state.frames[state.index].time);
    els.times.innerHTML = state.frames.map((frame, i) => `<span${i === state.index ? ' class="current"' : ''}>${formatHour(frame.time)}</span>`).join('');
    renderMap(); drawChart();
  }

  function setOverlay(overlay) {
    state.overlay = overlay;
    selectAnimation();
    document.querySelectorAll('[name="map-overlay"]').forEach((input) => { input.checked = input.value === overlay; });
    renderMap();
  }

  async function loadManifest() {
    els.state.hidden = false; els.state.textContent = 'Preparing the map…'; els.retry.hidden = true;
    try {
      const response = await fetch('./data/current.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('Forecast unavailable');
      const manifest = await response.json();
      state.frames = (manifest.frames || []).filter((frame) => isTime(frame.time) && frame.maps).sort((a, b) => new Date(a.time) - new Date(b.time));
      if (!state.frames.length) throw new Error('No forecast frames');
      state.manifest = manifest; els.time.max = state.frames.length - 1;
      const issue = manifest.runAt;
      els.updated.textContent = issue ? `ECMWF · ${formatTime(issue, false)} AWST${Date.now()-new Date(issue)>24*3600000?' · older run':''}` : 'ECMWF';
      const sources=$('#sources'); sources.replaceChildren();
      for (const source of manifest.attribution || []) {
        if(!/^https:\/\//.test(source.url)) continue;
        const link=document.createElement('a'); link.href=source.url; link.textContent=source.label; sources.append(link);
      }
      downloadReady.then(authoritative => { if (!authoritative) showDownload(manifest.release); });
      selectAnimation();
      setIndex(0);
      if (!prefersReducedMotion()) resetToNow();
    } catch { els.state.textContent = 'Forecast unavailable'; els.retry.hidden = false; els.updated.textContent = ''; }
  }

  document.querySelectorAll('.detail-tab').forEach((button) => button.addEventListener('click', () => {
    const previous = state.detail;
    state.detail = state.detail === button.dataset.layer ? null : button.dataset.layer;
    document.querySelectorAll('.detail-tab').forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.layer === state.detail)));
    if (state.detail && state.detail !== 'surf') setOverlay(state.detail === 'temperature' ? 'temperature' : state.detail === 'rain' ? 'rain' : 'wind');
    else if (!state.detail && previous === state.overlay) setOverlay('none');
    else if (state.detail === 'surf') setOverlay('none');
    drawChart();
  }));
  document.querySelectorAll('[name="map-overlay"]').forEach((input) => input.addEventListener('change', () => setOverlay(input.value)));
  els.time.addEventListener('input', (event) => { seekAnimation(event.target.value); });
  els.time.addEventListener('keydown', (event) => {
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    const candidate = state.animation;
    if (!direction || !candidate || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const maximum = Math.max(1, state.frames.length - 1);
    const span = candidate.validTo - candidate.validFrom;
    const current = candidate.validFrom + Number(els.time.value) / maximum * span;
    const next = Math.max(candidate.validFrom, Math.min(candidate.validTo, (Math.round(current / 3600000) + direction) * 3600000));
    // Retain fine-grained thumb motion during playback, but step by an hour
    // with the keyboard. Update immediately so repeated keys can accumulate.
    els.time.value = String((next - candidate.validFrom) / span * maximum);
    seekAnimation(els.time.value);
  });
  els.mapFrame.setAttribute('role', 'button'); els.mapFrame.tabIndex = 0;
  els.mapFrame.setAttribute('aria-label', 'Reset forecast to now and play');
  els.mapFrame.addEventListener('click', (event) => { if (event.target.closest('button')) return; resetToNow(); });
  els.mapFrame.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); resetToNow(); } });
  const viewer = document.querySelector('.viewer');
  viewer.append(els.timeline, els.times);
  els.play.addEventListener('click', playAnimation);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.animation?.playing) {
      els.video.pause(); state.animation.playing = false; updatePlayButton();
    }
  });
  els.retry.addEventListener('click', loadManifest);
  els.layersButton.addEventListener('click', (event) => { event.stopPropagation(); const opening = els.layers.hidden; els.layers.hidden = !opening; els.layersButton.setAttribute('aria-expanded', String(opening)); });
  document.addEventListener('click', (event) => { if (!els.layers.hidden && !els.layers.contains(event.target) && !els.layersButton.contains(event.target)) { els.layers.hidden = true; els.layersButton.setAttribute('aria-expanded', 'false'); } });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const wasOpen=!els.layers.hidden; els.layers.hidden = true; els.layersButton.setAttribute('aria-expanded', 'false'); if(wasOpen)els.layersButton.focus(); if (els.download.open) els.download.close(); } });
  window.addEventListener('resize', drawChart);
  els.downloadLink.addEventListener('click', (event) => { event.preventDefault(); els.download.showModal(); });
  els.download.querySelector('.dialog-close').addEventListener('click', () => els.download.close());
  const downloadReady = loadDownload();
  loadManifest();
})();
