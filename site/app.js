(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    image: $('#map-image'), video: $('#map-video'), play: $('#play-toggle'), state: $('#map-state'), retry: $('#retry'), time: $('#time'),
    timeLabel: $('#time-label'), times: $('#times'), title: $('#map-title'), note: $('#map-note'), updated: $('#updated'),
    chart: $('#chart'), empty: $('#chart-empty'), reading: $('#detail-reading'), detail: $('#detail-panel'), mapFrame: $('#map-frame'),
    layers: $('#layers-menu'), layersButton: $('#layers-button'), download: $('#download'),
    downloadLink: $('#download-link'), dialogDownload: $('#dialog-download'), downloadCopy: $('#download-copy'),
    switcher: $('#place-switcher'), temp: $('#current-temp'), days: $('#day-strip'), placeName: $('#place-name'), condition: $('#current-condition')
  };
  const state = { manifest: null, frames: [], index: 0, overlay: 'none', detail: null, images: new Map(), pending: new Map(), animation: null, videoCache: new Map(), playbackMode: 'manual', movieIntent: 0, place: null };
  const MAX_PRELOAD = 4;
  const MANIFEST_TIMEOUT_MS = 8000;
  const PLACE_KEY = 'isobar.place';
  const queue = [];
  let manifestLoad = 0;
  let manifestController = null;

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
  const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  function zone() {
    const name = state.place?.timezone;
    if (typeof name === 'string' && name.includes('/')) {
      try { new Intl.DateTimeFormat(undefined, { timeZone: name }); return name; }
      catch { /* An unknown IANA name falls back to Perth. */ }
    }
    return 'Australia/Perth';
  }
  // Browsers in most locales print Australian zones as "GMT+8"; people read AWST.
  const AUSTRALIAN_ZONES = { 480: 'AWST', 525: 'ACWST', 570: 'ACST', 600: 'AEST', 630: 'ACDT', 660: 'AEDT' };
  function zonePart(date, locale, style) {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: zone(), timeZoneName: style }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || '';
    } catch { return ''; }
  }
  function zoneAbbreviation(date) {
    const short = zonePart(date, 'en-AU', 'short');
    if (/^[A-Z]{3,5}$/.test(short)) return short;
    const offset = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zonePart(date, 'en-US', 'shortOffset') || short);
    const name = zone();
    if (offset && name.startsWith('Australia/')) {
      const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] || 0));
      if (name === 'Australia/Lord_Howe') return minutes === 660 ? 'LHDT' : 'LHST';
      if (AUSTRALIAN_ZONES[minutes]) return AUSTRALIAN_ZONES[minutes];
    }
    return short || 'UTC';
  }
  const formatTime = (value, withDay = true) => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '—';
    return `${new Intl.DateTimeFormat(undefined, {
      weekday: withDay ? 'short' : undefined,
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone()
    }).format(date)} ${zoneAbbreviation(date)}`;
  };
  const hourDate = (value) => {
    const timestamp = new Date(value).valueOf();
    return Number.isNaN(timestamp) ? null : new Date(Math.round(timestamp / 3600000) * 3600000);
  };
  const formatHour = (value) => {
    const date = hourDate(value);
    if (!date) return '—';
    return `${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone() }).format(date)} ${zoneAbbreviation(date)}`;
  };
  const formatTick = (value) => {
    const date = hourDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone() }).format(date) : '—';
  };
  const formatDegree = (value) => isNumber(value) ? `${Math.round(value)}°` : '—';
  // Below 1 mm a day reads as dry; the strip stays quiet rather than printing 0.
  const formatRain = (value) => isNumber(value) && value >= 1 ? `${Math.round(value)} mm` : '';
  function storedPlace() {
    try { return localStorage.getItem(PLACE_KEY); }
    catch { return null; }
  }
  function rememberPlace(id) {
    try { localStorage.setItem(PLACE_KEY, id); }
    catch { /* Private mode and locked storage must not block the forecast. */ }
  }
  function placeList(manifest) {
    const listed = Array.isArray(manifest?.places) ? manifest.places.filter((place) => place && typeof place.id === 'string' && typeof place.name === 'string') : [];
    if (listed.length) return listed;
    const legacy = manifest?.points;
    if (Array.isArray(legacy?.hours)) return [{ id: legacy.id || 'cottesloe', name: legacy.place || 'Perth', timezone: legacy.timezone || 'Australia/Perth', hours: legacy.hours, daily: legacy.daily || [] }];
    return [];
  }
  function hours() { return state.place?.hours || state.manifest?.points?.hours || []; }
  function timelineBounds() {
    const series = hours().filter((point) => isTime(point.time));
    const source = series.length ? series : state.frames;
    const from = source.length ? Date.parse(source[0].time) : Date.now();
    const to = source.length ? Date.parse(source[source.length - 1].time) : from + 3600000;
    return { from, to, max: Math.max(1, source.length - 1), span: Math.max(1, to - from) };
  }
  function nearestFrameIndex(time) {
    let best = 0, distance = Infinity;
    state.frames.forEach((frame, index) => {
      const delta = Math.abs(Date.parse(frame.time) - time);
      if (delta < distance) { distance = delta; best = index; }
    });
    return best;
  }
  function readingNow(place) {
    const series = (place?.hours || []).filter((hour) => isTime(hour.time));
    const now = Date.now();
    let best = null, bestAbs = Infinity;
    series.forEach((hour) => {
      const delta = Date.parse(hour.time) - now;
      if (delta < -90 * 60 * 1000) return;
      const abs = Math.abs(delta);
      if (abs < bestAbs) { bestAbs = abs; best = hour; }
    });
    return best || series.at(-1) || null;
  }
  function svg(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }
  function weatherLabel(code) {
    const n = Number(code);
    if (n === 0) return 'Clear';
    if (n === 1) return 'Mainly clear';
    if (n === 2) return 'Partly cloudy';
    if (n === 3) return 'Overcast';
    if (n === 45 || n === 48) return 'Fog';
    if (n >= 51 && n <= 57) return 'Drizzle';
    if (n >= 61 && n <= 67) return 'Rain';
    if (n >= 71 && n <= 77) return 'Snow';
    if (n >= 80 && n <= 82) return 'Showers';
    if (n >= 95) return 'Thunderstorm';
    return 'Forecast';
  }
  function weatherIcon(code) {
    const icon = svg('svg', { viewBox: '0 0 24 24', class: 'wx', 'aria-hidden': 'true' });
    const n = Number(code);
    const sun = (cx = 9, cy = 9) => icon.append(svg('circle', { cx, cy, r: '3.2', fill: 'currentColor' }));
    const cloud = () => icon.append(svg('path', { fill: 'currentColor', d: 'M8 18h9.2a3.3 3.3 0 0 0 .3-6.6 4.4 4.4 0 0 0-8.4-1.1A3 3 0 0 0 8 18z' }));
    const drops = (heavy) => {
      [[11, 16], [15, 18], [13, 21]].forEach(([x, y], index) => {
        if (!heavy && index === 2) return;
        icon.append(svg('circle', { cx: x, cy: y, r: heavy ? 1.15 : .9, fill: 'currentColor' }));
      });
    };
    if (n === 0 || n === 1) {
      icon.append(svg('circle', { cx: 12, cy: 12, r: '4', fill: 'currentColor' }));
      for (let ray = 0; ray < 8; ray += 1) {
        const a = ray * Math.PI / 4, x = Math.cos(a), y = Math.sin(a);
        icon.append(svg('path', { d: `M${(12 + x * 6.4).toFixed(2)} ${(12 + y * 6.4).toFixed(2)}L${(12 + x * 8.6).toFixed(2)} ${(12 + y * 8.6).toFixed(2)}`, stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
      }
    }
    else if (n === 2) { sun(8, 8); cloud(); }
    else if (n === 45 || n === 48) [9, 12, 15].forEach((y) => icon.append(svg('path', { d: `M5 ${y}h14`, stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' })));
    else if (n >= 95) { cloud(); icon.append(svg('path', { fill: 'currentColor', d: 'M13 14h-2l1 3h-2l3 5-1-4h2z' })); }
    else if (n >= 71 && n <= 77) { cloud(); icon.append(svg('path', { stroke: 'currentColor', 'stroke-width': '1.4', d: 'M12 16v5M10 18.5h4' })); }
    else if ((n >= 51 && n <= 67) || (n >= 80 && n <= 82)) { cloud(); drops(n >= 61); }
    else cloud();
    return icon;
  }
  function civilWeekday(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!match) return '—';
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: zone() }).format(new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12)));
  }
  function renderStrip(place) {
    const days = Array.isArray(place?.daily) ? place.daily : [];
    const temps = days.flatMap((day) => [day.tempMin, day.tempMax].filter(isNumber));
    const low = temps.length ? Math.min(...temps) : 0;
    const high = temps.length ? Math.max(...temps) : 1;
    const span = Math.max(.1, high - low);
    // The Mac day strip's ramp: blue-green at the week's low, warm at its high.
    const tint = (value) => {
      const u = high > low ? Math.max(0, Math.min(1, (value - low) / (high - low))) : .5;
      return `rgb(${Math.round(255 * (.42 + .52 * u))} ${Math.round(255 * (.68 - .16 * u))} ${Math.round(255 * (.78 - .48 * u))})`;
    };
    els.days.replaceChildren();
    days.forEach((day) => {
      const item = document.createElement('li');
      item.className = 'day';
      const name = document.createElement('span');
      name.className = 'day-name';
      name.textContent = civilWeekday(day.time);
      const max = document.createElement('span');
      max.className = 'day-max';
      max.textContent = formatDegree(day.tempMax);
      const min = document.createElement('span');
      min.className = 'day-min';
      min.textContent = formatDegree(day.tempMin);
      const range = document.createElement('span');
      range.className = 'day-range';
      const bar = document.createElement('span');
      bar.className = 'day-range-bar';
      if (isNumber(day.tempMin) && isNumber(day.tempMax)) {
        const start = (day.tempMin - low) / span;
        const end = (day.tempMax - low) / span;
        bar.style.left = `${start * 100}%`;
        bar.style.width = `${Math.max(0, end - start) * 100}%`;
        bar.style.setProperty('--from', tint(day.tempMin));
        bar.style.setProperty('--to', tint(day.tempMax));
        range.append(bar);
      }
      const rain = document.createElement('span');
      rain.className = 'day-rain';
      rain.textContent = formatRain(day.rain);
      item.setAttribute('aria-label', `${name.textContent}, ${weatherLabel(day.weatherCode)}, high ${max.textContent}, low ${min.textContent}${rain.textContent ? `, rain ${rain.textContent}` : ''}`);
      item.append(name, weatherIcon(day.weatherCode), min, range, max, rain);
      els.days.append(item);
    });
  }
  function runStatus() {
    const issue = state.manifest?.runAt;
    if (!issue || !isTime(issue)) return 'ECMWF';
    const aged = Date.now() - Date.parse(issue) > 24 * 3600000 ? ' · older run' : '';
    return `ECMWF run ${formatTime(issue, false)}${aged}`;
  }
  function renderPlace() {
    const place = state.place;
    let secondary = false;
    document.querySelectorAll('[data-place]').forEach((button) => {
      const selected = button.dataset.place === place?.id;
      if (button.classList.contains('place-option')) { button.setAttribute('aria-checked', String(selected)); secondary ||= selected; }
      else button.setAttribute('aria-pressed', String(selected));
    });
    const more = $('#more-places');
    if (more) {
      more.textContent = secondary ? place.name : 'More places';
      more.classList.toggle('active', secondary);
      more.setAttribute('aria-label', secondary ? `More places, ${place.name} selected` : 'More places');
    }
    const hour = readingNow(place);
    const today = Array.isArray(place?.daily) ? place.daily[0] : null;
    els.placeName.textContent = place?.name || '—';
    els.temp.textContent = formatDegree(hour?.temp);
    els.condition.textContent = [
      isNumber(hour?.weatherCode) ? weatherLabel(hour.weatherCode) : null,
      isNumber(today?.tempMax) ? `H ${formatDegree(today.tempMax)}` : null,
      isNumber(today?.tempMin) ? `L ${formatDegree(today.tempMin)}` : null
    ].filter(Boolean).join(' · ');
    renderStrip(place);
  }
  // Perth and Sydney lead; the other configured points are kite and surf spots.
  function primaryPlaces(places) {
    const named = places.filter((place) => place.name === 'Perth' || place.name === 'Sydney');
    return named.length ? named : places.slice(0, 2);
  }
  // A modal dialog sits in the top layer, so a scrolling summary cannot clip it.
  function openPlaceMenu(menu, more) {
    menu.showModal();
    more.setAttribute('aria-expanded', 'true');
    const anchor = more.getBoundingClientRect();
    menu.style.top = `${Math.round(Math.min(anchor.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, anchor.right - menu.offsetWidth)))}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  }
  function renderSwitcher() {
    els.switcher.replaceChildren();
    const places = placeList(state.manifest);
    const primary = primaryPlaces(places);
    primary.forEach((place) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'place';
      button.dataset.place = place.id;
      button.textContent = place.name;
      button.setAttribute('aria-pressed', String(place.id === state.place?.id));
      button.addEventListener('click', () => selectPlace(place.id, true));
      els.switcher.append(button);
    });
    const others = places.filter((place) => !primary.includes(place));
    if (!others.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'more-places';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'place more-button';
    more.id = 'more-places';
    more.textContent = 'More places';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', 'place-menu');
    const menu = document.createElement('dialog');
    menu.className = 'place-menu';
    menu.id = 'place-menu';
    const list = document.createElement('div');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', 'More places');
    others.forEach((place) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'place-option';
      item.dataset.place = place.id;
      item.textContent = place.name;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(place.id === state.place?.id));
      item.addEventListener('click', () => { menu.close(); selectPlace(place.id, true); });
      list.append(item);
    });
    menu.append(list);
    more.addEventListener('click', () => openPlaceMenu(menu, more));
    menu.addEventListener('click', (event) => { if (event.target === menu) menu.close(); });
    menu.addEventListener('close', () => { more.setAttribute('aria-expanded', 'false'); more.focus(); });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('button')];
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) { event.preventDefault(); items[(items.indexOf(document.activeElement) + step + items.length) % items.length].focus(); }
    });
    wrap.append(more, menu);
    els.switcher.append(wrap);
  }
  function selectPlace(id, persist) {
    const next = placeList(state.manifest).find((place) => place.id === id);
    if (!next || next === state.place) return;
    state.place = next;
    if (persist) rememberPlace(id);
    renderPlace();
    const when = Number.isFinite(state.forecastTime) ? state.forecastTime : Date.parse(readingNow(next)?.time);
    if (state.animation) syncTimeline(when);
    else setForecastTime(when);
    els.updated.textContent = runStatus();
  }
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
  // The encoded movie is already the 20–30 s forecast playback.
  const ambientRate = () => 1;
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
    entry = { video, sourceUrl: animation.url, ready: false, promise: null };
    video.dataset.source = animation.url;
    const sync = () => {
      const current = state.animation;
      // A paused scrub keeps the selected hour. Playback is what moves the cursor.
      if (els.video !== video || !current?.ready || !current.playing) return;
      syncTimeline(movieDate(current, video.currentTime));
    };
    video.addEventListener('loadedmetadata', () => { if (els.video === video) fitMap(video.videoWidth, video.videoHeight); });
    video.addEventListener('timeupdate', sync);
    video.addEventListener('seeked', sync);
    video.addEventListener('ended', () => {
      // Seeking a paused movie to its last frame also fires ended; only a playing forecast loops to now.
      if (els.video !== video || !state.animation?.playing) return;
      if (Date.now() < state.animation.validTo) { resetToNow(); return; }
      state.animation.playing = false; updatePlayButton();
    });
    video.addEventListener('error', () => {
      if (!video.getAttribute('src')) return;
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
      old.video.pause(); old.video.removeAttribute('src'); old.video.load(); old.video.remove();
      state.videoCache.delete(key);
    }
    return entry;
  }
  // Swapping the map movie pauses the element that is leaving. Forecast lenses
  // must not call this; they draw over the pressure movie.
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
  // The panel is sized from the map's own aspect so the map fills it edge to edge.
  function fitMap(width, height) {
    if (!(width >= 64 && height >= 64) || width / height < .5 || width / height > 3) return;
    document.documentElement.style.setProperty('--map-aspect', (width / height).toFixed(4));
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
  function renderTicks(date) {
    const bounds = timelineBounds();
    els.times.replaceChildren();
    const count = 5;
    for (let tick = 0; tick < count; tick += 1) {
      const stamp = bounds.from + bounds.span * tick / (count - 1);
      const label = document.createElement('span');
      label.textContent = formatTick(stamp);
      if (Math.abs(stamp - date) <= bounds.span / (count - 1) / 2) label.className = 'current';
      els.times.append(label);
    }
  }
  function syncTimeline(date) {
    const target = new Date(date).valueOf();
    if (!Number.isFinite(target) || !state.frames.length) return;
    state.forecastTime = target;
    state.index = nearestFrameIndex(target);
    const bounds = timelineBounds();
    els.time.max = String(bounds.max);
    els.time.value = String(Math.max(0, Math.min(1, (target - bounds.from) / bounds.span)) * bounds.max);
    els.timeLabel.textContent = formatHour(date);
    renderTicks(target);
    drawChart();
  }
  function whenCanPlay(video) {
    if (video.readyState >= 3) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); video.removeEventListener('canplay', ready); video.removeEventListener('error', failed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Animation could not be decoded')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Animation preparation timed out')); }, 30000);
      video.addEventListener('canplay', ready);
      video.addEventListener('error', failed);
      if (video.readyState >= 3) ready();
    });
  }
  async function ensureAnimation(candidate) {
    const entry = videoEntry(candidate), video = entry.video;
    if (!entry.ready) {
      if (!entry.promise) entry.promise = (async () => {
        // The generation path is the HTTP cache key. The element streams it.
        video.preload = 'metadata';
        if (video.getAttribute('src') !== entry.sourceUrl) video.src = entry.sourceUrl;
        try {
          await whenCanPlay(video);
          entry.ready = true;
        } catch (error) {
          entry.ready = false;
          video.removeAttribute('src'); video.load();
          throw error;
        }
      })().finally(() => { entry.promise = null; });
      await entry.promise;
    }
    candidate.ready = true; candidate.duration = video.duration;
    return video;
  }
  function targetMovieTime(candidate) {
    const target = state.forecastTime ?? Date.parse(state.frames[state.index].time);
    return Math.max(0, Math.min(movieSpan(candidate), (target - candidate.validFrom) / (candidate.validTo - candidate.validFrom) * movieSpan(candidate)));
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
  function snappedTimelineDate(value) {
    const bounds = timelineBounds();
    const fraction = Math.max(0, Math.min(1, Number(value) / bounds.max));
    const raw = bounds.from + fraction * bounds.span;
    return Math.max(bounds.from, Math.min(bounds.to, Math.round(raw / 3600000) * 3600000));
  }
  async function seekAnimation(value) {
    const snappedDate = snappedTimelineDate(value);
    const candidate = state.animation;
    if (!candidate) { setForecastTime(snappedDate); return; }
    state.playbackMode = 'manual';
    const intent = state.movieIntent = (state.movieIntent || 0) + 1;
    candidate.playPending = false;
    els.video.pause(); candidate.playing = false; updatePlayButton();
    try {
      const video = await ensureAnimation(candidate);
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      video.playbackRate = ambientRate(candidate);
      video.currentTime = movieTimeForDate(candidate, snappedDate);
      syncTimeline(snappedDate);
      setStaticMapVisible(false); els.state.hidden = true;
    } catch {
      if (state.animation !== candidate || intent !== state.movieIntent) return;
      setForecastTime(snappedDate); els.note.textContent = 'Animation unavailable · try Play again'; els.note.hidden = false;
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
      image.onload = async () => { try { await image.decode(); state.images.set(url, image); resolve(image); } catch (error) { reject(error); } finally { state.pending.delete(url); finished(); } };
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
    const label = { none: 'Pressure · hPa', temperature: 'Temperature · °C', rain: 'Rain · previous 24h ≥1 mm', wind: 'Wind · knots' }[unavailable ? 'none' : state.overlay];
    els.title.textContent = label;
    els.note.textContent = unavailable ? `${{ rain: '24h rain', temperature: 'Temperature', wind: 'Wind' }[state.overlay]} unavailable` : '';
    els.note.hidden = !unavailable;
    els.retry.hidden = true;
    els.state.hidden = false;
    els.state.textContent = 'Loading map…';
    try {
      const image = await imageFor(frameURL(frame));
      if (revision !== mapRevision) return;
      if (els.image !== image) { image.hidden = els.image.hidden; els.image.replaceWith(image); els.image = image; image.id = 'map-image'; }
      els.image.alt = `${label} forecast map for ${formatTime(frame.time)}`;
      els.image.classList.add('ready');
      fitMap(image.naturalWidth, image.naturalHeight);
      els.state.hidden = true;
      preload(state.frames.map((_, index) => index));
      if (!navigator.connection?.saveData) {
        for (const next of state.frames) for (const path of Object.values(next.maps)) imageFor(assetURL(path)).catch(() => {});
      }
    } catch {
      if (revision !== mapRevision) return;
      els.image.classList.remove('ready');
      els.state.textContent = 'Map unavailable';
      els.retry.hidden = false;
    }
  }

  function nearestPoint(time) {
    let best = null, distance = Infinity;
    hours().forEach((point) => {
      if (!isTime(point.time)) return;
      const candidate = Math.abs(Date.parse(point.time) - new Date(time));
      if (candidate < distance) { distance = candidate; best = point; }
    });
    return distance <= 45 * 60 * 1000 ? best : null;
  }
  function cssColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
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
    const maxima = state.detail === 'wind' ? [...present, ...hours().map((point) => point.gustKt).filter(isNumber)] : present;
    const low = state.detail === 'temperature' ? Math.floor(Math.min(...present) - 1) : 0;
    const high = Math.max(low + 1, Math.ceil(Math.max(...maxima) + (state.detail === 'temperature' ? 1 : 0)));
    const span = high - low;
    const textScale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
    const pad = { left: 48 * textScale, right: 12, top: 15 * textScale, bottom: 28 * textScale };
    const timedHours = hours().map((point) => isTime(point.time) ? Date.parse(point.time) : null);
    const firstTime = Math.min(...timedHours.filter((value) => value !== null));
    const lastTime = Math.max(...timedHours.filter((value) => value !== null));
    const xTime = (time) => pad.left + (width - pad.left - pad.right) * ((time - firstTime) / Math.max(1, lastTime - firstTime));
    const x = (index) => xTime(timedHours[index] ?? firstTime);
    const y = (value) => pad.top + (height - pad.top - pad.bottom) * (1 - (value - low) / span);
    const colorName = state.detail === 'temperature' ? 'temp' : state.detail === 'wind' ? 'wind' : state.detail === 'surf' ? 'surf' : 'rain';
    const color = cssColor(`--${colorName}`, '#238fae');
    const labelInk = cssColor('--muted', '#3d4a50');
    const grid = cssColor('--line', '#d5ddd8');
    context.font = `${11 * textScale}px ui-sans-serif, system-ui, sans-serif`; context.fillStyle = labelInk; context.strokeStyle = grid; context.lineWidth = 1;
    for (let tick = 0; tick < 3; tick += 1) {
      const yPos = pad.top + (height - pad.top - pad.bottom) * tick / 2;
      const value = high - (high - low) * tick / 2;
      context.beginPath(); context.moveTo(pad.left, yPos + .5); context.lineTo(width - pad.right, yPos + .5); context.stroke();
      const suffix = state.detail === 'temperature' ? '°' : state.detail === 'rain' ? ' mm' : state.detail === 'wind' ? ' kt' : ' m';
      context.fillText(`${state.detail === 'rain' || state.detail === 'surf' ? value.toFixed(1) : Math.round(value)}${suffix}`, 3, yPos + 4);
    }
    context.strokeStyle = color; context.lineWidth = 2.5; context.lineJoin = 'round'; context.beginPath();
    let penDown = false;
    values.forEach((value, index) => { if (value === null || timedHours[index] === null) { penDown = false; return; } if (index && timedHours[index] - timedHours[index - 1] > 3600000 * 1.5) penDown = false; if (state.detail === 'rain') { context.fillStyle = color; context.fillRect(x(index) - 2, y(value), 4, y(0) - y(value)); } else if (penDown) context.lineTo(x(index), y(value)); else context.moveTo(x(index), y(value)); penDown = true; });
    context.stroke();
    if (state.detail === 'wind') {
      const gustValues = hours().map((point) => isNumber(point.gustKt) ? point.gustKt : null);
      context.strokeStyle = color; context.globalAlpha = .35; context.setLineDash([3, 3]); context.beginPath();
      let gustPen = false;
      gustValues.forEach((value, index) => { if (value === null || timedHours[index] === null) { gustPen = false; return; } if (index && timedHours[index] - timedHours[index - 1] > 3600000 * 1.5) gustPen = false; if (gustPen) context.lineTo(x(index), y(value)); else context.moveTo(x(index), y(value)); gustPen = true; });
      context.stroke(); context.setLineDash([]); context.globalAlpha = 1;
      context.fillStyle = color;
      hours().forEach((point, index) => {
        if (index % Math.max(1, Math.ceil(hours().length / Math.max(1, (width - 70) / 32))) || !isNumber(point.windKt) || !isNumber(point.windFrom) || point.windKt <= 0) return;
        const length = 7 + Math.min(8, point.windKt * .35); const angle = (point.windFrom + 90) * Math.PI / 180;
        context.save(); context.translate(x(index), y(point.windKt)); context.rotate(angle); context.beginPath(); context.moveTo(0, 0); context.lineTo(length, 0); context.lineTo(length - 4, -3); context.moveTo(length, 0); context.lineTo(length - 4, 3); context.stroke(); context.restore();
      });
    }
    context.fillStyle = labelInk; context.font = `${11 * textScale}px ui-sans-serif, system-ui, sans-serif`;
    [0, Math.floor((hours().length - 1) / 2), hours().length - 1].forEach((index) => { if (index < 0 || timedHours[index] === null) return; const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', timeZone: zone() }).format(new Date(timedHours[index])); context.fillText(label, Math.min(width - context.measureText(label).width, Math.max(pad.left, x(index) - 20)), height - 7); });
    const selected = nearestPoint(state.forecastTime ?? state.frames[state.index].time);
    const selectedIndex = hours().indexOf(selected);
    if (selectedIndex >= 0) { context.strokeStyle = labelInk; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x(selectedIndex), pad.top); context.lineTo(x(selectedIndex), height - pad.bottom); context.stroke(); context.setLineDash([]); }
    const point = selected; const unit = state.detail === 'temperature' ? '°C' : state.detail === 'rain' ? 'mm · preceding hour' : state.detail === 'wind' ? 'kt' : 'm waves';
    if (!point) { els.reading.textContent = 'No point forecast for this time'; return; }
    const current = isNumber(point[key]) ? point[key] : null; let extra = '';
    if (state.detail === 'wind' && isNumber(point.gustKt)) extra = ` · gust ${Math.round(point.gustKt)} kt`;
    if (state.detail === 'surf' && isNumber(point.swellPeriod)) extra = ` · swell ${point.swellPeriod.toFixed(0)}s`;
    els.reading.textContent = current === null ? 'No reading for this time' : `${current.toFixed(state.detail === 'rain' || state.detail === 'surf' ? 1 : 0)} ${unit}${extra}`;
  }

  function setForecastTime(time) {
    const bounds = timelineBounds();
    const snapped = Math.max(bounds.from, Math.min(bounds.to, Math.round(new Date(time).valueOf() / 3600000) * 3600000));
    state.forecastTime = snapped;
    state.index = nearestFrameIndex(snapped);
    els.time.max = String(bounds.max);
    els.time.value = String(Math.max(0, Math.min(1, (snapped - bounds.from) / bounds.span)) * bounds.max);
    els.timeLabel.textContent = formatHour(snapped);
    renderTicks(snapped);
    if (els.video.hidden) renderMap();
    drawChart();
  }

  // A map layer swaps the movie; a playing forecast keeps playing from the same instant.
  function setOverlay(overlay) {
    const leaving = state.animation;
    const resume = Boolean(leaving && (leaving.playing || leaving.playPending));
    const mode = state.playbackMode;
    const at = resume && leaving.ready ? movieDate(leaving, els.video.currentTime) : null;
    state.overlay = overlay;
    selectAnimation();
    document.querySelectorAll('[name="map-overlay"]').forEach((input) => { input.checked = input.value === overlay; });
    renderMap();
    if (resume && state.animation) startAnimation(mode, at);
  }

  function manifestSignal(controller) {
    const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([controller.signal, timeout]);
    timeout.addEventListener('abort', () => controller.abort(), { once: true });
    return controller.signal;
  }
  async function loadManifest() {
    manifestController?.abort();
    const generation = ++manifestLoad;
    const controller = new AbortController();
    manifestController = controller;
    els.state.hidden = false; els.state.textContent = 'Preparing the map…'; els.retry.hidden = true;
    try {
      const response = await fetch('./data/current.json', { cache: 'no-cache', signal: manifestSignal(controller) });
      if (generation !== manifestLoad) return;
      if (!response.ok) throw new Error('Forecast unavailable');
      const manifest = await response.json();
      if (generation !== manifestLoad) return;
      state.frames = (manifest.frames || []).filter((frame) => isTime(frame.time) && frame.maps).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      if (!state.frames.length) throw new Error('No forecast frames');
      state.manifest = manifest;
      const places = placeList(manifest);
      const stored = storedPlace();
      state.place = places.find((place) => place.id === stored) || places.find((place) => place.name === 'Perth') || places[0] || null;
      renderSwitcher();
      renderPlace();
      els.updated.textContent = runStatus();
      const sources = $('#sources'); sources.replaceChildren();
      for (const source of manifest.attribution || []) {
        if (!/^https:\/\//.test(source.url)) continue;
        const link = document.createElement('a'); link.href = source.url; link.textContent = source.label; sources.append(link);
      }
      downloadReady.then((authoritative) => { if (!authoritative && generation === manifestLoad) showDownload(manifest.release); });
      selectAnimation();
      const hour = readingNow(state.place);
      setForecastTime(hour ? Date.parse(hour.time) : Date.parse(state.frames[0].time));
      if (!prefersReducedMotion()) resetToNow();
    } catch {
      if (generation !== manifestLoad) return;
      els.state.textContent = 'Forecast unavailable';
      els.retry.hidden = false;
      els.updated.textContent = 'Forecast unavailable';
    }
  }

  document.querySelectorAll('.detail-tab').forEach((button) => button.addEventListener('click', () => {
    state.detail = state.detail === button.dataset.layer ? null : button.dataset.layer;
    document.querySelectorAll('.detail-tab').forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.layer === state.detail)));
    drawChart();
  }));
  document.querySelectorAll('[name="map-overlay"]').forEach((input) => input.addEventListener('change', () => setOverlay(input.value)));
  els.time.addEventListener('input', (event) => { seekAnimation(event.target.value); });
  els.time.addEventListener('keydown', (event) => {
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    const candidate = state.animation;
    if (!direction || !candidate || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const bounds = timelineBounds();
    const current = bounds.from + Number(els.time.value) / bounds.max * bounds.span;
    const next = Math.max(bounds.from, Math.min(bounds.to, (Math.round(current / 3600000) + direction) * 3600000));
    els.time.value = String((next - bounds.from) / bounds.span * bounds.max);
    seekAnimation(els.time.value);
  });
  els.mapFrame.setAttribute('role', 'button'); els.mapFrame.tabIndex = 0;
  els.mapFrame.setAttribute('aria-label', 'Reset forecast to now and play');
  els.mapFrame.addEventListener('click', (event) => { if (event.target.closest('button')) return; resetToNow(); });
  els.mapFrame.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); resetToNow(); } });
  els.play.addEventListener('click', playAnimation);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.animation?.playing) {
      els.video.pause(); state.animation.playing = false; updatePlayButton();
    }
  });
  els.retry.addEventListener('click', loadManifest);
  els.layersButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (els.layers.open) { els.layers.close(); return; }
    els.layers.showModal();
    els.layersButton.setAttribute('aria-expanded', 'true');
    (els.layers.querySelector('input:checked') || els.layers.querySelector('input'))?.focus();
  });
  els.layers.addEventListener('click', (event) => { if (event.target === els.layers) els.layers.close(); });
  els.layers.addEventListener('close', () => {
    els.layersButton.setAttribute('aria-expanded', 'false');
    els.layersButton.focus();
  });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && els.download.open) els.download.close(); });
  window.addEventListener('resize', drawChart);
  els.downloadLink.addEventListener('click', (event) => { event.preventDefault(); els.download.showModal(); });
  els.download.querySelector('.dialog-close').addEventListener('click', () => els.download.close());
  const downloadReady = loadDownload();
  loadManifest();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
