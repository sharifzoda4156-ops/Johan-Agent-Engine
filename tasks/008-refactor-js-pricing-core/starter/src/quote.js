// Коммерческое предложение для B2B. Всё в центах.
import { PricingError } from './errors.js';

const REGION_TAX = { us: 0, de: 0.2, fr: 0.2, gb: 0.2 };
const PROMO = { SPRING10: { pct: 10 }, VIP25: { pct: 25, minCents: 10000 } };

export function quote(items, { region, code } = {}) {
  if (!(region in REGION_TAX)) throw new PricingError('UNKNOWN_REGION', `unknown region ${region}`);
  let subtotalCents = 0;
  for (const it of items) {
    if (!Number.isInteger(it.priceCents) || it.priceCents < 0 || !Number.isInteger(it.qty) || it.qty < 1) {
      throw new PricingError('INVALID_ITEM', `bad item ${it.sku}`);
    }
    subtotalCents += it.priceCents * it.qty;
  }
  let discountCents = 0;
  if (code) {
    const promo = PROMO[code];
    if (!promo) throw new PricingError('UNKNOWN_CODE', `unknown code ${code}`);
    if (promo.minCents && subtotalCents < promo.minCents) {
      throw new PricingError('MIN_SUBTOTAL_NOT_MET', `code ${code} needs ${promo.minCents}`);
    }
    discountCents = Math.floor((subtotalCents * promo.pct) / 100);
  }
  const taxCents = Math.round((subtotalCents - discountCents) * REGION_TAX[region]);
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}
