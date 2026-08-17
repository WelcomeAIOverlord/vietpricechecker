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
2. Wait on first open while it downloads the recognition engine — 5.8 MB, once,
   ever. It shows the megabytes as they arrive, and finished files are kept, so
   if the connection drops you can reconnect and it picks up where it stopped
   rather than starting over. Settings shows `ready · works offline` when done.
   **Do this on wifi before you travel.**
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
- **Highlight the price** — after the shutter the picture freezes. Drag across
  the price (a rough swipe along the line is enough) to read only that part.
  This is the answer to shelf labels with a barcode next to them: crop the
  barcode out and it cannot be misread.
- **Zoom** — pinch with two fingers, or double-tap, or use −/+. Two fingers
  always pinch and pan, whatever else is going on. The **Select / Move** toggle
  only decides what a *single* finger does: draw a box, or shove the picture
  around once you are zoomed in.
- **The picture never moves.** Results appear in a sheet that floats over it,
  so a box you drew over a price stays over that price. Drag the small handle
  at the top of the sheet to expand it and scroll the details, then drop it
  back to a peek.
- **Tap the right number** — every number found gets a marker on the frozen
  picture, labelled with its NT$ value. Tap one to make it the answer, or tap
  a row in the list underneath. **Retake** goes back to the camera.
- **live** (right) — keeps scanning every second or so. Handy for walking down
  a menu; it uses more battery.
- **Type a price** — the field at the bottom accepts `120.000`, `35k`, `1tr2`,
  `1,5 triệu` and so on, which is useful when someone tells you a price out loud.
- **Rate chip** (top left) — tap it for Settings: which currency to show, how to
  round, and the rate itself.

### Currency, rounding and your own rate

The price on the sign is always đồng; what it is shown as is your choice —
sixteen currencies, TWD by default.

**Rounding** has three settings. *Up* never understates what you will pay, which
is the useful one when budgeting; *Down* is its opposite; *Normal* is nearest.
Rounding happens at a step chosen from the size of the number, so it is never
absurd — NT$68.4 becomes 68 or 69, while $2.65 becomes $2.6 or $2.7 rather than
$2 or $3. What you see is exactly the rounded number, with no hidden decimals
contradicting the mode.

**The rate is yours to set.** Published rates are fetched when there is a
connection, but if you changed money at a counter you can type what you actually
got and see your true cost instead of a mid-market fiction. Your rate is kept
per currency, is marked *your rate* on every result, and survives a refresh of
the published ones until you tap *Use published*.

### What the tags mean

| Tag | Meaning |
| --- | --- |
| `assumed ×1.000` | The sign said just `45`, and it was read as 45.000 ₫ — the usual menu shorthand. Turn this off in Settings if you are somewhere that writes full prices. |
| `manual rate` | You typed the rate yourself, so it is not being refreshed. |
| `rate 4d ago` | The saved rate is getting stale; connect once to refresh. |

If several prices are visible, the best guess is shown large and the rest are
listed underneath — useful on a menu.

## What it reads well, and what it does not

Measured against the 50-image benchmark in `test/fixtures` (see below):

| Kind of price | Accuracy |
| --- | --- |
| Clean printed tags (`120.000 đ`, `250.000 VNĐ`) | 8/8 |
| Shorthand (`35k`, `1tr2`, `15 triệu`, `25 nghìn`) | 5/5 |
| Menus and receipts, every price on the list | 3/3 |
| Hard photos — tilted, blurred, glare, dark signage, night noise | 8/8 |
| Handwritten marker on paper or cardboard, chalkboard | 12/13 |
| Menu boards with the đồng sign set small and raised | 6/6 |
| Shelf labels cluttered with a barcode, a SKU and a per-kilo rate | 3/3, and the barcode is never offered as a price |
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

**The corpus is synthetic.** Every fixture is generated by
`tools/make_fixtures.py` — real photographs of Vietnamese price signs under an
open licence are not something I could find, and a benchmark built from images
I invented only proves the app handles what I thought to imagine. The reporting
flow above exists to close that gap: real photos from testers become real
fixtures.

## Reporting a bad scan

When a reading is wrong, **Wrong? Report it** sends the photo you just scanned,
what the app read, and what it should have said. That is the only way to fix
recognition against prices that exist in real shops rather than in a fixture
generator.

Reports land in a Cloudflare Worker backed by D1 and are reviewable as a page of
cards with the images — see [`worker/README.md`](worker/README.md). The photo is
downscaled before sending, nothing else about you goes with it, and the whole
thing is optional: the app works completely without it.

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
| `rate.json` | Bundled fallback rates, đồng per unit for every currency, refreshed weekly by a workflow |

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

Nothing you photograph leaves the phone unless you tap *Wrong? Report it*. The
only outbound request the app makes on its own is the exchange rate, and it is
fully usable without that too.

**There is no cloud recognition, on purpose.** Sending the picture to a vision
model would only help when there is a connection, and would put your photos on
someone else's server — both the opposite of what this is for. Recognition runs
on the phone, always. Two tests enforce it: one asserts that scanning contacts
no server at all, and one runs the whole app with the report API blackholed to
confirm nothing degrades.

## Exchange rate

Fetched from [open.er-api.com](https://open.er-api.com), falling back to
[currency-api](https://github.com/fawazahmed0/exchange-api). Neither needs a key.
One request covers every currency. Rates are stored as **đồng per one unit** —
the number written on the board at a money changer — so the value you type in
Settings is the value you were quoted, not its reciprocal.

The last good set is saved, and `rate.json` ships bundled starting values that
`.github/workflows/update-rate.yml` refreshes weekly.

No published rate is right to the đồng: what you actually pay at a counter or an
ATM differs. That is what the manual rate is for.

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
[Lucide](https://lucide.dev) icons are ISC (inlined as a sprite in `index.html`),
[Tesseract.js](https://github.com/naptha/tesseract.js) and the Tesseract engine
are Apache 2.0 (see `vendor/tesseract/`), and the handwriting fonts used only by
the test fixtures are SIL OFL 1.1 (see `test/fonts/README.md`).
