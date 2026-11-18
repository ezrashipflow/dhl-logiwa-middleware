// $0 customs lines -> product Sales Price (DermStreet, 2026-11-17).
//
// DermStreet's international orders can come into Logiwa at $0 (gifts,
// replacements, influencer sends). Logiwa passes that $0 straight through as
// the customs declaredValue. For the clients listed in
// ZERO_VALUE_SALES_PRICE_CLIENTS, any international line at $0 is declared at
// the product's Sales Price from Logiwa instead (price x quantity, because
// Logiwa's declaredValue is a line total). Lines that already have a value,
// other clients, and US orders are left alone. Only the customs declaration
// changes; the order in Logiwa keeps its $0.
//
// The Logiwa custom-carrier payload carries only the SKU, so the price is read
// from Logiwa's Product API (LOGIWA_EMAIL / LOGIWA_PASSWORD, read-only use).

const axios = require('axios');

const LOGIWA_API = process.env.LOGIWA_API_URL || 'https://myapi.logiwa.com';
const CLIENTS = (process.env.ZERO_VALUE_SALES_PRICE_CLIENTS || 'ed05c3d4-ebe8-41f7-a370-9411981f1625') // DermStreet
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const PRICE_TTL_MS = 60 * 60 * 1000;
// Short, so a slow Logiwa API never holds up a rate shop for long.
const LOOKUP_TIMEOUT_MS = 4000;

let token = null;
let tokenAt = 0;
const priceCache = {}; // clientId|sku -> { price, at }

async function logiwaToken(force) {
  if (!force && token && Date.now() - tokenAt < 30 * 60 * 1000) return token;
  if (!process.env.LOGIWA_EMAIL || !process.env.LOGIWA_PASSWORD) {
    throw new Error('LOGIWA_EMAIL / LOGIWA_PASSWORD not set');
  }
  const r = await axios.post(LOGIWA_API + '/v3.1/Authorize/token',
    { email: process.env.LOGIWA_EMAIL, password: process.env.LOGIWA_PASSWORD },
    { timeout: LOOKUP_TIMEOUT_MS });
  token = r.data.token;
  tokenAt = Date.now();
  return token;
}

async function salesPrice(clientId, sku) {
  const key = clientId + '|' + sku;
  const hit = priceCache[key];
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const url = LOGIWA_API + '/v3.1/Product/list/i/0/s/5?ClientIdentifier.eq=' + encodeURIComponent(clientId)
    + '&Sku.eq=' + encodeURIComponent(sku);
  let r;
  try {
    r = await axios.get(url, { headers: { Authorization: 'Bearer ' + await logiwaToken() }, timeout: LOOKUP_TIMEOUT_MS });
  } catch (e) {
    if (e.response?.status !== 401) throw e;
    r = await axios.get(url, { headers: { Authorization: 'Bearer ' + await logiwaToken(true) }, timeout: LOOKUP_TIMEOUT_MS });
  }
  const p = (r.data?.data || []).find((x) => String(x.sku) === String(sku));
  const price = p ? (parseFloat(p.salesPrice) || 0) : 0;
  priceCache[key] = { price, at: Date.now() };
  return price;
}

function appliesTo(order) {
  return CLIENTS.includes(String(order.clientIdentifier || '').toLowerCase());
}

// Fills $0 customs lines in place (internationalOptions.customsItems and every
// box's products[]). Call only for international orders.
// Returns { filled: [{sku, unit}], missing: [sku], error: string|null }.
async function fillZeroCustomsValues(order, tag) {
  const result = { filled: [], missing: [], error: null };
  if (!appliesTo(order)) return result;

  const items = Array.isArray(order.internationalOptions?.customsItems) ? order.internationalOptions.customsItems : [];
  const boxProducts = (order.requestedPackageLineItems || []).flatMap((b) => Array.isArray(b?.products) ? b.products : []);
  const isZero = (l) => !(parseFloat(l.declaredValue) > 0);

  // Order-wide quantity per SKU: box products carry the SKU's FULL line value
  // in every box (see orderUnitValues), so they get price x order quantity.
  const totalQty = {};
  const qtySource = items.length ? items : boxProducts;
  for (const l of qtySource) {
    if (l?.sku == null) continue;
    totalQty[l.sku] = (totalQty[l.sku] || 0) + (parseInt(l.quantity) || 0);
  }

  const skus = [...new Set(items.concat(boxProducts).filter((l) => l?.sku != null && isZero(l)).map((l) => String(l.sku)))];
  if (!skus.length) return result;

  // All SKUs at once (one Logiwa call each, cached for an hour).
  const looked = await Promise.all(skus.map((sku) => salesPrice(order.clientIdentifier, sku)
    .then((unit) => ({ sku, unit }), (e) => ({ sku, err: e.response?.status || e.message }))));
  const failed = looked.find((x) => x.err != null);
  if (failed) {
    result.error = 'Could not read the Sales Price for SKU ' + failed.sku + ' from Logiwa (' + failed.err + ')';
    console.error('[' + tag + '] ZERO-VALUE ' + order.shipmentOrderCode + ' — ' + result.error);
    return result;
  }

  for (const { sku, unit } of looked) {
    if (!(unit > 0)) { result.missing.push(sku); continue; }
    for (const l of items) {
      if (String(l.sku) === sku && isZero(l)) l.declaredValue = Math.round(unit * (parseInt(l.quantity) || 1) * 100) / 100;
    }
    for (const l of boxProducts) {
      if (String(l.sku) === sku && isZero(l)) l.declaredValue = Math.round(unit * (totalQty[sku] || parseInt(l.quantity) || 1) * 100) / 100;
    }
    result.filled.push({ sku, unit });
  }

  if (result.filled.length) {
    console.log('[' + tag + '] ZERO-VALUE ' + order.shipmentOrderCode + ' ($0 lines declared at Sales Price): '
      + result.filled.map((f) => f.sku + '=$' + f.unit).join(', '));
  }
  if (result.missing.length) {
    console.log('[' + tag + '] ZERO-VALUE ' + order.shipmentOrderCode + ' — no Sales Price in Logiwa for: ' + result.missing.join(', '));
  }
  return result;
}

// The message a label request is refused with, or null when it may go ahead.
function zeroValueRefusal(r) {
  if (r.error) return r.error + '. Try again in a minute.';
  if (r.missing.length) {
    return 'Customs value is $0 for SKU ' + r.missing.join(', ')
      + ' and the product has no Sales Price in Logiwa. Add a Sales Price to the product, then create the label again.';
  }
  return null;
}

module.exports = { fillZeroCustomsValues, zeroValueRefusal };
