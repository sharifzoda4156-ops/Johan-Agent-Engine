import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotals } from '../src/cart.js';
import { buildInvoice } from '../src/invoice.js';
import { quote } from '../src/quote.js';

test('cart: simple order in fr', () => {
  const r = cartTotals({ region: 'fr', lines: [{ sku: 'a', price: 10, qty: 2 }] });
  assert.deepEqual(r, { subtotal: 20, discount: 0, tax: 4, total: 24 });
});

test('cart: coupon', () => {
  const r = cartTotals({ region: 'us', coupon: 'SPRING10', lines: [{ sku: 'a', price: 50, qty: 1 }] });
  assert.equal(r.discount, 5);
  assert.equal(r.total, 45);
});

test('invoice: lines and totals', () => {
  const r = buildInvoice({ country: 'fr', items: [{ sku: 'a', unitPrice: '10.00', quantity: 3 }] });
  assert.equal(r.lines[0].amount, '30.00');
  assert.equal(r.total, '36.00');
});

test('quote: cents', () => {
  const r = quote([{ sku: 'a', priceCents: 1000, qty: 2 }], { region: 'gb' });
  assert.deepEqual(r, { subtotalCents: 2000, discountCents: 0, taxCents: 400, totalCents: 2400 });
});

test('quote: unknown code', () => {
  assert.throws(() => quote([], { region: 'us', code: 'NOPE' }), { code: 'UNKNOWN_CODE' });
});
