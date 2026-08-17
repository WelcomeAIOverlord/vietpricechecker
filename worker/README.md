# Bad-scan reports (Cloudflare Worker + D1)

**The app does not need this.** Scanning, converting and offline use all happen
on the phone with no network at all. This is reached only when someone taps
*Wrong? Report it*, which is inherently an online action. If it is down, or
deleted outright, the app is unaffected — there are tests that assert exactly
that.

It exists because GitHub Pages is static and cannot receive a report, and
because photographs of prices that actually broke the app are the only way to
keep improving it.

Live at `https://vietpricechecker-api.internalsys.workers.dev`.

| Route | What it does |
| --- | --- |
| `POST /report` | A tester says a scan was wrong. Stores the photo, what the app read, what it should have said, and a note. |
| `GET /reports?key=…` | The review page: every report as a card with its image. Needs `ADMIN_KEY`. Add `&format=json` for raw data (omits images). |
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

## Why there is no cloud recognition

There was a `/read` endpoint that sent an image to Gemini for a second opinion.
It has been removed.

The supplied key was refused for every inference call — including a plain
text-only request — with `403 Your project has been denied access`, so the
project behind it was never enabled for the Generative Language API. That is
fixable, but fixing it was not the right call: cloud recognition only helps
when there is a connection, and it sends the photograph off the device. Both
run against the point of the app, which is to work in a market with no signal
and keep your pictures on your phone.

Recognition stays entirely on the device.
