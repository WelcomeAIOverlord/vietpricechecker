/*
 * Vietnamese price parser.
 *
 * Turns messy OCR output ("120.000d", "1tr2", "35k", "1,5 trieu", "VND 250 000")
 * into numeric VND amounts, while rejecting things that merely look numeric
 * (dates, phone numbers, weights, times, percentages).
 *
 * Runs both in the browser (attaches to window.VPC) and in Node (module.exports)
 * so the rules can be unit tested without a headless browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VPC = Object.assign(root.VPC || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Separators that appear *inside* a number: thousands dots, commas, thin
  // spaces, apostrophes, and the marks Tesseract emits instead of "." when the
  // dot sits high against a tall digit (·, ˙, °, ^).
  const SEP = "[.,\\s'’·˙°^]";

  // Multipliers. Order matters: longer alternatives must be tried first.
  const UNITS = [
    { re: /^(?:t[yỷỉ]|ty)(?![a-zÀ-ỹ])/i, mult: 1e9, kind: 'billion' },
    { re: /^(?:tri[eệê]u|trieu|tr|c[uủ]|củ)(?![a-zÀ-ỹ])/i, mult: 1e6, kind: 'million' },
    { re: /^ch[uụủ]c(?![a-zÀ-ỹ])/i, mult: 1e4, kind: 'ten-thousand' },
    { re: /^(?:ngh[iìí]n|nghin|ng[aà]n|ngan|ngh|k)(?![a-zÀ-ỹ])/i, mult: 1e3, kind: 'thousand' },
    { re: /^(?:vn[dđ]|vnd|dong|đ[oồ]ng|[đ₫]|d)(?![a-zÀ-ỹ])/i, mult: 1, kind: 'currency' },
  ];

  const CURRENCY_PREFIX = /(?:vn[dđ]|[đ₫]|gi[aá]\s*[:\-]?)\s*$/i;

  // "Phòng 305" is a room, "Bàn 12" is a table. Only consulted for bare numbers
  // that would otherwise be assumed to be thousands.
  const LABEL_PREFIX = /(?:ph[oòơở]ng|b[aà]n|t[aâầ]ng|s[oố]|size|c[oỡ]|gh[eế]|qu[aậ]n|l[oô]|xe|m[aã]|k[eệ]|d[aã]y|lo[aạ]i|h[aạ]ng|ng[aà]y)\s*[:.\-]?\s*$/i;

  // What a small raised "đ" degrades into. Only trusted after a number that is
  // already grouped in thousands, so temperatures stay temperatures.
  const DONG_GLYPH_AFTER = /^\s{0,2}[°º ªᵈ\u00ba\u00aa](?![a-zÀ-ỹ0-9])/;

  // Vietnamese hotlines look exactly like a grouped price.
  const HOTLINE_PREFIX = /(?:hotline|t[oổ]ng\s*[dđ][aà]i|lh|li[eê]n\s*h[eệ]|[dđ]t|s[dđ]t|tel|phone|call)\s*[:.\-]?\s*$/i;

  // If one of these follows the number it is a measurement, not money.
  const MEASURE_AFTER = /^\s*(?:\+|°[cf]|kg|gr?am|gr|g|ml|lit|l[iíì]t|cm|mm|km|m2|m²|ph[uú]t|gi[oờ]|tu[oổ]i|n[aă]m|ng[aà]y|th[aá]ng|%|°|inch|"|pcs|pax|w|kw|v|hz|mah|gb|mb|tb)(?![a-zÀ-ỹ])/i;

  // Characters Tesseract commonly confuses with digits, applied only when a
  // token is already mostly numeric.
  const DIGIT_FIX = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6' };

  const MIN_VND = 500;
  const MAX_VND = 5e9;

  function normalize(raw) {
    let s = String(raw == null ? '' : raw).normalize('NFC');
    // Full-width digits -> ASCII
    s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    s = s.replace(/[     ]/g, ' '); // exotic spaces
    s = s.replace(/[‐-―−]/g, '-'); // dashes
    s = s.replace(/₫/g, 'đ'); // ₫
    return s;
  }

  /** Blank out spans that look like dates/times/phones/percentages. */
  function maskNonPrices(s) {
    const blank = (m) => ' '.repeat(m.length);
    return s
      .replace(/\b\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?\b/g, blank) // 16/08, 16/08/2026
      .replace(/\b\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{2,4}\b/g, blank) // 16-08-2026
      .replace(/\b\d{1,2}\s+\d{1,2}\s+(?:19|20)\d{2}\b/g, blank) // 16 08 2026
      .replace(/\b\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}\b/g, blank) // 16.08.2026
      .replace(/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/g, blank) // year ranges
      .replace(/\b\d{1,2}\s*[:h]\s*\d{2}\b/gi, blank) // 18:30 / 18h30
      .replace(/\d{1,12}(?:[.,]\d{1,6})?\s*%/g, blank) // 20%
      .replace(/(?<![\d.,'’])0\d{2,3}[.\s-]?\d{3,4}[.\s-]?\d{3,4}(?![\d.,'’])/g, blank) // phones
      .replace(/(?<![\d.,'’])0\d{8,10}(?![\d.,'’])/g, blank)
      .replace(/\(?\s*\+\s*84\s*\)?[\s.\-]*\d[\d.\s-]{6,14}/g, blank);
  }

  /**
   * Repair OCR letter/digit confusion, one whitespace-delimited token at a
   * time. Working across spaces was worse than useless: "250.000 Ship" became
   * "250.000 5hip", the 5 joined the number as a third group, and the price
   * disappeared rather than merely degrading.
   */
  function repairDigits(s) {
    return s.split(/(\s+)/).map(repairToken).join('');
  }

  function repairToken(tok) {
    if (!tok || /^\s+$/.test(tok) || tok.length > 64) return tok;

    // A run of digit-lookalike letters glued to a price unit is a price with no
    // surviving digits at all: hand-lettered "15k" comes back as "ISK".
    if (!/[0-9]/.test(tok)) {
      return tok.replace(/^[OoQDIlLSsBZzGb]{1,5}(?=(?:k|tr|đ|₫)$)/i, (run) =>
        run.replace(/[A-Za-z]/g, (c) => DIGIT_FIX[c] || DIGIT_FIX[c.toUpperCase()] || c)
      );
    }

    // "35.000D" is 35.000 đồng, not 35.0000 — never read a trailing currency
    // letter as a zero.
    const currency = tok.match(/(?:vn[dđ]|[dđ₫])$/i);
    const body = currency ? tok.slice(0, -currency[0].length) : tok;
    const suffix = currency ? currency[0] : '';

    let out = body;
    // Only repair a token that clearly starts as a number ("12O.OOO", "l20.000");
    // otherwise an all-caps word like "BOSS" would turn into digits.
    if (/[A-Za-z]/.test(body) && /^[0-9]|^.[0-9]/.test(body)) {
      out = body.replace(/[A-Za-z]+/g, (run) => {
        // Every letter has to be a known digit lookalike, and the run must not
        // be a unit of measure — "128GB" and "330ml" are not 12868 and 330m1.
        if (!run.split('').every((c) => DIGIT_FIX[c])) return run;
        if (MEASURE_AFTER.test(run)) return run;
        return run.replace(/./g, (c) => DIGIT_FIX[c]);
      });
    }

    // Marker strokes turn 7 into #. A leading "+" is a surcharge ("+50.000")
    // far more often than a mangled 7, so it only counts between digits.
    out = out.replace(/#(?=\d)|(?<=\d)#/g, '7');
    return out + suffix;
  }

  /**
   * Vietnamese prices are written in thousands, so the tail of a real one is
   * almost always zeros. Hand-lettered zeros are the glyph Tesseract fails on
   * most (0 comes back as 6, 8 or 9), which turns 50.000 into 56.666.
   *
   * When one non-zero 0-lookalike digit fills the tail of a number, this
   * returns the zeroed reading so the caller can offer it alongside the literal
   * one — never instead of it, because 99.999 is a real (if unusual) price.
   */
  function snapZeroTail(digits) {
    if (!/^\d+$/.test(digits) || digits.length < 5) return null;
    const tail = digits.slice(-4);
    const counts = {};
    for (const c of tail) counts[c] = (counts[c] || 0) + 1;

    let d = null;
    for (const k of Object.keys(counts)) {
      // Deliberately only 6. Widening this to 8 or 9 would rewrite the lucky
      // numbers and .999 retail prices that Vietnamese shops really use.
      if (counts[k] >= 3 && k === '6') d = k;
    }
    if (!d) return null;

    let i = digits.length - 4;
    while (i > 0 && digits[i - 1] === d) i--;
    if (i < 1) return null; // must keep at least one significant digit

    const snapped = digits.slice(0, i) + digits.slice(i).split(d).join('0');
    return snapped === digits ? null : snapped;
  }

  /**
   * "$" and "§" are what a hand-drawn 5 or 8 usually degrades into, and the two
   * readings are genuinely ambiguous, so both are offered.
   */
  function glyphVariants(line) {
    if (!/[$§](?=\d)/.test(line)) return [line];
    return [line.replace(/[$§](?=\d)/g, '5'), line.replace(/[$§](?=\d)/g, '8')];
  }

  /**
   * Interpret a raw digit-and-separator chunk such as "120.000", "1,5" or "250 000".
   * Returns { value, grouped } or null.
   */
  function readNumber(chunk) {
    if (typeof chunk !== 'string') return null;
    const trimmed = chunk.replace(new RegExp('^' + SEP + '+|' + SEP + '+$', 'g'), '');
    if (!/\d/.test(trimmed)) return null;
    const groups = trimmed.split(new RegExp(SEP + '+')).filter(Boolean);
    if (!groups.length) return null;
    if (groups.some((g) => !/^\d+$/.test(g))) return null;

    const digits = groups.join('');
    const totalDigits = digits.length;
    if (totalDigits > 12) return null;
    // A leading zero means a phone number, a serial, or a clock reading —
    // nobody writes a price as "0800".
    if (groups[0][0] === '0' && groups[0].length > 1) return null;

    if (groups.length === 1) {
      return { value: parseInt(groups[0], 10), grouped: false, decimals: 0, digits };
    }

    // Vietnamese grouping never starts with more than three digits, so a
    // space-separated run that does is a phone number: "1900 545 471".
    if (groups.length > 1 && /\s/.test(trimmed) && groups[0].length > 3) return null;

    const tail = groups.slice(1);
    if (tail.every((g) => g.length === 3)) {
      // Classic Vietnamese thousands grouping: 1.250.000
      return { value: parseInt(digits, 10), grouped: true, decimals: 0, digits };
    }

    // Every group after the first is exactly three digits except the last,
    // which has four. Menus print the đồng sign as a small raised character
    // right after the price, and Tesseract reads that as a digit — usually 4,
    // sometimes 1 or 7 — so "25.000đ" arrives as "25.0004". Report the price
    // without the stray glyph and let the caller offer both readings.
    if (tail.slice(0, -1).every((g) => g.length === 3) && tail[tail.length - 1].length === 4) {
      const kept = digits.slice(0, -1);
      return {
        value: parseInt(digits, 10),
        grouped: true,
        decimals: 0,
        digits,
        strayGlyph: { digits: kept, value: parseInt(kept, 10), glyph: digits.slice(-1) },
      };
    }

    if (groups.length === 2 && tail[0].length <= 2) {
      // Decimal: "1,5" triệu / "35.5"
      return { value: parseFloat(groups[0] + '.' + tail[0]), grouped: false, decimals: tail[0].length, digits };
    }
    // Three or more groups that are not all thousands is a date, a version
    // number or a serial — "16 08 2026" is not sixteen million.
    if (groups.length > 2) return null;
    // Two groups with an odd tail, e.g. "1.25000" — trust the digits, drop the
    // structure.
    return { value: parseInt(digits, 10), grouped: true, decimals: 0, digits };
  }

  function matchUnit(after) {
    for (const u of UNITS) {
      const m = after.match(u.re);
      if (m) return { mult: u.mult, kind: u.kind, len: m[0].length };
    }
    return null;
  }

  /**
   * Extract price candidates from one line of text.
   *
   * options.assumeThousands — treat a bare 1..999 (no separator, no unit) as
   * thousands, which is how most Vietnamese menus and market stalls write prices.
   */
  function extractFromLine(line, options) {
    const out = [];
    for (const variant of glyphVariants(String(line == null ? '' : line))) {
      scanVariant(variant, options, out);
    }
    return out;
  }

  function scanVariant(line, options, out) {
    const opts = Object.assign({ assumeThousands: true }, options || {});
    const src = maskNonPrices(repairDigits(normalize(line)));

    // A space only continues a number when it is followed by exactly three
    // digits, so "Hotline 1900 6017" and "25.000 2 ly" stay separate numbers
    // while "1 250 000" does not.
    const numRe = new RegExp("\\d(?:[.,'’·˙°^]?\\d)*(?:\\s\\d{3}(?!\\d))*", 'g');
    let m;
    while ((m = numRe.exec(src)) !== null) {
      const raw = m[0];
      const start = m.index;
      let end = start + raw.length;

      const num = readNumber(raw);
      if (!num) continue;

      const before = src.slice(Math.max(0, start - 12), start);
      let after = src.slice(end);
      let dongGlyph = false;

      // Menus set the đồng sign small and raised, and Tesseract reads that
      // superscript as a degree or ordinal mark. After a number that is already
      // grouped in thousands it is money, not a temperature — "25.000°" is
      // twenty-five thousand đồng, while a bare "25°C" stays a temperature.
      if (num.grouped && DONG_GLYPH_AFTER.test(after)) {
        const g = after.match(DONG_GLYPH_AFTER)[0];
        end += g.length;
        after = src.slice(end);
        dongGlyph = true;
      }

      // Reject measurements: "500 g", "1 kg", "330ml"
      if (!dongGlyph && MEASURE_AFTER.test(after)) continue;
      // Reject anything glued to a slash-date or ratio we failed to mask.
      if (/^\s*[/]\s*\d/.test(after) || /\d\s*[/]\s*$/.test(before)) continue;

      let value = num.value;
      let mult = 1;
      let unitKind = null;
      let explicitCurrency = dongGlyph || CURRENCY_PREFIX.test(before);

      const spaced = after.match(/^\s*/)[0].length;
      const unit = matchUnit(after.slice(spaced));
      if (unit) {
        end += spaced + unit.len;
        after = src.slice(end);
        if (unit.kind === 'currency') {
          explicitCurrency = true;
        } else {
          mult = unit.mult;
          unitKind = unit.kind;
          // Compound shorthand: "1tr2" = 1.2 triệu, "1tr250" = 1.25 triệu.
          const frac = after.match(/^(\d{1,3})(?![\d.,])/);
          if (frac && num.decimals === 0) {
            value = value + parseFloat('0.' + frac[1]);
            end += frac[0].length;
            after = src.slice(end);
          }
        }
      }

      // A currency marker can also trail after the unit: "35k đ", "1tr2 VND"
      if (!explicitCurrency && /^\s{0,2}(?:vn[dđ]|[đ]|dong|đ[oồ]ng)(?![a-zÀ-ỹ])/i.test(after)) {
        explicitCurrency = true;
      }

      let value_vnd = value * mult;
      let assumed = false;

      if (!unitKind && !num.grouped && value_vnd < 1000) {
        if (!opts.assumeThousands) continue;
        // A single bare digit ("bàn 7", "2 người") is almost never a price;
        // bare menu prices are written as 10..999 thousand.
        if (value < 10 || value > 999) continue;
        value_vnd = value * 1000;
        assumed = true;
      }

      if (!Number.isFinite(value_vnd)) continue;
      value_vnd = Math.round(value_vnd);
      if (value_vnd < MIN_VND || value_vnd > MAX_VND) continue;

      // An unmarked number — no grouping, no unit, no ₫ — has nothing to say
      // for itself, so it has to at least look like money. Every price in
      // circulation is a multiple of 500; a clock reading like "2200" is not.
      const bare = !num.grouped && !unitKind && !explicitCurrency;
      if (bare && !assumed) {
        // Below 10.000 the field is crowded with clock readings and years, so
        // require a round number; above it, only cap the length — an eight
        // digit unmarked run is an order number, not a price.
        if (num.digits.length > 7) continue;
        if (value_vnd < 10000 && value_vnd % 500 !== 0) continue;
      }

      // "Phòng 305" and "Hotline 1900 6017" are labels, not money.
      if (assumed && LABEL_PREFIX.test(before)) continue;
      if (HOTLINE_PREFIX.test(before)) continue;

      const matched = src.slice(start, end).trim();
      const base = {
        matched,
        grouped: num.grouped,
        unit: unitKind,
        currency: explicitCurrency,
        assumed,
      };

      let score = 0;
      if (num.grouped) score += 3;
      if (unitKind) score += 3;
      if (explicitCurrency) score += 2;
      if (value_vnd >= 5000 && value_vnd <= 2e6) score += 1;
      if (assumed) score -= 2;
      if (value_vnd % 1000 === 0) score += 0.5;

      out.push(Object.assign({ vnd: value_vnd, raw, score, repaired: false }, base));

      // A four-digit final group is a đồng sign that got read as a digit.
      // Offer the price without it; the literal reading stays in the list, but
      // it never wins, because "25.0004" is not a shape any price takes.
      if (num.strayGlyph && mult === 1 && !assumed) {
        const stripped = num.strayGlyph.value;
        if (stripped >= MIN_VND && stripped <= MAX_VND) {
          // Only take the lead when the literal reading is not a shape money
          // comes in. "25.0004" is not, so the đồng sign is the explanation;
          // "1.2500" is a fine price on its own, so leave that one alone.
          const literalPlausible = value_vnd % 500 === 0;
          out.push(Object.assign({}, base, {
            vnd: stripped,
            raw,
            // The stray glyph *is* the currency mark, so this reading earns the
            // same confidence a written "đ" would have given it.
            currency: !literalPlausible,
            score: score + (literalPlausible ? -1.5 : 2.5),
            repaired: true,
          }));
        }
      }

      // Offer the zeroed reading of a mangled tail as a sibling candidate.
      const snapped = num.digits && mult === 1 && !assumed ? snapZeroTail(num.digits) : null;
      if (snapped) {
        const snappedValue = parseInt(snapped, 10);
        if (snappedValue >= MIN_VND && snappedValue <= MAX_VND && snappedValue !== value_vnd) {
          // Only worth more than the literal reading when the literal one is
          // not a shape any price actually takes.
          const literalPlausible = value_vnd % 500 === 0;
          out.push(Object.assign({
            vnd: snappedValue,
            raw,
            score: score + (literalPlausible ? -1.5 : 1.5),
            repaired: true,
          }, base));
        }
      }

      numRe.lastIndex = end;
    }

    return out;
  }

  /** Parse a multi-line blob (used for pasted/manual text). */
  function extract(text, options) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const all = [];
    lines.forEach((line, i) => {
      for (const c of extractFromLine(line, options)) all.push(Object.assign({ line: i, source: line.trim() }, c));
    });
    return all;
  }

  /**
   * Collapse duplicates and rank best-first.
   *
   * Scores are bucketed to half-points before sorting so that tiny confidence
   * wobble cannot reorder genuinely equivalent readings — a menu column of
   * equally-sized prices then falls back to reading order, which is what a
   * person expects, instead of shuffling between scans.
   */
  function rank(candidates) {
    if (!Array.isArray(candidates)) return [];
    const byValue = new Map();
    for (const c of candidates) {
      const prev = byValue.get(c.vnd);
      if (!prev) {
        byValue.set(c.vnd, Object.assign({ hits: 1, order: 0 }, c));
      } else {
        prev.hits++;
        prev.order = Math.min(prev.order, c.order || 0);
        if (c.score > prev.score) {
          const keep = { hits: prev.hits, order: prev.order };
          Object.assign(prev, c, keep);
        }
      }
    }
    const out = [...byValue.values()];
    // Seeing the same number in more than one pass is real evidence.
    for (const c of out) c.score += Math.min(2.5, (c.hits - 1) * 0.7);
    return out.sort((a, b) => {
      const sa = Math.round(a.score * 2);
      const sb = Math.round(b.score * 2);
      if (sa !== sb) return sb - sa;
      if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
      return b.vnd - a.vnd;
    });
  }


  /* ------------------------------------------------------------------ *
   * money out
   *
   * The price read from a sign is always đồng. What it is shown as is the
   * traveller's choice, and rates are stored as "đồng per one unit", which is
   * the number people actually quote at an exchange counter.
   * ------------------------------------------------------------------ */

  const CURRENCIES = {
    TWD: { symbol: 'NT$', name: 'New Taiwan dollar' },
    USD: { symbol: '$', name: 'US dollar' },
    EUR: { symbol: '€', name: 'Euro' },
    GBP: { symbol: '£', name: 'Pound sterling' },
    JPY: { symbol: '¥', name: 'Japanese yen' },
    KRW: { symbol: '₩', name: 'Korean won' },
    CNY: { symbol: 'CN¥', name: 'Chinese yuan' },
    HKD: { symbol: 'HK$', name: 'Hong Kong dollar' },
    SGD: { symbol: 'S$', name: 'Singapore dollar' },
    MYR: { symbol: 'RM', name: 'Malaysian ringgit' },
    THB: { symbol: '฿', name: 'Thai baht' },
    PHP: { symbol: '₱', name: 'Philippine peso' },
    IDR: { symbol: 'Rp', name: 'Indonesian rupiah' },
    INR: { symbol: '₹', name: 'Indian rupee' },
    AUD: { symbol: 'A$', name: 'Australian dollar' },
    CAD: { symbol: 'C$', name: 'Canadian dollar' },
  };

  /**
   * How finely to round, chosen from the size of the number so that a mode is
   * never absurd: rounding 2.65 up to 3 loses too much, rounding 68.8 up to
   * 68.81 gains nothing.
   */
  function roundingStep(value) {
    const v = Math.abs(value);
    if (v >= 10) return 1;
    if (v >= 1) return 0.1;
    return 0.01;
  }

  /** mode: 'exact' | 'up' | 'down' | anything else for nearest. */
  function applyRounding(value, mode) {
    // "exact" keeps the real figure; two decimals is as fine as money gets and
    // is enough to stop float dust showing through.
    if (mode === 'exact') return Math.round(value * 100) / 100;
    const step = roundingStep(value);
    const n = value / step;
    const rounded = mode === 'up' ? Math.ceil(n) : mode === 'down' ? Math.floor(n) : Math.round(n);
    // Re-round to kill the float dust that 0.1 steps leave behind.
    return Math.round(rounded * step * 100) / 100;
  }

  /**
   * Convert đồng to a currency.
   *
   * vndPerUnit is how many đồng one unit costs — the number on the board at the
   * money changer — so a traveller can type in what they actually paid and see
   * their true cost rather than a mid-market fiction.
   */
  function convert(vnd, vndPerUnit, mode) {
    if (!(vndPerUnit > 0)) return null;
    return applyRounding(vnd / vndPerUnit, mode);
  }

  /**
   * Shown precision follows the rounding step, so the number on screen is
   * exactly the one that was rounded. In "exact" mode nothing was rounded, so
   * it shows the two decimals money actually has.
   */
  function formatMoney(value, code, mode) {
    if (value == null || !Number.isFinite(value)) return '—';
    const cur = CURRENCIES[code] || { symbol: code + ' ' };
    const step = roundingStep(value);
    const digits = mode === 'exact' ? 2 : step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    const n = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
    return cur.symbol + n;
  }

  function formatVnd(v) {
    return new Intl.NumberFormat('vi-VN').format(Math.round(v)) + ' ₫';
  }

  function formatTwd(v) {
    return formatMoney(v, 'TWD');
  }

  function toTwd(vnd, vndPerTwd) {
    return vnd / vndPerTwd;
  }

  return {
    normalize,
    maskNonPrices,
    repairDigits,
    snapZeroTail,
    glyphVariants,
    readNumber,
    extractFromLine,
    extract,
    rank,
    formatVnd,
    formatTwd,
    toTwd,
    CURRENCIES,
    convert,
    applyRounding,
    roundingStep,
    formatMoney,
    MIN_VND,
    MAX_VND,
  };
});
