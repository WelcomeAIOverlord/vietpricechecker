import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VPC = require('../parser.js');

/** Best-guess VND for a line, or null. */
function best(line, opts) {
  const r = VPC.rank(VPC.extract(line, opts));
  return r.length ? r[0].vnd : null;
}

/** Every value found on a line, ranked. */
function all(line, opts) {
  return VPC.rank(VPC.extract(line, opts)).map((c) => c.vnd);
}

test('grouped thousands', () => {
  assert.equal(best('120.000'), 120000);
  assert.equal(best('120,000'), 120000);
  assert.equal(best('120 000'), 120000);
  assert.equal(best('1.250.000'), 1250000);
  assert.equal(best('250.000đ'), 250000);
  assert.equal(best('250.000 VND'), 250000);
  assert.equal(best('250.000 VNĐ'), 250000);
  assert.equal(best('₫89.000'), 89000);
  assert.equal(best('Giá: 45.000 đ'), 45000);
});

test('k shorthand', () => {
  assert.equal(best('35k'), 35000);
  assert.equal(best('35K'), 35000);
  assert.equal(best('35 k'), 35000);
  assert.equal(best('120k'), 120000);
  assert.equal(best('35 nghìn'), 35000);
  assert.equal(best('35 ngàn'), 35000);
});

test('triệu shorthand and compounds', () => {
  assert.equal(best('1tr'), 1000000);
  assert.equal(best('1tr2'), 1200000);
  assert.equal(best('1tr25'), 1250000);
  assert.equal(best('1tr250'), 1250000);
  assert.equal(best('1,5tr'), 1500000);
  assert.equal(best('1.5 triệu'), 1500000);
  assert.equal(best('2 trieu'), 2000000);
  assert.equal(best('3 củ'), 3000000);
});

test('bare menu numbers become thousands', () => {
  assert.equal(best('Phở bò 45'), 45000);
  assert.equal(best('Cà phê sữa đá 25'), 25000);
  assert.equal(best('35.5'), 35500);
  assert.equal(best('45', { assumeThousands: false }), null);
});

test('the assumption is flagged', () => {
  const c = VPC.rank(VPC.extract('Phở bò 45'))[0];
  assert.equal(c.assumed, true);
  const d = VPC.rank(VPC.extract('Phở bò 45.000'))[0];
  assert.equal(d.assumed, false);
});

test('OCR digit confusion is repaired', () => {
  assert.equal(best('12O.OOO'), 120000);
  assert.equal(best('l20.000'), 120000);
  assert.equal(best('35.OOOd'), 35000);
});

test('rejects non-prices', () => {
  assert.equal(best('16/08/2026'), null);
  assert.equal(best('16.08.2026'), null);
  assert.equal(best('0987 654 321'), null);
  assert.equal(best('0912345678'), null);
  assert.equal(best('Giảm 20%'), null);
  assert.equal(best('Mở cửa 18:30'), null);
  assert.equal(best('Mở cửa 18h30'), null);
  assert.equal(best('500g'), null);
  assert.equal(best('1 kg'), null);
  assert.equal(best('330ml'), null);
  assert.equal(best('Bàn số 7'), null, 'single tiny digit is not a price');
});

test('kg is a weight, not k + g', () => {
  const r = VPC.extract('Thịt bò 1kg 350.000đ');
  const values = VPC.rank(r).map((c) => c.vnd);
  assert.ok(values.includes(350000));
  assert.ok(!values.includes(1000));
});

test('multiple prices on one line are all found and ranked', () => {
  const v = all('Bún bò 45.000 - Phở gà 50.000');
  assert.deepEqual(v.sort((a, b) => a - b), [45000, 50000]);
});

test('the strongest signal wins the ranking', () => {
  // "2" is a table number, "120.000" is the price.
  const r = VPC.rank(VPC.extract('Bàn 2 tổng cộng 120.000đ'));
  assert.equal(r[0].vnd, 120000);
});

test('multi-line menu blob', () => {
  const menu = [
    'THUC DON',
    'Pho bo tai      65.000',
    'Bun cha        55.000',
    'Ca phe sua da   25k',
    'Bia Ha Noi      1tr2',
  ].join('\n');
  const v = all(menu);
  for (const expected of [65000, 55000, 25000, 1200000]) {
    assert.ok(v.includes(expected), `expected ${expected} in ${JSON.stringify(v)}`);
  }
});

test('range guards', () => {
  assert.equal(best('0,00001'), null);
  assert.equal(best('999.999.999.999'), null);
});

test('mangled zero tails are offered zeroed', () => {
  // Hand-lettered zeros come back from Tesseract as 6, 8 or 9.
  assert.equal(best("56'666"), 50000);
  assert.equal(best('126°666'), 120000);
  assert.equal(best('36°666'), 30000);
  assert.equal(best('#6 666'), 70000);
  // The literal reading is kept as an alternative, never thrown away.
  assert.ok(all("56'666").includes(56666));
});

test('a number that is all one digit is left alone', () => {
  // 99.999 and 66.666 are odd but real; only mixed numbers get zeroed.
  assert.equal(best('99.999'), 99999);
  assert.equal(best('66.666'), 66666);
  assert.equal(VPC.snapZeroTail('99999'), null);
  assert.equal(VPC.snapZeroTail('56666'), '50000');
});

test('digit-lookalike letters glued to a unit', () => {
  assert.equal(best('ISK'), 15000); // "15k" in marker pen
  assert.equal(best('lOOk'), 100000);
});

test('ambiguous $ is read as both 5 and 8', () => {
  const v = all('$5,000 VND');
  assert.ok(v.includes(85000), 'expected the 8 reading');
  assert.ok(v.includes(55000), 'expected the 5 reading');
});

test('unmarked numbers must look like money', () => {
  assert.equal(best('2200'), null, 'a clock reading is not 2.200 đ');
  assert.equal(best('0800'), null, 'leading zero is never a price');
  assert.equal(best('15000'), 15000, 'a round unmarked number is fine');
});

test('space-separated dates are not millions', () => {
  assert.equal(best('16 08 2026'), null);
  assert.equal(best('Han dung 16 08 2026'), null);
  // but a genuine three-group price still reads
  assert.equal(best('1 250 000'), 1250000);
});

// ---------------------------------------------------------------------------
// Cases found by an adversarial audit of the parser. Each one was a real defect.
// ---------------------------------------------------------------------------

test('retail prices ending in 999 survive the zero-snap', () => {
  assert.equal(best('19.999đ'), 19999);
  assert.equal(best('199.999đ'), 199999);
  assert.equal(best('1.999.999đ'), 1999999);
  assert.equal(best('49.999đ'), 49999);
  assert.equal(best('1.888.888'), 1888888, 'lucky-number pricing is real');
});

test('a leading + is a surcharge, not a mangled 7', () => {
  assert.equal(best('Phụ thu +50.000'), 50000);
  assert.equal(best('Size L +10.000'), 10000);
  assert.equal(best('Thêm trứng +5k'), 5000);
  assert.equal(best('18+'), null);
  assert.equal(best('Combo 2+1'), null);
});

test('a quantity after a price is not a compound fraction', () => {
  assert.equal(best('Bún 45k 2 tô'), 45000);
  assert.equal(best('1tr 2 cái'), 1000000);
  assert.equal(best('Combo 100k 4 người'), 100000);
  assert.equal(best('Vé 200k 2 vé'), 200000);
  assert.equal(best('1tr2'), 1200000, 'glued shorthand still works');
});

test('a trailing D is đồng, not a zero', () => {
  assert.equal(best('35.000D'), 35000);
  assert.equal(best('250.000 D'), 250000);
});

test('hotlines and landlines are not prices', () => {
  assert.equal(best('Hotline: 1900 6017'), null);
  assert.equal(best('Hotline 1900 1234'), null);
  assert.equal(best('LH 1900 545 471'), null);
  assert.equal(best('(024) 3825 1234'), null);
  assert.equal(best('(+84) 909 123 456'), null);
});

test('labels are not prices', () => {
  assert.equal(best('Phòng 305'), null);
  assert.equal(best('Bàn 12'), null);
  assert.equal(best('Size 42'), null);
  assert.equal(best('Tầng 12'), null);
  assert.equal(best('25°C'), null);
  assert.equal(best('30°C hôm nay'), null);
});

test('a following word must not delete the price', () => {
  assert.equal(best('250.000 Ship toàn quốc'), 250000);
  assert.equal(best('45.000 Bát'), 45000);
  assert.equal(best('1.200.000 Bao ship'), 1200000);
  assert.equal(best('Cà phê 25.000 2 ly'), 25000);
  assert.equal(best('Bia 20.000 3 chai'), 20000);
  assert.deepEqual(all('Phở 65.000 Bún 55.000').sort((a, b) => a - b), [55000, 65000]);
});

test('units of measure survive digit repair', () => {
  assert.equal(best('16 GB'), null);
  assert.equal(best('500 GR'), null);
  assert.equal(best('Thịt 500 GRAM'), null);
  assert.equal(best('330ml'), null);
  assert.equal(best('iPhone 128GB 12.500.000'), 12500000);
});

test('tỷ and chục', () => {
  assert.equal(best('2 tỷ'), 2000000000);
  assert.equal(best('3,5 tỷ'), 3500000000);
  assert.equal(best('5 chục nghìn'), 50000);
});

test('billions written in full survive the phone mask', () => {
  assert.equal(best('2.000.000.000'), 2000000000);
  assert.equal(best('Giá 2.000.000.000 VNĐ'), 2000000000);
  assert.equal(best('3.000.000.000 đ'), 3000000000);
});

test('dash ranges are prices, not dates', () => {
  assert.equal(best('5-7 triệu'), 7000000);
  assert.equal(best('10 - 20 nghìn'), 20000);
});

test('unmarked numbers ending in 900', () => {
  assert.equal(best('89900'), 89900);
  assert.equal(best('129900'), 129900);
  assert.equal(best('19006017'), null, 'eight unmarked digits is an order number');
});

test('no quadratic blow-up on a long digit run', () => {
  for (const input of ['1'.repeat(80000), '$1'.repeat(20000), '1.'.repeat(40000)]) {
    const t0 = Date.now();
    VPC.extract(input);
    const ms = Date.now() - t0;
    assert.ok(ms < 250, `took ${ms}ms on a ${input.length}-char line`);
  }
});

test('exported helpers do not throw on junk', () => {
  assert.doesNotThrow(() => VPC.rank(null));
  assert.doesNotThrow(() => VPC.readNumber(null));
  assert.doesNotThrow(() => VPC.extract(null));
  assert.doesNotThrow(() => VPC.extract(undefined));
  assert.doesNotThrow(() => VPC.extract({}));
  assert.deepEqual(VPC.rank(null), []);
});

test('formatting', () => {
  assert.match(VPC.formatVnd(120000), /120[.,\s]000\s*₫/);
  assert.equal(VPC.formatTwd(146.5), 'NT$147');
  assert.equal(VPC.formatTwd(43.21), 'NT$43.2');
  assert.equal(VPC.formatTwd(3.456), 'NT$3.46');
});

test('conversion', () => {
  // ~819 VND per 1 TWD
  assert.equal(Math.round(VPC.toTwd(120000, 819)), 147);
});
