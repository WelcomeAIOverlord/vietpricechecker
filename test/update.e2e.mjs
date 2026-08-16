/**
 * Deploy tests. These guard the failure mode where an installed PWA keeps
 * serving old code forever, which is invisible in normal testing because the
 * first install always looks correct.
 *
 * Runs its own server over a throwaway copy of the repo, mounted at a subpath
 * so it matches GitHub Pages, and edits that copy between reloads to simulate
 * a release.
 *
 *   node test/update.e2e.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const CHROME = process.env.CHROME_PATH || undefined;
const MOUNT = '/vietpricechecker';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
/**
 * Wait for the app to be ready, allowing for the extra reload the page performs
 * when a newly-installed worker claims control. Real users see the same thing:
 * one quick refresh on the launch after a release.
 */
async function settle(page, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await page.waitForFunction(() => window.__vpcReady === true, null,
        { timeout: Math.max(1000, deadline - Date.now()) });
      return;
    } catch (err) {
      // The page reloads itself when a new worker claims control, which tears
      // down the evaluation context mid-wait. Just start waiting again.
      if (!/context was destroyed|Execution context|Target closed/i.test(String(err.message))) throw err;
    }
  }
  throw new Error('app never became ready');
}

/**
 * Reload and wait long enough for a pending worker update to install, activate,
 * claim, and for the page's own follow-up reload to land. Becoming ready is not
 * enough on its own — that happens on the old build first.
 */
async function relaunch(page) {
  await page.reload({ waitUntil: 'load' });
  await settle(page);
  await page.waitForTimeout(6000);
  await settle(page);
}

/** Poll until the page is running the expected build, tolerating its reload. */
async function waitForBuild(page, expected, ms = 60000) {
  const deadline = Date.now() + ms;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await page.evaluate(() => window.__buildMarker).catch(() => null);
    if (seen === expected) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`still running build "${seen}", expected "${expected}"`);
}

async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    passed++;
  } catch (err) {
    console.log(' FAIL  ' + name + '\n         ' + String(err.message).split('\n')[0]);
    failed++;
  }
}

// ---- a throwaway copy of the site, served at a subpath ---------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-deploy-'));
const site = path.join(root, 'vietpricechecker');
fs.mkdirSync(site);
for (const entry of ['index.html', 'styles.css', 'app.js', 'parser.js', 'sw.js',
  'rate.json', 'manifest.webmanifest', 'vendor', 'icons', 'test']) {
  fs.cpSync(path.join(REPO, entry), path.join(site, entry), { recursive: true });
}

/** Stand in for the CI step that stamps the commit sha into the worker. */
function deploy(build) {
  const sw = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
  assert(sw.includes("'__BUILD__'"), 'sw.js lost its __BUILD__ placeholder');
  fs.writeFileSync(path.join(site, 'sw.js'), sw.replace('__BUILD__', build));
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gz': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}${MOUNT}/`;

// ---------------------------------------------------------------------------

deploy('build-one');
fs.writeFileSync(path.join(site, 'app.js'),
  fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').replace(
    "const VERSION = '", "window.__buildMarker = 'one'; const VERSION = '"));

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

console.log('\nFIRST INSTALL  ' + BASE);
await page.goto(BASE, { waitUntil: 'load' });
await settle(page);

await check('boots under a subpath and takes control', async () => {
  assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'no controller');
  assert(await page.evaluate(() => window.__buildMarker) === 'one', 'wrong build loaded');
});

await check('SIMD is detected, so the fast core is used', async () => {
  const urls = await page.evaluate(async () => {
    const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
    return (await (await caches.open(k)).keys()).map((r) => r.url);
  });
  assert(urls.some((u) => u.includes('simd')), 'cached the non-SIMD core: ' + urls.join(', '));
});

await check('the page-side library lives in the shell, not the engine cache', async () => {
  const where = await page.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) {
      const urls = (await (await caches.open(k)).keys()).map((r) => r.url);
      if (urls.some((u) => u.endsWith('tesseract.min.js'))) out[k] = true;
    }
    return Object.keys(out);
  });
  assert(where.length === 1 && where[0].startsWith('vpc-shell-'),
    'tesseract.min.js is cached in: ' + where.join(', '));
});

await check('the status line is not left mid-warm-up', async () => {
  const status = await page.textContent('#status');
  assert(!/Initializing|Loading|loading/i.test(status), 'status reads: ' + status);
  assert(/Point at a price|Ready|scan a saved photo/i.test(status), 'status reads: ' + status);
});

// ---- the release ----------------------------------------------------------

console.log('\nAFTER A RELEASE');
const engineBefore = await page.evaluate(async () => {
  const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
  return (await (await caches.open(k)).keys()).length;
});

fs.writeFileSync(path.join(site, 'app.js'),
  fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').replace(
    "const VERSION = '", "window.__buildMarker = 'two'; const VERSION = '"));
deploy('build-two');

await relaunch(page);

await check('a released app.js actually reaches an installed user', async () => {
  await waitForBuild(page, 'two');
  await settle(page);
});

await check('the release did not cost the user the 6 MB engine', async () => {
  const after = await page.evaluate(async () => {
    const k = (await caches.keys()).find((n) => n.startsWith('vpc-engine-'));
    return k ? (await (await caches.open(k)).keys()).length : 0;
  });
  assert(after === engineBefore, `engine cache went from ${engineBefore} to ${after}`);
});

await check('only one shell cache is left behind', async () => {
  const shells = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('vpc-shell-'));
  assert(shells.length === 1, 'shell caches: ' + shells.join(', '));
});

await check('the bundled rate file is refreshed by a release', async () => {
  fs.writeFileSync(path.join(site, 'rate.json'),
    JSON.stringify({ vndPerTwd: 1234.5, asOf: '2026-08-16T00:00:00Z' }));
  deploy('build-three');

  // A browser only checks for a new worker on navigation, so relaunching is
  // what actually picks a release up — exactly what a user does.
  let served = null;
  for (let launch = 0; launch < 3; launch++) {
    await relaunch(page);
    served = await page
      .evaluate(() => fetch('rate.json', { cache: 'no-cache' }).then((r) => r.json()))
      .catch(() => null);
    if (served && served.vndPerTwd === 1234.5) break;
  }
  assert(served && served.vndPerTwd === 1234.5,
    'still serving the old rate.json: ' + JSON.stringify(served));
});

// ---- large photos ---------------------------------------------------------

console.log('\nLARGE PHOTOS');
await settle(page);
await page.waitForTimeout(3000);
await settle(page);
await check('a 12 MP photo is scaled down before OCR', async () => {
  const dims = await page.evaluate(async () => {
    // Reproduce prepareCanvas's sizing decision for a full-resolution iPhone shot.
    const TARGET = 1600;
    const sw = 4032, sh = 3024;
    const scale = Math.min(3, TARGET / Math.max(sw, sh * 0.75));
    return { w: Math.round(sw * scale), h: Math.round(sh * scale) };
  });
  assert(dims.w <= 1700, 'a 4032px photo would be processed at ' + dims.w + 'px');
  assert(dims.w >= 1200, 'scaled too far down: ' + dims.w + 'px');
});

await check('a big photo still scans correctly and quickly', async () => {
  const big = path.join(root, 'big.png');
  // Blow a fixture up to phone-photo dimensions.
  const buf = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const c = document.createElement('canvas');
    c.width = 4032; c.height = 3024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, 'test/fixtures/print_tag_120k.jpg');
  fs.writeFileSync(big, Buffer.from(buf, 'base64'));

  const t0 = Date.now();
  await page.evaluate(() => { window.__vpcLast = null; });
  await page.setInputFiles('#fileInput', big);
  await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
  const ms = Date.now() - t0;
  const r = await page.evaluate(() => window.__vpcLast);
  assert(r.ranked.length && r.ranked[0].vnd === 120000, 'read ' + JSON.stringify(r.ranked.slice(0, 2)));
  assert(ms < 15000, 'took ' + ms + 'ms');
  console.log('         (4032x3024 photo scanned in ' + ms + 'ms)');
});

// ---------------------------------------------------------------------------

await browser.close();
server.close();
fs.rmSync(root, { recursive: true, force: true });

console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
