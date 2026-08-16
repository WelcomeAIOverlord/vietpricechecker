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
  // spaces, apostrophes, and the middle dot Tesseract sometimes emits for ".".
  const SEP = "[.,\\s'’·˙]";

  // Multipliers. Order matters: longer alternatives must be tried first.
  const UNITS = [
    { re: /^(?:tri[eệê]u|trieu|tr|c[uủ]|củ)(?![a-zÀ-ỹ])/i, mult: 1e6, kind: 'million' },
    { re: /^(?:ngh[iìí]n|nghin|ng[aà]n|ngan|ngh|k)(?![a-zÀ-ỹ])/i, mult: 1e3, kind: 'thousand' },
    { re: /^(?:vn[dđ]|vnd|dong|đ[oồ]ng|[đ₫]|d)(?![a-zÀ-ỹ])/i, mult: 1, kind: 'currency' },
  ];

  const CURRENCY_PREFIX = /(?:vn[dđ]|[đ₫]|gi[aá]\s*[:\-]?)\s*$/i;

  // If one of these follows the number it is a measurement, not money.
  const MEASURE_AFTER = /^\s*(?:kg|gr?am|gr|g|ml|lit|l[iíì]t|cm|mm|km|m2|m²|ph[uú]t|gi[oờ]|tu[oổ]i|n[aă]m|ng[aà]y|th[aá]ng|%|°|inch|"|pcs|pax|w|kw|v|hz|mah|gb|mb|tb)(?![a-zÀ-ỹ])/i;

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
      .replace(/\b\d{1,2}\s*[/\-]\s*\d{1,2}(?:\s*[/\-]\s*\d{2,4})?\b/g, blank) // 16/08, 16-08-2026
      .replace(/\b\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}\b/g, blank) // 16.08.2026
      .replace(/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/g, blank) // year ranges
      .replace(/\b\d{1,2}\s*[:h]\s*\d{2}\b/gi, blank) // 18:30 / 18h30
      .replace(/\d+(?:[.,]\d+)?\s*%/g, blank) // 20%
      .replace(/\b0\d{2,3}[.\s-]?\d{3,4}[.\s-]?\d{3,4}\b/g, blank) // phone numbers
      .replace(/\b0\d{8,10}\b/g, blank);
  }

  /** Repair OCR letter/digit confusion inside otherwise-numeric tokens. */
  function repairDigits(s) {
    return s.replace(/[0-9OoQDIlLSsBZzGb][0-9OoQDIlLSsBZzGb.,'’ ]{1,}[0-9OoQDIlLSsBZzGb]/g, (tok) => {
      const digits = (tok.match(/[0-9]/g) || []).length;
      const letters = (tok.match(/[A-Za-z]/g) || []).length;
      if (digits === 0 || letters === 0) return tok;
      // Only repair runs that clearly *start* as a number ("12O.OOO", "l20.000").
      // Otherwise an all-caps word like "BOSS" would turn into digits.
      if (!/^[0-9]|^.[0-9]/.test(tok)) return tok;
      return tok.replace(/[A-Za-z]/g, (c) => DIGIT_FIX[c] || c);
    });
  }

  /**
   * Interpret a raw digit-and-separator chunk such as "120.000", "1,5" or "250 000".
   * Returns { value, grouped } or null.
   */
  function readNumber(chunk) {
    const trimmed = chunk.replace(new RegExp('^' + SEP + '+|' + SEP + '+$', 'g'), '');
    if (!/\d/.test(trimmed)) return null;
    const groups = trimmed.split(new RegExp(SEP + '+')).filter(Boolean);
    if (!groups.length) return null;
    if (groups.some((g) => !/^\d+$/.test(g))) return null;

    const totalDigits = groups.join('').length;
    if (totalDigits > 12) return null;
    // Leading zero on a long run is a phone/serial number, not money.
    if (groups[0][0] === '0' && groups[0].length > 1 && totalDigits >= 7) return null;

    if (groups.length === 1) {
      return { value: parseInt(groups[0], 10), grouped: false, decimals: 0 };
    }

    const tail = groups.slice(1);
    if (tail.every((g) => g.length === 3)) {
      // Classic Vietnamese thousands grouping: 1.250.000
      return { value: parseInt(groups.join(''), 10), grouped: true, decimals: 0 };
    }
    if (groups.length === 2 && tail[0].length <= 2) {
      // Decimal: "1,5" triệu / "35.5"
      return { value: parseFloat(groups[0] + '.' + tail[0]), grouped: false, decimals: tail[0].length };
    }
    // Mixed grouping, e.g. "1.250.00" — trust the digits, drop the structure.
    return { value: parseInt(groups.join(''), 10), grouped: true, decimals: 0 };
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
    const opts = Object.assign({ assumeThousands: true }, options || {});
    const src = maskNonPrices(repairDigits(normalize(line)));
    const out = [];

    const numRe = new RegExp('\\d(?:' + SEP + '?\\d)*', 'g');
    let m;
    while ((m = numRe.exec(src)) !== null) {
      const raw = m[0];
      const start = m.index;
      let end = start + raw.length;

      const num = readNumber(raw);
      if (!num) continue;

      const before = src.slice(Math.max(0, start - 12), start);
      let after = src.slice(end);

      // Reject measurements: "500 g", "1 kg", "330ml"
      if (MEASURE_AFTER.test(after)) continue;
      // Reject anything glued to a slash-date or ratio we failed to mask.
      if (/^\s*[/]\s*\d/.test(after) || /\d\s*[/]\s*$/.test(before)) continue;

      let value = num.value;
      let mult = 1;
      let unitKind = null;
      let explicitCurrency = CURRENCY_PREFIX.test(before);

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
          const frac = after.match(/^\s?(\d{1,3})(?![\d.,])/);
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

      let score = 0;
      if (num.grouped) score += 3;
      if (unitKind) score += 3;
      if (explicitCurrency) score += 2;
      if (value_vnd >= 5000 && value_vnd <= 2e6) score += 1;
      if (assumed) score -= 2;

      out.push({
        vnd: value_vnd,
        text: line.slice(0, 0) || raw, // raw digits as seen
        matched: src.slice(start, end).trim(),
        grouped: num.grouped,
        unit: unitKind,
        currency: explicitCurrency,
        assumed,
        score,
      });

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

  /** Collapse duplicates and rank best-first. */
  function rank(candidates) {
    const byValue = new Map();
    for (const c of candidates) {
      const prev = byValue.get(c.vnd);
      if (!prev || c.score > prev.score) byValue.set(c.vnd, c);
      else if (prev) prev.score += 0.25; // repeated sightings are reassuring
    }
    return [...byValue.values()].sort((a, b) => b.score - a.score || b.vnd - a.vnd);
  }

  function formatVnd(v) {
    return new Intl.NumberFormat('vi-VN').format(Math.round(v)) + ' ₫';
  }

  function formatTwd(v) {
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    return 'NT$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }

  function toTwd(vnd, vndPerTwd) {
    return vnd / vndPerTwd;
  }

  return {
    normalize,
    maskNonPrices,
    repairDigits,
    readNumber,
    extractFromLine,
    extract,
    rank,
    formatVnd,
    formatTwd,
    toTwd,
    MIN_VND,
    MAX_VND,
  };
});
