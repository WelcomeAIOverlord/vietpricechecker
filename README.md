# ₫ → NT$ · Viet Price Checker

Point your phone at a Vietnamese price tag, tap the shutter, and read the price
in New Taiwan dollars. It installs to the iOS home screen and **keeps working
with no internet at all** — the text recognition runs on the phone, not on a
server.

**Live app:** https://welcomeaioverlord.github.io/vietpricechecker/

---

## Install it on your iPhone

1. Open the link above **in Safari** (not Chrome — only Safari can install a
   web app on iOS).
2. Wait a few seconds on first open. It downloads a ~6 MB recognition engine
   once and stores it on the phone. The Settings panel shows `ready · works
   offline` when that has finished.
3. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
4. Open it from the home-screen icon. Allow camera access when asked.

After step 2 you can put the phone in airplane mode and it still scans. The
only thing that needs a connection is refreshing the exchange rate, and it
remembers the last one it saw.

## Using it

- **Shutter button** — frame the price inside the yellow box and tap. The
  result appears at the bottom: the big teal number is the NT$ price, the
  smaller line under it is what it read in đồng.
- **Photo button** (left) — scan a picture already in your library. This runs
  the most thorough recognition, so it is the one to use when a live scan
  struggles.
- **live** (right) — keeps scanning every second or so. Handy for walking down
  a menu; it uses more battery.
- **Type a price** — the field at the bottom accepts `120.000`, `35k`, `1tr2`,
  `1,5 triệu` and so on, which is useful when someone tells you a price out loud.
- **Rate chip** (top left) — tap it to see where the rate came from, refresh it,
  or type your own if you got a different rate at the money changer.

### What the tags mean

| Tag | Meaning |
| --- | --- |
| `assumed ×1.000` | The sign said just `45`, and it was read as 45.000 ₫ — the usual menu shorthand. Turn this off in Settings if you are somewhere that writes full prices. |
| `manual rate` | You typed the rate yourself, so it is not being refreshed. |
| `rate 4d ago` | The saved rate is getting stale; connect once to refresh. |

If several prices are visible, the best guess is shown large and the rest are
listed underneath — useful on a menu.

## What it reads well, and what it does not

Measured against the 41-image benchmark in `test/fixtures` (see below):

| Kind of price | Accuracy |
| --- | --- |
| Clean printed tags (`120.000 đ`, `250.000 VNĐ`) | 8/8 |
| Shorthand (`35k`, `1tr2`, `15 triệu`, `25 nghìn`) | 5/5 |
| Menus and receipts, every price on the list | 3/3 |
| Hard photos — tilted, blurred, glare, dark signage, night noise | 8/8 |
| Handwritten marker on paper or cardboard, chalkboard | 12/13 |
| Things that are **not** prices (dates, phone numbers, weights, opening hours) | 4/4 correctly ignored |

**Honest limits.** The engine is Tesseract, which is trained on print. Block
handwriting of the kind you see on market cardboard works well; genuinely
cursive or very stylised handwriting can still fail, and the one benchmark case
that fails is exactly that. When a scan looks wrong:

- turn on **Show what the camera read** in Settings to see the raw text,
- try the **photo button** instead of the live shutter (more passes),
- or just type the number in.

It reads Latin digits, not Vietnamese words for numbers, so `hai mươi lăm nghìn`
spelled out in full will not be picked up.

## How it works

```
camera frame
   └─ crop to the guide box
      └─ greyscale + contrast stretch, auto-invert for light-on-dark signs
         └─ pass 1  greyscale, single block          ─┐
            pass 2  Otsu black & white, single block  │  stops as soon as a
            pass 3  Otsu, sparse text                 │  reading is structurally
            pass 4  greyscale, sparse text            │  convincing
            pass 5  Otsu, single line, digits only   ─┘
               └─ Vietnamese price grammar (parser.js)
                  └─ rank by size, structure and agreement across passes
                     └─ ÷ exchange rate → NT$
```

`parser.js` is where the domain knowledge lives. It understands thousands
grouping (`120.000`, `120,000`, `120 000`), the `k` / `nghìn` / `ngàn` and
`triệu` / `tr` / `củ` multipliers, compound shorthand (`1tr2` = 1.200.000),
currency markers (`đ`, `₫`, `VND`, `VNĐ`), and the menu convention where a bare
`45` means 45.000 ₫. It also knows what a price is *not*, and rejects dates,
phone numbers, times, percentages, weights and volumes.

It corrects the mistakes Tesseract actually makes on price signs: `O`→`0`,
`l`→`1`, `S`→`5`, and — the big one for handwriting — a mangled zero tail, where
`50.000` comes back as `56.666`. That reading is offered zeroed *and* literally,
so nothing is silently rewritten.

### Deployment

`main` is deployed by `.github/workflows/pages.yml`: it runs all four suites,
stamps the commit sha into `sw.js`, assembles the site without the test and
tooling directories, pushes it to the `gh-pages` branch, and then polls the live
URL until it is serving that commit. Pages is configured to serve `gh-pages`.

### Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css` | The whole UI |
| `app.js` | Camera, image preprocessing, scan passes, ranking, rate handling |
| `parser.js` | Vietnamese price grammar — no browser needed, unit tested |
| `sw.js` | Service worker; separate shell and engine caches |
| `vendor/` | Tesseract runtime and English training data, committed so the app has no CDN dependency |
| `rate.json` | Fallback exchange rate, refreshed weekly by a workflow |

No build step, no framework, no bundler. It is a folder of static files.

### Offline design

Two caches with different lifetimes:

- `vpc-shell-<commit>` — the HTML/CSS/JS, a few hundred KB. The commit sha in
  the name is what makes a release reach people who already installed the app:
  `sw.js` ships a `__BUILD__` placeholder that the deploy workflow replaces, so
  the worker's bytes change on every release, a new one installs, and the whole
  shell is swapped atomically. The page reloads itself once when that happens
  so it is never new HTML running old JavaScript.
- `vpc-engine-vN` — the ~6 MB WebAssembly engine and training data, written by
  the page on first run and **kept across deploys**, so shipping an update never
  costs you another 6 MB download. Bump that name by hand, and only when those
  files actually change.

Nothing you photograph leaves the phone. The only outbound request the app ever
makes is the exchange rate.

## Exchange rate

Fetched from [open.er-api.com](https://open.er-api.com), falling back to
[currency-api](https://github.com/fawazahmed0/exchange-api). Neither needs a key.
The last good rate is saved, and `rate.json` ships a bundled starting value that
`.github/workflows/update-rate.yml` refreshes weekly.

There is no rate that is right to the đồng — what you actually pay at a money
changer or an ATM differs. Treat the number as a good estimate, and use the
manual rate box if you want it to match what you really got.

## Development

```bash
npm install                       # playwright, for the browser tests
npx playwright install chromium
pip install pillow                # for the fixture generator

npm run serve                     # http://localhost:8099
```

Then, in another shell:

```bash
npm test                          # 34 parser unit tests, no browser
npm run e2e                       # app behaviour, offline, installability
npm run update                    # releases reach installed users; big photos
npm run bench                     # OCR accuracy against the committed corpus
npm run test:all                  # all four
```

The fixture corpus is committed, so the benchmark measures the same pixels
everywhere. `python3 tools/make_fixtures.py` regenerates it; CI checks that the
generator still produces what is checked in.

`npm run bench handwritten` runs a single category. Both browser suites accept
`BASE=https://…/` to run against the deployed site instead of localhost, and
`CHROME_PATH=` if Playwright's Chromium lives somewhere unusual.

The benchmark enforces a per-category accuracy floor, so a change that makes
recognition worse fails CI rather than shipping quietly. Every push runs all
four suites before Pages deploys.

`test/update.e2e.mjs` deserves a note: it serves a throwaway copy of the site at
a subpath, edits it between reloads, and checks that a release actually reaches
a browser that already installed the app. That failure mode is invisible in
ordinary testing — the first install always looks right — and it is why `sw.js`
carries a `__BUILD__` placeholder that CI replaces with the commit sha. Do not
remove it, or every future deploy will stop short of the people already using
the app.

Regenerating the icons needs Pillow: `python3 tools/make_icons.py`.

## Licence

MIT for the app code. Bundled dependencies keep their own licences:
[Tesseract.js](https://github.com/naptha/tesseract.js) and the Tesseract engine
are Apache 2.0 (see `vendor/tesseract/`), and the handwriting fonts used only by
the test fixtures are SIL OFL 1.1 (see `test/fonts/README.md`).
