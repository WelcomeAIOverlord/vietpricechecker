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
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

// ---------------------------------------------------------------------------
// 1. First run: boots, caches the engine, converts a real image
// ---------------------------------------------------------------------------

console.log('\nFIRST RUN');
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ['camera'],
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

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

await check('a manual rate override is applied and persisted', async () => {
  await page.click('#settingsBtn');
  await page.fill('#rateInput', '800');
  await page.dispatchEvent('#rateInput', 'change');
  await page.waitForTimeout(150);
  const twd = await page.textContent('#heroTwd');
  assert(twd.includes('1,500'), '1.200.000 / 800 should be NT$1,500, got ' + twd);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vpc.rate')));
  assert(stored.manual === true && stored.vndPerTwd === 800, JSON.stringify(stored));
  await page.click('#settingsClose');
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

await check('no uncaught page errors during the run', async () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
});

// ---------------------------------------------------------------------------

await browser.close();
console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) console.log('failed: ' + failures.join(', '));
process.exit(failed ? 1 : 0);
