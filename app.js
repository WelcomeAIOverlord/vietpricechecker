/* Viet Price Checker — camera → Vietnamese price → New Taiwan dollars.
 *
 * Everything (OCR included) runs on the device. The only network call is the
 * exchange rate, and the app is fully usable without it.
 */
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const RATE_KEY = 'vpc.rate';
  const OPTS_KEY = 'vpc.opts';
  const ENGINE_CACHE = 'vpc-engine-v1';

  const CORE_SIMD = 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js';
  const CORE_PLAIN = 'vendor/tesseract/tesseract-core-lstm.wasm.js';
  const WORKER_JS = 'vendor/tesseract/worker.min.js';
  const TRAINEDDATA = 'vendor/tessdata/eng.traineddata.gz';
  const LANG_PATH = 'vendor/tessdata';

  // Only these characters survive when "numbers-only OCR" is switched on.
  const DIGIT_WHITELIST = '0123456789.,\'đĐ₫kKtTrRnNgGhHiIuUeEaAoOvVdDcC ';

  const $ = (id) => document.getElementById(id);
  const el = {
    cam: $('cam'), guide: $('guide'), guideHint: $('guideHint'),
    camGate: $('camGate'), camGateMsg: $('camGateMsg'), camStart: $('camStart'),
    shutter: $('shutter'), liveBtn: $('liveBtn'), pickPhoto: $('pickPhoto'),
    pickPhotoAlt: $('pickPhotoAlt'), fileInput: $('fileInput'), shotFlash: $('shotFlash'),
    status: $('status'), hero: $('hero'), heroTwd: $('heroTwd'), heroVnd: $('heroVnd'),
    heroFlags: $('heroFlags'), more: $('more'), raw: $('raw'), rawWrap: $('rawWrap'),
    manualForm: $('manualForm'), manualInput: $('manualInput'),
    rateChip: $('rateChip'), rateValue: $('rateValue'), rateAge: $('rateAge'),
    netChip: $('netChip'), settingsBtn: $('settingsBtn'), settingsPanel: $('settingsPanel'),
    settingsClose: $('settingsClose'), rateDetail: $('rateDetail'), rateInput: $('rateInput'),
    rateRefresh: $('rateRefresh'), rateAuto: $('rateAuto'),
    optThousands: $('optThousands'), optDigits: $('optDigits'), optRaw: $('optRaw'),
    packStatus: $('packStatus'), packBtn: $('packBtn'), version: $('version'),
    toast: $('toast'),
  };

  const state = {
    stream: null,
    worker: null,
    workerReady: null,
    busy: false,
    live: false,
    liveTimer: null,
    rate: null,          // { vndPerTwd, source, fetchedAt, manual }
    fallbackRate: null,
    opts: { thousands: true, digits: false, raw: false },
    packReady: false,
    coreUrl: CORE_SIMD,
  };

  /* ------------------------------------------------------------------ *
   * small helpers
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms || 2600);
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg;
    el.status.classList.toggle('err', !!isError);
  }

  function abs(path) {
    return new URL(path, location.href).href;
  }

  function ago(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------------ *
   * exchange rate
   * ------------------------------------------------------------------ */

  const RATE_SOURCES = [
    {
      name: 'exchangerate-api',
      url: 'https://open.er-api.com/v6/latest/VND',
      read: (j) => (j && j.rates && j.rates.TWD ? 1 / j.rates.TWD : null),
    },
    {
      name: 'currency-api',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/vnd.min.json',
      read: (j) => (j && j.vnd && j.vnd.twd ? 1 / j.vnd.twd : null),
    },
  ];

  async function fetchRate() {
    for (const src of RATE_SOURCES) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(src.url, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (!res.ok) continue;
        const vndPerTwd = src.read(await res.json());
        if (vndPerTwd && vndPerTwd > 100 && vndPerTwd < 100000) {
          return { vndPerTwd, source: src.name, fetchedAt: Date.now(), manual: false };
        }
      } catch (e) { /* try the next source */ }
    }
    return null;
  }

  async function loadFallbackRate() {
    try {
      const res = await fetch('rate.json', { cache: 'no-cache' });
      const j = await res.json();
      if (j && j.vndPerTwd) {
        state.fallbackRate = {
          vndPerTwd: j.vndPerTwd,
          source: 'bundled ' + (j.asOf || '').slice(0, 10),
          fetchedAt: Date.parse(j.asOf) || Date.now(),
          manual: false,
          bundled: true,
        };
      }
    } catch (e) { /* offline first run without the file cached */ }
  }

  function applyRate(rate, persist) {
    if (!rate) return;
    state.rate = rate;
    if (persist) saveJson(RATE_KEY, rate);
    renderRate();
    rerenderLast();
  }

  function renderRate() {
    const r = state.rate;
    if (!r) {
      el.rateValue.textContent = 'no rate';
      el.rateAge.textContent = '';
      el.rateDetail.textContent = 'unavailable';
      return;
    }
    el.rateValue.textContent = 'NT$1 = ' + Math.round(r.vndPerTwd).toLocaleString('en-US') + ' ₫';
    el.rateAge.textContent = r.manual ? 'manual' : ago(r.fetchedAt);
    el.rateDetail.textContent = (r.manual ? 'set by you' : r.source) + ' · ' + ago(r.fetchedAt);
    if (document.activeElement !== el.rateInput) {
      el.rateInput.value = Math.round(r.vndPerTwd * 10) / 10;
    }
  }

  async function refreshRate(loud) {
    if (!navigator.onLine) {
      if (loud) toast('No connection — keeping the saved rate');
      return;
    }
    if (loud) toast('Fetching rate…', 1500);
    const r = await fetchRate();
    if (r) {
      const wasManual = state.rate && state.rate.manual;
      if (wasManual && !loud) return; // don't stomp a manual override in the background
      applyRate(r, true);
      if (loud) toast('Rate updated');
    } else if (loud) {
      toast('Could not reach the rate service');
    }
  }

  /* ------------------------------------------------------------------ *
   * offline pack (the ~6 MB OCR engine)
   * ------------------------------------------------------------------ */

  function wasmSimdSupported() {
    try {
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11,
      ]));
    } catch (e) {
      return false;
    }
  }

  function enginePaths() {
    return [state.coreUrl, WORKER_JS, TRAINEDDATA];
  }

  async function packPresent() {
    if (!('caches' in window)) return false;
    try {
      const cache = await caches.open(ENGINE_CACHE);
      for (const p of enginePaths()) {
        if (!(await cache.match(abs(p)))) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function downloadPack(loud) {
    if (!('caches' in window)) {
      state.packReady = true;
      el.packStatus.textContent = 'not supported on this browser';
      return false;
    }
    el.packBtn.disabled = true;
    const cache = await caches.open(ENGINE_CACHE);
    const paths = enginePaths();
    let done = 0;

    for (const p of paths) {
      const url = abs(p);
      if (await cache.match(url)) { done++; continue; }
      el.packStatus.textContent = 'downloading ' + (done + 1) + '/' + paths.length + '…';
      if (loud) setStatus('Saving the offline scanner… ' + (done + 1) + '/' + paths.length);
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(url, res.clone());
        done++;
      } catch (e) {
        el.packBtn.disabled = false;
        el.packStatus.textContent = 'incomplete — tap to retry';
        if (loud) setStatus('Could not finish the offline download. Reconnect and retry.', true);
        return false;
      }
    }

    state.packReady = true;
    el.packBtn.disabled = false;
    el.packBtn.textContent = 'Re-download';
    el.packStatus.textContent = 'ready · works offline';
    return true;
  }

  async function ensurePack(loud) {
    if (state.packReady) return true;
    if (await packPresent()) {
      state.packReady = true;
      el.packStatus.textContent = 'ready · works offline';
      el.packBtn.textContent = 'Re-download';
      return true;
    }
    if (!navigator.onLine) {
      el.packStatus.textContent = 'missing — connect once to download';
      if (loud) setStatus('Scanner not saved yet. Connect to the internet once, then it works offline forever.', true);
      return false;
    }
    return downloadPack(loud);
  }

  /* ------------------------------------------------------------------ *
   * OCR engine
   * ------------------------------------------------------------------ */

  function initWorker() {
    if (state.workerReady) return state.workerReady;
    state.workerReady = (async () => {
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: abs(WORKER_JS),
        corePath: abs(state.coreUrl),
        langPath: abs(LANG_PATH),
        gzip: true,
        cacheMethod: 'write',
        logger: (m) => {
          if (m.status && m.status !== 'recognizing text') {
            setStatus(m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…');
          }
        },
      });
      state.worker = worker;
      await applyOcrParams(worker);
      return worker;
    })().catch((err) => {
      state.workerReady = null;
      throw err;
    });
    return state.workerReady;
  }

  async function applyOcrParams(worker) {
    const params = {
      tessedit_pageseg_mode: state.opts.digits ? '11' : '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    };
    params.tessedit_char_whitelist = state.opts.digits ? DIGIT_WHITELIST : '';
    await worker.setParameters(params);
  }

  /* ------------------------------------------------------------------ *
   * camera
   * ------------------------------------------------------------------ */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showGate('This browser cannot open the camera. You can still scan a saved photo.');
      return false;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      el.cam.srcObject = state.stream;
      await el.cam.play().catch(() => {});
      el.camGate.classList.remove('show');
      setStatus('Point at a price and tap the button.');
      return true;
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showGate(denied
        ? 'Camera access was blocked. Allow it in Settings → Safari → Camera, or scan a saved photo.'
        : 'Could not start the camera (' + (err && err.name) + '). You can still scan a saved photo.');
      return false;
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  function showGate(msg) {
    el.camGateMsg.textContent = msg;
    el.camGate.classList.add('show');
  }

  /* ------------------------------------------------------------------ *
   * frame capture and preprocessing
   * ------------------------------------------------------------------ */

  /** Map the on-screen guide box back to source pixels of an object-fit:cover video. */
  function guideCrop(vw, vh) {
    const vr = el.cam.getBoundingClientRect();
    const gr = el.guide.getBoundingClientRect();
    if (!vr.width || !vr.height || !vw || !vh) return { sx: 0, sy: 0, sw: vw, sh: vh };

    const scale = Math.max(vr.width / vw, vr.height / vh);
    const offX = (vw * scale - vr.width) / 2;
    const offY = (vh * scale - vr.height) / 2;

    let sx = (gr.left - vr.left + offX) / scale;
    let sy = (gr.top - vr.top + offY) / scale;
    let sw = gr.width / scale;
    let sh = gr.height / scale;

    sx = Math.max(0, Math.min(sx, vw - 1));
    sy = Math.max(0, Math.min(sy, vh - 1));
    sw = Math.max(8, Math.min(sw, vw - sx));
    sh = Math.max(8, Math.min(sh, vh - sy));
    return { sx, sy, sw, sh };
  }

  /**
   * Draw a source region onto a canvas at a size Tesseract likes, then flatten
   * it to high-contrast greyscale. Light-on-dark signage gets inverted, because
   * Tesseract is trained on dark text over a light page.
   */
  function prepareCanvas(source, sw0, sh0, crop) {
    const sx = crop ? crop.sx : 0;
    const sy = crop ? crop.sy : 0;
    const sw = crop ? crop.sw : sw0;
    const sh = crop ? crop.sh : sh0;

    const TARGET = 1500;
    const scale = Math.max(1, Math.min(3, TARGET / sw));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const hist = new Uint32Array(256);
    const grey = new Uint8ClampedArray(w * h);

    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      grey[p] = g;
      hist[g]++;
    }

    // Contrast stretch between the 2nd and 98th percentile.
    const total = w * h;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    if (hi - lo < 24) { lo = 0; hi = 255; }

    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    const invert = sum / total < 110;

    const range = hi - lo;
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      let g = ((grey[p] - lo) * 255) / range;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      if (invert) g = 255 - g;
      px[i] = px[i + 1] = px[i + 2] = g;
      px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function flattenLines(data) {
    if (Array.isArray(data.lines) && data.lines.length) return data.lines;
    const out = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) out.push(l);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * scanning
   * ------------------------------------------------------------------ */

  let lastResults = null;

  async function scanCanvas(canvas) {
    const worker = await initWorker();
    setStatus('Reading…');
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });

    const lines = flattenLines(data);
    const heights = lines.map((l) => (l.bbox ? l.bbox.y1 - l.bbox.y0 : 0));
    const maxH = Math.max(1, ...heights);

    const candidates = [];
    lines.forEach((line, i) => {
      const text = (line.text || '').trim();
      if (!text) return;
      const found = VPC.extractFromLine(text, { assumeThousands: state.opts.thousands });
      for (const c of found) {
        const conf = typeof line.confidence === 'number' ? line.confidence : 60;
        // Prominent, confidently-read text is far more likely to be the price.
        c.score += (conf - 62) / 18;
        c.score += (heights[i] / maxH) * 2;
        c.source = text;
        candidates.push(c);
      }
    });

    return { ranked: VPC.rank(candidates), text: data.text || '' };
  }

  async function runScan(getCanvas) {
    if (state.busy) return;
    if (!(await ensurePack(true))) return;

    state.busy = true;
    el.shutter.disabled = true;
    el.guide.classList.add('busy');
    const started = Date.now();

    try {
      const canvas = await getCanvas();
      const result = await scanCanvas(canvas);
      lastResults = result;
      renderResults(result, Date.now() - started);
    } catch (err) {
      console.error(err);
      setStatus('Scan failed: ' + (err && err.message ? err.message : err), true);
    } finally {
      state.busy = false;
      el.shutter.disabled = false;
      el.guide.classList.remove('busy');
    }
  }

  function captureFromVideo() {
    const vw = el.cam.videoWidth;
    const vh = el.cam.videoHeight;
    if (!vw || !vh) throw new Error('camera not ready yet');
    return prepareCanvas(el.cam, vw, vh, guideCrop(vw, vh));
  }

  function scanNow() {
    if (!state.stream) {
      toast('Camera is off — use the photo button');
      return;
    }
    el.shotFlash.classList.remove('on');
    void el.shotFlash.offsetWidth;
    el.shotFlash.classList.add('on');
    runScan(async () => captureFromVideo());
  }

  function scanFile(file) {
    runScan(() => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        // A picked photo is already framed by the user, so read the whole thing.
        resolve(prepareCanvas(img, img.naturalWidth, img.naturalHeight, null));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not open that image')); };
      img.src = url;
    }));
  }

  /* ------------------------------------------------------------------ *
   * rendering results
   * ------------------------------------------------------------------ */

  function renderResults(result, ms) {
    const ranked = result.ranked;
    el.rawWrap.hidden = !state.opts.raw;
    el.raw.textContent = result.text || '(nothing)';

    if (!ranked.length) {
      el.hero.hidden = true;
      el.more.innerHTML = '';
      setStatus('No price found. Fill the box with the number and try again.', true);
      return;
    }

    const rate = state.rate;
    const best = ranked[0];
    el.hero.hidden = false;
    el.heroVnd.textContent = VPC.formatVnd(best.vnd);
    el.heroTwd.textContent = rate ? VPC.formatTwd(VPC.toTwd(best.vnd, rate.vndPerTwd)) : '—';

    el.heroFlags.innerHTML = '';
    if (best.assumed) addFlag('assumed ×1.000');
    if (!rate) addFlag('no rate yet');
    else if (rate.manual) addFlag('manual rate');
    else if (Date.now() - rate.fetchedAt > 3 * 864e5) addFlag('rate ' + ago(rate.fetchedAt));

    el.more.innerHTML = '';
    for (const c of ranked.slice(1, 7)) {
      const li = document.createElement('li');
      const twd = document.createElement('span');
      twd.className = 'm-twd';
      twd.textContent = rate ? VPC.formatTwd(VPC.toTwd(c.vnd, rate.vndPerTwd)) : '—';
      const vnd = document.createElement('span');
      vnd.className = 'm-vnd';
      vnd.textContent = VPC.formatVnd(c.vnd) + (c.assumed ? ' *' : '');
      li.append(twd, vnd);
      el.more.appendChild(li);
    }

    const extra = ranked.length > 1 ? ' · ' + (ranked.length - 1) + ' more' : '';
    setStatus('Read in ' + (ms / 1000).toFixed(1) + 's' + extra);
  }

  function addFlag(text) {
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = text;
    el.heroFlags.appendChild(s);
  }

  function rerenderLast() {
    if (lastResults) renderResults(lastResults, 0);
  }

  /* ------------------------------------------------------------------ *
   * live mode
   * ------------------------------------------------------------------ */

  function setLive(on) {
    state.live = on;
    el.liveBtn.setAttribute('aria-pressed', String(on));
    clearTimeout(state.liveTimer);
    if (on) {
      el.guideHint.textContent = 'Scanning continuously — tap “live” to stop';
      liveTick();
    } else {
      el.guideHint.textContent = 'Fill the box with the price';
    }
  }

  async function liveTick() {
    if (!state.live) return;
    if (state.stream && !state.busy && document.visibilityState === 'visible') {
      await runScan(async () => captureFromVideo());
    }
    if (state.live) state.liveTimer = setTimeout(liveTick, 900);
  }

  /* ------------------------------------------------------------------ *
   * manual entry
   * ------------------------------------------------------------------ */

  function manualLookup(text) {
    const ranked = VPC.rank(VPC.extract(text, { assumeThousands: state.opts.thousands }));
    if (!ranked.length) {
      setStatus('Could not read a price out of “' + text + '”.', true);
      el.hero.hidden = true;
      el.more.innerHTML = '';
      return;
    }
    lastResults = { ranked, text };
    renderResults(lastResults, 0);
    setStatus('Typed in');
  }

  /* ------------------------------------------------------------------ *
   * settings
   * ------------------------------------------------------------------ */

  function loadOpts() {
    const saved = loadJson(OPTS_KEY);
    if (saved) Object.assign(state.opts, saved);
    el.optThousands.checked = state.opts.thousands;
    el.optDigits.checked = state.opts.digits;
    el.optRaw.checked = state.opts.raw;
    el.rawWrap.hidden = !state.opts.raw;
  }

  function saveOpts() {
    saveJson(OPTS_KEY, state.opts);
  }

  function openSettings() {
    renderRate();
    el.settingsPanel.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */

  function wire() {
    el.shutter.addEventListener('click', scanNow);
    el.camStart.addEventListener('click', startCamera);
    el.liveBtn.addEventListener('click', () => setLive(!state.live));

    const pick = () => el.fileInput.click();
    el.pickPhoto.addEventListener('click', pick);
    el.pickPhotoAlt.addEventListener('click', pick);
    el.fileInput.addEventListener('change', () => {
      const f = el.fileInput.files && el.fileInput.files[0];
      if (f) scanFile(f);
      el.fileInput.value = '';
    });

    el.manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = el.manualInput.value.trim();
      if (v) manualLookup(v);
      el.manualInput.blur();
    });

    el.settingsBtn.addEventListener('click', openSettings);
    el.rateChip.addEventListener('click', openSettings);
    el.settingsClose.addEventListener('click', () => { el.settingsPanel.hidden = true; });
    el.settingsPanel.addEventListener('click', (e) => {
      if (e.target === el.settingsPanel) el.settingsPanel.hidden = true;
    });

    el.rateRefresh.addEventListener('click', () => refreshRate(true));
    el.rateAuto.addEventListener('click', async () => {
      const cached = loadJson(RATE_KEY);
      if (cached && !cached.manual) applyRate(cached, true);
      else if (state.fallbackRate) applyRate(state.fallbackRate, true);
      await refreshRate(true);
    });
    el.rateInput.addEventListener('change', () => {
      const v = parseFloat(el.rateInput.value);
      if (v > 0) {
        applyRate({ vndPerTwd: v, source: 'manual', fetchedAt: Date.now(), manual: true }, true);
        toast('Using your rate');
      }
    });

    el.optThousands.addEventListener('change', () => {
      state.opts.thousands = el.optThousands.checked;
      saveOpts();
      rerenderLast();
    });
    el.optDigits.addEventListener('change', async () => {
      state.opts.digits = el.optDigits.checked;
      saveOpts();
      if (state.worker) await applyOcrParams(state.worker);
    });
    el.optRaw.addEventListener('change', () => {
      state.opts.raw = el.optRaw.checked;
      saveOpts();
      el.rawWrap.hidden = !state.opts.raw;
    });

    el.packBtn.addEventListener('click', () => downloadPack(false));

    window.addEventListener('online', () => {
      el.netChip.hidden = true;
      refreshRate(false);
      ensurePack(false);
    });
    window.addEventListener('offline', () => { el.netChip.hidden = false; });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.live) setLive(false);
    });

    // Re-render the "x minutes ago" label without a full reload.
    setInterval(renderRate, 60000);
  }

  /* ------------------------------------------------------------------ *
   * service worker
   * ------------------------------------------------------------------ */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready — close and reopen the app', 5000);
          }
        });
      });
    }).catch((e) => console.warn('SW registration failed', e));
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  async function boot() {
    el.version.textContent = 'v' + VERSION + ' · offline OCR by Tesseract';
    state.coreUrl = wasmSimdSupported() ? CORE_SIMD : CORE_PLAIN;
    el.netChip.hidden = navigator.onLine;

    loadOpts();
    wire();
    registerSW();

    const cached = loadJson(RATE_KEY);
    if (cached && cached.vndPerTwd) applyRate(cached, false);
    await loadFallbackRate();
    if (!state.rate && state.fallbackRate) applyRate(state.fallbackRate, false);
    renderRate();

    // A rate older than six hours is worth a quiet refresh.
    if (!state.rate || Date.now() - state.rate.fetchedAt > 6 * 3600e3) refreshRate(false);

    setStatus('Getting the camera ready…');
    await startCamera();

    const ready = await ensurePack(false);
    if (ready) {
      setStatus(state.stream ? 'Point at a price and tap the button.' : 'Ready — scan a saved photo.');
      // Warm the OCR engine so the first real scan is not the slow one.
      initWorker().catch(() => {});
    } else if (navigator.onLine) {
      setStatus('Saving the offline scanner…');
      if (await downloadPack(true)) {
        setStatus('Ready — and it works offline from now on.');
        initWorker().catch(() => {});
      }
    } else {
      setStatus('Offline scanner not saved yet — connect once to finish setup.', true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
