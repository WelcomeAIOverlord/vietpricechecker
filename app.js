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
  const ENGINE_CACHE = 'vpc-engine-v2';

  // Optional support API: reporting a bad scan. The app never needs it to work.
  const API_BASE = 'https://vietpricechecker-api.internalsys.workers.dev';

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
    still: $('still'), selectLayer: $('selectLayer'), selectBox: $('selectBox'),
    hits: $('hits'), frozenBar: $('frozenBar'), frozenHint: $('frozenHint'),
    retakeBtn: $('retakeBtn'), guideWrap: $('guideWrap'),
    resultActions: $('resultActions'), reportBtn: $('reportBtn'),
    reportPanel: $('reportPanel'), reportClose: $('reportClose'),
    reportExpected: $('reportExpected'), reportNote: $('reportNote'),
    reportSend: $('reportSend'), reportStatus: $('reportStatus'),
  };

  // Hooks the browser tests read. Harmless in production: a boolean and the
  // last scan result, nothing that changes behaviour.
  window.__vpcReady = false;
  window.__vpcLast = null;

  let hadController = false;

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
    // The frozen frame the user drags on, and where it sits on screen.
    frozen: null,     // { canvas, w, h }
    frozenFit: null,  // { x, y, w, h } of the image inside #stage
    chosen: null,     // index into the ranked list the user tapped
    build: 'dev',
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

  function setReadyStatus(msg) {
    if (msg) return setStatus(msg);
    setStatus(state.stream ? 'Point at a price and tap the button.' : 'Ready — scan a saved photo.');
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
      // Canonical wasm-feature-detect module: (func () (i32.const 0) (i8x16.splat) (drop))
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
        10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11,
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
      state.noStorage = true;
      el.packStatus.textContent = 'not supported — online only';
      return true;
    }
    el.packBtn.disabled = true;
    let cache;
    try {
      cache = await caches.open(ENGINE_CACHE);
    } catch (err) {
      // Storage can be denied outright. Stay usable, just not offline.
      state.packReady = true;
      state.noStorage = true;
      el.packBtn.disabled = false;
      el.packStatus.textContent = 'storage blocked — online only';
      if (loud) setStatus('This browser will not let the app save anything, so it needs a connection each time.', true);
      return true;
    }
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
      return worker;
    })().catch((err) => {
      state.workerReady = null;
      throw err;
    });
    return state.workerReady;
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
   *
   * Returns { canvas, grey, w, h, inverted } — `grey` is reused by the
   * binarised variant so the pixels are only walked once.
   */
  function prepareCanvas(source, sw0, sh0, crop) {
    const sx = crop ? crop.sx : 0;
    const sy = crop ? crop.sy : 0;
    const sw = crop ? crop.sw : sw0;
    const sh = crop ? crop.sh : sh0;

    // Scale toward a working size in *both* directions. A 4032px phone photo
    // has to come down — at full size it costs seconds per pass and hundreds of
    // megabytes of canvas, which is how Safari decides to kill the tab.
    const TARGET = 1600;
    const scale = Math.min(3, TARGET / Math.max(sw, sh * 0.75));
    const w = Math.max(16, Math.round(sw * scale));
    const h = Math.max(16, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const total = w * h;
    const hist = new Uint32Array(256);
    const grey = new Uint8ClampedArray(total);

    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      grey[p] = g;
      hist[g]++;
    }

    // Contrast stretch between the 2nd and 98th percentile.
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    if (hi - lo < 24) { lo = 0; hi = 255; }

    // Text is the minority of the pixels, so compare the ink against the paper:
    // if the darker tail is smaller than the lighter one the sign is inverted.
    let darkCount = 0;
    const mid = (lo + hi) / 2;
    for (let v = 0; v < 256; v++) if (v < mid) darkCount += hist[v];
    const inverted = darkCount > total * 0.55;

    const range = hi - lo;
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      let g = ((grey[p] - lo) * 255) / range;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      if (inverted) g = 255 - g;
      grey[p] = g;
      px[i] = px[i + 1] = px[i + 2] = g;
      px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Everything needed to map a recognised line back onto the source image.
    const origin = { sx, sy, scale, pad: MARGIN };
    return { canvas, grey, w, h, inverted, origin };
  }

  /**
   * Otsu threshold. Flattening a marker-on-cardboard photo to pure black and
   * white removes the paper texture that otherwise breaks up thick strokes,
   * and it is the single biggest win on hand-lettered signs.
   */
  function binarize(prep) {
    const { grey, w, h } = prep;
    const total = w * h;
    const hist = new Uint32Array(256);
    for (let p = 0; p < total; p++) hist[grey[p]]++;

    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(w, h);
    const px = img.data;
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      const v = grey[p] > thr ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  const MARGIN = 24;

  /** Pad the image with white so Tesseract does not clip glyphs at the edge. */
  function withMargin(canvas, margin) {
    const m = margin || MARGIN;
    const out = document.createElement('canvas');
    out.width = canvas.width + m * 2;
    out.height = canvas.height + m * 2;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, m, m);
    return out;
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
   * freeze, then highlight
   *
   * Framing a price and holding the phone still are two hard things at once.
   * The shutter freezes a full-resolution frame, and everything after that
   * happens on a still image: drag across the price to scan exactly that
   * region, which is also the only reliable way to exclude a barcode sitting
   * next to it.
   * ------------------------------------------------------------------ */

  /** Copy the current video frame at full sensor resolution. */
  function grabFrame() {
    const vw = el.cam.videoWidth;
    const vh = el.cam.videoHeight;
    if (!vw || !vh) throw new Error('camera not ready yet');
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    canvas.getContext('2d').drawImage(el.cam, 0, 0);
    return { canvas, w: vw, h: vh };
  }

  /** Show a frozen frame and switch the stage into selection mode. */
  function freeze(frame) {
    state.frozen = frame;
    const ctx = el.still.getContext('2d');
    el.still.width = frame.w;
    el.still.height = frame.h;
    ctx.drawImage(frame.canvas, 0, 0);

    el.still.hidden = false;
    el.selectLayer.hidden = false;
    el.frozenBar.hidden = false;
    el.guideWrap.hidden = true;
    el.guideHint.textContent = '';
    stopCamera();
    layoutFrozen();
  }

  function unfreeze() {
    state.frozen = null;
    state.frozenFit = null;
    el.still.hidden = true;
    el.selectLayer.hidden = true;
    el.frozenBar.hidden = true;
    el.selectBox.hidden = true;
    el.hits.innerHTML = '';
    el.guideWrap.hidden = false;
    el.guideHint.textContent = state.live
      ? 'Scanning continuously — tap “live” to stop'
      : 'Fill the box with the price';
    if (!state.stream) startCamera();
  }

  /**
   * Where the frozen image actually sits inside the stage. The canvas is
   * object-fit: contain, so it is letterboxed, and every screen coordinate has
   * to be mapped through this to reach image pixels.
   */
  function layoutFrozen() {
    if (!state.frozen) return;
    const r = el.still.getBoundingClientRect();
    const { w, h } = state.frozen;
    const scale = Math.min(r.width / w, r.height / h);
    const dw = w * scale;
    const dh = h * scale;
    state.frozenFit = {
      x: r.left + (r.width - dw) / 2,
      y: r.top + (r.height - dh) / 2,
      w: dw,
      h: dh,
      scale,
    };
  }

  function screenToImage(clientX, clientY) {
    const f = state.frozenFit;
    if (!f) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(state.frozen.w, (clientX - f.x) / f.scale)),
      y: Math.max(0, Math.min(state.frozen.h, (clientY - f.y) / f.scale)),
    };
  }

  function imageRectToScreen(box) {
    const f = state.frozenFit;
    const stage = el.selectLayer.getBoundingClientRect();
    return {
      left: f.x - stage.left + box.sx * f.scale,
      top: f.y - stage.top + box.sy * f.scale,
      width: box.sw * f.scale,
      height: box.sh * f.scale,
    };
  }

  /**
   * Turn a drag into a crop. A deliberate rectangle is used as drawn; a quick
   * horizontal swipe across a line of text is barely any height at all, so it
   * is grown into a band tall enough to hold the digits it crossed.
   */
  function dragToCrop(a, b) {
    const sx = Math.min(a.x, b.x);
    const sy = Math.min(a.y, b.y);
    let sw = Math.abs(b.x - a.x);
    let sh = Math.abs(b.y - a.y);

    const MIN_BAND = state.frozen.h * 0.045;
    let top = sy;
    if (sh < MIN_BAND) {
      // A swipe: centre a band on the line the finger travelled along.
      const band = Math.max(MIN_BAND, sw * 0.28);
      top = sy + sh / 2 - band / 2;
      sh = band;
    }

    // A little margin on each side keeps Tesseract from clipping the glyphs.
    const padX = Math.max(8, sw * 0.04);
    const padY = Math.max(8, sh * 0.18);
    const x0 = Math.max(0, sx - padX);
    const y0 = Math.max(0, top - padY);
    return {
      sx: x0,
      sy: y0,
      sw: Math.min(state.frozen.w - x0, sw + padX * 2),
      sh: Math.min(state.frozen.h - y0, sh + padY * 2),
    };
  }

  function wireSelection() {
    let start = null;
    let moved = false;

    const down = (e) => {
      if (!state.frozen || state.busy) return;
      const t = e.touches ? e.touches[0] : e;
      layoutFrozen();
      start = screenToImage(t.clientX, t.clientY);
      moved = false;
      el.hits.innerHTML = '';
      el.selectBox.hidden = false;
      Object.assign(el.selectBox.style, { left: '0px', top: '0px', width: '0px', height: '0px' });
      e.preventDefault();
    };

    const move = (e) => {
      if (!start) return;
      const t = e.touches ? e.touches[0] : e;
      const now = screenToImage(t.clientX, t.clientY);
      moved = Math.abs(now.x - start.x) > 6 || Math.abs(now.y - start.y) > 6;
      const box = {
        sx: Math.min(start.x, now.x),
        sy: Math.min(start.y, now.y),
        sw: Math.abs(now.x - start.x),
        sh: Math.abs(now.y - start.y),
      };
      const r = imageRectToScreen(box);
      Object.assign(el.selectBox.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      e.preventDefault();
    };

    const up = (e) => {
      if (!start) return;
      const t = (e.changedTouches && e.changedTouches[0]) || e;
      const end = screenToImage(t.clientX, t.clientY);
      const from = start;
      start = null;
      if (!moved) {
        el.selectBox.hidden = true;
        return; // a tap, not a drag — leave the last result alone
      }
      const crop = dragToCrop(from, end);
      const r = imageRectToScreen(crop);
      Object.assign(el.selectBox.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      el.frozenHint.textContent = 'Reading your selection…';
      scanFrozen(crop);
    };

    el.selectLayer.addEventListener('touchstart', down, { passive: false });
    el.selectLayer.addEventListener('touchmove', move, { passive: false });
    el.selectLayer.addEventListener('touchend', up);
    el.selectLayer.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('resize', () => { layoutFrozen(); renderHits(); });
  }

  /** Draw a tappable marker over every number the scan found. */
  function renderHits(result) {
    el.hits.innerHTML = '';
    const r = result || lastResults;
    if (!r || !state.frozen || !r.ranked) return;
    // The results sheet grows when an answer appears, which resizes the stage,
    // so the image has to be re-measured before anything is drawn over it.
    layoutFrozen();

    r.ranked.forEach((c, i) => {
      if (!c.box) return;
      const pos = imageRectToScreen(c.box);
      if (!(pos.width > 4 && pos.height > 4)) return;
      const div = document.createElement('div');
      div.className = 'hit' + (i === (state.chosen || 0) ? ' chosen' : '');
      Object.assign(div.style, {
        left: pos.left + 'px', top: pos.top + 'px',
        width: pos.width + 'px', height: pos.height + 'px',
      });
      const label = document.createElement('span');
      label.className = 'hit-label';
      if (pos.top < 26) label.style.top = '2px';
      label.textContent = state.rate
        ? VPC.formatTwd(VPC.toTwd(c.vnd, state.rate.vndPerTwd))
        : VPC.formatVnd(c.vnd);
      div.appendChild(label);
      div.addEventListener('click', (e) => { e.stopPropagation(); choose(i); });
      div.addEventListener('touchend', (e) => { e.stopPropagation(); e.preventDefault(); choose(i); });
      el.hits.appendChild(div);
    });
  }

  /** Promote one candidate to the headline answer. */
  function choose(index) {
    if (!lastResults || !lastResults.ranked[index]) return;
    state.chosen = index;
    renderResults(lastResults, lastResults.ms || 0);
    renderHits();
  }

  /* ------------------------------------------------------------------ *
   * scanning
   * ------------------------------------------------------------------ */

  let lastResults = null;

  /**
   * The passes, cheapest first. A clean printed tag is solved by the first one
   * in a fraction of a second; the rest only run when that comes back empty or
   * unconvincing, which is the usual story for handwriting and bad light.
   */
  const PASSES = [
    { id: 'grey-block', variant: 'grey', psm: '6' },
    { id: 'bw-block', variant: 'bw', psm: '6' },
    { id: 'bw-sparse', variant: 'bw', psm: '11' },
    { id: 'grey-sparse', variant: 'grey', psm: '11' },
    { id: 'bw-line-digits', variant: 'bw', psm: '7', whitelist: DIGIT_WHITELIST },
  ];

  // A candidate this strong means the structure of the number itself is
  // convincing (grouped thousands, or a k/triệu/₫ marker), so stop early.
  const CONFIDENT = 6;

  function collectCandidates(data, pass, out, origin) {
    const lines = flattenLines(data);
    const heights = lines.map((l) => (l.bbox ? l.bbox.y1 - l.bbox.y0 : 0));
    const maxH = Math.max(1, ...heights);

    lines.forEach((line, i) => {
      const text = (line.text || '').trim();
      if (!text) return;
      const found = VPC.extractFromLine(text, { assumeThousands: state.opts.thousands });
      for (const c of found) {
        const conf = typeof line.confidence === 'number' ? line.confidence : 60;
        // Big, confidently-read text is far more likely to be the price.
        c.score += (conf - 62) / 30;
        c.score += Math.pow(heights[i] / maxH, 2) * 3;
        c.order = i;
        c.pass = pass.id;
        c.source = text;
        // Map the line back to the frozen image so it can be drawn and tapped.
        if (origin && line.bbox) {
          c.box = {
            sx: origin.sx + (line.bbox.x0 - origin.pad) / origin.scale,
            sy: origin.sy + (line.bbox.y0 - origin.pad) / origin.scale,
            sw: (line.bbox.x1 - line.bbox.x0) / origin.scale,
            sh: (line.bbox.y1 - line.bbox.y0) / origin.scale,
          };
        }
        out.push(c);
      }
    });
  }

  async function scanImage(prep, mode) {
    const worker = await initWorker();
    const variants = {
      grey: () => withMargin(prep.canvas),
      bw: () => {
        const bw = binarize(prep);
        const padded = withMargin(bw);
        releaseCanvas(bw);
        return padded;
      },
    };
    const built = {};
    const candidates = [];
    const texts = [];
    const passesRun = [];
    const deep = mode === 'file';

    // "Numbers-only OCR" is a user override: run just that, and nothing else.
    // Live mode stays on the two cheapest passes so the preview keeps up.
    const plan = state.opts.digits
      ? [{ id: 'digits-only', variant: 'bw', psm: '11', whitelist: DIGIT_WHITELIST }]
      : mode === 'live' ? PASSES.slice(0, 2) : PASSES;

    for (let i = 0; i < plan.length; i++) {
      const pass = plan[i];
      if (i > 0) setStatus('Looking harder… (' + (i + 1) + '/' + plan.length + ')');
      if (!built[pass.variant]) built[pass.variant] = variants[pass.variant]();

      await worker.setParameters({
        tessedit_pageseg_mode: pass.psm,
        tessedit_char_whitelist: pass.whitelist || '',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });

      let data;
      try {
        ({ data } = await worker.recognize(built[pass.variant], {}, { blocks: true, text: true }));
      } catch (err) {
        console.warn('pass ' + pass.id + ' failed', err);
        continue;
      }
      passesRun.push(pass.id);
      if (data.text && data.text.trim()) texts.push(data.text.trim());
      collectCandidates(data, pass, candidates, prep.origin);

      const ranked = VPC.rank(candidates.slice());
      const goodEnough = ranked.length && ranked[0].score >= CONFIDENT && !ranked[0].assumed;
      if (!deep && goodEnough) break;
    }

    // Safari holds on to canvas backing stores far longer than the JS objects
    // that reference them; live mode would otherwise stack up a fresh pair of
    // multi-megapixel buffers every second. Zeroing the dimensions frees them now.
    releaseCanvas(prep.canvas);
    for (const key of Object.keys(built)) releaseCanvas(built[key]);

    return {
      ranked: VPC.rank(candidates),
      text: texts.join('\n'),
      passes: passesRun,
    };
  }

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  async function runScan(getPrep, mode) {
    if (state.busy) return null;

    state.busy = true;
    el.shutter.disabled = true;
    el.guide.classList.add('busy');
    const started = Date.now();

    try {
      if (!(await ensurePack(true))) return null;
      const prep = await getPrep();
      const result = await scanImage(prep, mode);
      result.ms = Date.now() - started;
      lastResults = result;
      window.__vpcLast = { ranked: result.ranked, text: result.text, passes: result.passes, ms: result.ms };
      renderResults(result, result.ms);
      return result;
    } catch (err) {
      console.error(err);
      setStatus('Scan failed: ' + (err && err.message ? err.message : err), true);
      window.__vpcLast = { ranked: [], text: '', passes: [], error: String(err && err.message) };
      return null;
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

  /**
   * Tapping the shutter freezes the frame and reads the guide box, so a plain
   * tap still works exactly as before. The still stays on screen afterwards so
   * the price can be highlighted directly if that first read was not it.
   */
  function scanNow() {
    if (state.frozen) {
      // Already frozen: re-read the guide-box area of the still.
      scanFrozen(guideCropOn(state.frozen));
      return;
    }
    if (!state.stream) {
      toast('Camera is off — use the photo button');
      return;
    }
    el.shotFlash.classList.remove('on');
    void el.shotFlash.offsetWidth;
    el.shotFlash.classList.add('on');

    let frame;
    try {
      frame = grabFrame();
    } catch (err) {
      setStatus('Camera is not ready yet — give it a moment.', true);
      return;
    }
    const crop = guideCrop(frame.w, frame.h);
    freeze(frame);
    scanFrozen(crop);
  }

  /** The guide box mapped onto a frozen frame rather than the live video. */
  function guideCropOn(frame) {
    const inset = 0.09;
    return {
      sx: frame.w * inset,
      sy: frame.h * 0.33,
      sw: frame.w * (1 - inset * 2),
      sh: frame.h * 0.34,
    };
  }

  /** Read one region of the frozen still. */
  function scanFrozen(crop) {
    state.chosen = null;
    runScan(async () => prepareCanvas(state.frozen.canvas, state.frozen.w, state.frozen.h, crop), 'tap')
      .then((result) => {
        if (!state.frozen) return;
        el.frozenHint.textContent = result && result.ranked.length
          ? 'Tap a number, or drag again'
          : 'Drag across just the price';
        renderHits(result);
      });
  }

  /**
   * A picked photo is frozen exactly like a captured frame, so the whole image
   * is read first and the price can then be highlighted if that is not enough.
   */
  function scanFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      freeze({ canvas, w: canvas.width, h: canvas.height });

      state.chosen = null;
      runScan(async () => prepareCanvas(canvas, canvas.width, canvas.height, null), 'file')
        .then((result) => {
          if (!state.frozen) return;
          el.frozenHint.textContent = result && result.ranked.length
            ? 'Tap a number, or drag across the right one'
            : 'Drag across just the price';
          renderHits(result);
        });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus('Could not open that image.', true);
    };
    img.src = url;
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
      el.resultActions.hidden = !state.frozen;
      setStatus(state.frozen
        ? 'No price found there. Drag across just the number and it will try again.'
        : 'No price found. Fill the box with the number and try again.', true);
      return;
    }

    const rate = state.rate;
    const pick = Math.min(state.chosen || 0, ranked.length - 1);
    const best = ranked[pick];
    el.hero.hidden = false;
    el.resultActions.hidden = false;
    el.heroVnd.textContent = VPC.formatVnd(best.vnd);
    el.heroTwd.textContent = rate ? VPC.formatTwd(VPC.toTwd(best.vnd, rate.vndPerTwd)) : '—';

    el.heroFlags.innerHTML = '';
    if (best.assumed) addFlag('assumed ×1.000');
    if (!rate) addFlag('no rate yet');
    else if (rate.manual) addFlag('manual rate');
    else if (Date.now() - rate.fetchedAt > 3 * 864e5) addFlag('rate ' + ago(rate.fetchedAt));

    // Every other reading stays one tap away — on a shelf full of barcodes the
    // ranking is a suggestion, not a verdict.
    el.more.innerHTML = '';
    ranked.forEach((c, i) => {
      if (i === pick) return;
      const li = document.createElement('li');
      li.tabIndex = 0;
      const twd = document.createElement('span');
      twd.className = 'm-twd';
      twd.textContent = rate ? VPC.formatTwd(VPC.toTwd(c.vnd, rate.vndPerTwd)) : '—';
      const vnd = document.createElement('span');
      vnd.className = 'm-vnd';
      vnd.textContent = VPC.formatVnd(c.vnd) + (c.assumed ? ' *' : '');
      li.append(twd, vnd);
      li.addEventListener('click', () => choose(i));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') choose(i); });
      el.more.appendChild(li);
    });

    const extra = ranked.length > 1 ? ' · tap another of ' + (ranked.length - 1) : '';
    const hard = result.passes && result.passes.length > 1 ? ' · ' + result.passes.length + ' passes' : '';
    setStatus('Read in ' + (ms / 1000).toFixed(1) + 's' + extra + hard);
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
    if (on && state.frozen) unfreeze();
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
    if (state.stream && !state.frozen && !state.busy && document.visibilityState === 'visible') {
      await runScan(async () => captureFromVideo(), 'live');
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
    state.chosen = null;
    lastResults = { ranked, text };
    renderResults(lastResults, 0);
    setStatus('Typed in');
  }


  /* ------------------------------------------------------------------ *
   * reporting a bad scan
   *
   * A tester who sees a wrong number can send the picture and what the app
   * read. That is the only way to fix recognition against prices that exist
   * in real shops rather than in a fixture generator.
   * ------------------------------------------------------------------ */

  /** Shrink the frozen frame to something worth sending over mobile data. */
  function reportImage() {
    if (!state.frozen) return null;
    const MAX = 1000;
    const { canvas, w, h } = state.frozen;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    const data = out.toDataURL('image/jpeg', 0.7);
    releaseCanvas(out);
    return data;
  }

  function openReport() {
    if (!lastResults) {
      toast('Scan something first');
      return;
    }
    el.reportExpected.value = '';
    el.reportNote.value = '';
    el.reportStatus.textContent = state.frozen
      ? ''
      : 'No picture to send — this will report the reading only.';
    el.reportPanel.hidden = false;
  }

  async function sendReport() {
    const typed = el.reportExpected.value.trim();
    let expected = null;
    if (typed) {
      const parsed = VPC.rank(VPC.extract(typed, { assumeThousands: state.opts.thousands }));
      if (!parsed.length) {
        el.reportStatus.textContent = 'Could not read “' + typed + '” as a price. Try 25.000 or 25k.';
        return;
      }
      expected = parsed[0].vnd;
    }

    const ranked = lastResults.ranked || [];
    const shown = ranked.length ? ranked[Math.min(state.chosen || 0, ranked.length - 1)].vnd : null;

    el.reportSend.disabled = true;
    el.reportStatus.textContent = 'Sending…';
    try {
      const res = await fetch(API_BASE + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appVersion: VERSION,
          build: state.build,
          source: state.frozen ? 'photo' : 'typed',
          image: reportImage(),
          ocrText: (lastResults.text || '').slice(0, 4000),
          candidates: ranked.slice(0, 8).map((c) => ({ vnd: c.vnd, score: c.score, repaired: !!c.repaired })),
          shown,
          expected,
          note: el.reportNote.value.trim().slice(0, 500),
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      el.reportPanel.hidden = true;
      toast('Thanks — report sent');
    } catch (err) {
      el.reportStatus.textContent = navigator.onLine
        ? 'Could not send it (' + err.message + '). Try again later.'
        : 'You are offline — reconnect and report it then.';
    } finally {
      el.reportSend.disabled = false;
    }
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
    el.retakeBtn.addEventListener('click', unfreeze);
    el.reportBtn.addEventListener('click', openReport);
    el.reportClose.addEventListener('click', () => { el.reportPanel.hidden = true; });
    el.reportSend.addEventListener('click', sendReport);
    el.reportPanel.addEventListener('click', (e) => {
      if (e.target === el.reportPanel) el.reportPanel.hidden = true;
    });
    wireSelection();
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
    el.optDigits.addEventListener('change', () => {
      // Each scan pass sets its own parameters, so there is nothing to apply here.
      state.opts.digits = el.optDigits.checked;
      saveOpts();
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
      if (document.visibilityState === 'hidden') {
        if (state.live) setLive(false);
        stopCamera();
      } else if (!state.stream && !el.camGate.classList.contains('show')) {
        startCamera();
      }
    });
    window.addEventListener('pagehide', stopCamera);

    keepInputAboveKeyboard();

    // Re-render the "x minutes ago" label without a full reload.
    setInterval(renderRate, 60000);
  }

  /**
   * The page is a fixed 100dvh with overflow hidden, so when iOS raises the
   * keyboard it covers the bottom sheet and nothing can be scrolled to reach
   * the field being typed into. visualViewport reports how much was taken, and
   * lifting the sheet by that much puts the field back on screen.
   */
  function keepInputAboveKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;

    const apply = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const focused = document.activeElement;
      const typing = focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA');
      document.documentElement.style.setProperty('--kb', (typing ? hidden : 0) + 'px');
    };

    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', () => {
      document.documentElement.style.setProperty('--kb', '0px');
      // Safari can leave the layout viewport offset after the keyboard closes.
      window.scrollTo(0, 0);
    });
  }

  /* ------------------------------------------------------------------ *
   * service worker
   * ------------------------------------------------------------------ */

  /**
   * Ask the controlling worker which build it is, so a report can name the
   * deploy that produced it. Fetching sw.js would have done the same thing and
   * failed every time the app was offline.
   */
  function askBuildId() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'build' && e.data.build) {
        state.build = e.data.build;
        el.version.textContent = 'v' + VERSION + ' · build ' + state.build;
      }
    });
    navigator.serviceWorker.ready
      .then((reg) => {
        const sw = navigator.serviceWorker.controller || reg.active;
        if (sw) sw.postMessage({ type: 'build' });
      })
      .catch(() => {});
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    // A worker that skips waiting starts serving the new shell to a page that
    // is still running the old scripts. Reload once so the two match. The
    // controller check keeps the very first install from reloading.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Updating…', 2500);
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
    askBuildId();
    state.coreUrl = wasmSimdSupported() ? CORE_SIMD : CORE_PLAIN;
    el.netChip.hidden = navigator.onLine;

    loadOpts();
    wire();
    hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    registerSW();

    const cached = loadJson(RATE_KEY);
    if (cached && cached.vndPerTwd) applyRate(cached, false);
    await loadFallbackRate();
    if (!state.rate && state.fallbackRate) applyRate(state.fallbackRate, false);
    renderRate();

    // A rate older than six hours is worth a quiet refresh.
    if (!state.rate || Date.now() - state.rate.fetchedAt > 6 * 3600e3) refreshRate(false);

    setStatus('Getting the camera ready…');
    const packPromise = ensurePack(false);
    await startCamera();

    const ready = await packPromise;
    if (ready) {
      // Warm the OCR engine so the first real scan is not the slow one.
      await initWorker().catch(() => {});
      setReadyStatus();
      window.__vpcReady = true;
    } else if (navigator.onLine) {
      setStatus('Saving the offline scanner…');
      if (await downloadPack(true)) {
        await initWorker().catch(() => {});
        setReadyStatus(state.noStorage ? null : 'Ready — and it works offline from now on.');
        window.__vpcReady = true;
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
