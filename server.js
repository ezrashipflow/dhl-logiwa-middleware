/**
 * DHL eCommerce Americas <-> Logiwa Custom Carrier Middleware v2.5.0
 * Changes from v2.4.6:
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
  version: '2.5.0',
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

      console.log('[GET-RATE] ' + order.shipmentOrderCode + ' boxes=' + boxes.length + (isIntl ? ' INTL ' + shipTo.country : ' DOM') + (isDDP ? ' DDP' : ''));

      let rateList = [], msg = '';
      try {
        // Price every box; collect each box's returned product list.
        const perBoxProducts = [];
        for (const box of boxes) {
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

        if (isDDP) {
          const plt = svc['PLT'];
          if (plt && plt.count === nBoxes) {
            rateList = [{
              carrier:        order.carrier || 'DHLEC',
              shippingOption: 'PLT-DDP',
              totalCost:      round2(plt.cost),
              shippingCost:   round2(plt.cost),
              otherCost:      0,
              currency:       plt.currency,
              estimatedDays:  plt.estDays,
            }];
            console.log('[GET-RATE] PLT-DDP rate (' + nBoxes + ' boxes): $' + round2(plt.cost));
          } else {
            msg = 'PLT service not available for all boxes — DDP not supported for this shipment';
          }
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
        if (!rateList.length && !msg) msg = 'No DHL rates available for this route';
      } catch (e) {
        logError('GET-RATE', e);
        msg = e.response?.data?.invalidParams
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

      // One DHL label per box; each box declares only its own products.
      for (let i = 0; i < boxes.length; i++) {
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

          const trk = isInternational
            ? (label.packageId || label.dhlPackageId || packageId)
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
            trackingUrl:           null,
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
  console.log('\n🚀 DHL eCommerce-Logiwa Middleware v2.5.0 on port ' + PORT);
  console.log('   Label proxy  : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Pickup ID    : ' + DHL_PICKUP_ID);
  console.log('   Distribution : ' + DHL_DISTRIBUTION);
  console.log('   Base URL     : ' + DHL_BASE_URL + '\n');
});
