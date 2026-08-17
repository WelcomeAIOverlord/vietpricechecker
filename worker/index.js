/**
 * Viet Price Checker — bad-scan reports.
 *
 * One job, and the app never depends on it. Scanning, converting and offline
 * use all happen on the phone with no network at all; this is reached only when
 * someone taps "Wrong? Report it", which is inherently an online action. If it
 * is down, or deleted, the app is unaffected.
 *
 *   POST /report   a tester says a scan was wrong. Stores the photo (as base64
 *                  in D1, since R2 needs a card on file) alongside what the app
 *                  read and what the right answer was.
 *   GET  /reports  the review page. Needs ADMIN_KEY.
 *   GET  /health   liveness.
 *
 * Bindings: DB (D1), ADMIN_KEY (secret).
 *
 * There was a /read endpoint that sent an image to Gemini for a second opinion.
 * It is gone: the key was refused for every call, and more to the point it only
 * ever helped online, which is the opposite of what this app is for.
 */

const MAX_BODY = 900 * 1024; // a downscaled JPEG plus its JSON envelope
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

/** Coarse identifier for rate limiting. Never store the address itself. */
async function hashIp(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|vpc'));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tooManyRecently(env, ipHash, limit, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?'
  ).bind(ipHash, since).first();
  return (row && row.n) >= limit;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/report' && request.method === 'POST') {
      return handleReport(request, env);
    }
    if (url.pathname === '/reports' && request.method === 'GET') {
      return handleReports(request, env, url);
    }
    return json({ error: 'not found' }, 404);
  },
};

// ---------------------------------------------------------------------------

async function handleReport(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'payload too large' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: 'bad json' }, 400);
  }

  const ipHash = await hashIp(request);
  if (await tooManyRecently(env, ipHash, 40, 60)) {
    return json({ error: 'too many reports, try again later' }, 429);
  }

  const image = typeof body.image === 'string' ? body.image.slice(0, 800 * 1024) : null;
  const clean = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

  await env.DB.prepare(
    `INSERT INTO reports
       (created_at, app_version, build, user_agent, source, ocr_text,
        candidates, shown, expected, note, image, ip_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    new Date().toISOString(),
    clean(body.appVersion, 32),
    clean(body.build, 64),
    clean(request.headers.get('User-Agent'), 300),
    clean(body.source, 32),
    clean(body.ocrText, 4000),
    clean(JSON.stringify(body.candidates || []), 4000),
    num(body.shown),
    num(body.expected),
    clean(body.note, 500),
    image,
    ipHash
  ).run();

  return json({ ok: true });
}

// ---------------------------------------------------------------------------

async function handleReports(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 100);
  const wantJson = url.searchParams.get('format') === 'json';

  const { results } = await env.DB.prepare(
    `SELECT id, created_at, app_version, build, user_agent, source, ocr_text,
            candidates, shown, expected, note ${wantJson ? '' : ', image'}
       FROM reports ORDER BY id DESC LIMIT ?`
  ).bind(limit).all();

  if (wantJson) {
    return json({ count: results.length, reports: results });
  }
  return new Response(reportsPage(results), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
  });
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const vnd = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US') + ' ₫');

function reportsPage(rows) {
  const cards = rows.map((r) => {
    let cands = [];
    try { cands = JSON.parse(r.candidates || '[]'); } catch (e) { /* ignore */ }
    const wrong = r.expected != null && r.shown != null && r.expected !== r.shown;
    return `
      <article class="${wrong ? 'bad' : ''}">
        <header>
          <b>#${r.id}</b>
          <time>${esc(r.created_at)}</time>
          <span class="tag">${esc(r.source || 'scan')}</span>
          ${r.build ? `<span class="tag">${esc(r.build)}</span>` : ''}
        </header>
        ${r.image ? `<img src="${esc(r.image)}" alt="reported scan">` : '<p class="muted">no image</p>'}
        <dl>
          <dt>app showed</dt><dd>${vnd(r.shown)}</dd>
          <dt>should be</dt><dd class="${wrong ? 'want' : ''}">${vnd(r.expected)}</dd>
          <dt>other readings</dt><dd>${cands.length ? cands.map((c) => vnd(c.vnd)).join(', ') : '—'}</dd>
          ${r.note ? `<dt>note</dt><dd>${esc(r.note)}</dd>` : ''}
        </dl>
        <details><summary>what the camera read</summary><pre>${esc(r.ocr_text)}</pre></details>
        <p class="muted small">${esc(r.user_agent)}</p>
      </article>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan reports</title><style>
:root{color-scheme:dark;--line:#26324a}
body{margin:0;padding:20px;background:#0a1020;color:#eef2f8;
  font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
h1{font-size:19px;margin:0 0 16px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
article{background:#121c31;border:1px solid var(--line);border-radius:14px;padding:14px;overflow:hidden}
article.bad{border-color:#8a5a2a}
header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px}
time{color:#93a1bb;font-size:12px}
.tag{background:#1d2b45;color:#93a1bb;border-radius:999px;padding:2px 8px;font-size:11px}
img{width:100%;border-radius:10px;display:block;background:#05080f}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:12px 0 8px;font-size:14px}
dt{color:#93a1bb}
dd{margin:0;font-variant-numeric:tabular-nums}
dd.want{color:#ffc43d;font-weight:700}
pre{white-space:pre-wrap;word-break:break-word;background:#05080f;padding:10px;
  border-radius:8px;font-size:12px;max-height:200px;overflow:auto}
summary{cursor:pointer;color:#93a1bb;font-size:13px}
.muted{color:#93a1bb}.small{font-size:11px;word-break:break-word}
</style></head><body>
<h1>Scan reports <span class="muted">(${rows.length})</span></h1>
<div class="grid">${cards || '<p class="muted">Nothing reported yet.</p>'}</div>
</body></html>`;
}
