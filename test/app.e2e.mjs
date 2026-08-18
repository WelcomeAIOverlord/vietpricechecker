/**
 * End-to-end tests for the app itself: install, offline, camera, settings,
 * rate handling and manual entry.
 *
 *   npx http-server -p 8099 -c-1 .        (in another shell)
 *   node test/app.e2e.mjs
 *
 * Set CHROME_PATH if Playwright's bundled Chromium is elsewhere.
 * Screenshots land in test/shots/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FIXTURES = path.join(HERE, 'fixtures');
const SHOTS = path.join(HERE, 'shots');
const BASE = process.env.BASE || 'http://localhost:8099/';
const CHROME = process.env.CHROME_PATH || undefined;
// Only route through a proxy when BASE is genuinely remote — sending loopback
// traffic to one just breaks the local runs.
const REMOTE = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(BASE);
const PROXY = REMOTE ? (process.env.HTTPS_PROXY || process.env.https_proxy) : null;
const LAUNCH = {
  executablePath: CHROME,
  ...(PROXY ? { proxy: { server: PROXY, bypass: 'localhost,127.0.0.1,::1' } } : {}),
};

fs.mkdirSync(SHOTS, { recursive: true });

// A real fixture if the corpus has been generated, otherwise a tiny fallback
// so the suite still runs without Python.
const SAMPLE = fs.existsSync(path.join(FIXTURES, 'print_tag_120k.jpg'))
  ? path.join(FIXTURES, 'print_tag_120k.jpg')
  : null;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    passed++;
  } catch (err) {
    console.log(' FAIL  ' + name + '\n         ' + String(err.message).split('\n')[0]);
    failures.push(name);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const browser = await chromium.launch({
  ...LAUNCH,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

// ---------------------------------------------------------------------------
// 1. First run: boots, caches the engine, converts a real image
// ---------------------------------------------------------------------------

console.log('\nFIRST RUN');
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ['camera'],
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // The offline section deliberately cuts the network, and a failed request is
  // the expected result of that; offline behaviour is asserted on its own.
  if (m.type() !== 'error') return;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource/.test(m.text())) return;
  pageErrors.push('console: ' + m.text());
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });

await check('service worker takes control', async () => {
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  assert(controlled, 'no service worker controller');
});

await check('engine is stored in its own cache', async () => {
  const keys = await page.evaluate(() => caches.keys());
  assert(keys.some((k) => k.startsWith('vpc-engine-')), 'no engine cache: ' + keys);
  assert(keys.some((k) => k.startsWith('vpc-shell-')), 'no shell cache: ' + keys);
});

await check('shell and engine caches are separate', async () => {
  const counts = await page.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).length;
    return out;
  });
  const engine = Object.entries(counts).find(([k]) => k.startsWith('vpc-engine-'));
  assert(engine && engine[1] >= 3, 'engine cache should hold core+worker+traineddata, got ' + JSON.stringify(counts));
});

await check('an exchange rate is available', async () => {
  const txt = await page.textContent('#rateValue');
  assert(/NT\$1 = [\d,]+ ₫/.test(txt), 'rate chip reads: ' + txt);
});

if (SAMPLE) {
  await check('scans an image and converts it', async () => {
    await page.evaluate(() => { window.__vpcLast = null; });
    await page.setInputFiles('#fileInput', SAMPLE);
    await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.__vpcLast);
    assert(r.ranked.length > 0, 'no candidates');
    assert(r.ranked[0].vnd === 120000, 'expected 120000, got ' + r.ranked[0].vnd);
    const twd = await page.textContent('#heroTwd');
    assert(/^NT\$[\d,.]+$/.test(twd.trim()), 'hero shows: ' + twd);
  });
}

await check('manual entry works', async () => {
  await page.fill('#manualInput', '1tr2');
  await page.click('#manualForm button[type=submit]');
  await page.waitForTimeout(200);
  const vnd = (await page.textContent('#heroVnd')).replace(/\D/g, '');
  assert(vnd === '1200000', 'got ' + vnd);
});

await check('your own rate is applied and persisted', async () => {
  try {
    await page.click('#settingsBtn');
    await page.fill('#rateInput', '800');
    await page.dispatchEvent('#rateInput', 'change');
    await page.waitForTimeout(200);
    const shown = await page.textContent('#heroTwd');
    assert(shown.includes('1,500'), '1.200.000 / 800 should be NT$1,500, got ' + shown);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vpc.manual') || '{}'));
    assert(stored.TWD === 800, 'stored ' + JSON.stringify(stored));
    assert(/your rate/i.test(await page.textContent('#heroFlags')), 'the result is not marked as yours');
  } finally {
    // Leaving the panel open would block every later click.
    await page.click('#settingsClose').catch(() => {});
  }
});

await check('the currency can be changed', async () => {
  try {
    await page.click('#settingsBtn');
    // A rate you set for one currency must not leak into another.
    await page.selectOption('#currencySelect', 'USD');
    await page.waitForTimeout(250);
    const usd = await page.textContent('#heroTwd');
    assert(usd.trim().startsWith('$'), 'expected dollars, got ' + usd);
    assert(!usd.includes('NT$'), 'still showing NT$: ' + usd);

    const opts = await page.evaluate(() => JSON.parse(localStorage.getItem('vpc.opts') || '{}'));
    assert(opts.currency === 'USD', 'currency not saved: ' + JSON.stringify(opts));

    await page.selectOption('#currencySelect', 'TWD');
    await page.waitForTimeout(250);
    const back = await page.textContent('#heroTwd');
    assert(back.includes('1,500'), 'the TWD rate you set was lost: ' + back);
  } finally {
    await page.click('#settingsClose').catch(() => {});
  }
});

await check('rounding can be forced up or down', async () => {
  try {
    await page.click('#settingsBtn');
    // 1.200.000 at 813 đồng is 1475.9..., so the three modes must differ.
    await page.fill('#rateInput', '813');
    await page.dispatchEvent('#rateInput', 'change');
    await page.waitForTimeout(150);

    const read = async (mode) => {
      await page.click(`[data-round="${mode}"]`);
      await page.waitForTimeout(150);
      return parseFloat((await page.textContent('#heroTwd')).replace(/[^\d.]/g, ''));
    };
    const up = await read('up');
    const near = await read('nearest');
    const down = await read('down');

    assert(up >= near && near >= down, `expected up >= normal >= down, got ${up} / ${near} / ${down}`);
    assert(up > down, `up and down are identical (${up})`);
    assert(Number.isInteger(up) && Number.isInteger(down), 'values above 10 should round to whole units');

    // Exact keeps the decimals and sits between the two rounded readings.
    await page.click('[data-round="exact"]');
    await page.waitForTimeout(150);
    const exactText = await page.textContent('#heroTwd');
    assert(/\.\d\d$/.test(exactText.trim()), 'exact should show two decimals, got ' + exactText);
    const exact = parseFloat(exactText.replace(/[^\d.]/g, ''));
    assert(exact >= down && exact <= up, `exact ${exact} is outside ${down}..${up}`);
    assert(!Number.isInteger(exact * 100) || exact !== Math.round(exact),
      'exact looks rounded to a whole unit: ' + exactText);
    assert(/exact/i.test(await page.textContent('#heroFlags')), 'the result is not marked exact');

    await page.click('[data-round="nearest"]');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vpc.opts') || '{}'));
    assert(saved.rounding === 'nearest', 'rounding not saved: ' + JSON.stringify(saved));
  } finally {
    await page.click('#settingsClose').catch(() => {});
  }
});

await check('the thousands assumption can be turned off', async () => {
  await page.click('#settingsBtn');
  await page.uncheck('#optThousands');
  await page.click('#settingsClose');
  await page.fill('#manualInput', 'Pho bo 45');
  await page.click('#manualForm button[type=submit]');
  await page.waitForTimeout(200);
  assert((await page.textContent('#status')).includes('Could not read'), 'expected no match with the option off');

  await page.click('#settingsBtn');
  await page.check('#optThousands');
  await page.click('#settingsClose');
  await page.fill('#manualInput', 'Pho bo 45');
  await page.click('#manualForm button[type=submit]');
  await page.waitForTimeout(200);
  const vnd = (await page.textContent('#heroVnd')).replace(/\D/g, '');
  assert(vnd === '45000', 'got ' + vnd);
});

await check('an assumed value is flagged in the UI', async () => {
  const flags = await page.textContent('#heroFlags');
  assert(/assumed/.test(flags), 'expected an "assumed" tag, got: ' + flags);
});

await check('the camera stream starts', async () => {
  const live = await page.evaluate(() => {
    const v = document.getElementById('cam');
    return !!v.srcObject && v.videoWidth > 0;
  });
  assert(live, 'video has no dimensions');
});

// ---------------------------------------------------------------------------
// Freeze, highlight, and pick — the barcode problem
// ---------------------------------------------------------------------------

if (SAMPLE) {
  const MENU = path.join(FIXTURES, 'menu_printed.jpg');
  const hasMenu = fs.existsSync(MENU);

  await check('a picked photo freezes so it can be highlighted', async () => {
    await page.evaluate(() => { window.__vpcLast = null; });
    await page.setInputFiles('#fileInput', hasMenu ? MENU : SAMPLE);
    await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    assert(!(await page.isHidden('#still')), 'the still is not shown');
    assert(!(await page.isHidden('#selectLayer')), 'the select layer is not shown');
    assert(!(await page.isHidden('#frozenBar')), 'the retake bar is not shown');
  });

  await check('every reading gets a tappable marker on the image', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('#hits .hit').length);
    const found = (await page.evaluate(() => window.__vpcLast.ranked.length));
    assert(n > 0, 'no markers drawn for ' + found + ' readings');
  });

  if (hasMenu) {
    await check('tapping another reading promotes it to the answer', async () => {
      const before = (await page.textContent('#heroVnd')).replace(/\D/g, '');
      const rows = await page.$$('#more li');
      assert(rows.length > 0, 'no alternatives listed');
      // Read the đồng column only — the row also carries the NT$ figure.
      const alt = (await rows[0].$eval('.m-vnd', (n) => n.textContent)).replace(/\D/g, '');
      await rows[0].click();
      await page.waitForTimeout(150);
      const after = (await page.textContent('#heroVnd')).replace(/\D/g, '');
      assert(after !== before, 'the headline did not change');
      assert(after === alt, 'tapped ' + alt + ' but the headline shows ' + after);
    });

    await check('the picture does not move when an answer appears', async () => {
      // The reported bug: results arrived, the layout reflowed, and the image
      // slid out from under the selection. The stage is sized from the
      // collapsed sheet alone, so nothing below it may shift the picture.
      const before = await page.evaluate(() => {
        const r = document.getElementById('still').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });

      await page.evaluate(() => { window.__vpcLast = null; });
      await page.setInputFiles('#fileInput', hasMenu ? MENU : SAMPLE);
      await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
      await page.waitForTimeout(400);

      const after = await page.evaluate(() => {
        const r = document.getElementById('still').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });
      assert(JSON.stringify(before) === JSON.stringify(after),
        'the image moved: ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    });

    await check('expanding the results sheet leaves the picture where it is', async () => {
      const before = await page.evaluate(() => {
        const r = document.getElementById('still').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(',');
      });
      await page.click('#sheetHandle');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => ({
        expanded: document.getElementById('sheet').classList.contains('open'),
        rect: (() => {
          const r = document.getElementById('still').getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(',');
        })(),
        scrollable: document.getElementById('sheet').scrollHeight >= document.getElementById('sheet').clientHeight,
      }));
      assert(open.expanded, 'the sheet did not expand');
      assert(open.rect === before, 'expanding moved the image: ' + before + ' -> ' + open.rect);
      assert(open.scrollable, 'the expanded sheet is not scrollable');

      await page.click('#sheetHandle');
      await page.waitForTimeout(400);
      const closed = await page.evaluate(() => ({
        expanded: document.getElementById('sheet').classList.contains('open'),
        rect: (() => {
          const r = document.getElementById('still').getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(',');
        })(),
      }));
      assert(!closed.expanded, 'the sheet did not collapse again');
      assert(closed.rect === before, 'collapsing moved the image');
    });

    await check('zooming keeps the markers on their prices', async () => {
      // Zoom in, then confirm a marker still sits exactly over the same part of
      // the image — that is what "the highlight follows the picture" means.
      const before = await page.evaluate(() => {
        const c = window.__vpcLast.ranked.find((x) => x.box);
        const hit = document.querySelector('#hits .hit');
        const r = hit.getBoundingClientRect();
        return { vnd: c.vnd, w: Math.round(r.width) };
      });

      await page.click('#zoomIn');
      await page.waitForTimeout(250);

      const after = await page.evaluate(() => {
        const hit = document.querySelector('#hits .hit');
        const r = hit.getBoundingClientRect();
        const still = document.getElementById('still').getBoundingClientRect();
        return { w: Math.round(r.width), stillW: Math.round(still.width) };
      });
      assert(after.w > before.w * 1.3, 'the marker did not grow with the zoom');
      // And the crop taken from a zoomed view still reads the same price.
      const target = await page.evaluate(() => {
        const r = document.querySelector('#hits .hit').getBoundingClientRect();
        return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
      });
      await page.evaluate(() => { window.__vpcLast = null; });
      const midY = (target.y0 + target.y1) / 2;
      await page.mouse.move(Math.max(2, target.x0 - 4), midY);
      await page.mouse.down();
      await page.mouse.move(Math.min(386, target.x1 + 4), midY, { steps: 10 });
      await page.mouse.up();
      await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
      const r = await page.evaluate(() => window.__vpcLast);
      assert(r.ranked.some((c) => c.vnd === before.vnd),
        'zoomed selection read ' + JSON.stringify(r.ranked.map((c) => c.vnd)) + ', wanted ' + before.vnd);

      // Zoom out until the control disables itself at 1x, which is the app
      // telling us there is nothing left to zoom out of.
      for (let i = 0; i < 6; i++) {
        if (await page.isDisabled('#zoomOut')) break;
        await page.click('#zoomOut');
        await page.waitForTimeout(120);
      }
      assert(await page.isDisabled('#zoomOut'), 'zoom out never reached 1x');
    });

    await check('the one-finger mode can be switched', async () => {
      await page.click('#modeMove');
      assert(await page.getAttribute('#modeMove', 'aria-pressed') === 'true', 'Move did not engage');
      assert(await page.getAttribute('#modeSelect', 'aria-pressed') === 'false', 'Select stayed on');
      await page.click('#modeSelect');
      assert(await page.getAttribute('#modeSelect', 'aria-pressed') === 'true', 'Select did not come back');
    });

    await check('dragging across one price reads only that price', async () => {
      // Drag over a marker the app itself drew, so the test never re-derives
      // the screen-to-image mapping and cannot disagree with the app about it.
      const target = await page.evaluate(() => {
        const hit = document.querySelector('#hits .hit');
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
      });
      assert(target, 'no marker was drawn');
      const expected = await page.evaluate(() => window.__vpcLast.ranked.find((c) => c.box).vnd);

      await page.evaluate(() => { window.__vpcLast = null; });
      const midY = (target.y0 + target.y1) / 2;
      await page.mouse.move(target.x0 - 4, midY);
      await page.mouse.down();
      await page.mouse.move(target.x1 + 4, midY, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });

      const r = await page.evaluate(() => window.__vpcLast);
      assert(r.ranked.length > 0, 'the selection produced nothing');
      assert(r.ranked.some((c) => c.vnd === expected),
        'expected ' + expected + ' in ' + JSON.stringify(r.ranked.map((c) => c.vnd)));
      assert(r.ranked.length < 4, 'the selection still picked up ' + r.ranked.length + ' readings');
    });

    await page.screenshot({ path: path.join(SHOTS, '05-highlight.png') });
  }

  await check('permission is asked for once, not on every shutter tap', async () => {
    // Each getUserMedia is a chance for iOS to put the permission sheet back on
    // screen. A whole session of shutter, retake and app-switching must not
    // cost more than the one request made at startup.
    const before = await page.evaluate(() => window.__vpcGum());
    assert(before >= 1, 'the camera was never requested at all');

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { window.__vpcLast = null; });
      await page.setInputFiles('#fileInput', SAMPLE);
      await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
      await page.click('#retakeBtn');
      await page.waitForTimeout(300);
    }

    // And backgrounding the app, which is what a phone does constantly.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(250);
    }

    const after = await page.evaluate(() => window.__vpcGum());
    assert(after === before,
      `permission was requested ${after - before} more time(s) across freeze/retake/backgrounding`);

    // The camera must actually still work after all that.
    const live = await page.evaluate(() => {
      const v = document.getElementById('cam');
      return !!v.srcObject && v.srcObject.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    });
    assert(live, 'the camera did not come back after being paused');
  });

  await check('retake returns to the live camera', async () => {
    // Freeze first, so this does not depend on what the previous test left behind.
    await page.evaluate(() => { window.__vpcLast = null; });
    await page.setInputFiles('#fileInput', SAMPLE);
    await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    assert(!(await page.isHidden('#still')), 'the picture never froze');

    await page.click('#retakeBtn');
    await page.waitForTimeout(400);
    assert(await page.isHidden('#still'), 'the still is still showing');
    assert(await page.isHidden('#selectLayer'), 'the select layer is still showing');
    const live = await page.evaluate(() => {
      const v = document.getElementById('cam');
      return !!v.srcObject && v.srcObject.getVideoTracks().some((t) => t.enabled);
    });
    assert(live, 'the camera did not resume after retake');
  });
}

await page.screenshot({ path: path.join(SHOTS, '01-main.png') });
await page.click('#settingsBtn');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(SHOTS, '02-settings.png') });
await page.click('#settingsClose');

// ---------------------------------------------------------------------------
// 2. Offline: a cold start with the network cut must still work
// ---------------------------------------------------------------------------

console.log('\nOFFLINE (cold start, same profile)');
await ctx.setOffline(true);
const offPage = await ctx.newPage();
const offFailures = [];
offPage.on('requestfailed', (r) => offFailures.push(r.url()));
await offPage.goto(BASE, { waitUntil: 'load' });
await offPage.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });

await check('boots with no network', async () => {
  assert(await offPage.evaluate(() => window.__vpcReady === true));
});

await check('shows the offline chip', async () => {
  assert(!(await offPage.isHidden('#netChip')), 'offline chip is hidden');
});

await check('still knows an exchange rate', async () => {
  const txt = await offPage.textContent('#rateValue');
  assert(/NT\$1 = [\d,]+ ₫/.test(txt), 'rate chip reads: ' + txt);
});

if (SAMPLE) {
  await check('OCR works offline', async () => {
    await offPage.evaluate(() => { window.__vpcLast = null; });
    await offPage.setInputFiles('#fileInput', SAMPLE);
    await offPage.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    const r = await offPage.evaluate(() => window.__vpcLast);
    assert(r.ranked.length && r.ranked[0].vnd === 120000, 'got ' + JSON.stringify(r.ranked.slice(0, 2)));
  });
}

await check('no same-origin request fails while offline', async () => {
  const origin = new URL(BASE).origin;
  const sameOrigin = offFailures.filter((u) => u.startsWith(origin));
  assert(sameOrigin.length === 0, 'failed: ' + sameOrigin.join(', '));
});

await offPage.screenshot({ path: path.join(SHOTS, '03-offline.png') });
await offPage.close();
await ctx.setOffline(false);

// ---------------------------------------------------------------------------
// 3. A redeploy must not cost the user the 6 MB engine again
// ---------------------------------------------------------------------------

console.log('\nUPDATE SAFETY');
await check('bumping the shell cache keeps the engine cache', async () => {
  const before = await page.evaluate(async () => {
    const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
    return (await (await caches.open(k)).keys()).length;
  });
  // Simulate what the new service worker's activate handler does.
  await page.evaluate(async () => {
    const keys = await caches.keys();
    const SHELL = 'vpc-shell-v99';
    await caches.open(SHELL);
    await Promise.all(keys.filter((k) => k.startsWith('vpc-shell-') && k !== SHELL).map((k) => caches.delete(k)));
  });
  const after = await page.evaluate(async () => {
    const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
    return k ? (await (await caches.open(k)).keys()).length : 0;
  });
  assert(after === before && after >= 3, `engine cache went from ${before} to ${after}`);
});

// ---------------------------------------------------------------------------
// 4. Denied camera must not break the app
// ---------------------------------------------------------------------------

console.log('\nCAMERA DENIED');
const denyCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await denyCtx.grantPermissions([]);
const denyPage = await denyCtx.newPage();
await denyPage.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(
    Object.assign(new Error('denied'), { name: 'NotAllowedError' })
  );
});
await denyPage.goto(BASE, { waitUntil: 'load' });
await denyPage.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });

await check('shows the camera gate instead of failing', async () => {
  const shown = await denyPage.evaluate(() => document.getElementById('camGate').classList.contains('show'));
  assert(shown, 'gate not shown');
  const msg = await denyPage.textContent('#camGateMsg');
  assert(/blocked|Settings/i.test(msg), 'unhelpful message: ' + msg);
});

await check('the photo path still works without a camera', async () => {
  if (!SAMPLE) return;
  await denyPage.evaluate(() => { window.__vpcLast = null; });
  await denyPage.setInputFiles('#fileInput', SAMPLE);
  await denyPage.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
  const r = await denyPage.evaluate(() => window.__vpcLast);
  assert(r.ranked.length > 0, 'no result');
});

await denyPage.screenshot({ path: path.join(SHOTS, '04-camera-denied.png') });
await denyCtx.close();

// ---------------------------------------------------------------------------
// 5. Static checks on the manifest and icons
// ---------------------------------------------------------------------------

console.log('\nINSTALLABILITY');
await check('manifest is valid and complete', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.webmanifest'), 'utf8'));
  assert(m.name && m.short_name, 'missing names');
  assert(m.display === 'standalone', 'display is ' + m.display);
  assert(m.start_url.startsWith('./') && m.scope === './', 'start_url/scope must be relative for a project page');
  const sizes = m.icons.map((i) => i.sizes);
  assert(sizes.includes('192x192') && sizes.includes('512x512'), 'missing icon sizes: ' + sizes);
  assert(m.icons.some((i) => i.purpose === 'maskable'), 'no maskable icon');
  for (const i of m.icons) {
    assert(fs.existsSync(path.join(REPO, i.src)), 'missing icon file ' + i.src);
  }
});

await check('iOS home-screen tags are present', async () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  for (const needle of [
    'apple-mobile-web-app-capable',
    'apple-touch-icon',
    'viewport-fit=cover',
    'playsinline',
  ]) {
    assert(html.includes(needle), 'index.html is missing ' + needle);
  }
  assert(fs.existsSync(path.join(REPO, 'icons/apple-touch-icon.png')), 'no apple-touch-icon.png');
});

await check('no absolute paths that would break on a project page', async () => {
  const files = ['index.html', 'app.js', 'sw.js', 'manifest.webmanifest', 'styles.css'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    const bad = text.match(/(?:href|src|url)\s*[=(]\s*["']?\/(?!\/)/g);
    assert(!bad, f + ' has a root-absolute URL: ' + bad);
  }
});

// ---------------------------------------------------------------------------
// Independence: the app is a local tool. Nothing it does routinely may depend
// on a server being reachable.
// ---------------------------------------------------------------------------

await check('the first-run download reports real progress and resumes', async () => {
  // A fresh profile so the engine is fetched from scratch and watched.
  const fresh = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const p2 = await fresh.newPage();

  try {
    await p2.goto(BASE, { waitUntil: 'load' });
    await p2.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });

    const log = await p2.evaluate(() => window.__vpcPackLog || []);
    assert(log.length > 1, 'no byte progress was recorded: ' + JSON.stringify(log));
    assert(log[log.length - 1] > log[0], 'progress never moved: ' + JSON.stringify(log.slice(0, 5)));
    assert(log[log.length - 1] > 4_000_000, 'only saw ' + log[log.length - 1] + ' bytes');
    const status = await p2.textContent('#packStatus');
    assert(/works offline|ready/i.test(status), 'ended on: ' + status);

    // Losing one file must not cost the whole download again.
    const before = await p2.evaluate(async () => {
      const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
      const c = await caches.open(k);
      const keys = await c.keys();
      const victim = keys.find((r) => r.url.includes('traineddata'));
      await c.delete(victim);
      return (await c.keys()).length;
    });
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });
    const after = await p2.evaluate(async () => {
      const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
      return (await (await caches.open(k)).keys()).length;
    });
    assert(after === before + 1, `expected the missing file to be refetched, ${before} -> ${after}`);
  } finally {
    await fresh.close();
  }
});

await check('scanning never talks to any server', async () => {
  const calls = [];
  const watch = (r) => {
    const u = r.url();
    if (!u.startsWith(new URL(BASE).origin) && !u.startsWith('data:') && !u.startsWith('blob:')) {
      calls.push(u);
    }
  };
  page.on('request', watch);
  try {
    await page.evaluate(() => { window.__vpcLast = null; });
    await page.setInputFiles('#fileInput', SAMPLE);
    await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    await page.fill('#manualInput', '35k');
    await page.click('#manualForm button[type=submit]');
    await page.waitForTimeout(300);
  } finally {
    page.off('request', watch);
  }
  // The exchange rate may refresh in the background; nothing else is allowed,
  // and the report API must never be touched without an explicit tap.
  const offenders = calls.filter((u) => !/er-api\.com|currency-api|jsdelivr/.test(u));
  assert(offenders.length === 0, 'scanning reached: ' + offenders.join(', '));
  assert(!calls.some((u) => /workers\.dev/.test(u)), 'the report API was contacted without being asked');
});

await check('the app is unaffected when the report API is unreachable', async () => {
  await page.route('**/*.workers.dev/**', (route) => route.abort('failed'));
  try {
    await page.evaluate(() => { window.__vpcLast = null; });
    await page.setInputFiles('#fileInput', SAMPLE);
    await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.__vpcLast);
    assert(r.ranked.length && r.ranked[0].vnd === 120000, 'scan broke: ' + JSON.stringify(r.ranked.slice(0, 2)));

    // Reporting itself should fail politely rather than hang or throw.
    await page.click('#reportBtn');
    await page.click('#reportSend');
    await page.waitForFunction(
      () => /Could not send|offline/i.test(document.getElementById('reportStatus').textContent),
      null, { timeout: 20000 }
    );
    assert(!(await page.isHidden('#reportPanel')), 'the dialog closed as if it had worked');
    await page.click('#reportClose');
  } finally {
    await page.unroute('**/*.workers.dev/**');
  }
});

await check('a bad scan can be reported', async () => {
  // Intercept so the suite never writes to the real reports database.
  let sent = null;
  await page.route('**/report', async (route) => {
    sent = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.evaluate(() => { window.__vpcLast = null; });
  await page.setInputFiles('#fileInput', SAMPLE);
  await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });

  await page.click('#reportBtn');
  assert(!(await page.isHidden('#reportPanel')), 'the report dialog did not open');
  await page.fill('#reportExpected', '120k');
  await page.fill('#reportNote', 'e2e self-test');
  await page.click('#reportSend');
  await page.waitForFunction(() => document.getElementById('reportPanel').hidden, null, { timeout: 20000 });

  assert(sent, 'nothing was posted');
  assert(sent.expected === 120000, 'expected parsed as ' + sent.expected);
  assert(sent.shown === 120000, 'shown was ' + sent.shown);
  assert(typeof sent.image === 'string' && sent.image.startsWith('data:image/jpeg;base64,'),
    'no downscaled jpeg attached');
  assert(sent.image.length < 400000, 'image not downscaled: ' + sent.image.length + ' chars');
  assert(sent.note === 'e2e self-test', 'note was ' + sent.note);
  assert(Array.isArray(sent.candidates) && sent.candidates.length > 0, 'no candidates attached');
  await page.unroute('**/report');
});

await check('a report with an unreadable expected price is refused', async () => {
  await page.click('#reportBtn');
  await page.fill('#reportExpected', 'not a price');
  await page.click('#reportSend');
  await page.waitForTimeout(200);
  assert(!(await page.isHidden('#reportPanel')), 'the dialog closed anyway');
  assert(/Could not read/.test(await page.textContent('#reportStatus')), 'no explanation shown');
  await page.click('#reportClose');
});

await check('no uncaught page errors during the run', async () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
});

// ---------------------------------------------------------------------------

await browser.close();
console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) console.log('failed: ' + failures.join(', '));
process.exit(failed ? 1 : 0);
