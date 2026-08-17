/**
 * Smoke test for the support Worker.
 *
 *   node test/worker.smoke.mjs
 *
 * Read-only by default, so it can be run against production without leaving
 * junk in the reports database. Set WRITE=1 to also post a throwaway report,
 * and ADMIN_KEY=… to check the review page is served and guarded.
 *
 * Deliberately not wired into the deploy pipeline: a green deploy should not
 * depend on a third party being reachable at that moment.
 */
const API = process.env.API_BASE || 'https://vietpricechecker-api.internalsys.workers.dev';
const ADMIN = process.env.ADMIN_KEY || '';
const ORIGIN = process.env.ORIGIN || 'https://welcomeaioverlord.github.io';

let passed = 0;
let failed = 0;

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const post = (path, body, headers) =>
  fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

console.log('\nWORKER  ' + API);

await check('health responds', async () => {
  const r = await fetch(API + '/health');
  assert(r.ok, 'HTTP ' + r.status);
  assert((await r.json()).ok === true, 'unexpected body');
});

await check('an unknown route is a 404', async () => {
  const r = await fetch(API + '/nope');
  assert(r.status === 404, 'HTTP ' + r.status);
});

await check('the browser preflight is answered', async () => {
  const r = await fetch(API + '/report', {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert(r.ok, 'HTTP ' + r.status);
  assert(r.headers.get('access-control-allow-origin') === '*', 'no CORS origin header');
  assert(/POST/.test(r.headers.get('access-control-allow-methods') || ''), 'POST not allowed');
});

await check('a malformed body is refused', async () => {
  const r = await post('/report', 'not json at all');
  assert(r.status === 400, 'HTTP ' + r.status);
});

await check('an oversized report is refused', async () => {
  const r = await post('/report', { image: 'data:image/jpeg;base64,' + 'A'.repeat(1_200_000) });
  assert(r.status === 413, 'HTTP ' + r.status);
});

await check('the review page needs a key', async () => {
  assert((await fetch(API + '/reports')).status === 401, 'reports were served without a key');
  assert((await fetch(API + '/reports?key=obviously-wrong')).status === 401, 'a wrong key was accepted');
});

await check('there is no cloud-reading endpoint', async () => {
  // Deliberately removed: it only helped online, which is the opposite of what
  // this app is for. A 404 here is the desired state, not a gap.
  const r = await post('/read', { image: 'x' });
  assert(r.status === 404, 'HTTP ' + r.status + ' — /read should not exist');
});

if (ADMIN) {
  await check('the review page is served with the key', async () => {
    const r = await fetch(`${API}/reports?key=${encodeURIComponent(ADMIN)}&limit=3`);
    assert(r.ok, 'HTTP ' + r.status);
    assert(/text\/html/.test(r.headers.get('content-type') || ''), 'not HTML');
    assert(/Scan reports/.test(await r.text()), 'unexpected page');
  });

  await check('the json view omits the images', async () => {
    const r = await fetch(`${API}/reports?format=json&limit=3&key=${encodeURIComponent(ADMIN)}`);
    const j = await r.json();
    assert(Array.isArray(j.reports), 'no reports array');
    assert(j.reports.every((x) => x.image === undefined), 'images should not be in the json view');
  });
} else {
  console.log('  skip  review-page checks (set ADMIN_KEY to include them)');
}

if (process.env.WRITE === '1') {
  await check('a report can be stored', async () => {
    const r = await post('/report', {
      appVersion: 'smoke',
      build: 'smoke',
      source: 'self-test',
      ocrText: 'smoke test',
      candidates: [{ vnd: 25000 }],
      shown: 25000,
      expected: 25000,
      note: 'worker smoke test',
    });
    assert(r.ok, 'HTTP ' + r.status);
    assert((await r.json()).ok === true, 'unexpected body');
  });
} else {
  console.log('  skip  write check (set WRITE=1 to include it)');
}

console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
