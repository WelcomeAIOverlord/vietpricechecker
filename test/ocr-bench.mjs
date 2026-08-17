/**
 * OCR benchmark — drives the real published page in a headless browser and
 * feeds it the synthetic corpus from tools/make_fixtures.py.
 *
 *   python3 tools/make_fixtures.py
 *   node test/ocr-bench.mjs                 # everything
 *   node test/ocr-bench.mjs handwritten     # one category
 *   BASE=https://user.github.io/repo/ node test/ocr-bench.mjs   # against production
 *
 * Exits non-zero if any category falls under the floor in THRESHOLDS.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
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
const ONLY = process.argv[2];

// Minimum share of each category that must land on the exact expected value.
// Handwriting is deliberately lower: Tesseract is a print engine, and the
// number here is what the multi-pass scan actually delivers, not a wish.
const THRESHOLDS = {
  'printed-clean': 1.0,
  'printed-shorthand': 1.0,
  'menu': 1.0,
  'receipt': 1.0,
  'printed-hard': 1.0,
  'handwritten': 0.85,
  'negative': 1.0,
  'currency-glyph': 1.0,
};

if (!fs.existsSync(path.join(FIXTURES, 'index.json'))) {
  console.error('No fixtures. Run: python3 tools/make_fixtures.py');
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8'));
const cases = ONLY ? index.filter((c) => c.category === ONLY) : index;
if (!cases.length) {
  console.error('No fixtures match', ONLY);
  process.exit(2);
}

const browser = await chromium.launch(LAUNCH);
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__vpcReady === true, null, { timeout: 180000 });
console.log('app ready at', BASE, '\n');

async function scan(file) {
  await page.evaluate(() => { window.__vpcLast = null; });
  await page.setInputFiles('#fileInput', path.join(FIXTURES, file));
  await page.waitForFunction(() => window.__vpcLast !== null, null, { timeout: 120000 });
  return page.evaluate(() => window.__vpcLast);
}

const rows = [];
for (const c of cases) {
  const t0 = Date.now();
  let result;
  try {
    result = await scan(c.file);
  } catch (err) {
    rows.push({ ...c, ok: false, got: null, all: [], ms: Date.now() - t0, error: String(err.message).slice(0, 80) });
    continue;
  }
  const all = result.ranked.map((r) => r.vnd);
  const top = all.length ? all[0] : null;

  let ok;
  if (c.expect === null) {
    ok = all.length === 0; // a negative must produce nothing at all
  } else if (c.mustInclude && c.mustInclude.length) {
    ok = c.mustInclude.every((v) => all.includes(v));
  } else {
    ok = top === c.expect;
  }

  rows.push({ ...c, ok, got: top, all, ms: Date.now() - t0, raw: (result.text || '').replace(/\s+/g, ' ').slice(0, 70) });
}

// ---- report --------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const money = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));

let currentCat = null;
for (const r of rows) {
  if (r.category !== currentCat) {
    currentCat = r.category;
    console.log('\n' + currentCat.toUpperCase());
  }
  const mark = r.ok ? '  ok ' : ' FAIL';
  const want = r.mustInclude && r.mustInclude.length
    ? r.mustInclude.map(money).join('/')
    : money(r.expect);
  console.log(
    `${mark} ${pad(r.file, 28)} want ${pad(want, 26)} got ${pad(r.all.map(money).join(', ') || '(none)', 34)} ${String(r.ms).padStart(5)}ms`
  );
  if (!r.ok && r.raw) console.log(`      read: "${r.raw}"`);
  if (r.error) console.log(`      error: ${r.error}`);
}

const cats = [...new Set(rows.map((r) => r.category))];
let failed = false;
console.log('\n' + '─'.repeat(72));
for (const cat of cats) {
  const sub = rows.filter((r) => r.category === cat);
  const passed = sub.filter((r) => r.ok).length;
  const rate = passed / sub.length;
  const floor = THRESHOLDS[cat] ?? 0;
  const bad = rate < floor - 1e-9;
  if (bad) failed = true;
  console.log(
    `${bad ? 'FAIL' : ' ok '} ${pad(cat, 20)} ${passed}/${sub.length}  ${(rate * 100).toFixed(0).padStart(3)}%   floor ${(floor * 100).toFixed(0)}%`
  );
}
const total = rows.filter((r) => r.ok).length;
const median = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log('─'.repeat(72));
console.log(`overall ${total}/${rows.length} (${((total / rows.length) * 100).toFixed(0)}%)   median scan ${median}ms`);

if (jsErrors.length) {
  console.log('\nJS errors during the run:');
  for (const e of [...new Set(jsErrors)].slice(0, 10)) console.log('  ' + e);
  failed = true;
}

await browser.close();
process.exit(failed ? 1 : 0);
