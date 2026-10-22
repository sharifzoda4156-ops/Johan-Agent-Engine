// Итоги корзины на витрине. Цены — числа в основных единицах (19.99).
const TAX = { us: 0, de: 0.19, fr: 0.2 };
const COUPONS = { SPRING10: 0.1, VIP25: 0.25 };

export function cartTotals(cart) {
  const rate = TAX[cart.region];
  if (rate === undefined) throw new Error(`unknown region ${cart.region}`);
  let subtotal = 0;
  for (const line of cart.lines) {
    if (line.qty <= 0) throw new Error('bad qty');
    subtotal += Math.round(line.price * line.qty * 100) / 100;
  }
  let discount = 0;
  if (cart.coupon) {
    const pct = COUPONS[cart.coupon];
    if (!pct) throw new Error('unknown coupon');
    discount = Math.round(subtotal * pct * 100) / 100;
  }
  const tax = Math.round((subtotal - discount) * rate * 100) / 100;
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
