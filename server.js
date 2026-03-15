/**
 * DHL eCommerce Americas <-> Logiwa Custom Carrier Middleware v2.1.0
 * Changes from v2.0.3:
 *   - Detailed request/response logging on ALL DHL API calls
 *   - encodedLabel removed from packageResponse (labelUrl only)
 *   - Full error body logged on every DHL failure
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
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.MIDDLEWARE_URL || 'https://dhl-logiwa-middleware-production.up.railway.app');

// In-memory label cache: { [packageId]: { labelData, encodeType, format } }
const labelCache = {};

let cachedToken = null;
let tokenExpiry  = 0;

// ─── LOGGING HELPERS ──────────────────────────────────────────────────────────

function logRequest(tag, method, url, headers, body) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${tag}] ► REQUEST  ${method} ${url}`);
  console.log(`[${tag}]   HEADERS: ${JSON.stringify(headers, null, 2)}`);
  if (body) {
    console.log(`[${tag}]   BODY:\n${JSON.stringify(body, null, 2)}`);
  }
}

function logResponse(tag, status, data) {
  console.log(`[${tag}] ◄ RESPONSE status=${status}`);
  const body = JSON.stringify(data, null, 2);
  console.log(`[${tag}]   BODY:\n${body.slice(0, 1000)}${body.length > 1000 ? '\n...[truncated]' : ''}`);
  console.log(`${'─'.repeat(60)}\n`);
}

function logError(tag, error) {
  console.error(`[${tag}] ✗ ERROR`);
  if (error.response) {
    console.error(`[${tag}]   HTTP STATUS : ${error.response.status}`);
    console.error(`[${tag}]   RESPONSE HEADERS: ${JSON.stringify(error.response.headers, null, 2)}`);
    console.error(`[${tag}]   RESPONSE BODY:\n${JSON.stringify(error.response.data, null, 2)}`);
  } else if (error.request) {
    console.error(`[${tag}]   NO RESPONSE RECEIVED (network error)`);
    console.error(`[${tag}]   REQUEST: ${JSON.stringify(error.request, null, 2)}`);
  } else {
    console.error(`[${tag}]   MESSAGE: ${error.message}`);
  }
  console.error(`${'─'.repeat(60)}\n`);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function getDHLToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  const tag = 'AUTH';
  logRequest(tag, 'POST', DHL_AUTH_URL,
    { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ***' },
    { grant_type: 'client_credentials' }
  );

  try {
    const r = await axios.post(DHL_AUTH_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: DHL_CLIENT_ID, password: DHL_CLIENT_SECRET },
    });
    logResponse(tag, r.status, { access_token: '***REDACTED***', expires_in: r.data.expires_in, token_type: r.data.token_type });
    cachedToken = r.data.access_token;
    tokenExpiry  = Date.now() + 55 * 60 * 1000;
    console.log('[AUTH] DHL token refreshed successfully');
    return cachedToken;
  } catch (e) {
    logError(tag, e);
    throw e;
  }
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

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'running',
  service: 'DHL eCommerce <-> Logiwa Middleware',
  version: '2.1.0',
}));

// ─── LABEL PROXY ──────────────────────────────────────────────────────────────
app.get('/label/:id', (req, res) => {
  const cached = labelCache[req.params.id];
  if (!cached) {
    console.log(`[LABEL-PROXY] Miss for id=${req.params.id}`);
    return res.status(404).json({ error: 'Label not found', id: req.params.id });
  }
  const buf = Buffer.from(cached.labelData, 'base64');
  const fmt = (cached.format || 'pdf').toLowerCase();
  const contentType = fmt === 'zpl' ? 'application/x-zebra-zpl'
    : fmt === 'png' ? 'image/png'
    : 'application/pdf';
  console.log(`[LABEL-PROXY] Serving label id=${req.params.id} format=${fmt} size=${buf.length} bytes`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${req.params.id}.${fmt}"`);
  res.send(buf);
});

// ─── 1. GET RATE ──────────────────────────────────────────────────────────────
app.post('/get-rate', async (req, res) => {
  console.log('\n[GET-RATE] ══ Incoming Logiwa request ══');
  console.log('[GET-RATE] Logiwa payload:\n', JSON.stringify(req.body, null, 2));

  try {
    const token  = await getDHLToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const weightLB  = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims = pkg.dimensions || {};
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
        rate:      { calculate: true, currency: order.currency || 'USD' },
        packageDetail: {
          packageId:          `RATE-${(order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'')}-${Date.now()}`.slice(0,30),
          packageDescription: order.shipmentOrderCode || 'Shipment',
          weight: { unitOfMeasure: 'LB', value: weightLB },
          ...(l > 0 && w > 0 && h > 0 && {
            dimension: { length:l, width:w, height:h, unitOfMeasure:(dims.Units||dims.units||'IN').toUpperCase() },
          }),
        },
      };

      const rateUrl = `${DHL_BASE_URL}/shipping/v4/products`;
      logRequest('GET-RATE', 'POST', rateUrl,
        { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
        dhlReq
      );

      let rateList = [], msg = '';
      try {
        const dhlRes = await axios.post(rateUrl, dhlReq, {
          headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
        });
        logResponse('GET-RATE', dhlRes.status, dhlRes.data);

        const prods = Array.isArray(dhlRes.data?.products) ? dhlRes.data.products : [];
        rateList = prods.map((p) => ({
          carrier:        order.carrier || 'DHLEC',
          shippingOption: p.orderedProductId || p.productId || p.productName || 'GND',
          totalCost:      parseFloat(p.rate?.amount || 0),
          shippingCost:   parseFloat(p.rate?.amount || 0),
          otherCost:      0,
          currency:       p.rate?.currency || order.currency || 'USD',
        }));
        console.log(`[GET-RATE] OK ${order.shipmentOrderCode} - ${rateList.length} rates found`);
        if (!rateList.length) msg = 'No DHL rates available for this route';
      } catch (e) {
        logError('GET-RATE', e);
        msg = e.response?.data?.invalidParams
          ? `DHL validation: ${JSON.stringify(e.response.data.invalidParams)}`
          : `DHL error: ${e.response?.data?.detail || e.response?.data?.title || e.message}`;
      }

      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message:      msg,
      });
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[GET-RATE] → Response to Logiwa:\n', JSON.stringify(logiwaResponse, null, 2));
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    return res.json(parseLogiwaBody(req.body).map((o) => ({
      shipmentOrderCode:       o.shipmentOrderCode,
      shipmentOrderIdentifier: o.shipmentOrderIdentifier,
      rateList:    [],
      isSuccessful: false,
      message:     `Middleware error: ${err.message}`,
    })));
  }
});

// ─── 2. CREATE LABEL ──────────────────────────────────────────────────────────
app.post('/create-label', async (req, res) => {
  console.log('\n[CREATE-LABEL] ══ Incoming Logiwa request ══');
  console.log('[CREATE-LABEL] Logiwa payload:\n', JSON.stringify(req.body, null, 2));

  try {
    const token  = await getDHLToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const labelSpec = order.labelSpecification || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const weightLB  = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
const packageId = `${(order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'').slice(0,16)}-${Date.now()}`.slice(0,30);
      const labelFmt  = { PDF:'pdf', ZPL:'zpl', PNG:'png' }[(labelSpec.labelFileType||'').toUpperCase()] || 'pdf';
      const dims = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 0);
      const w = parseFloat(dims.Width  || dims.width  || 0);
      const h = parseFloat(dims.Height || dims.height || 0);

      const isInternational = (shipTo.country || 'US').toUpperCase() !== 'US';

      const dhlReq = {
        pickup:             DHL_PICKUP_ID,
        distributionCenter: DHL_DISTRIBUTION,
        orderedProductId:   mapServiceToDHL(order.shippingOption),
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

      // International customs
      const customs = order.internationalOptions?.customsItems;
      if (isInternational) {
        console.log(`[CREATE-LABEL] International shipment detected → country=${shipTo.country}`);
        if (Array.isArray(customs) && customs.length > 0) {
          dhlReq.customsDetails = customs.map((item) => ({
            itemDescription:  item.description || 'Merchandise',
            packagedQuantity: parseInt(item.quantity) || 1,
            itemValue:        parseFloat(item.declaredValue) || 0,
            currency:         order.currency || 'USD',
            countryOfOrigin:  item.originCountryCode || 'US',
            ...(item.hsTariffCode && { hsCode: item.hsTariffCode }),
          }));
          console.log(`[CREATE-LABEL] Customs items mapped: ${dhlReq.customsDetails.length} line(s)`);
        } else {
          console.warn('[CREATE-LABEL] ⚠ International order but NO customs items found — this will likely cause a DHL rate error');
        }
      }

      const labelUrl = `${DHL_BASE_URL}/shipping/v4/label?format=${labelFmt.toUpperCase()}`;
      logRequest('CREATE-LABEL', 'POST', labelUrl,
        { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
        dhlReq
      );

      try {
        const dhlRes = await axios.post(labelUrl, dhlReq, {
          headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
        });

        // Log full response but redact base64 label data to keep logs readable
        const logSafeData = JSON.parse(JSON.stringify(dhlRes.data));
        if (Array.isArray(logSafeData.labels)) {
          logSafeData.labels = logSafeData.labels.map(l => ({
            ...l,
            labelData: l.labelData ? `[BASE64 ${Buffer.from(l.labelData,'base64').length} bytes]` : undefined,
          }));
        }
        logResponse('CREATE-LABEL', dhlRes.status, logSafeData);

        const d     = dhlRes.data;
        const label = Array.isArray(d.labels) ? d.labels[0] : d;
        const trk   = label.dhlPackageId || label.packageId || packageId;

        // Cache label data so /label/:id can serve it without DHL auth
        if (label.labelData) {
          labelCache[trk] = {
            labelData:  label.labelData,
            encodeType: label.encodeType || 'BASE64',
            format:     labelFmt,
          };
          console.log(`[CREATE-LABEL] Label cached → key=${trk} format=${labelFmt}`);
        } else {
          console.warn('[CREATE-LABEL] ⚠ DHL response contained no labelData field');
        }

        const proxyLabelUrl = `${MIDDLEWARE_URL}/label/${trk}`;
        console.log(`[CREATE-LABEL] SUCCESS tracking=${trk} labelUrl=${proxyLabelUrl}`);

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'DHLEC',
          shippingOption: order.shippingOption,
         packageResponse: [{
  packageSequenceNumber: pkg.packageSequenceNumber || 0,
trackingNumber:        trk,
encodedLabel:          label.labelData || '',
labelURL:              proxyLabelUrl,
trackingUrl:           null,
            rateDetail: {
              totalCost:    parseFloat(d.rateDetails?.totalAmount || 0),
              shippingCost: parseFloat(d.rateDetails?.baseAmount  || 0),
              otherCost:    parseFloat(d.rateDetails?.otherAmount  || 0),
              currency:     order.currency || 'USD',
            },
            externalReference: packageId,
          }],
          rateDetail: {
            totalCost:    parseFloat(d.rateDetails?.totalAmount || 0),
            shippingCost: parseFloat(d.rateDetails?.baseAmount  || 0),
            otherCost:    parseFloat(d.rateDetails?.otherAmount  || 0),
            currency:     order.currency || 'USD',
          },
          masterTrackingNumber: trk,
          isSuccessful: true,
          message:      [],
        });

      } catch (e) {
        logError('CREATE-LABEL', e);

        // Surface a clean, structured error message back to Logiwa
        const errData = e.response?.data;
        let em = errData?.detail || errData?.title || e.message;

        // DHL sometimes returns invalidParams array — flatten it for readability
        if (Array.isArray(errData?.invalidParams) && errData.invalidParams.length) {
          em = errData.invalidParams.map(p => `${p.name}: ${p.reason}`).join(' | ');
        }

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'DHLEC',
          shippingOption: order.shippingOption,
          packageResponse: [],
          rateDetail: { totalCost:0, shippingCost:0, otherCost:0, currency:'USD' },
          masterTrackingNumber: '',
          isSuccessful: false,
          message: `DHL error: ${em}`,
        });
      }
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[CREATE-LABEL] → Response to Logiwa:\n', JSON.stringify({
      ...logiwaResponse,
      data: logiwaResponse.data?.map(d => ({
        ...d,
        packageResponse: d.packageResponse?.map(p => ({ ...p, encodedLabel: p.encodedLabel ? '[omitted]' : '' })),
      })),
    }, null, 2));
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      shipmentOrderIdentifier: o.shipmentOrderIdentifier,
      shipmentOrderCode:       o.shipmentOrderCode,
      carrier:        o.carrier || 'DHLEC',
      shippingOption: o.shippingOption,
      packageResponse: [],
      rateDetail: { totalCost:0, shippingCost:0, otherCost:0, currency:'USD' },
      masterTrackingNumber: '',
      isSuccessful: false,
      message:      `Middleware error: ${err.message}`,
    });
  }
});

// ─── 3. VOID LABEL ────────────────────────────────────────────────────────────
app.post('/void-label', async (req, res) => {
  console.log('\n[VOID-LABEL] ══ Incoming Logiwa request ══');
  console.log('[VOID-LABEL] Payload:\n', JSON.stringify(req.body, null, 2));

  try {
    const token  = await getDHLToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const trk = order.masterTrackingNumber;
const dhlPackageId = order.externalReference || labelCache[trk]?.originalPackageId || trk;
      if (!trk) {
        out.push({ shipmentOrderIdentifier:order.shipmentOrderIdentifier, masterTrackingNumber:'', isSuccessful:false, message:'No tracking number' });
        continue;
      }

      const voidUrl = `${DHL_BASE_URL}/shipping/v4/label/${DHL_PICKUP_ID}?packageId=${dhlPackageId}`;
      logRequest('VOID-LABEL', 'DELETE', voidUrl, { Authorization: 'Bearer ***' }, null);

      try {
        const dhlRes = await axios.delete(voidUrl, {
          headers: { Authorization:`Bearer ${token}` },
        });
        logResponse('VOID-LABEL', dhlRes.status, dhlRes.data);
        delete labelCache[trk];
        out.push({ shipmentOrderIdentifier:order.shipmentOrderIdentifier, masterTrackingNumber:trk, isSuccessful:true, message:'Voided' });
      } catch (e) {
        logError('VOID-LABEL', e);
        const alreadyVoided = e.response?.status === 404;
        out.push({ shipmentOrderIdentifier:order.shipmentOrderIdentifier, masterTrackingNumber:trk, isSuccessful:alreadyVoided, message:alreadyVoided?'Already voided':`DHL error: ${e.message}` });
      }
    }
    return res.json(out[0]);
  } catch (err) {
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({ shipmentOrderIdentifier:o.shipmentOrderIdentifier, masterTrackingNumber:o.masterTrackingNumber||'', isSuccessful:false, message:`Error: ${err.message}` });
  }
});

// ─── 4. END-OF-DAY REPORT ─────────────────────────────────────────────────────
app.post('/end-of-day-report', async (req, res) => {
  console.log('\n[EOD] ══ Incoming Logiwa request ══');
  console.log('[EOD] Payload:\n', JSON.stringify(req.body, null, 2));

  try {
    const token = await getDHLToken();
    const body  = Array.isArray(req.body) ? req.body[0] : req.body;
    const closeDate = body.closeDate || new Date().toISOString().split('T')[0];

    const manifestUrl = `${DHL_BASE_URL}/shipping/v4/manifests`;
    const manifestReq = { pickup: DHL_PICKUP_ID, closeDate };
    logRequest('EOD', 'POST', manifestUrl, { Authorization: 'Bearer ***', 'Content-Type': 'application/json' }, manifestReq);

    const dhlRes = await axios.post(manifestUrl, manifestReq,
      { headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    logResponse('EOD', dhlRes.status, dhlRes.data);

    return res.json({
      carrierSetupIdentifier: body.carrierSetupIdentifier,
      carrier:        body.carrier || 'DHLEC',
      encodedReport:  Buffer.from(JSON.stringify(dhlRes.data)).toString('base64'),
      isSuccessful:   true,
      message:        '',
    });
  } catch (err) {
    logError('EOD', err);
    const b = Array.isArray(req.body) ? req.body[0] : req.body;
    return res.json({ carrierSetupIdentifier:b.carrierSetupIdentifier, carrier:b.carrier||'DHLEC', encodedReport:'', isSuccessful:false, message:`Error: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 DHL-Logiwa Middleware v2.1.0 on port ${PORT}`);
  console.log(`   Label proxy : ${MIDDLEWARE_URL}/label/:id`);
  console.log(`   Env check   : PICKUP=${DHL_PICKUP_ID} DIST=${DHL_DISTRIBUTION}\n`);
});
