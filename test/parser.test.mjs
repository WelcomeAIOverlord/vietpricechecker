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
