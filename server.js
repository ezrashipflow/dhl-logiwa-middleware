/**
 * DHL eCommerce Americas <-> Logiwa Custom Carrier Middleware v2.0.2
 * Logging reduced to prevent Railway 500/sec rate limit from hiding errors
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
const PORT              = process.env.PORT || 3000;

const DHL_AUTH_URL = 'https://api.dhlecs.com/auth/v4/accesstoken';
const DHL_BASE_URL = 'https://api.dhlecs.com';

let cachedToken = null;
let tokenExpiry = 0;

async function getDHLToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  const r = await axios.post(DHL_AUTH_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: { username: DHL_CLIENT_ID, password: DHL_CLIENT_SECRET },
  });
  cachedToken = r.data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  console.log('[AUTH] DHL token refreshed');
  return cachedToken;
}

function parseLogiwaBody(body) {
  return Array.isArray(body) ? body : [body];
}

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
    name:    c.personName    || c.name    || '',
    company: c.companyName   || c.company || '',
    phone:   c.phoneNumber   || c.phone   || '',
    email:   c.emailAddress  || c.email   || '',
  };
}

function weightToLB(value, unit) {
  const v = parseFloat(value) || 0;
  const u = (unit || 'LB').toUpperCase();
  let lb;
  if (u === 'OZ') lb = v / 16;
  else if (u === 'G')  lb = v / 453.592;
  else if (u === 'KG') lb = v * 2.20462;
  else lb = v;
  return Math.max(Math.ceil(lb * 100) / 100, 0.01);
}

function mapServiceToDHL(s) {
  if (!s) return 'GND';
  const u = s.toUpperCase();
  const map = {
    'GND': 'GND', 'GROUND': 'GND',
    'EXP': 'EXP', 'EXPEDITED': 'EXP',
    'MAX': 'MAX', 'BGN': 'BGN', 'BEX': 'BEX',
    'PLT': 'PLT', 'PLY': 'PLY', 'PKY': 'PKY',
    'RGN': 'RGN', 'RPL': 'RPL', 'RLT': 'RLT',
  };
  for (const [key, val] of Object.entries(map)) {
    if (u === key || u.includes(key)) return val;
  }
  return s;
}

const DEFAULT_FROM = {
  name: 'ShipFlow',
  address1: '625 JERSEY AVE STE 9', address2: '',
  city: 'NEW BRUNSWICK', state: 'NJ', postalCode: '08901', country: 'US',
  phone: '9085253857', email: 'info@shipflow.co',
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

app.get('/', (req, res) => res.json({
  status: 'running',
  service: 'DHL eCommerce <-> Logiwa Middleware',
  version: '2.0.2',
}));

// ─── 1. GET RATE ────────────────────────────────────────────────────────────────
app.post('/get-rate', async (req, res) => {
  try {
    const token  = await getDHLToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const weightLB  = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims      = pkg.dimensions || {};
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
        returnAddress: buildReturnAddress(order.shipFrom),
        distributionCenter: DHL_DISTRIBUTION,
        pickup: DHL_PICKUP_ID,
        rate: { calculate: true, currency: order.currency || 'USD' },
        packageDetail: {
          packageId:          `RATE-${(order.shipmentOrderCode || '').replace(/[^A-Za-z0-9]/g,'')}-${Date.now()}`.slice(0, 30),
          packageDescription: order.shipmentOrderCode || 'Shipment',
          weight: { unitOfMeasure: 'LB', value: weightLB },
          ...(l > 0 && w > 0 && h > 0 && {
            dimension: { length: l, width: w, height: h,
              unitOfMeasure: (dims.Units || dims.units || 'IN').toUpperCase() },
          }),
        },
      };

      let rateList = [], msg = '';
      try {
        const dhlRes = await axios.post(`${DHL_BASE_URL}/shipping/v4/products`, dhlReq, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        const prods = Array.isArray(dhlRes.data?.products) ? dhlRes.data.products : [];
        rateList = prods.map((p) => ({
          carrier:        order.carrier || 'DHLEC',
          shippingOption: p.orderedProductId || p.productId || p.productName || 'GND',
          totalCost:      parseFloat(p.rate?.amount || 0),
          shippingCost:   parseFloat(p.rate?.amount || 0),
          otherCost:      0,
          currency:       p.rate?.currency || order.currency || 'USD',
        }));
        console.log(`[GET-RATE] OK ${order.shipmentOrderCode} - ${rateList.length} rates`);
        if (!rateList.length) msg = 'No DHL rates available for this route';
      } catch (e) {
        msg = e.response?.data?.invalidParams
          ? `DHL validation: ${JSON.stringify(e.response.data.invalidParams)}`
          : `DHL error: ${e.response?.data?.detail || e.message}`;
        console.error('[GET-RATE] FAIL:', msg);
      }

      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message: msg,
      });
    }

    return res.json({ data: [out[0]] });
  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    return res.json(parseLogiwaBody(req.body).map((o) => ({
      shipmentOrderCode: o.shipmentOrderCode,
      shipmentOrderIdentifier: o.shipmentOrderIdentifier,
      rateList: [], isSuccessful: false,
      message: `Middleware error: ${err.message}`,
    })));
  }
});

// ─── 2. CREATE LABEL ────────────────────────────────────────────────────────────
app.post('/create-label', async (req, res) => {
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
      const packageId = `${(order.shipmentOrderCode||'').replace(/[^A-Za-z0-9]/g,'')}-${Date.now()}`.slice(0,40);
      const labelFmt  = { PDF:'pdf', ZPL:'zpl', PNG:'png' }[(labelSpec.labelFileType||'').toUpperCase()] || 'pdf';
      const dims      = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 0);
      const w = parseFloat(dims.Width  || dims.width  || 0);
      const h = parseFloat(dims.Height || dims.height || 0);

      const dhlReq = {
        pickup: DHL_PICKUP_ID,
        distributionCenter: DHL_DISTRIBUTION,
        orderedProductId: mapServiceToDHL(order.shippingOption),
        returnAddress: buildReturnAddress(order.shipFrom),
        packageDetail: {
          packageId,
          packageDescription: order.shipmentOrderCode || 'Shipment',
          weight: { unitOfMeasure: 'LB', value: weightLB },
          ...(l > 0 && w > 0 && h > 0 && {
            dimension: { length: l, width: w, height: h,
              unitOfMeasure: (dims.Units || dims.units || 'IN').toUpperCase() },
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
const isInternational = (shipTo.country || 'US').toUpperCase() !== 'US';
if (isInternational && Array.isArray(customs) && customs.length > 0) {
        dhlReq.customsDetails = customs.map((item) => ({
          itemDescription:  item.description || 'Merchandise',
          packagedQuantity: parseInt(item.quantity) || 1,
          itemValue:        parseFloat(item.declaredValue) || 0,
          currency:         order.currency || 'USD',
          countryOfOrigin:  item.originCountryCode || 'US',
          ...(item.hsTariffCode && { hsCode: item.hsTariffCode }),
        }));
      }

      console.log(`[CREATE-LABEL] order=${order.shipmentOrderCode} service=${dhlReq.orderedProductId} weight=${weightLB}LB`);
      console.log('[CREATE-LABEL] DHL body:', JSON.stringify(dhlReq));

      try {
        const dhlRes = await axios.post(`${DHL_BASE_URL}/shipping/v4/label?format=PDF`, dhlReq, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        const d   = dhlRes.data;
        const trk = d.dhlPackageId || d.packageId || packageId;
        console.log('[CREATE-LABEL] SUCCESS tracking:', trk, 'keys:', Object.keys(d).join(','));
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:                 order.carrier || 'DHLEC',
          shippingOption:          order.shippingOption,
          packageResponse: [{
            packageSequenceNumber: pkg.packageSequenceNumber || 1,
            trackingNumber: trk,
            encodedLabel:   labelFmt !== 'zpl' ? (d.labelData || '') : Buffer.from(d.labelData || '').toString('base64'),
            labelURL:       d.labelUrl || '',
          }],
          rateDetail: {
            totalCost:    parseFloat(d.rateDetails?.totalAmount || 0),
            shippingCost: parseFloat(d.rateDetails?.baseAmount  || 0),
            otherCost:    parseFloat(d.rateDetails?.otherAmount || 0),
            currency:     order.currency || 'USD',
          },
          masterTrackingNumber: trk,
          isSuccessful: true,
          message: '',
        });
      } catch (e) {
        const errData = e.response?.data;
        console.error(`[CREATE-LABEL] DHL FAIL status=${e.response?.status} body=${JSON.stringify(errData)}`);
        const em = errData?.detail || errData?.title || e.message;
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

    return res.json({ data: out.length === 1 ? out[0] : out[0] });
  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      shipmentOrderIdentifier: o.shipmentOrderIdentifier,
      shipmentOrderCode:       o.shipmentOrderCode,
      carrier: o.carrier || 'DHLEC', shippingOption: o.shippingOption,
      packageResponse: [],
      rateDetail: { totalCost:0, shippingCost:0, otherCost:0, currency:'USD' },
      masterTrackingNumber: '', isSuccessful: false,
      message: `Middleware error: ${err.message}`,
    });
  }
});

// ─── 3. VOID LABEL ──────────────────────────────────────────────────────────────
app.post('/void-label', async (req, res) => {
  try {
    const token  = await getDHLToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];
    for (const order of orders) {
      const trk = order.masterTrackingNumber;
      if (!trk) {
        out.push({ shipmentOrderIdentifier: order.shipmentOrderIdentifier, masterTrackingNumber:'', isSuccessful:false, message:'No tracking number' });
        continue;
      }
      try {
        await axios.delete(`${DHL_BASE_URL}/shipping/v4/label/${trk}`, { headers: { Authorization:`Bearer ${token}` } });
        out.push({ shipmentOrderIdentifier:order.shipmentOrderIdentifier, masterTrackingNumber:trk, isSuccessful:true, message:'Voided' });
      } catch (e) {
        const alreadyVoided = e.response?.status === 404;
        out.push({ shipmentOrderIdentifier:order.shipmentOrderIdentifier, masterTrackingNumber:trk, isSuccessful:alreadyVoided, message: alreadyVoided ? 'Already voided' : `DHL error: ${e.message}` });
      }
    }
    return res.json(out.length === 1 ? out[0] : out[0]);
  } catch (err) {
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({ shipmentOrderIdentifier:o.shipmentOrderIdentifier, masterTrackingNumber:o.masterTrackingNumber||'', isSuccessful:false, message:`Error: ${err.message}` });
  }
});

// ─── 4. END-OF-DAY REPORT ───────────────────────────────────────────────────────
app.post('/end-of-day-report', async (req, res) => {
  try {
    const token = await getDHLToken();
    const body  = Array.isArray(req.body) ? req.body[0] : req.body;
    const closeDate = body.closeDate || new Date().toISOString().split('T')[0];
    const dhlRes = await axios.post(`${DHL_BASE_URL}/shipping/v4/manifests`,
      { pickup: DHL_PICKUP_ID, closeDate },
      { headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    return res.json({ carrierSetupIdentifier:body.carrierSetupIdentifier, carrier:body.carrier||'DHLEC', encodedReport:Buffer.from(JSON.stringify(dhlRes.data)).toString('base64'), isSuccessful:true, message:'' });
  } catch (err) {
    const b = Array.isArray(req.body) ? req.body[0] : req.body;
    return res.json({ carrierSetupIdentifier:b.carrierSetupIdentifier, carrier:b.carrier||'DHLEC', encodedReport:'', isSuccessful:false, message:`Error: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 DHL-Logiwa Middleware v2.0.2 on port ${PORT}\n`);
});
