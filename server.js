/**
 * DHL eCommerce Americas <-> Logiwa Custom Carrier Middleware v2.6.0
 * Changes from v2.5.0:
 *   - HAZMAT: a box holding a product Logiwa flags as hazardous is declared to
 *     DHL as packageDetail.contentCategory on /get-rate and /create-label
 *     (Limited Quantity by default, lithium categories by UN number). Only the
 *     DHL products allowed to carry it are offered — Ground for Limited
 *     Quantity — and a label on any other service is refused. International
 *     hazmat is Parcel Direct to Canada / Mexico only; anywhere else is blocked.
 *   - Ground (GND) is offered to Logiwa's rate shop only for hazmat orders.
 *
 * Changes in v2.5.0 (from v2.4.6):
 *   - MULTI-BOX support: /get-rate and /create-label now loop over every
 *     requestedPackageLineItems entry instead of only [0]. Rates are summed
 *     across boxes; create-label returns one tracking number per box.
 *   - Per-box customs: international customsDetails + declaredValue are built
 *     from each box's products[] (what was actually packed in that box),
 *     falling back to order-level internationalOptions.customsItems only when
 *     a box has no products[]. Stops over-declaring the whole order on each box.
 *   - Single-line request/response logging to stay under Railway's 500 logs/sec.
 */
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const DHL_CLIENT_ID     = process.env.DHL_CLIENT_ID;
const DHL_CLIENT_SECRET = process.env.DHL_CLIENT_SECRET;
const DHL_PICKUP_ID     = process.env.DHL_PICKUP_ID;
const DHL_DISTRIBUTION  = process.env.DHL_DISTRIBUTION;
const PORT = process.env.PORT || 3000;

const DHL_AUTH_URL = 'https://api.dhlecs.com/auth/v4/accesstoken';
const DHL_BASE_URL = 'https://api.dhlecs.com';

const MIDDLEWARE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : (process.env.MIDDLEWARE_URL || 'https://dhl-logiwa-middleware-production.up.railway.app');

const labelCache = {};

let cachedToken = null;
let tokenExpiry  = 0;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
// Carrier API calls only — no full Logiwa payload dumps (causes Railway log rate limit)

// Single-line logs only. Railway drops messages past 500 logs/sec, and the old
// pretty-printed dumps emitted one log line per JSON line — enough to blow the
// cap on a multi-box order. Keep each request/response to a single line.
function logRequest(tag, method, url, headers, body) {
  let line = '[' + tag + '] ► REQUEST ' + method + ' ' + url;
  if (body) {
    const s = JSON.stringify(body);
    line += ' BODY: ' + (s.length > 1500 ? s.slice(0, 1500) + '…[truncated]' : s);
  }
  console.log(line);
}

function logResponse(tag, status, data) {
  const s = JSON.stringify(data);
  console.log('[' + tag + '] ◄ RESPONSE status=' + status + ' BODY: ' + (s.length > 1000 ? s.slice(0, 1000) + '…[truncated]' : s));
}

function logError(tag, error) {
  if (error.response) {
    console.error('[' + tag + '] ✗ ERROR status=' + error.response.status + ' BODY: ' + JSON.stringify(error.response.data));
  } else if (error.request) {
    console.error('[' + tag + '] ✗ ERROR NO RESPONSE RECEIVED (network error): ' + error.message);
  } else {
    console.error('[' + tag + '] ✗ ERROR ' + error.message);
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function getDHLToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  logRequest('AUTH', 'POST', DHL_AUTH_URL,
    { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ***' },
    { grant_type: 'client_credentials' }
  );
  try {
    const r = await axios.post(DHL_AUTH_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: DHL_CLIENT_ID, password: DHL_CLIENT_SECRET },
    });
    logResponse('AUTH', r.status, { access_token: '***REDACTED***', expires_in: r.data.expires_in, token_type: r.data.token_type });
    cachedToken = r.data.access_token;
    tokenExpiry  = Date.now() + 55 * 60 * 1000;
    console.log('[AUTH] DHL token refreshed successfully');
    return cachedToken;
  } catch (e) { logError('AUTH', e); throw e; }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseLogiwaBody(body) { return Array.isArray(body) ? body : [body]; }

function getAddr(obj) {
  if (!obj) return {};
  const a = obj.address || obj;
  return {
    address1:   a.AddressLine1 || a.addressLine1 || a.adressLine1 || '',
    address2:   a.AddressLine2 || a.addressLine2 || '',
    city:       a.City         || a.city         || '',
    state:      a.StateOrProvinceCode || a.stateOrProvinceCode || '',
    postalCode: a.PostalCode   || a.postalCode   || '',
    country:    a.CountryCode  || a.countryCode  || 'US',
  };
}

function getContact(obj) {
  if (!obj) return {};
  const c = obj.contact || obj;
  return {
    name:    c.personName   || c.name    || '',
    company: c.companyName  || c.company || '',
    phone:   c.phoneNumber  || c.phone   || '',
    email:   c.emailAddress || c.email   || '',
  };
}

function weightToLB(value, unit) {
  const v = parseFloat(value) || 0;
  const u = (unit || 'LB').toUpperCase();
  let lb;
  if      (u === 'OZ') lb = v / 16;
  else if (u === 'G')  lb = v / 453.592;
  else if (u === 'KG') lb = v * 2.20462;
  else                 lb = v;
  return Math.max(Math.ceil(lb * 100) / 100, 0.01);
}

function mapServiceToDHL(s) {
  if (!s) return 'GND';
  const u = s.toUpperCase();
  if (u === 'PLT-DDP') return 'PLT';
  const map = {
    'GND':'GND','GROUND':'GND','EXP':'EXP','EXPEDITED':'EXP',
    'MAX':'MAX','BGN':'BGN','BEX':'BEX','PLT':'PLT','PLY':'PLY',
    'PKY':'PKY','RGN':'RGN','RPL':'RPL','RLT':'RLT',
  };
  for (const [key, val] of Object.entries(map)) {
    if (u === key || u.includes(key)) return val;
  }
  return s;
}

function stripUspsPrefix(trackingId) {
  if (!trackingId) return '';
  if (trackingId.startsWith('420') && trackingId.length > 8) {
    return trackingId.slice(8);
  }
  return trackingId;
}

function buildCustomsDetails(customsItems, currency) {
  if (!Array.isArray(customsItems) || !customsItems.length) return null;
  return customsItems.map(item => {
    // DHL itemValue is PER-UNIT and DHL multiplies it by packagedQuantity.
    // Logiwa's declaredValue is the LINE TOTAL, so divide by quantity — else
    // DHL inflates the customs value by qty and trips its $2,500 cap.
    const qty       = parseInt(item.quantity) || 1;
    const lineTotal = parseFloat(item.declaredValue) || 0;
    return {
      itemDescription:  (item.description || 'Merchandise').slice(0, 50),
      packagedQuantity: qty,
      itemValue:        Math.round((lineTotal / qty) * 100) / 100,
      currency:         currency || 'USD',
      countryOfOrigin:  item.originCountryCode || 'US',
      ...(item.hsTariffCode && { hsCode: item.hsTariffCode }),
    };
  });
}

// True per-unit customs value per SKU for the whole order. Logiwa repeats a
// SKU's FULL line declaredValue in every box that contains it (with that box's
// quantity), so dividing a box's lineTotal by the box quantity over-declares a
// split SKU in each box. We instead derive per-unit = full line ÷ TOTAL order
// quantity, so the same SKU declares the same per-unit value in every box and
// the boxes sum to the true order value. Prefer the order-level customsItems
// rollup; fall back to summing quantities across the boxes' products.
function orderUnitValues(order) {
  const lineTotal = {};  // sku -> full line declaredValue
  const totalQty  = {};  // sku -> total quantity across the order

  const items = order.internationalOptions?.customsItems;
  if (Array.isArray(items) && items.length) {
    for (const it of items) {
      if (!it.sku) continue;
      lineTotal[it.sku] = parseFloat(it.declaredValue) || 0;
      totalQty[it.sku]  = parseInt(it.quantity) || 1;
    }
  } else {
    // No order-level rollup: reconstruct from the boxes. Each box carries the
    // SKU's full line value, so take it once and sum quantities across boxes.
    for (const box of (order.requestedPackageLineItems || [])) {
      for (const p of (box.products || [])) {
        if (!p.sku) continue;
        lineTotal[p.sku] = parseFloat(p.declaredValue) || 0;
        totalQty[p.sku]  = (totalQty[p.sku] || 0) + (parseInt(p.quantity) || 0);
      }
    }
  }

  const map = {};
  for (const sku of Object.keys(lineTotal)) {
    const q = totalQty[sku] || 1;
    map[sku] = Math.round((lineTotal[sku] / q) * 100) / 100;
  }
  return map;
}

// requestedPackageLineItems[].products[] = the items actually packed in THAT
// box. internationalOptions.customsItems[] is the order-level rollup of all
// boxes' products. For multi-box international shipments we declare each box's
// own products — not the whole order on every box. itemValue is PER-UNIT (DHL
// multiplies by packagedQuantity); we use the order-wide per-unit value so a
// split SKU isn't over-declared in each box.
function buildCustomsFromProducts(products, currency, unitValues) {
  if (!Array.isArray(products) || !products.length) return null;
  return products.map(item => {
    const qty       = parseInt(item.quantity) || 1;
    const lineTotal = parseFloat(item.declaredValue) || 0;
    const perUnit   = (unitValues && item.sku != null && unitValues[item.sku] != null)
      ? unitValues[item.sku]
      : Math.round((lineTotal / qty) * 100) / 100;
    return {
      itemDescription:  (item.description || 'Merchandise').slice(0, 50),
      packagedQuantity: qty,
      itemValue:        perUnit,
      currency:         currency || 'USD',
      countryOfOrigin:  item.originCountryCode || 'US',
      ...(item.hsTariffCode && { hsCode: item.hsTariffCode }),
    };
  });
}

// Always returns an array of at least one box, so callers can loop uniformly.
function getBoxes(order) {
  const items = order.requestedPackageLineItems;
  return (Array.isArray(items) && items.length) ? items : [{}];
}

// Per-box customs + declaredValue for an international shipment. Prefers the
// box's own products[]; falls back to order-level customsItems / order total
// only when a box has no products[]. declaredValue is summed from the same
// per-unit values DHL sees (Σ itemValue × packagedQuantity), so the box's
// declared value reflects only its own contents and the boxes sum to the order.
function boxCustomsAndValue(order, box) {
  const hasProducts = box && Array.isArray(box.products) && box.products.length;
  if (hasProducts) {
    const customs = buildCustomsFromProducts(box.products, order.currency, orderUnitValues(order));
    const declaredValue = Math.round(
      customs.reduce((s, c) => s + c.itemValue * c.packagedQuantity, 0) * 100
    ) / 100;
    return { customs, declaredValue };
  }
  return {
    customs:       buildCustomsDetails(order.internationalOptions?.customsItems, order.currency),
    declaredValue: parseFloat(order.shipmentOrderTotalPrice || 0),
  };
}

// ─── HAZMAT / DANGEROUS GOODS ─────────────────────────────────────────────────
// Logiwa flags hazmat per product (isHazardous + hazmat* fields) on each box's
// products[] and on internationalOptions.customsItems. DHL takes the
// declaration as packageDetail.contentCategory, on the rate AND the label call.
//
// DHL "Content Categories", domestic:
//   01 / 04  lithium metal / ion, contained in equipment  — GND, EXP, MAX
//   02 / 05  lithium metal / ion, packed with equipment   — GND only
//   03 / 06  lithium metal / ion, stand-alone             — GND only
//   08       Limited Quantity / ORM-D (max 25 lb)         — GND only
//   09       Small Quantity Provision                     — GND only
// International: Parcel Direct (PLT) to Canada and Mexico only, where Limited
// Quantity is code 40 and Small Quantity is not accepted.
//
// With contentCategory on the rate request DHL itself returns only the
// products that may carry it (verified live: 08 returns GND alone, with the
// hazmat surcharge in the price). We filter to the same list anyway, and
// refuse a label on any other service.

// A hazmat product with no lithium UN number is declared as this category.
const DG_DEFAULT_CATEGORY = process.env.DHL_DG_DEFAULT_CATEGORY || '08';

// 09 Small Quantity Provision is 49 CFR 173.4: inner containers of 30 mL / 30 g
// or less, domestic ground only, no Limited Quantity mark. Logiwa has no
// "small quantity" Hazmat Type, so a product opts in with one of these Hazmat
// Types (EQ, Excepted Quantity, by default) or by naming 173.4 / "small
// quantity" in its shipping name.
const DG_SMALL_QTY_CATEGORY = '09';
const DG_SMALL_QTY_TYPES = (process.env.DHL_DG_SMALL_QTY_TYPES || 'EQ')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function isSmallQuantityLine(p) {
  const type = String(p.hazmatTypeName || p.hazmatType || '').trim().toUpperCase();
  return DG_SMALL_QTY_TYPES.includes(type)
    || /173\.4\b|small\s+quantit/i.test(p.hazmatShippingName || '');
}
const DG_ALL_SERVICES  = ['GND', 'EXP', 'MAX'];
const DG_INTL_COUNTRIES = ['CA', 'MX'];
// The DHL product offered to Logiwa only when the order holds hazmat.
const HAZMAT_ONLY_SERVICE = 'GND';

function isHazmatLine(p) {
  return !!p && (p.isHazardous === true || String(p.isHazardous).toLowerCase() === 'true'
    || !!p.hazmatIdentificationNumber || !!p.hazmatClassDivisionNumber);
}

// DHL content category for one hazmat product. Lithium batteries are told
// apart by UN number; "contained in equipment" must be said in the shipping
// name, otherwise the stricter ground-only category is used.
function dgCategoryForLine(p) {
  const un = String(p.hazmatIdentificationNumber || '').replace(/\D/g, '');
  const contained = /contained\s+in/i.test(p.hazmatShippingName || '');
  if (un === '3090') return '03';
  if (un === '3091') return contained ? '01' : '02';
  if (un === '3480') return '06';
  if (un === '3481') return contained ? '04' : '05';
  if (isSmallQuantityLine(p)) return DG_SMALL_QTY_CATEGORY;
  return DG_DEFAULT_CATEGORY;
}

function orderProducts(order) {
  const customs = order.internationalOptions?.customsItems;
  return getBoxes(order).flatMap(b => Array.isArray(b.products) ? b.products : [])
    .concat(Array.isArray(customs) ? customs : []);
}

// What one box has to declare. Uses the box's own products[]; when Logiwa
// sends none, the order-level items stand in for every box.
//   skus     — the hazmat SKUs ([] = nothing to declare)
//   category — packageDetail.contentCategory to send DHL
//   services — DHL products allowed to carry it
//   blocked  — why DHL cannot take this box at all (no rate, no label)
function boxDangerousGoods(order, box, isIntl, country) {
  const own   = box && Array.isArray(box.products) && box.products.length ? box.products : null;
  const lines = (own || order.internationalOptions?.customsItems || []).filter(isHazmatLine);
  const skus  = [...new Set(lines.map(p => p.sku || p.description || 'unknown SKU'))];
  if (!skus.length) return { skus, category: null, services: null, blocked: null };

  const label = 'Hazmat item on order (' + skus.join(', ') + ')';
  const cats  = [...new Set(lines.map(dgCategoryForLine))];
  if (cats.length > 1) {
    return { skus, category: null, services: [], blocked: label + ' — one box mixes DHL dangerous goods categories ' + cats.join(' + ') + '; DHL takes one per package' };
  }
  let category = cats[0];

  if (isIntl) {
    const c = (country || '').toUpperCase();
    if (!DG_INTL_COUNTRIES.includes(c)) {
      return { skus, category: null, services: [], blocked: label + ' — DHL eCommerce ships hazmat internationally to Canada and Mexico only, not ' + (c || '?') };
    }
    if (category === '09') {
      return { skus, category: null, services: [], blocked: label + ' — DHL eCommerce does not ship Small Quantity hazmat internationally' };
    }
    if (category === '08') category = '40';
    return { skus, category, services: ['PLT'], blocked: null };
  }

  const services = (category === '01' || category === '04') ? DG_ALL_SERVICES : ['GND'];
  return { skus, category, services, blocked: null };
}

// One entry per box, plus the order-wide answer: is it hazmat, is it blocked,
// and which DHL products every hazmat box allows.
function orderDangerousGoods(order, boxes, isIntl, country) {
  const perBox  = boxes.map(box => boxDangerousGoods(order, box, isIntl, country));
  const hazBoxes = perBox.filter(d => d.skus.length);
  const blocked = (hazBoxes.find(d => d.blocked) || {}).blocked || null;
  const services = hazBoxes.length
    ? hazBoxes.reduce((ok, d) => ok.filter(s => d.services.includes(s)), hazBoxes[0].services.slice())
    : null;
  return {
    perBox, blocked, services,
    isHazmat: hazBoxes.length > 0,
    skus: [...new Set(hazBoxes.flatMap(d => d.skus))],
    categories: [...new Set(hazBoxes.map(d => d.category).filter(Boolean))],
  };
}

function hazmatError(message) { return Object.assign(new Error(message), { hazmat: true }); }

// ─── LIMITED QUANTITY MARK ────────────────────────────────────────────────────
// A hazmat carton must carry the Limited Quantity mark (49 CFR §172.315): a
// square on point, top and bottom corners black, centre white. We print it as
// a second label straight after the shipping label, in the same file, so the
// packer gets both from one print.
//
// Size: the rule is 100 mm per side, or no less than 50 mm where the package
// is too small for that. A 4x6 label is 101.6 mm wide, so the largest mark it
// can hold is about 63 mm per side — the reduced size, right for small parcels.
//
// Small Quantity (09) boxes take no diamond. 49 CFR 173.4(a)(10) has the
// shipper certify by marking the package with the statement below, so we
// print that in its place.
//
// Lithium batteries take the lithium battery mark instead, which needs a UN
// number and phone number; we do not print that one.

const LITHIUM_UN = ['3480', '3481', '3090', '3091'];
const SMALL_QTY_STATEMENT = 'This package conforms to 49 CFR 173.4 for domestic highway or rail transport only.';

// Which mark this box's hazmat takes: 'LQ', 'SQ' or null. Uses the box's own
// products[]; when Logiwa sends none, the order's items stand in.
function hazmatMarkFor(order, box) {
  const own   = box && Array.isArray(box.products) && box.products.length ? box.products : null;
  const lines = (own || orderProducts(order)).filter(isHazmatLine)
    .filter(p => !LITHIUM_UN.includes(String(p.hazmatIdentificationNumber || '').replace(/\D/g, '')));
  if (!lines.length) return null;
  return lines.every(p => dgCategoryForLine(p) === DG_SMALL_QTY_CATEGORY) ? 'SQ' : 'LQ';
}

// Breaks text into lines no wider than `room` at the given size.
function wrapText(text, measure, room) {
  const out = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = out[out.length - 1];
    if (last !== undefined && measure(last + ' ' + word) <= room) out[out.length - 1] = last + ' ' + word;
    else out.push(word);
  }
  return out;
}

// The mark as plain geometry, in whatever unit the caller draws in.
//   r = half the diagonal, t = border thickness, a = half-height of the white band
function lqGeometry(width, height, margin, t) {
  const r  = Math.min(width, height) / 2 - margin;
  const cx = width / 2, cy = height / 2;
  const a  = r * 0.5;
  const ri = r - t * Math.SQRT2;          // inner (white) diamond, inset by the border
  return { r, cx, cy, a, ri, t };
}

async function lqMarkPdf(pdfBase64, caption) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc   = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const first = doc.getPage(0).getSize();
  const page  = doc.addPage([first.width, first.height]);
  const { width: W, height: H } = first;
  const mm = 72 / 25.4;
  const g  = lqGeometry(W, H, 6 * mm, 2 * mm);
  const P  = (pts) => 'M ' + pts.map(([x, y]) => x.toFixed(2) + ' ' + y.toFixed(2)).join(' L ') + ' Z';
  // SVG path space: origin top-left of the page, y down.
  const at = { x: 0, y: H };
  page.drawSvgPath(P([[g.cx, g.cy - g.r], [g.cx + g.r, g.cy], [g.cx, g.cy + g.r], [g.cx - g.r, g.cy]]), { ...at, color: rgb(0, 0, 0) });
  const w = g.ri - g.a;                    // half-width of the white band at its top and bottom
  page.drawSvgPath(P([[g.cx - w, g.cy - g.a], [g.cx + w, g.cy - g.a], [g.cx + g.ri, g.cy], [g.cx + w, g.cy + g.a], [g.cx - w, g.cy + g.a], [g.cx - g.ri, g.cy]]), { ...at, color: rgb(1, 1, 1) });
  // One caption line per entry, centred; the size drops until the widest fits.
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const room = W - 2 * 4 * mm;
  let size = 14;
  while (size > 6 && Math.max(...caption.map(l => font.widthOfTextAtSize(l, size))) > room) size -= 0.5;
  caption.forEach((line, i) => {
    const y = 7 * mm + (caption.length - 1 - i) * size * 1.25;
    page.drawText(line, { x: (W - font.widthOfTextAtSize(line, size)) / 2, y, size, font, color: rgb(0, 0, 0) });
  });
  return Buffer.from(await doc.save()).toString('base64');
}

// The Small Quantity page: the 173.4 statement, large and centred, with the
// order code under it.
async function sqMarkPdf(pdfBase64, orderCode) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc   = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const { width: W, height: H } = doc.getPage(0).getSize();
  const page  = doc.addPage([W, H]);
  const mm    = 72 / 25.4;
  const font  = await doc.embedFont(StandardFonts.HelveticaBold);
  const room  = W - 2 * 8 * mm;
  const size  = 20;
  const lines = wrapText(SMALL_QTY_STATEMENT, l => font.widthOfTextAtSize(l, size), room);
  const lead  = size * 1.3;
  let y = H / 2 + (lines.length * lead) / 2;
  page.drawRectangle({ x: 5 * mm, y: y - lines.length * lead - 4 * mm, width: W - 10 * mm, height: lines.length * lead + 10 * mm, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  for (const line of lines) {
    y -= lead;
    page.drawText(line, { x: (W - font.widthOfTextAtSize(line, size)) / 2, y: y + lead * 0.25, size, font, color: rgb(0, 0, 0) });
  }
  if (orderCode) {
    let s = 14;
    while (s > 6 && font.widthOfTextAtSize(orderCode, s) > W - 8 * mm) s -= 0.5;
    page.drawText(orderCode, { x: (W - font.widthOfTextAtSize(orderCode, s)) / 2, y: 7 * mm, size: s, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save()).toString('base64');
}

function sqMarkZpl(label, orderCode) {
  const plain = String(label).includes('^XA');
  const zpl   = plain ? String(label) : Buffer.from(String(label), 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  const pw  = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const dpm = pw / 101.6;
  const W = pw, H = Math.round(pw * 1.5);
  const clean = s => String(s).replace(/[\^~\\]/g, ' ');
  const out = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0',
    '^FO' + Math.round(5 * dpm) + ',' + Math.round(H / 2 - 30 * dpm) + '^GB' + Math.round(W - 10 * dpm) + ',' + Math.round(60 * dpm) + ',' + Math.round(0.7 * dpm) + '^FS',
    '^FO' + Math.round(8 * dpm) + ',' + Math.round(H / 2 - 24 * dpm) + '^A0N,' + Math.round(7 * dpm) + ',' + Math.round(7 * dpm) + '^FB' + Math.round(W - 16 * dpm) + ',6,' + Math.round(1.5 * dpm) + ',C^FD' + clean(SMALL_QTY_STATEMENT) + '^FS'];
  if (orderCode) out.push('^FO' + Math.round(4 * dpm) + ',' + Math.round(H - 18 * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + Math.round(W - 8 * dpm) + ',2,' + Math.round(dpm) + ',C^FD' + clean(orderCode) + '^FS');
  out.push('^XZ');
  const both = zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n';
  return plain ? both : Buffer.from(both).toString('base64');
}

// Carriers hand ZPL back either as plain text or base64; return it the same way.
function lqMarkZpl(label, caption) {
  const plain = String(label).includes('^XA');
  const zpl   = plain ? String(label) : Buffer.from(String(label), 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  // Match the printer resolution of the carrier's own label: ^PW is its width in dots.
  const pw  = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const dpm = pw / 101.6;                  // dots per mm on a 4-inch-wide label
  const W = pw, H = Math.round(pw * 1.5);
  const g = lqGeometry(W, H, 6 * dpm, 2 * dpm);
  const step = 3;                          // strip height in dots
  const bar  = Math.round(g.t * Math.SQRT2);
  const out  = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0'];
  const strip = (x, y, w) => out.push('^FO' + Math.round(x) + ',' + Math.round(y) + '^GB' + Math.max(Math.round(w), 1) + ',' + step + ',' + step + '^FS');
  for (let y = g.cy - g.r; y < g.cy + g.r; y += step) {
    const hw = g.r - Math.abs(y + step / 2 - g.cy);   // half-width of the diamond on this row
    if (hw <= 0) continue;
    if (Math.abs(y + step / 2 - g.cy) >= g.a || hw * 2 <= bar * 2) {
      strip(g.cx - hw, y, hw * 2);                     // black corner: full width
    } else {
      strip(g.cx - hw, y, bar);                        // white band: just the two borders
      strip(g.cx + hw - bar, y, bar);
    }
  }
  // ^FB wraps inside the label width; \& starts each caption line on its own row.
  const text = caption.map(l => l.replace(/[\^~\\]/g, ' ')).join('\\&');
  const lines = caption.length + 1;        // room for one extra wrap of a long order code
  out.push('^FO' + Math.round(4 * dpm) + ',' + Math.round(H - (6 + 6 * lines) * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + Math.round(W - 8 * dpm) + ',' + lines + ',' + Math.round(dpm) + ',C^FD' + text + '^FS', '^XZ');
  const both = zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n';
  return plain ? both : Buffer.from(both).toString('base64');
}

// The shipping label with the box's hazmat mark added after it: the Limited
// Quantity diamond, or the 173.4 statement for Small Quantity. The shipping
// label is already bought by the time this runs, so any failure here hands
// the original label back untouched.
async function withLimitedQuantityMark(tag, label, format, order, box) {
  const mark = label && hazmatMarkFor(order, box);
  if (!mark) return label;
  const fmt  = String(format || '').toLowerCase();
  const code = order.shipmentOrderCode || '';
  const name = mark === 'SQ' ? 'Small Quantity (49 CFR 173.4) statement' : 'Limited Quantity mark';
  // Two lines, so a long order code never runs off the edge of the label.
  const caption = ['LIMITED QUANTITY', code].filter(Boolean);
  try {
    let out;
    if (fmt.includes('zpl')) out = mark === 'SQ' ? sqMarkZpl(label, code) : lqMarkZpl(label, caption);
    else if (fmt.includes('pdf')) out = mark === 'SQ' ? await sqMarkPdf(label, code) : await lqMarkPdf(label, caption);
    else throw new Error('cannot add a label to ' + (format || 'unknown') + ' format');
    console.log('[' + tag + '] ' + name + ' added after the shipping label (' + fmt + ')');
    return out;
  } catch (e) {
    console.warn('[' + tag + '] ⚠ could not add the ' + name + ' — apply one by hand: ' + e.message);
    return label;
  }
}

// ─── ORIENTATION ARROWS ("THIS SIDE UP") ─────────────────────────────────────
// A box holding liquid hazmat (perfume, nail polish) must carry package
// orientation arrows on two opposite sides (49 CFR §172.312; GOFO and UniUni
// guides §4.2.3), and the shipping label does not count as one. We print two
// more 4x6 labels after the hazmat mark, one per side, so nothing needs cutting.
//
// Look approved by Ezra 2026-10-20: two arrows over a bar inside a box, about
// 1.8 x 2.8 in, centred on a sideways (landscape) 4x6, arrows pointing up when
// the label is turned sideways. No words — the rule asks for the symbol only.
//
// Liquid = class 3 (flammable liquids are always liquid), or a shipping name
// that says liquid / solution. Aerosols (UN1950, class 2) and solids get none.

function isLiquidHazmatLine(p) {
  if (!isHazmatLine(p)) return false;
  const un  = String(p.hazmatIdentificationNumber || '').replace(/\D/g, '');
  const cls = (String(p.hazmatClassDivisionNumber || '').match(/\d(\.\d)?/) || [''])[0];
  if (un === '1950' || cls.startsWith('2')) return false;
  return cls === '3' || /liquid|solution/i.test(p.hazmatShippingName || '');
}

function needsOrientationArrows(order, box) {
  const own = box && Array.isArray(box.products) && box.products.length ? box.products : null;
  return (own || orderProducts(order)).some(isLiquidHazmatLine);
}

// The mark as rectangles and arrow outlines, in points on a 6x4 landscape page
// (432 x 288), y down. Drawn as the approved sample: box 128 x 200 centred.
function arrowShapes() {
  const rects = [
    // border, as four bars 4 pt thick
    [150, 42, 132, 4], [150, 242, 132, 4], [150, 42, 4, 204], [278, 42, 4, 204],
    [172, 207, 88, 11],                    // base bar under the arrows
  ];
  const arrows = [191, 241].map(cx => [
    [cx, 63], [cx + 18, 103], [cx + 7, 103], [cx + 7, 197],
    [cx - 7, 197], [cx - 7, 103], [cx - 18, 103],
  ]);
  return { rects, arrows };
}

// Two pages the same size as the shipping label. Each is turned a quarter
// (/Rotate 90) so it shows sideways like the approved sample; on the roll the
// arrows point to the label's left edge, the same as the ZPL version.
async function arrowsPdf(pdfBase64) {
  const { PDFDocument, rgb, degrees } = require('pdf-lib');
  const doc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const { width: W, height: H } = doc.getPage(0).getSize();
  const s = Math.min(W / 288, H / 432);
  const { rects, arrows } = arrowShapes();
  // Landscape (X, Y down) → upright page (x, y down): x = Y, y = H - X.
  const pt = ([X, Y]) => [Y * s, H - X * s];
  const P = (pts) => 'M ' + pts.map(p => pt(p).map(n => n.toFixed(2)).join(' ')).join(' L ') + ' Z';
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([W, H]);
    page.setRotation(degrees(90));
    const at = { x: 0, y: H, color: rgb(0, 0, 0) };
    for (const [x, y, w, h] of rects) page.drawSvgPath(P([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), at);
    for (const a of arrows) page.drawSvgPath(P(a), at);
  }
  return Buffer.from(await doc.save()).toString('base64');
}

// Carriers hand ZPL back either as plain text or base64; return it the same way.
function arrowsZpl(label) {
  const plain = String(label).includes('^XA');
  const zpl   = plain ? String(label) : Buffer.from(String(label), 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  const pw = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const W = pw, H = Math.round(pw * 1.5);
  const s = pw / 288;                      // dots per point on a 4-inch-wide label
  const { rects, arrows } = arrowShapes();
  const box = (x, y, w, h) => '^FO' + Math.round(x) + ',' + Math.round(y) + '^GB' + Math.max(Math.round(w), 1) + ',' + Math.max(Math.round(h), 1) + ',' + Math.max(Math.round(Math.min(w, h)), 1) + '^FS';
  const page = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0'];
  // Landscape rectangle (X, Y, w, h) → upright: x = Y, y = H - X - w.
  for (const [X, Y, w, h] of rects) page.push(box(Y * s, H - (X + w) * s, h * s, w * s));
  for (const a of arrows) {
    const [cx, tip] = a[0], half = a[1][0] - cx, base = a[1][1], shaft = a[2][0] - cx, end = a[3][1];
    page.push(box(base * s, H - (cx + shaft) * s, (end - base) * s, 2 * shaft * s));   // shaft
    // Head: columns from the tip, each as tall as the triangle is wide there.
    const step = 3;
    for (let Y = tip; Y < base; Y += step / s) {
      const hw = half * (Y + step / s / 2 - tip) / (base - tip);
      page.push(box(Y * s, H - (cx + hw) * s, step, 2 * hw * s));
    }
  }
  page.push('^XZ');
  const one  = page.join('\n');
  const all  = zpl.replace(/\s+$/, '') + '\n' + one + '\n' + one + '\n';
  return plain ? all : Buffer.from(all).toString('base64');
}

// The label with two orientation-arrow labels added after it, for a box of
// liquid hazmat. The shipping label is already bought by now, so any failure
// hands the label back as it was.
async function withOrientationArrows(tag, label, format, order, box) {
  if (!label || !needsOrientationArrows(order, box)) return label;
  const fmt = String(format || '').toLowerCase();
  try {
    let out;
    if (fmt.includes('zpl')) out = arrowsZpl(label);
    else if (fmt.includes('pdf')) out = await arrowsPdf(label);
    else throw new Error('cannot add a label to ' + (format || 'unknown') + ' format');
    console.log('[' + tag + '] 2 orientation-arrow labels added (' + fmt + ')');
    return out;
  } catch (e) {
    console.warn('[' + tag + '] ⚠ could not add the orientation arrows — apply two by hand: ' + e.message);
    return label;
  }
}

/**
 * Resolve label format from Logiwa labelSpecification.
 * DHL label endpoint accepts format as a query param: ?format=PDF or ?format=ZPL
 * labelData in response is always BASE64 regardless of format.
 */
function resolveLabelFormat(order) {
  const raw = (
    order.labelSpecification?.labelFileType ||
    order.labelSpecification?.labelFormat   ||
    'PDF'
  ).toUpperCase();

  if (raw === 'ZPL') {
    return {
      format:      'zpl',
      queryParam:  'ZPL',
      mimeType:    'application/x-zebra-zpl',
    };
  }
  // Default PDF
  return {
    format:     'pdf',
    queryParam: 'PDF',
    mimeType:   'application/pdf',
  };
}

const DEFAULT_FROM = {
  name:'ShipFlow', address1:'625 JERSEY AVE STE 9', address2:'',
  city:'NEW BRUNSWICK', state:'NJ', postalCode:'08901', country:'US',
  phone:'9085253857', email:'info@shipflow.co',
};

function buildReturnAddress(shipFrom) {
  const a = getAddr(shipFrom);
  const c = getContact(shipFrom);
  return {
    name:       c.name       || DEFAULT_FROM.name,
    address1:   a.address1   || DEFAULT_FROM.address1,
    address2:   a.address2   || DEFAULT_FROM.address2,
    city:       a.city       || DEFAULT_FROM.city,
    state:      a.state      || DEFAULT_FROM.state,
    postalCode: a.postalCode || DEFAULT_FROM.postalCode,
    country:    a.country    || DEFAULT_FROM.country,
    phone:      c.phone      || DEFAULT_FROM.phone,
    email:      c.email      || DEFAULT_FROM.email,
  };
}

// ─── RATE LOOKUP HELPER ───────────────────────────────────────────────────────

async function getRateForService(token, order, weightLB, dims, targetService, box) {
  const shipTo    = getAddr(order.shipTo);
  const toContact = getContact(order.shipTo);
  const l = parseFloat(dims.Length || dims.length || 0);
  const w = parseFloat(dims.Width  || dims.width  || 0);
  const h = parseFloat(dims.Height || dims.height || 0);
  const isIntl = (shipTo.country || 'US').toUpperCase() !== 'US';
  const isDDP  = (order.shippingOption || '').toUpperCase() === 'PLT-DDP';
  const dg     = boxDangerousGoods(order, box || {}, isIntl, shipTo.country);

  const rateReq = {
    consigneeAddress: {
      name:       toContact.name || toContact.company || 'Recipient',
      address1:   shipTo.address1   || 'N/A',
      address2:   shipTo.address2,
      city:       shipTo.city       || 'N/A',
      state:      shipTo.state,
      postalCode: shipTo.postalCode,
      country:    shipTo.country    || 'US',
    },
    returnAddress:      buildReturnAddress(order.shipFrom),
    distributionCenter: DHL_DISTRIBUTION,
    pickup:             DHL_PICKUP_ID,
    rate:               { calculate: true, currency: order.currency || 'USD' },
    estimatedDeliveryDate: { calculate: true },
    packageDetail: {
      packageId: ('RATE' + (order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'') + Date.now()).slice(0,30),
      packageDescription: order.shipmentOrderCode || 'Shipment',
      weight: { unitOfMeasure: 'LB', value: weightLB },
      ...(dg.category && { contentCategory: dg.category }),
      ...(l > 0 && w > 0 && h > 0 && {
        dimension: { length:l, width:w, height:h, unitOfMeasure:(dims.Units||dims.units||'IN').toUpperCase() },
      }),
    },
  };

  if (isIntl) {
    const { customs, declaredValue } = boxCustomsAndValue(order, box);
    rateReq.packageDetail.shippingCost = {
      currency:      order.currency || 'USD',
      declaredValue,
      ...(isDDP && { dutiesPaid: true }),
    };
    if (customs) rateReq.customsDetails = customs;
  }

  try {
    const rateRes = await axios.post(DHL_BASE_URL + '/shipping/v4/products', rateReq, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const prods = Array.isArray(rateRes.data?.products) ? rateRes.data.products : [];
    const match = prods.find(p => (p.orderedProductId || '').toUpperCase() === targetService.toUpperCase());
    const cost = parseFloat((match || prods[0])?.rate?.amount || 0);
    console.log('[RATE-LOOKUP] Service=' + targetService + (isDDP ? ' (DDP)' : '') + ' cost=$' + cost + ' from ' + prods.length + ' products');
    return cost;
  } catch (e) {
    console.warn('[RATE-LOOKUP] Failed, defaulting to 0:', e.message);
    return 0;
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'running',
  service: 'DHL eCommerce <-> Logiwa Middleware',
  version: '2.6.0',
}));

// ─── LABEL PROXY ──────────────────────────────────────────────────────────────

app.get('/label/:id', (req, res) => {
  const cached = labelCache[req.params.id];
  if (!cached) {
    console.log('[LABEL-PROXY] Miss for id=' + req.params.id);
    return res.status(404).json({ error: 'Label not found', id: req.params.id });
  }
  const buf = Buffer.from(cached.labelData, 'base64');
  const fmt = (cached.format || 'pdf').toLowerCase();
  const contentType = fmt === 'zpl' ? 'application/x-zebra-zpl'
    : fmt === 'png' ? 'image/png'
    : 'application/pdf';
  console.log('[LABEL-PROXY] Serving label id=' + req.params.id + ' format=' + fmt + ' size=' + buf.length + ' bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'inline; filename="' + req.params.id + '.' + fmt + '"');
  res.send(buf);
});

// ─── GET RATE ─────────────────────────────────────────────────────────────────

app.post('/get-rate', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[GET-RATE] ══ Incoming Logiwa request ══ orders=' + orders.length + ' first=' + orders[0]?.shipmentOrderCode + ' service=' + orders[0]?.shippingOption + ' to=' + (orders[0]?.shipTo?.address?.PostalCode || orders[0]?.shipTo?.address?.postalCode || '?'));

  try {
    const token  = await getDHLToken();
    const out    = [];

    for (const order of orders) {
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const isIntl   = (shipTo.country || 'US').toUpperCase() !== 'US';
      const isDDP    = (order.shippingOption || '').toUpperCase() === 'PLT-DDP';
      const currency = order.currency || 'USD';
      const boxes    = getBoxes(order);
      const round2   = (n) => Math.round(n * 100) / 100;

      const dg = orderDangerousGoods(order, boxes, isIntl, shipTo.country);
      console.log('[GET-RATE] ' + order.shipmentOrderCode + ' boxes=' + boxes.length + (isIntl ? ' INTL ' + shipTo.country : ' DOM') + (isDDP ? ' DDP' : '')
        + ' products=' + orderProducts(order).length
        + ' hazmat=' + (dg.isHazmat ? dg.skus.join(',') + ' category=' + (dg.categories.join(',') || 'none') + ' allowed=' + (dg.services.join(',') || 'none') : 'no'));

      let rateList = [], msg = '';
      try {
        if (dg.blocked) throw hazmatError(dg.blocked);
        if (dg.isHazmat && !dg.services.length) throw hazmatError('Hazmat item on order (' + dg.skus.join(', ') + ') — no single DHL service can carry every box');

        // Price every box; collect each box's returned product list.
        const perBoxProducts = [];
        for (let b = 0; b < boxes.length; b++) {
          const box = boxes[b];
          const weightLB = weightToLB(box.weight?.Value || box.weight?.value, box.weight?.Units || box.weight?.units);
          const dims = box.dimensions || {};
          const l = parseFloat(dims.Length || dims.length || 0);
          const w = parseFloat(dims.Width  || dims.width  || 0);
          const h = parseFloat(dims.Height || dims.height || 0);

          const dhlReq = {
            consigneeAddress: {
              name:       toContact.name || toContact.company || 'Recipient',
              address1:   shipTo.address1   || 'N/A',
              address2:   shipTo.address2,
              city:       shipTo.city       || 'N/A',
              state:      shipTo.state,
              postalCode: shipTo.postalCode,
              country:    shipTo.country    || 'US',
            },
            returnAddress:      buildReturnAddress(order.shipFrom),
            distributionCenter: DHL_DISTRIBUTION,
            pickup:             DHL_PICKUP_ID,
            rate:               { calculate: true, currency },
            estimatedDeliveryDate: { calculate: true },
            packageDetail: {
              packageId:          ('RATE-' + (order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'') + '-' + (box.packageSequenceNumber ?? 0) + '-' + Date.now()).slice(0,30),
              packageDescription: order.shipmentOrderCode || 'Shipment',
              weight: { unitOfMeasure: 'LB', value: weightLB },
              ...(dg.perBox[b].category && { contentCategory: dg.perBox[b].category }),
              ...(l > 0 && w > 0 && h > 0 && {
                dimension: { length:l, width:w, height:h, unitOfMeasure:(dims.Units||dims.units||'IN').toUpperCase() },
              }),
            },
          };

          if (isIntl) {
            const { customs, declaredValue } = boxCustomsAndValue(order, box);
            dhlReq.packageDetail.shippingCost = {
              currency,
              declaredValue,
              ...(isDDP && { dutiesPaid: true }),
            };
            if (customs) dhlReq.customsDetails = customs;
            else console.warn('[GET-RATE] ⚠ International order but NO customs/products for box ' + (box.packageSequenceNumber ?? 0));
          }

          const rateUrl = DHL_BASE_URL + '/shipping/v4/products';
          logRequest('GET-RATE', 'POST', rateUrl, {}, dhlReq);
          const dhlRes = await axios.post(rateUrl, dhlReq, {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          });
          logResponse('GET-RATE', dhlRes.status, dhlRes.data);
          perBoxProducts.push(Array.isArray(dhlRes.data?.products) ? dhlRes.data.products : []);
        }

        // Combine boxes into order-level options. A service is only offered if
        // it priced for EVERY box; the order cost is the sum across boxes.
        const nBoxes = perBoxProducts.length;
        const svc = {}; // serviceId -> { cost, currency, estDays, count }
        perBoxProducts.forEach((prods) => {
          prods.forEach((p) => {
            const id   = p.orderedProductId || p.productId || p.productName || 'GND';
            const amt  = parseFloat(p.rate?.amount || 0);
            const cur  = p.rate?.currency || currency;
            const days = parseInt(p.estimatedDeliveryDate?.deliveryDaysMin, 10);
            if (!svc[id]) svc[id] = { cost: 0, currency: cur, estDays: null, count: 0 };
            svc[id].cost  += amt;
            svc[id].count += 1;
            if (days) svc[id].estDays = Math.max(svc[id].estDays || 0, days);
          });
        });

        // Hazmat: keep only the DHL products allowed to carry it. DHL already
        // leaves the others out when contentCategory is declared; this makes
        // sure a non-compliant service can never reach Logiwa's rate shop.
        if (dg.isHazmat) {
          for (const id of Object.keys(svc)) {
            if (!dg.services.includes(String(id).toUpperCase())) {
              console.log('[GET-RATE] hazmat — dropping ' + id + ' (not allowed for category ' + dg.categories.join(',') + ')');
              delete svc[id];
            }
          }
        }

        // Ground is for hazmat only. It is the cheapest DHL product, so if it
        // were offered on ordinary orders it would win every rate shop — and we
        // ship those Expedited. A non-hazmat order is never offered Ground.
        if (!dg.isHazmat && svc[HAZMAT_ONLY_SERVICE]) {
          console.log('[GET-RATE] not hazmat — ' + HAZMAT_ONLY_SERVICE + ' $' + round2(svc[HAZMAT_ONLY_SERVICE].cost) + ' withheld from the rate shop');
          delete svc[HAZMAT_ONLY_SERVICE];
        }

        // DDP-first for international shipments. DHL offers the duties-paid
        // "Direct" (PLT) product only for certain countries. When it does, we
        // return ONLY PLT-DDP so Logiwa can't rate-shop down to a duties-unpaid
        // service and leave the customer holding the duty bill. When DHL does
        // not offer PLT for the route (a DDU-only country), we fall back to the
        // full duties-unpaid menu — unchanged behavior. Verified against the
        // live DHL rating API: dutiesPaid does not change quoted prices, so the
        // single pricing pass above already gives us PLT's cost — no extra call.
        const plt      = svc['PLT'];
        const pltAvail = plt && plt.count === nBoxes;
        if (isIntl && pltAvail) {
          rateList = [{
            carrier:        order.carrier || 'DHLEC',
            shippingOption: 'PLT-DDP',
            totalCost:      round2(plt.cost),
            shippingCost:   round2(plt.cost),
            otherCost:      0,
            currency:       plt.currency,
            estimatedDays:  plt.estDays,
          }];
          console.log('[GET-RATE] DDP-first → PLT-DDP $' + round2(plt.cost) + ' for ' + (shipTo.country || '?') + ' (' + nBoxes + ' boxes)');
        } else if (isDDP) {
          // Explicit PLT-DDP request but Direct is not offered for this route.
          msg = 'PLT service not available for all boxes — DDP not supported for this shipment';
        } else {
          rateList = Object.entries(svc)
            .filter(([, v]) => v.count === nBoxes)
            .map(([id, v]) => ({
              carrier:        order.carrier || 'DHLEC',
              shippingOption: id,
              totalCost:      round2(v.cost),
              shippingCost:   round2(v.cost),
              otherCost:      0,
              currency:       v.currency,
              estimatedDays:  v.estDays,
            }));
        }

        console.log('[GET-RATE] OK ' + order.shipmentOrderCode + ' — ' + rateList.length + ' rates (' + nBoxes + ' boxes)');
        if (!rateList.length && !msg) msg = dg.isHazmat
          ? 'Hazmat item on order (' + dg.skus.join(', ') + ') — DHL offers no ' + dg.services.join('/') + ' rate for this shipment'
          : 'No DHL rates available for this route';
      } catch (e) {
        logError('GET-RATE', e);
        msg = e.hazmat ? e.message
          : e.response?.data?.invalidParams
          ? 'DHL validation: ' + JSON.stringify(e.response.data.invalidParams)
          : 'DHL error: ' + (e.response?.data?.detail || e.response?.data?.title || e.message);
      }

      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message:      msg ? [msg] : [],
      });
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[GET-RATE] → Response to Logiwa: ' + (out[0]?.rateList?.length || 0) + ' rates for ' + out[0]?.shipmentOrderCode);
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    return res.json({
      data: parseLogiwaBody(req.body).map((o) => ({
        shipmentOrderCode:       o.shipmentOrderCode,
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        rateList:     [],
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      })),
    });
  }
});

// ─── CREATE LABEL ─────────────────────────────────────────────────────────────

app.post('/create-label', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[CREATE-LABEL] ══ Incoming Logiwa request ══ orders=' + orders.length + ' first=' + orders[0]?.shipmentOrderCode + ' carrier=' + orders[0]?.carrier + ' service=' + orders[0]?.shippingOption);

  try {
    const token  = await getDHLToken();
    const out    = [];

    for (const order of orders) {
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const isInternational = (shipTo.country || 'US').toUpperCase() !== 'US';
      const isDDP           = (order.shippingOption || '').toUpperCase() === 'PLT-DDP';
      const selectedService = mapServiceToDHL(order.shippingOption);
      const labelFmt        = resolveLabelFormat(order);
      const rateCurrency    = order.currency || 'USD';
      const boxes           = getBoxes(order);
      const round2          = (n) => Math.round(n * 100) / 100;

      console.log('[CREATE-LABEL] ' + order.shipmentOrderCode + ' boxes=' + boxes.length + ' service=' + selectedService + (isInternational ? ' INTL ' + shipTo.country : ' DOM') + (isDDP ? ' DDP' : '') + ' format=' + labelFmt.format.toUpperCase());

      const packageResponse = [];
      const errors = [];
      let orderCost = 0;
      let masterTrk = '';

      // Hazmat: refuse the whole order before buying any label if DHL cannot
      // carry it, or if the chosen service is not one allowed to carry it.
      const dg = orderDangerousGoods(order, boxes, isInternational, shipTo.country);
      if (dg.isHazmat) {
        const hz = 'Hazmat item on order (' + dg.skus.join(', ') + ')';
        if (dg.blocked) errors.push(dg.blocked);
        else if (!dg.services.includes(String(selectedService).toUpperCase())) {
          errors.push(hz + ' — DHL can only ship it by ' + (dg.services.join(' / ') || 'no service') + ', not ' + selectedService);
        }
        console.log('[CREATE-LABEL] ' + order.shipmentOrderCode + ' hazmat=' + dg.skus.join(',') + ' category=' + (dg.categories.join(',') || 'none')
          + (errors.length ? ' BLOCKED — ' + errors[0] : ' declared on ' + selectedService));
      }
      const hazmatRefused = errors.length > 0;

      // One DHL label per box; each box declares only its own products.
      for (let i = 0; i < boxes.length && !hazmatRefused; i++) {
        const box = boxes[i];
        const seq = box.packageSequenceNumber ?? i;
        const weightLB  = weightToLB(box.weight?.Value || box.weight?.value, box.weight?.Units || box.weight?.units);
        const dims = box.dimensions || {};
        const l = parseFloat(dims.Length || dims.length || 0);
        const w = parseFloat(dims.Width  || dims.width  || 0);
        const h = parseFloat(dims.Height || dims.height || 0);
        const packageId = ((order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'').slice(0,12) + seq + Date.now()).slice(0,30);

        const postageAmount = await getRateForService(token, order, weightLB, dims, selectedService, box);
        console.log('[CREATE-LABEL] box ' + seq + ' postage ' + selectedService + (isDDP ? ' DDP' : '') + ': $' + postageAmount);

        const dhlReq = {
          pickup:             DHL_PICKUP_ID,
          distributionCenter: DHL_DISTRIBUTION,
          orderedProductId:   selectedService,
          returnAddress:      buildReturnAddress(order.shipFrom),
          packageDetail: {
            packageId,
            packageDescription: order.shipmentOrderCode || 'Shipment',
            weight: { unitOfMeasure: 'LB', value: weightLB },
            ...(dg.perBox[i].category && { contentCategory: dg.perBox[i].category }),
            ...(l > 0 && w > 0 && h > 0 && {
              dimension: { length:l, width:w, height:h, unitOfMeasure:(dims.Units||dims.units||'IN').toUpperCase() },
            }),
          },
          consigneeAddress: {
            name:        toContact.name    || '',
            companyName: toContact.company || '',
            address1:    shipTo.address1   || '',
            address2:    shipTo.address2   || '',
            city:        shipTo.city       || '',
            state:       shipTo.state      || '',
            postalCode:  shipTo.postalCode || '',
            country:     shipTo.country    || 'US',
            phone:       toContact.phone   || '',
            email:       toContact.email   || '',
          },
        };

        if (isInternational) {
          const { customs, declaredValue } = boxCustomsAndValue(order, box);
          dhlReq.packageDetail.shippingCost = {
            currency:      rateCurrency,
            declaredValue,
            ...(isDDP && { dutiesPaid: true }),
          };
          if (customs) dhlReq.customsDetails = customs;
          else console.warn('[CREATE-LABEL] ⚠ International order but NO customs/products for box ' + seq);
        }

        const labelUrl = DHL_BASE_URL + '/shipping/v4/label?format=' + labelFmt.queryParam;
        logRequest('CREATE-LABEL', 'POST', labelUrl, {}, dhlReq);

        try {
          const dhlRes = await axios.post(labelUrl, dhlReq, {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          });

          // Log response with label data size instead of full base64
          const logSafeData = JSON.parse(JSON.stringify(dhlRes.data));
          if (Array.isArray(logSafeData.labels)) {
            logSafeData.labels = logSafeData.labels.map(lbl => ({
              ...lbl,
              labelData: lbl.labelData ? '[BASE64 ' + Buffer.from(lbl.labelData, 'base64').length + ' bytes]' : undefined,
            }));
          }
          logResponse('CREATE-LABEL', dhlRes.status, logSafeData);

          const d     = dhlRes.data;
          const label = Array.isArray(d.labels) ? d.labels[0] : d;
          label.labelData = await withLimitedQuantityMark('CREATE-LABEL', label.labelData, labelFmt.format, order, box);
          label.labelData = await withOrientationArrows('CREATE-LABEL', label.labelData, labelFmt.format, order, box);

          // International labels come back with no trackingId; dhlPackageId (3387…) is the
          // number DHL tracks. Our own packageId (SPY…) made Shopify guess "Asendia USA".
          const trk = isInternational
            ? (label.dhlPackageId || label.packageId || packageId)
            : (stripUspsPrefix(label.trackingId) || label.dhlPackageId || packageId);

          if (label.labelData) {
            labelCache[trk] = {
              labelData:         label.labelData,
              encodeType:        label.encodeType || 'BASE64',
              format:            labelFmt.format,
              mimeType:          labelFmt.mimeType,
              originalPackageId: packageId,
            };
            console.log('[CREATE-LABEL] box ' + seq + ' cached → key=' + trk + ' format=' + labelFmt.format);
          } else {
            console.warn('[CREATE-LABEL] ⚠ box ' + seq + ' DHL response contained no labelData field');
          }

          const proxyLabelUrl = MIDDLEWARE_URL + '/label/' + trk;
          console.log('[CREATE-LABEL] box ' + seq + ' SUCCESS tracking=' + trk + ' cost=$' + postageAmount);
          orderCost += parseFloat(postageAmount) || 0;
          if (!masterTrk) masterTrk = trk;

          packageResponse.push({
            packageSequenceNumber: seq,
            trackingNumber:        trk,
            encodedLabel:          label.labelData || '',
            labelURL:              proxyLabelUrl,
            trackingUrl:           'https://webtrack.dhlecs.com/orders?trackingNumber=' + trk,
            rateDetail: {
              totalCost:    parseFloat(postageAmount) || 0,
              shippingCost: parseFloat(postageAmount) || 0,
              otherCost:    0,
              currency:     rateCurrency,
            },
            externalReference: packageId,
          });
        } catch (e) {
          logError('CREATE-LABEL', e);
          const errData = e.response?.data;
          let em = errData?.detail || errData?.title || e.message;
          if (Array.isArray(errData?.invalidParams) && errData.invalidParams.length) {
            em = errData.invalidParams.map(p => p.name + ': ' + p.reason).join(' | ');
          }
          errors.push('Box ' + seq + ': ' + em);
        }
      }

      const allOk = packageResponse.length === boxes.length && errors.length === 0;
      console.log('[CREATE-LABEL] ' + order.shipmentOrderCode + ' → ' + packageResponse.length + '/' + boxes.length + ' labels, cost=$' + round2(orderCost) + (allOk ? ' OK' : ' PARTIAL/FAIL'));

      out.push({
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        shipmentOrderCode:       order.shipmentOrderCode,
        carrier:        order.carrier || 'DHLEC',
        shippingOption: order.shippingOption,
        packageResponse,
        rateDetail: {
          totalCost:    round2(orderCost),
          shippingCost: round2(orderCost),
          otherCost:    0,
          currency:     rateCurrency,
        },
        masterTrackingNumber: masterTrk,
        isSuccessful: allOk,
        message:      errors,
      });
    }

    const logiwaResponse = { data: [out[0]] };
    const allTrk = (out[0]?.packageResponse || []).map(p => p.trackingNumber).join(', ');
    console.log('[CREATE-LABEL] → Response to Logiwa: ' + (out[0]?.packageResponse?.length || 0) + ' label(s) [' + allTrk + '] master=' + out[0]?.masterTrackingNumber + ' success=' + out[0]?.isSuccessful);
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      data: [{
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        shipmentOrderCode:       o.shipmentOrderCode,
        carrier:        o.carrier || 'DHLEC',
        shippingOption: o.shippingOption,
        packageResponse: [],
        rateDetail: { totalCost:0, shippingCost:0, otherCost:0, currency:'USD' },
        masterTrackingNumber: '',
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      }],
    });
  }
});

// ─── VOID LABEL ───────────────────────────────────────────────────────────────

app.post('/void-label', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[VOID-LABEL] ══ Incoming Logiwa request ══ trk=' + orders[0]?.masterTrackingNumber);
  try {
    const token  = await getDHLToken();
    const out    = [];
    for (const order of orders) {
      const trk = order.masterTrackingNumber;
      const dhlPackageId = order.externalReference || labelCache[trk]?.originalPackageId || trk;
      if (!trk) {
        out.push({ shipmentOrderIdentifier: order.shipmentOrderIdentifier, masterTrackingNumber: '', externalReference: '', isSuccessful: false, message: [] });
        continue;
      }
      const voidUrl = DHL_BASE_URL + '/shipping/v4/label/' + DHL_PICKUP_ID + '?packageId=' + dhlPackageId;
      logRequest('VOID-LABEL', 'DELETE', voidUrl, { Authorization: 'Bearer ***' }, null);
      try {
        const dhlRes = await axios.delete(voidUrl, { headers: { Authorization: 'Bearer ' + token } });
        logResponse('VOID-LABEL', dhlRes.status, dhlRes.data);
        delete labelCache[trk];
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          masterTrackingNumber:    order.masterTrackingNumber,
          externalReference:       dhlPackageId,
          isSuccessful: true,
          message: [],
        });
      } catch (e) {
        logError('VOID-LABEL', e);
        const alreadyGone =
          e.response?.status === 404 ||
          (e.response?.status === 400 && JSON.stringify(e.response?.data).includes('not found'));
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          masterTrackingNumber:    order.masterTrackingNumber,
          externalReference:       dhlPackageId,
          isSuccessful: alreadyGone,
          message: [],
        });
      }
    }
    return res.json({ data: [out[0]] });
  } catch (err) {
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({ data: [{ shipmentOrderIdentifier: o.shipmentOrderIdentifier, masterTrackingNumber: o.masterTrackingNumber||'', externalReference: '', isSuccessful: false, message: [] }] });
  }
});

// ─── END OF DAY REPORT ────────────────────────────────────────────────────────

app.post('/end-of-day-report', async (req, res) => {
  const body = Array.isArray(req.body) ? req.body[0] : req.body;
  console.log('\n[EOD] ══ Incoming Logiwa request ══ carrier=' + body?.carrier);
  try {
    const token = await getDHLToken();

    const manifestReq = { pickup: DHL_PICKUP_ID, manifests: [] };
    const createUrl = DHL_BASE_URL + '/shipping/v4/manifest';
    logRequest('EOD', 'POST', createUrl, { Authorization: 'Bearer ***', 'Content-Type': 'application/json' }, manifestReq);

    const createRes = await axios.post(createUrl, manifestReq, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    logResponse('EOD', createRes.status, createRes.data);

    const { requestId, link } = createRes.data;
    console.log('[EOD] Manifest created → requestId=' + requestId + ' link=' + link);

    let manifestData = null;
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
      console.log('[EOD] Polling manifest status attempt ' + attempts + '...');
      const getRes = await axios.get(link, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      });
      logResponse('EOD', getRes.status, getRes.data);
      if (getRes.data.status !== 'CREATED') {
        manifestData = getRes.data;
        break;
      }
    }

    if (!manifestData) {
      manifestData = { requestId, status: 'CREATED', link };
      console.warn('[EOD] ⚠ Manifest still processing after 10 attempts — returning partial data');
    }

    return res.json({
      carrierSetupIdentifier: body.carrierSetupIdentifier,
      carrier:        body.carrier || 'DHLEC',
      encodedReport:  Buffer.from(JSON.stringify(manifestData)).toString('base64'),
      isSuccessful:   true,
      message:        '',
    });

  } catch (err) {
    logError('EOD', err);
    return res.json({
      carrierSetupIdentifier: body.carrierSetupIdentifier,
      carrier: body.carrier || 'DHLEC',
      encodedReport: '',
      isSuccessful: false,
      message: 'Error: ' + err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log('\n🚀 DHL eCommerce-Logiwa Middleware v2.6.0 on port ' + PORT);
  console.log('   Label proxy  : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Pickup ID    : ' + DHL_PICKUP_ID);
  console.log('   Distribution : ' + DHL_DISTRIBUTION);
  console.log('   Base URL     : ' + DHL_BASE_URL + '\n');
});
