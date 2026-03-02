/**
 * DHL eCommerce Americas <-> Logiwa Custom Carrier Middleware
 * 
 * This server acts as a translator between Logiwa's Custom Carrier API format
 * and DHL eCommerce Americas API format.
 * 
 * Endpoints exposed (registered in Logiwa):
 *   POST /get-rate
 *   POST /create-label
 *   POST /void-label
 *   POST /end-of-day-report
 */

const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─── Configuration ─────────────────────────────────────────────────────────────
const DHL_CLIENT_ID     = process.env.DHL_CLIENT_ID;
const DHL_CLIENT_SECRET = process.env.DHL_CLIENT_SECRET;
const DHL_PICKUP_ID     = process.env.DHL_PICKUP_ID;       // Your DHL Pickup Account Number
const DHL_DISTRIBUTION  = process.env.DHL_DISTRIBUTION;   // Your DHL Distribution Center (e.g. USDFW1)
const PORT              = process.env.PORT || 3000;

// DHL API base URLs
const DHL_AUTH_URL = 'https://api.dhlecs.com/auth/v4/accesstoken';
const DHL_BASE_URL = 'https://api.dhlecs.com';

// Token cache — DHL tokens last 1 hour, we refresh 5 minutes early
let cachedToken = null;
let tokenExpiry = 0;

// ─── DHL Authentication ─────────────────────────────────────────────────────────
async function getDHLToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(DHL_AUTH_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      auth: {
        username: DHL_CLIENT_ID,
        password: DHL_CLIENT_SECRET,
      },
    });

    cachedToken = response.data.access_token;
    // Cache for 55 minutes (tokens are valid 60 min)
    tokenExpiry = now + 55 * 60 * 1000;

    console.log('[AUTH] DHL token refreshed successfully');
    return cachedToken;
  } catch (err) {
    console.error('[AUTH] Failed to get DHL token:', err.response?.data || err.message);
    throw new Error('Failed to authenticate with DHL eCommerce API');
  }
}

// ─── Health Check ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'DHL eCommerce <-> Logiwa Middleware',
    endpoints: ['/get-rate', '/create-label', '/void-label', '/end-of-day-report'],
  });
});

// ─── 1. GET RATE ────────────────────────────────────────────────────────────────
/**
 * Logiwa sends shipment details → we ask DHL for available products/rates
 * → we return rates in Logiwa's format
 */
app.post('/get-rate', async (req, res) => {
  console.log('[GET-RATE] Request received:', JSON.stringify(req.body, null, 2));

  try {
    const logiwaRequest = req.body;
    const token = await getDHLToken();
    const pkg = logiwaRequest.requestedPackageLineItems?.[0] || {};

    // Build DHL Product Finder request
    const dhlRequest = {
      consigneeAddress: {
        address1: logiwaRequest.shipTo?.addressLine1 || '',
        address2: logiwaRequest.shipTo?.addressLine2 || '',
        city: logiwaRequest.shipTo?.city || '',
        state: logiwaRequest.shipTo?.stateOrProvinceCode || '',
        postalCode: logiwaRequest.shipTo?.postalCode || '',
        country: logiwaRequest.shipTo?.countryCode || 'US',
      },
      distributionCenter: DHL_DISTRIBUTION,
      packageDetail: {
        weight: {
          unitOfMeasure: (pkg.weight?.Units || 'LB').toUpperCase(),
          value: pkg.weight?.Value || 1,
        },
        dimension: pkg.dimensions ? {
          length: pkg.dimensions.Length || 0,
          width: pkg.dimensions.Width || 0,
          height: pkg.dimensions.Height || 0,
          unitOfMeasure: (pkg.dimensions.Units || 'IN').toUpperCase(),
        } : undefined,
      },
      pickup: DHL_PICKUP_ID,
    };

    const dhlResponse = await axios.post(
      `${DHL_BASE_URL}/shipping/v4/products`,
      dhlRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Map DHL product list → Logiwa rateList format
    const products = dhlResponse.data?.products || [];
    const rateList = products.map((product) => ({
      carrier: logiwaRequest.carrier || 'DHL eCommerce',
      shippingOption: product.productName || product.productId,
      totalCost: product.rateDetails?.totalAmount || 0,
      shippingCost: product.rateDetails?.baseAmount || 0,
      otherCost: product.rateDetails?.otherAmount || 0,
      currency: logiwaRequest.currency || 'USD',
    }));

    const logiwaResponse = {
      data: {
        shipmentOrderCode: logiwaRequest.shipmentOrderCode,
        shipmentOrderIdentifier: logiwaRequest.shipmentOrderIdentifier,
        rateList,
        isSuccessful: true,
        message: '',
      },
    };

    console.log('[GET-RATE] Success — returned', rateList.length, 'rates');
    return res.json(logiwaResponse);
  } catch (err) {
    const errMsg = err.response?.data?.detail || err.response?.data?.message || err.message;
    console.error('[GET-RATE] Error:', errMsg);
    return res.json({
      data: {
        shipmentOrderCode: req.body.shipmentOrderCode,
        shipmentOrderIdentifier: req.body.shipmentOrderIdentifier,
        rateList: [],
        isSuccessful: false,
        message: `Error getting rates: ${errMsg}`,
      },
    });
  }
});

// ─── 2. CREATE LABEL ────────────────────────────────────────────────────────────
/**
 * Logiwa sends shipment details → we create a label with DHL
 * → we return the label data in Logiwa's format
 */
app.post('/create-label', async (req, res) => {
  console.log('[CREATE-LABEL] Request received:', JSON.stringify(req.body, null, 2));

  try {
    const logiwaRequest = req.body;
    const token = await getDHLToken();
    const pkg = logiwaRequest.requestedPackageLineItems?.[0] || {};
    const labelSpec = logiwaRequest.labelSpecification || {};

    // Generate a unique package ID using order code + timestamp
    const packageId = `${logiwaRequest.shipmentOrderCode}-${Date.now()}`.slice(0, 40);

    // Map label format from Logiwa to DHL
    const formatMap = { PDF: 'pdf', ZPL: 'zpl', PNG: 'png' };
    const labelFormat = formatMap[labelSpec.labelFileType?.toUpperCase()] || 'pdf';

    // Build DHL Label request
    const dhlRequest = {
      pickup: DHL_PICKUP_ID,
      distributionCenter: DHL_DISTRIBUTION,
      orderedProductId: mapServiceToDHL(logiwaRequest.shippingOption),
      packageDetail: {
        packageId,
        packageDescription: logiwaRequest.shipmentOrderCode || 'Shipment',
        weight: {
          unitOfMeasure: (pkg.weight?.units || 'LB').toUpperCase(),
          value: parseFloat(pkg.weight?.value || 1),
        },
        ...(pkg.dimensions && {
          dimension: {
            length: pkg.dimensions.length || 0,
            width: pkg.dimensions.width || 0,
            height: pkg.dimensions.height || 0,
            unitOfMeasure: (pkg.dimensions.Units || 'IN').toUpperCase(),
          },
        }),
      },
      consigneeAddress: {
        name: logiwaRequest.shipTo?.contact?.personName || '',
        companyName: logiwaRequest.shipTo?.contact?.companyName || '',
        address1: logiwaRequest.shipTo?.address?.adressLine1 || logiwaRequest.shipTo?.address?.addressLine1 || '',
        address2: logiwaRequest.shipTo?.address?.addressLine2 || '',
        city: logiwaRequest.shipTo?.address?.city || '',
        state: logiwaRequest.shipTo?.address?.stateOrProvinceCode || '',
        postalCode: logiwaRequest.shipTo?.address?.postalCode || '',
        country: logiwaRequest.shipTo?.address?.countryCode || 'US',
        email: logiwaRequest.shipTo?.contact?.emailAddress || '',
        phone: logiwaRequest.shipTo?.contact?.phoneNumber || '',
      },
      returnAddress: {
        companyName: logiwaRequest.shipFrom?.contact?.companyName || '',
        name: logiwaRequest.shipFrom?.contact?.personName || '',
        address1: logiwaRequest.shipFrom?.address?.addressLine1 || '',
        address2: logiwaRequest.shipFrom?.address?.addressLine2 || '',
        city: logiwaRequest.shipFrom?.address?.city || '',
        state: logiwaRequest.shipFrom?.address?.stateOrProvinceCode || '',
        postalCode: logiwaRequest.shipFrom?.address?.postalCode || '',
        country: logiwaRequest.shipFrom?.address?.countryCode || 'US',
      },
      labelFormat,
      // International customs
      ...(logiwaRequest.internationalOptions?.customsItems?.length > 0 && {
        customsDetails: logiwaRequest.internationalOptions.customsItems.map((item) => ({
          itemDescription: item.description || '',
          itemQuantity: item.quantity || 1,
          itemTotalValue: item.declaredValue || 0,
          countryOfManufacture: item.originCountryCode || 'US',
          skuNumber: item.SKU || '',
          hsCode: item.HSTarriffCode || '',
        })),
      }),
    };

    const dhlResponse = await axios.post(
      `${DHL_BASE_URL}/shipping/v4/labels`,
      dhlRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const dhlData = dhlResponse.data;
    const trackingNumber = dhlData.dhlPackageId || dhlData.packageId || packageId;
    const labelData = dhlData.labelData || '';
    const isBase64 = labelFormat !== 'zpl';

    const logiwaResponse = {
      data: {
        shipmentOrderIdentifier: logiwaRequest.shipmentOrderIdentifier,
        shipmentOrderCode: logiwaRequest.shipmentOrderCode,
        carrier: logiwaRequest.carrier || 'DHL eCommerce',
        shippingOption: logiwaRequest.shippingOption,
        packageResponse: [
          {
            packageSequenceNumber: pkg.packageSequenceNumber || 1,
            trackingNumber,
            encodedLabel: isBase64 ? labelData : Buffer.from(labelData).toString('base64'),
            labelURL: dhlData.labelUrl || '',
          },
        ],
        rateDetail: {
          totalCost: dhlData.rateDetails?.totalAmount || 0,
          shippingCost: dhlData.rateDetails?.baseAmount || 0,
          otherCost: dhlData.rateDetails?.otherAmount || 0,
          currency: logiwaRequest.currency || 'USD',
        },
        masterTrackingNumber: trackingNumber,
        isSuccessful: true,
        message: '',
      },
    };

    console.log('[CREATE-LABEL] Success — tracking:', trackingNumber);
    return res.json(logiwaResponse);
  } catch (err) {
    const errMsg = err.response?.data?.detail || err.response?.data?.message || err.message;
    console.error('[CREATE-LABEL] Error:', errMsg, err.response?.data);
    return res.json({
      data: {
        shipmentOrderIdentifier: req.body.shipmentOrderIdentifier,
        shipmentOrderCode: req.body.shipmentOrderCode,
        carrier: req.body.carrier || 'DHL eCommerce',
        shippingOption: req.body.shippingOption,
        packageResponse: [],
        rateDetail: { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
        masterTrackingNumber: '',
        isSuccessful: false,
        message: `Error creating label: ${errMsg}`,
      },
    });
  }
});

// ─── 3. VOID LABEL ──────────────────────────────────────────────────────────────
/**
 * Logiwa sends a tracking number → we void/cancel it with DHL
 * → we return success/failure to Logiwa
 */
app.post('/void-label', async (req, res) => {
  console.log('[VOID-LABEL] Request received:', JSON.stringify(req.body, null, 2));

  try {
    const logiwaRequest = req.body;
    const token = await getDHLToken();
    const trackingNumber = logiwaRequest.masterTrackingNumber;

    if (!trackingNumber) {
      return res.json({
        shipmentOrderIdentifier: logiwaRequest.shipmentOrderIdentifier,
        masterTrackingNumber: '',
        isSuccessful: false,
        message: 'No tracking number provided to void',
      });
    }

    await axios.delete(
      `${DHL_BASE_URL}/shipping/v4/labels/${trackingNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('[VOID-LABEL] Success — voided:', trackingNumber);
    return res.json({
      shipmentOrderIdentifier: logiwaRequest.shipmentOrderIdentifier,
      masterTrackingNumber: trackingNumber,
      isSuccessful: true,
      message: 'Label voided successfully',
    });
  } catch (err) {
    const errMsg = err.response?.data?.detail || err.response?.data?.message || err.message;
    // DHL returns 404 if already voided — still treat as success
    const alreadyVoided = err.response?.status === 404;
    console.error('[VOID-LABEL]', alreadyVoided ? 'Already voided (404)' : 'Error: ' + errMsg);
    return res.json({
      shipmentOrderIdentifier: req.body.shipmentOrderIdentifier,
      masterTrackingNumber: req.body.masterTrackingNumber,
      isSuccessful: alreadyVoided,
      message: alreadyVoided ? 'Label was already voided or not found' : `Error voiding label: ${errMsg}`,
    });
  }
});

// ─── 4. END-OF-DAY REPORT ───────────────────────────────────────────────────────
/**
 * Logiwa requests EOD report → we trigger DHL manifest close
 * → we return the manifest report to Logiwa
 */
app.post('/end-of-day-report', async (req, res) => {
  console.log('[EOD-REPORT] Request received:', JSON.stringify(req.body, null, 2));

  try {
    const logiwaRequest = req.body;
    const token = await getDHLToken();

    const closeDate = logiwaRequest.closeDate || new Date().toISOString().split('T')[0];

    const dhlRequest = {
      pickup: DHL_PICKUP_ID,
      closeDate,
    };

    const dhlResponse = await axios.post(
      `${DHL_BASE_URL}/shipping/v4/manifests`,
      dhlRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // DHL returns a manifest report, encode it as base64 for Logiwa
    const reportContent = JSON.stringify(dhlResponse.data);
    const encodedReport = Buffer.from(reportContent).toString('base64');

    console.log('[EOD-REPORT] Success');
    return res.json({
      carrierSetupIdentifier: logiwaRequest.carrierSetupIdentifier,
      carrier: logiwaRequest.carrier || 'DHL eCommerce',
      encodedReport,
      isSuccessful: true,
      message: '',
    });
  } catch (err) {
    const errMsg = err.response?.data?.detail || err.response?.data?.message || err.message;
    console.error('[EOD-REPORT] Error:', errMsg);
    return res.json({
      carrierSetupIdentifier: req.body.carrierSetupIdentifier,
      carrier: req.body.carrier || 'DHL eCommerce',
      encodedReport: '',
      isSuccessful: false,
      message: `Error generating EOD report: ${errMsg}`,
    });
  }
});

// ─── Helper: Map Logiwa Service Name to DHL Product ID ──────────────────────────
/**
 * You may need to add or edit these mappings to match the exact service names
 * you set up in Logiwa's Custom Carrier Data Setup, and your DHL account's products.
 *
 * Common DHL eCommerce Americas product IDs:
 *   GND  = DHL SmartMail Parcel Ground
 *   EXP  = DHL SmartMail Parcel Expedited
 *   PLT  = DHL SmartMail Parcel Plus Ground
 *   PLTE = DHL SmartMail Parcel Plus Expedited
 *   BPM  = DHL SmartMail Bound Printed Matter
 *   LIB  = DHL SmartMail Media Mail
 *   FCLE = DHL GlobalMail International
 */
function mapServiceToDHL(logiwaServiceName) {
  if (!logiwaServiceName) return 'GND';
  const upper = logiwaServiceName.toUpperCase();

  const map = {
    'GROUND':           'GND',
    'GND':              'GND',
    'EXPEDITED':        'EXP',
    'EXP':              'EXP',
    'PARCEL PLUS':      'PLT',
    'PLT':              'PLT',
    'PARCEL PLUS EXP':  'PLTE',
    'PLTE':             'PLTE',
    'INTERNATIONAL':    'FCLE',
    'FCLE':             'FCLE',
    'MEDIA':            'LIB',
    'BPM':              'BPM',
  };

  for (const [key, val] of Object.entries(map)) {
    if (upper.includes(key)) return val;
  }

  // If no match, return as-is (DHL will reject with a clear error)
  return logiwaServiceName;
}

// ─── Start Server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DHL-Logiwa Middleware running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
  console.log(`   Get Rate:     POST http://localhost:${PORT}/get-rate`);
  console.log(`   Create Label: POST http://localhost:${PORT}/create-label`);
  console.log(`   Void Label:   POST http://localhost:${PORT}/void-label`);
  console.log(`   EOD Report:   POST http://localhost:${PORT}/end-of-day-report\n`);
});
