// Счёт для бухгалтерии. Цены — строки ("19.99"), суммы — строки с двумя знаками.
const RATES = { us: 0, de: 0.19, fr: 0.2, gb: 0.2 };
const CODES = { VIP25: { percent: 25, min: 100 } };

export function buildInvoice(order) {
  const rate = RATES[order.country] ?? 0;
  const lines = order.items.map((it) => {
    const amount = parseFloat(it.unitPrice) * it.quantity;
    return { sku: it.sku, qty: it.quantity, unitPrice: it.unitPrice, amount: amount.toFixed(2) };
  });
  const subtotal = lines.reduce((sum, l) => sum + parseFloat(l.amount), 0);
  let discount = 0;
  const code = CODES[order.discountCode];
  if (code && subtotal >= code.min) discount = (subtotal * code.percent) / 100;
  const tax = (subtotal - discount) * rate;
  const total = subtotal - discount + tax;
  return {
    currency: 'EUR',
    lines,
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
  };
}
