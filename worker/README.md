# Support API (Cloudflare Worker + D1)

A small Worker that backs two optional things. **The app does not need it.**
Scanning, converting and offline use all happen on the phone; this is only
reached when someone reports a bad scan, or if cloud reading is ever switched on.

Live at `https://vietpricechecker-api.internalsys.workers.dev`.

| Route | What it does |
| --- | --- |
| `POST /report` | A tester says a scan was wrong. Stores the photo, what the app read, what it should have said, and a note. |
| `GET /reports?key=…` | The review page: every report as a card with its image. Needs `ADMIN_KEY`. Add `&format=json` for raw data (omits images). |
| `POST /read` | Sends one image to Gemini for a second opinion, so the API key stays server-side instead of in a public web page. |
| `GET /health` | Liveness. |

## Reviewing what testers hit

Open `/reports?key=<ADMIN_KEY>` in a browser. Each card shows the photo, what
the app displayed, what the tester said it should be, the other readings it
considered, and the raw recognised text. Reports where the two disagree are
outlined.

That raw text is the useful part — it says whether recognition misread the
image or the parser misread the text, which are different bugs with different
fixes.

## Storage

Images are base64 in D1 (`reports.image`) rather than R2, because R2 needs a
card on file. The app downscales to 1000px and JPEG q70 first, so a report is
roughly 60–120 KB. D1's free tier holds 5 GB, which is a few tens of thousands
of reports — ample for testing, and the wrong shape for production. If this ever
stops being a POC, move the images to R2 and keep only a key in D1.

Writes are capped at 900 KB per request and rate limited to 40 reports per hour
per client, keyed on a truncated hash of the IP. The address itself is never
stored.

## Bindings

| Name | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 | database `vietpricechecker` |
| `ADMIN_KEY` | secret | guards `/reports` |
| `GEMINI_KEY` | secret | used by `/read` |
| `GEMINI_MODEL` | var (optional) | defaults to `gemini-flash-latest` |

## Schema

```sql
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  app_version TEXT, build TEXT, user_agent TEXT, source TEXT,
  ocr_text TEXT, candidates TEXT,
  shown INTEGER, expected INTEGER, note TEXT,
  image TEXT, ip_hash TEXT
);
CREATE INDEX reports_created ON reports (created_at DESC);
```

## Checking it

```bash
npm run worker                          # read-only, safe against production
ADMIN_KEY=… npm run worker              # also checks the review page
WRITE=1 npm run worker                  # also posts a throwaway report
```

Covers health, routing, the browser preflight, the size cap, the malformed-body
path and that `/reports` refuses a missing or wrong key. It is deliberately not
part of the deploy pipeline — a green deploy of a static site should not depend
on a third party being reachable at that moment.

## Deploying

There is no build step; `index.js` is a module Worker uploaded as-is.

```bash
npx wrangler deploy          # with a wrangler.toml carrying the bindings
```

or straight through the API, which is how it was first deployed:

```bash
curl -X PUT -H "Authorization: Bearer $CF_API_TOKEN" \
  -F 'metadata={"main_module":"index.js","compatibility_date":"2026-01-01",
        "bindings":[{"type":"d1","name":"DB","id":"<database uuid>"}]};type=application/json' \
  -F "index.js=@index.js;type=application/javascript+module" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/vietpricechecker-api"
```

Secrets are set as `secret_text` bindings in that metadata, so they live in
Cloudflare and never in this repository.

## Status of the Gemini second opinion

`/read` is written and deployed but **cannot currently run**. The supplied key
lists models fine, and is refused for every inference call:

```
403  Your project has been denied access. Please contact support.
```

A plain text-only "Say OK" fails the same way, so this is not about images or
about the request shape — the Google Cloud project behind the key is not
enabled for the Generative Language API. Enable it (or issue a key from a
project that is) and `/read` starts working with no code change; the Worker
returns Google's own message verbatim so the cause is visible from the app.

Worth knowing before it is switched on: cloud reading sends the photo off the
device, which is the one privacy promise the app currently makes without
qualification. It should stay opt-in and clearly labelled.
