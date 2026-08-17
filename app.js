/* Viet Price Checker — camera → Vietnamese price → New Taiwan dollars.
 *
 * Everything (OCR included) runs on the device. The only network call is the
 * exchange rate, and the app is fully usable without it.
 */
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const RATE_KEY = 'vpc.rates';
  const MANUAL_KEY = 'vpc.manual';
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
    currencySelect: $('currencySelect'), rateUnit: $('rateUnit'),
    roundBtns: Array.from(document.querySelectorAll('[data-round]')),
    optThousands: $('optThousands'), optDigits: $('optDigits'), optRaw: $('optRaw'),
    packStatus: $('packStatus'), packBtn: $('packBtn'), version: $('version'),
    toast: $('toast'),
    stage: $('stage'),
    still: $('still'), selectLayer: $('selectLayer'), selectBox: $('selectBox'),
    hits: $('hits'), frozenBar: $('frozenBar'), frozenHint: $('frozenHint'),
    retakeBtn: $('retakeBtn'), guideWrap: $('guideWrap'),
    resultActions: $('resultActions'), reportBtn: $('reportBtn'),
    modeSelect: $('modeSelect'), modeMove: $('modeMove'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'),
    sheet: $('sheet'), sheetHandle: $('sheetHandle'), sheetHandleLabel: $('sheetHandleLabel'),
    reportPanel: $('reportPanel'), reportClose: $('reportClose'),
    reportExpected: $('reportExpected'), reportNote: $('reportNote'),
    reportSend: $('reportSend'), reportStatus: $('reportStatus'),
  };

  // Hooks the browser tests read. Harmless in production: a boolean and the
  // last scan result, nothing that changes behaviour.
  window.__vpcReady = false;
  window.__vpcLast = null;
  window.__vpcPackLog = [];

  let hadController = false;

  const state = {
    stream: null,
    worker: null,
    workerReady: null,
    busy: false,
    live: false,
    liveTimer: null,
    rates: null,         // { values: { CODE: đồng per unit }, source, fetchedAt }
    fallbackRates: null,
    manual: {},          // per-currency overrides you typed in yourself
    currency: 'TWD',
    rounding: 'nearest', // 'up' | 'nearest' | 'down'
    opts: { thousands: true, digits: false, raw: false },
    packReady: false,
    coreUrl: CORE_SIMD,
    // The frozen frame the user drags on, and where it sits on screen.
    frozen: null,     // { canvas, w, h }
    // How the frozen image is laid over the stage. One source of truth for
    // drawing, for pinch zoom, and for turning a finger position into a pixel.
    view: { base: 1, zoom: 1, tx: 0, ty: 0 },
    oneFinger: 'select', // or 'move'
    chosen: null,     // index into the ranked list the user tapped
    sheetOpen: false,
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

  // Everything is stored as "đồng per one unit", because that is the number
  // written on the board at a money changer.
  const RATE_SOURCES = [
    {
      name: 'exchangerate-api',
      url: 'https://open.er-api.com/v6/latest/VND',
      read: (j) => (j && j.rates ? j.rates : null),
    },
    {
      name: 'currency-api',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/vnd.min.json',
      read: (j) => (j && j.vnd ? j.vnd : null),
    },
  ];

  /** Turn "units per đồng" into "đồng per unit" for the currencies on offer. */
  function toVndPerUnit(perDong) {
    const out = {};
    for (const code of Object.keys(VPC.CURRENCIES)) {
      const r = perDong[code] || perDong[code.toLowerCase()];
      const v = r > 0 ? 1 / r : 0;
      // Anything outside this range is a broken feed, not an exchange rate.
      if (v > 0.5 && v < 5e6) out[code] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  async function fetchRates() {
    for (const src of RATE_SOURCES) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(src.url, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (!res.ok) continue;
        const values = toVndPerUnit(src.read(await res.json()) || {});
        if (values) return { values, source: src.name, fetchedAt: Date.now() };
      } catch (e) { /* try the next source */ }
    }
    return null;
  }

  async function loadFallbackRates() {
    try {
      const res = await fetch('rate.json', { cache: 'no-cache' });
      const j = await res.json();
      const values = j && (j.vndPerUnit || (j.vndPerTwd ? { TWD: j.vndPerTwd } : null));
      if (values) {
        state.fallbackRates = {
          values,
          source: 'bundled ' + String(j.asOf || '').slice(0, 10),
          fetchedAt: Date.parse(j.asOf) || Date.now(),
          bundled: true,
        };
      }
    } catch (e) { /* offline first run without the file cached */ }
  }

  /** The rate in force for the chosen currency: yours if you set one. */
  function vndPerUnit(code) {
    const c = code || state.currency;
    const manual = state.manual[c];
    if (manual > 0) return manual;
    return (state.rates && state.rates.values[c]) || 0;
  }

  function isManual(code) {
    return (state.manual[code || state.currency] || 0) > 0;
  }

  function applyRates(rates, persist) {
    if (!rates) return;
    state.rates = rates;
    if (persist) saveJson(RATE_KEY, rates);
    renderRate();
    rerenderLast();
  }

  function setCurrency(code) {
    if (!VPC.CURRENCIES[code]) return;
    state.currency = code;
    saveOpts();
    renderRate();
    rerenderLast();
    renderHits();
  }

  function setRounding(mode) {
    state.rounding = mode;
    saveOpts();
    for (const btn of el.roundBtns) {
      btn.setAttribute('aria-pressed', String(btn.dataset.round === mode));
    }
    rerenderLast();
    renderHits();
  }

  function setManualRate(code, value) {
    if (value > 0) state.manual[code] = value;
    else delete state.manual[code];
    saveJson(MANUAL_KEY, state.manual);
    renderRate();
    rerenderLast();
    renderHits();
  }

  /** Format an amount of đồng in the chosen currency, with rounding applied. */
  function money(vnd) {
    const converted = VPC.convert(vnd, vndPerUnit(), state.rounding);
    return converted == null ? '—' : VPC.formatMoney(converted, state.currency);
  }

  function renderRate() {
    const code = state.currency;
    const cur = VPC.CURRENCIES[code];
    const rate = vndPerUnit(code);

    if (!rate) {
      el.rateValue.textContent = 'no ' + code + ' rate';
      el.rateAge.textContent = '';
      el.rateDetail.textContent = 'unavailable';
    } else {
      el.rateValue.textContent = cur.symbol + '1 = ' + Math.round(rate).toLocaleString('en-US') + ' ₫';
      el.rateAge.textContent = isManual(code)
        ? 'yours'
        : state.rates ? ago(state.rates.fetchedAt) : '';
      el.rateDetail.textContent = isManual(code)
        ? 'the rate you entered'
        : (state.rates ? state.rates.source + ' · ' + ago(state.rates.fetchedAt) : 'unavailable');
    }

    el.rateUnit.textContent = cur.symbol + '1 =';
    if (document.activeElement !== el.rateInput) {
      el.rateInput.value = rate ? Math.round(rate * 100) / 100 : '';
    }
    if (el.currencySelect.value !== code) el.currencySelect.value = code;
  }

  async function refreshRate(loud) {
    if (!navigator.onLine) {
      if (loud) toast('No connection — keeping the saved rates');
      return;
    }
    if (loud) toast('Fetching rates…', 1500);
    const r = await fetchRates();
    if (r) {
      applyRates(r, true);
      if (loud) {
        toast(isManual() ? 'Rates updated — yours still applies to ' + state.currency : 'Rates updated');
      }
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

  // Roughly what each file weighs, used only to show sensible progress before
  // the server has told us anything. Being a little off is harmless.
  const ENGINE_BYTES = { core: 3938657, worker: 123724, traineddata: 1976314 };
  const ENGINE_TOTAL = ENGINE_BYTES.core + ENGINE_BYTES.worker + ENGINE_BYTES.traineddata;

  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  /**
   * Fetch one engine file, reporting bytes as they arrive.
   *
   * This is the only moment the app needs a connection, and on mobile data in
   * a market it is a slow one. "1 of 3" for four megabytes looks like a hang;
   * a moving byte count does not.
   */
  async function fetchWithProgress(url, onBytes) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!res.body || !res.body.getReader) return res; // no streams: no progress

    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onBytes(got);
    }
    // Rebuild the response carrying only the content type. The body here has
    // already been decoded by fetch, so copying the original Content-Encoding
    // would label plain bytes as gzip — GitHub Pages serves these files gzipped
    // — and the original Content-Length is the compressed size, which no longer
    // describes what is being stored.
    const headers = new Headers();
    const type = res.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    return new Response(new Blob(chunks), { status: 200, headers });
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
    let carried = 0; // bytes from files already finished this run

    for (const p of paths) {
      const url = abs(p);
      const weight = p === WORKER_JS ? ENGINE_BYTES.worker
        : p === TRAINEDDATA ? ENGINE_BYTES.traineddata
          : ENGINE_BYTES.core;

      if (await cache.match(url)) { carried += weight; continue; }

      const report = (bytes) => {
        const soFar = Math.min(carried + bytes, ENGINE_TOTAL);
        const pct = Math.min(99, Math.round((soFar / ENGINE_TOTAL) * 100));
        const line = mb(soFar) + ' of ' + mb(ENGINE_TOTAL) + ' · ' + pct + '%';
        el.packStatus.textContent = line;
        window.__vpcPackLog.push(soFar);
        if (loud) setStatus('Saving the offline scanner so it works with no signal… ' + line);
      };
      report(0);

      try {
        const res = await fetchWithProgress(url, report);
        await cache.put(url, res);
        carried += weight;
      } catch (e) {
        el.packBtn.disabled = false;
        el.packStatus.textContent = 'stopped at ' + mb(carried) + ' — tap to resume';
        if (loud) {
          setStatus('The download stopped partway. Finished files are kept, so ' +
            'reconnecting and tapping again picks up where it left off.', true);
        }
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

  /**
   * Capture the current video frame. It is drawn straight into the canvas that
   * displays it: a phone frame is tens of megabytes, and keeping a separate
   * copy for OCR would double that for no reason.
   */
  function grabFrame() {
    const vw = el.cam.videoWidth;
    const vh = el.cam.videoHeight;
    if (!vw || !vh) throw new Error('camera not ready yet');
    return drawIntoStill(el.cam, vw, vh);
  }

  function drawIntoStill(source, w, h) {
    el.still.width = w;
    el.still.height = h;
    el.still.getContext('2d').drawImage(source, 0, 0, w, h);
    return { canvas: el.still, w, h };
  }

  /** Show a frozen frame and switch the stage into selection mode. */
  function freeze(frame) {
    state.frozen = frame;
    el.still.hidden = false;
    el.selectLayer.hidden = false;
    el.frozenBar.hidden = false;
    el.frozenHint.hidden = false;
    el.guideWrap.hidden = true;
    el.guideHint.textContent = '';
    setOneFinger('select');
    stopCamera();
    fitView();
  }

  function unfreeze() {
    state.frozen = null;
    state.view = { base: 1, zoom: 1, tx: 0, ty: 0 };
    el.still.hidden = true;
    el.frozenHint.hidden = true;
    el.still.style.transform = '';
    // Hand the frame's backing store back before starting the camera again.
    releaseCanvas(el.still);
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

  /* ---- view transform ------------------------------------------------ *
   * The image is placed by an explicit scale and offset rather than by
   * object-fit, so pinch zoom, the marker overlay and the crop that gets
   * recognised all read from the same numbers and cannot drift apart.
   * -------------------------------------------------------------------- */

  const MAX_ZOOM = 8;

  function stageRect() {
    return el.stage.getBoundingClientRect();
  }

  /** Scale the whole image to fit, centred, and forget any zoom. */
  function fitView() {
    if (!state.frozen) return;
    const r = stageRect();
    const { w, h } = state.frozen;
    const base = Math.min(r.width / w, r.height / h) || 1;
    state.view = { base, zoom: 1, tx: (r.width - w * base) / 2, ty: (r.height - h * base) / 2 };
    applyView();
  }

  function viewScale() {
    return state.view.base * state.view.zoom;
  }

  /**
   * Keep the image within reach. Whichever axis is smaller than the stage stays
   * centred; the other is clamped so it cannot be flung off screen entirely.
   */
  function clampView() {
    const r = stageRect();
    const s = viewScale();
    const w = state.frozen.w * s;
    const h = state.frozen.h * s;
    state.view.tx = w <= r.width
      ? (r.width - w) / 2
      : Math.min(0, Math.max(r.width - w, state.view.tx));
    state.view.ty = h <= r.height
      ? (r.height - h) / 2
      : Math.min(0, Math.max(r.height - h, state.view.ty));
  }

  function applyView() {
    if (!state.frozen) return;
    clampView();
    const { tx, ty } = state.view;
    el.still.style.width = state.frozen.w + 'px';
    el.still.style.height = state.frozen.h + 'px';
    el.still.style.transform =
      'translate(' + tx + 'px,' + ty + 'px) scale(' + viewScale() + ')';
    el.zoomOut.disabled = state.view.zoom <= 1.001;
    el.zoomIn.disabled = state.view.zoom >= MAX_ZOOM - 0.001;
    renderHits();
  }

  /** Zoom about a point in stage coordinates, so that point stays put. */
  function zoomAround(factor, px, py) {
    const before = viewScale();
    const next = Math.max(1, Math.min(MAX_ZOOM, state.view.zoom * factor));
    state.view.zoom = next;
    const after = viewScale();
    const k = after / before;
    state.view.tx = px - (px - state.view.tx) * k;
    state.view.ty = py - (py - state.view.ty) * k;
    applyView();
  }

  function screenToImage(clientX, clientY) {
    const r = stageRect();
    const s = viewScale();
    return {
      x: Math.max(0, Math.min(state.frozen.w, (clientX - r.left - state.view.tx) / s)),
      y: Math.max(0, Math.min(state.frozen.h, (clientY - r.top - state.view.ty) / s)),
    };
  }

  /** An image-space rectangle in coordinates the overlay can be styled with. */
  function imageRectToScreen(box) {
    const s = viewScale();
    return {
      left: state.view.tx + box.sx * s,
      top: state.view.ty + box.sy * s,
      width: box.sw * s,
      height: box.sh * s,
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

    el.selectLayer.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('resize', () => { if (state.frozen) fitView(); });

    wireTouchGestures(down, move, up);
  }


  /* ---- touch gestures ------------------------------------------------- *
   * Two fingers always pinch and pan: that can never be mistaken for a
   * one-finger drag, so it needs no mode. The toggle only decides what a
   * single finger does, which is the one genuinely ambiguous case once the
   * picture is zoomed in.
   * -------------------------------------------------------------------- */

  function setOneFinger(mode) {
    state.oneFinger = mode;
    const selecting = mode === 'select';
    el.modeSelect.setAttribute('aria-pressed', String(selecting));
    el.modeMove.setAttribute('aria-pressed', String(!selecting));
    el.frozenHint.textContent = selecting
      ? 'Drag across the price · pinch to zoom'
      : 'Drag to move · pinch to zoom · switch to Select to pick a price';
  }

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  function wireTouchGestures(selectDown, selectMove, selectUp) {
    let pinch = null;   // { d, cx, cy }
    let pan = null;     // { x, y }
    let selecting = false;
    let lastTap = 0;

    const onStart = (e) => {
      if (!state.frozen || state.busy) return;

      if (e.touches.length === 2) {
        // A second finger cancels any selection that had started.
        if (selecting) { selectUp({ changedTouches: [e.touches[0]] }); selecting = false; }
        el.selectBox.hidden = true;
        const r = stageRect();
        const m = mid(e.touches[0], e.touches[1]);
        pinch = { d: dist(e.touches[0], e.touches[1]), cx: m.x - r.left, cy: m.y - r.top };
        pan = null;
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const now = Date.now();
        if (now - lastTap < 300) {
          // Double tap: in one step to a useful magnification, or back out.
          const r = stageRect();
          zoomAround(state.view.zoom > 1.2 ? 1 / state.view.zoom : 2.5, t.clientX - r.left, t.clientY - r.top);
          lastTap = 0;
          e.preventDefault();
          return;
        }
        lastTap = now;

        if (state.oneFinger === 'move') {
          pan = { x: t.clientX, y: t.clientY };
        } else {
          selecting = true;
          selectDown(e);
        }
      }
    };

    const onMove = (e) => {
      if (pinch && e.touches.length === 2) {
        const d = dist(e.touches[0], e.touches[1]);
        if (pinch.d > 0) zoomAround(d / pinch.d, pinch.cx, pinch.cy);
        const m = mid(e.touches[0], e.touches[1]);
        const r = stageRect();
        state.view.tx += (m.x - r.left) - pinch.cx;
        state.view.ty += (m.y - r.top) - pinch.cy;
        pinch = { d, cx: m.x - r.left, cy: m.y - r.top };
        applyView();
        e.preventDefault();
        return;
      }
      if (pan && e.touches.length === 1) {
        const t = e.touches[0];
        state.view.tx += t.clientX - pan.x;
        state.view.ty += t.clientY - pan.y;
        pan = { x: t.clientX, y: t.clientY };
        applyView();
        e.preventDefault();
        return;
      }
      if (selecting) selectMove(e);
    };

    const onEnd = (e) => {
      if (pinch) { pinch = null; if (e.touches.length === 0) pan = null; return; }
      if (pan) { if (e.touches.length === 0) pan = null; return; }
      if (selecting) { selecting = false; selectUp(e); }
    };

    el.selectLayer.addEventListener('touchstart', onStart, { passive: false });
    el.selectLayer.addEventListener('touchmove', onMove, { passive: false });
    el.selectLayer.addEventListener('touchend', onEnd);
    el.selectLayer.addEventListener('touchcancel', onEnd);

    // A mouse wheel is the desktop equivalent of a pinch, and makes the
    // behaviour testable in a headless browser.
    el.selectLayer.addEventListener('wheel', (e) => {
      if (!state.frozen) return;
      const r = stageRect();
      zoomAround(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
      e.preventDefault();
    }, { passive: false });
  }

  /* ---- results sheet --------------------------------------------------- */

  /**
   * The sheet overlays the picture instead of resizing it. That is the whole
   * point: a box drawn over a price must stay over that price when an answer
   * appears underneath.
   */
  function setSheetOpen(open) {
    state.sheetOpen = open;
    el.sheet.classList.toggle('open', open);
    el.sheetHandle.setAttribute('aria-expanded', String(open));
    el.sheetHandleLabel.textContent = open ? 'Collapse the results' : 'Expand the results';
    if (!open) el.sheet.scrollTop = 0;
  }

  /** Draw a tappable marker over every number the scan found. */
  function renderHits(result) {
    el.hits.innerHTML = '';
    const r = result || lastResults;
    if (!r || !state.frozen || !r.ranked) return;


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
      label.textContent = vndPerUnit() ? money(c.vnd) : VPC.formatVnd(c.vnd);
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
      const frame = drawIntoStill(img, img.naturalWidth, img.naturalHeight);
      freeze(frame);

      state.chosen = null;
      runScan(async () => prepareCanvas(frame.canvas, frame.w, frame.h, null), 'file')
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

    const pick = Math.min(state.chosen || 0, ranked.length - 1);
    const best = ranked[pick];
    el.hero.hidden = false;
    el.resultActions.hidden = false;
    el.heroVnd.textContent = VPC.formatVnd(best.vnd);
    el.heroTwd.textContent = money(best.vnd);

    el.heroFlags.innerHTML = '';
    if (best.assumed) addFlag('assumed ×1.000');
    if (!vndPerUnit()) addFlag('no rate yet');
    else if (isManual()) addFlag('your rate');
    else if (state.rates && Date.now() - state.rates.fetchedAt > 3 * 864e5) {
      addFlag('rate ' + ago(state.rates.fetchedAt));
    }
    if (state.rounding !== 'nearest') addFlag('rounded ' + state.rounding);

    // Every other reading stays one tap away — on a shelf full of barcodes the
    // ranking is a suggestion, not a verdict.
    el.more.innerHTML = '';
    ranked.forEach((c, i) => {
      if (i === pick) return;
      const li = document.createElement('li');
      li.tabIndex = 0;
      const twd = document.createElement('span');
      twd.className = 'm-twd';
      twd.textContent = money(c.vnd);
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

  /** Carry over the single-currency rate an earlier version saved. */
  function migrateOldRate() {
    const old = loadJson('vpc.rate');
    if (!old || !old.vndPerTwd) return;
    if (old.manual) state.manual.TWD = old.vndPerTwd;
    else if (!loadJson(RATE_KEY)) {
      saveJson(RATE_KEY, { values: { TWD: old.vndPerTwd }, source: old.source || 'saved', fetchedAt: old.fetchedAt || Date.now() });
    }
    saveJson(MANUAL_KEY, state.manual);
    try { localStorage.removeItem('vpc.rate'); } catch (e) { /* private mode */ }
  }

  /** Fill the picker, marking which currencies actually have a rate. */
  function buildCurrencyList() {
    el.currencySelect.innerHTML = '';
    for (const [code, cur] of Object.entries(VPC.CURRENCIES)) {
      const known = (state.rates && state.rates.values[code]) || state.manual[code];
      const o = document.createElement('option');
      o.value = code;
      o.textContent = code + ' · ' + cur.name + (known ? '' : ' (no rate yet)');
      el.currencySelect.appendChild(o);
    }
    el.currencySelect.value = state.currency;
  }

  function loadOpts() {
    const saved = loadJson(OPTS_KEY);
    if (saved) Object.assign(state.opts, saved);
    if (saved && VPC.CURRENCIES[saved.currency]) state.currency = saved.currency;
    if (saved && ['up', 'down', 'nearest'].includes(saved.rounding)) state.rounding = saved.rounding;
    el.optThousands.checked = state.opts.thousands;
    el.optDigits.checked = state.opts.digits;
    el.optRaw.checked = state.opts.raw;
    el.rawWrap.hidden = !state.opts.raw;
  }

  function saveOpts() {
    saveJson(OPTS_KEY, Object.assign({}, state.opts, {
      currency: state.currency,
      rounding: state.rounding,
    }));
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
    el.modeSelect.addEventListener('click', () => setOneFinger('select'));
    el.modeMove.addEventListener('click', () => setOneFinger('move'));
    el.zoomIn.addEventListener('click', () => {
      const r = stageRect();
      zoomAround(1.6, r.width / 2, r.height / 2);
    });
    el.zoomOut.addEventListener('click', () => {
      const r = stageRect();
      zoomAround(1 / 1.6, r.width / 2, r.height / 2);
    });
    el.sheetHandle.addEventListener('click', () => setSheetOpen(!state.sheetOpen));
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
      setManualRate(state.currency, 0);
      toast('Back to the published rate for ' + state.currency);
      await refreshRate(true);
    });
    el.rateInput.addEventListener('change', () => {
      const v = parseFloat(el.rateInput.value);
      if (v > 0) {
        setManualRate(state.currency, v);
        toast('Using your ' + state.currency + ' rate');
      }
    });
    el.currencySelect.addEventListener('change', () => setCurrency(el.currencySelect.value));
    for (const btn of el.roundBtns) {
      btn.addEventListener('click', () => setRounding(btn.dataset.round));
    }

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

    state.manual = loadJson(MANUAL_KEY) || {};
    migrateOldRate();
    const cached = loadJson(RATE_KEY);
    if (cached && cached.values) applyRates(cached, false);
    await loadFallbackRates();
    if (!state.rates && state.fallbackRates) applyRates(state.fallbackRates, false);
    buildCurrencyList();
    setRounding(state.rounding);
    renderRate();

    // Rates older than six hours are worth a quiet refresh.
    if (!state.rates || Date.now() - state.rates.fetchedAt > 6 * 3600e3) refreshRate(false);

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
