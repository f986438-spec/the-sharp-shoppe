/**
 * The Sharp Shoppe — Label & Payment Server
 * Generates real USPS prepaid shipping labels via Shippo API v2
 * Handles Coinbase Commerce crypto payment charges
 * Run: node label-server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Shippo } = require('shippo');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── Shippo client
const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY || 'shippo_test_PLACEHOLDER';
const shippoConfigured = SHIPPO_API_KEY !== 'shippo_test_PLACEHOLDER';
const shippo = new Shippo({ apiKeyHeader: SHIPPO_API_KEY });

// ── Coinbase Commerce
const COINBASE_COMMERCE_API_KEY = process.env.COINBASE_COMMERCE_API_KEY || '';
const coinbaseConfigured = !!(COINBASE_COMMERCE_API_KEY && COINBASE_COMMERCE_API_KEY !== 'YOUR_COINBASE_COMMERCE_API_KEY');

// ── Sharp Shoppe destination address
const SHARP_SHOPPE = {
  name: 'The Sharp Shoppe',
  company: 'The Sharp Shoppe',
  street1: '230 Phoenix Blvd NW',
  city: 'Christiansburg',
  state: 'VA',
  zip: '24073',
  country: 'US',
  phone: '8553015586',
  email: 'thesharpshoppe@gmail.com'
};

/**
 * POST /create-label
 * Body: { customer: { firstName, lastName, address, city, state, zip, phone, email }, items: [{name, qty, price}], orderNumber }
 */
app.post('/create-label', async (req, res) => {
  const { customer, items, orderNumber } = req.body;

  if (!customer || !customer.address) {
    return res.status(400).json({ error: 'Missing customer address' });
  }

  if (!shippoConfigured) {
    // Return a demo label response when API key not configured
    return res.json({
      success: true,
      demo: true,
      labelUrl: null,
      trackingNumber: 'DEMO-' + Date.now(),
      trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction',
      carrier: 'USPS',
      service: 'Priority Mail',
      rate: '9.85',
      currency: 'USD',
      estimatedDays: 3,
      orderNumber: orderNumber,
      message: 'Demo mode — configure SHIPPO_API_KEY in .env for live labels'
    });
  }

  // Estimate weight: 0.5 lbs base + 0.3 per item
  const totalItems = items.reduce((sum, i) => sum + i.qty, 0);
  const estimatedWeight = Math.max(1, 0.5 + totalItems * 0.3);

  try {
    // 1. Create shipment
    const shipmentResp = await shippo.shipments.create({
      addressFrom: {
        name: customer.firstName + ' ' + customer.lastName,
        street1: customer.address,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        country: 'US',
        phone: customer.phone || '',
        email: customer.email || ''
      },
      addressTo: SHARP_SHOPPE,
      parcels: [{
        length: '12',
        width: '10',
        height: '4',
        distanceUnit: 'in',
        weight: estimatedWeight.toString(),
        massUnit: 'lb'
      }],
      extra: {
        reference1: orderNumber || 'TSS-ORDER',
        reference2: 'Sharp Shoppe Mail-In'
      },
      async: false
    });

    if (!shipmentResp.rates || shipmentResp.rates.length === 0) {
      return res.status(500).json({ error: 'No rates available for this address combination' });
    }

    // 2. Select best USPS Priority rate
    const uspsRates = shipmentResp.rates.filter(r =>
      r.provider === 'USPS' &&
      r.servicelevel &&
      (r.servicelevel.token.includes('priority') || r.servicelevel.token.includes('first'))
    );

    const allRates = uspsRates.length > 0 ? uspsRates : shipmentResp.rates;
    const selectedRate = allRates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

    // 3. Purchase label
    const txn = await shippo.transactions.create({
      rate: selectedRate.objectId,
      labelFileType: 'PDF',
      async: false
    });

    if (txn.status !== 'SUCCESS') {
      return res.status(500).json({
        error: 'Label purchase failed: ' + (txn.messages || []).map(m => m.text).join(', ')
      });
    }

    return res.json({
      success: true,
      labelUrl: txn.labelUrl,
      trackingNumber: txn.trackingNumber,
      trackingUrl: txn.trackingUrlProvider,
      carrier: selectedRate.provider,
      service: selectedRate.servicelevel.name,
      rate: selectedRate.amount,
      currency: selectedRate.currency,
      estimatedDays: selectedRate.estimatedDays,
      orderNumber: orderNumber
    });

  } catch (err) {
    console.error('Shippo API error:', JSON.stringify(err, null, 2));
    return res.status(500).json({
      error: err.message || 'Label generation failed',
      detail: err.rawResponse || null
    });
  }
});

// ════════════════════════════════════════════
// COINBASE COMMERCE — Create Crypto Charge
// ════════════════════════════════════════════
/**
 * POST /create-crypto-charge
 * Body: { name, description, amount, currency, customer: { name, email } }
 */
app.post('/create-crypto-charge', async (req, res) => {
  const { name, description, amount, currency, customer } = req.body;

  if (!coinbaseConfigured) {
    // Demo mode — return a simulated response
    console.log('Coinbase Commerce: Demo mode (API key not configured)');
    return res.json({
      success: false,
      demo: true,
      message: 'Coinbase Commerce API key not configured. Set COINBASE_COMMERCE_API_KEY in .env'
    });
  }

  try {
    const response = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': COINBASE_COMMERCE_API_KEY,
        'X-CC-Version': '2018-03-22'
      },
      body: JSON.stringify({
        name: name || 'The Sharp Shoppe — Blade Sharpening',
        description: description || 'Professional blade sharpening service',
        pricing_type: 'fixed_price',
        local_price: {
          amount: amount,
          currency: currency || 'USD'
        },
        metadata: {
          customer_name: customer ? customer.name : '',
          customer_email: customer ? customer.email : ''
        },
        redirect_url: req.headers.origin || 'http://localhost:3001/order.html',
        cancel_url: req.headers.origin || 'http://localhost:3001/order.html'
      })
    });

    const data = await response.json();

    if (data.data) {
      return res.json({
        success: true,
        charge_id: data.data.id,
        hosted_url: data.data.hosted_url,
        expires_at: data.data.expires_at,
        pricing: data.data.pricing
      });
    } else {
      return res.status(400).json({
        success: false,
        error: data.error ? data.error.message : 'Failed to create charge'
      });
    }
  } catch (err) {
    console.error('Coinbase Commerce error:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Coinbase Commerce API error'
    });
  }
});

// ════════════════════════════════════════════
// COINBASE COMMERCE — Check Charge Status
// ════════════════════════════════════════════
/**
 * GET /check-crypto-charge/:chargeId
 */
app.get('/check-crypto-charge/:chargeId', async (req, res) => {
  const { chargeId } = req.params;

  if (!coinbaseConfigured) {
    return res.json({ status: 'DEMO', message: 'Coinbase Commerce not configured' });
  }

  try {
    const response = await fetch(`https://api.commerce.coinbase.com/charges/${chargeId}`, {
      headers: {
        'X-CC-Api-Key': COINBASE_COMMERCE_API_KEY,
        'X-CC-Version': '2018-03-22'
      }
    });

    const data = await response.json();

    if (data.data) {
      // Check timeline for latest status
      const timeline = data.data.timeline || [];
      const latestStatus = timeline.length > 0 ? timeline[timeline.length - 1].status : 'PENDING';
      return res.json({
        status: latestStatus,
        payments: data.data.payments || [],
        expires_at: data.data.expires_at
      });
    } else {
      return res.status(404).json({ error: 'Charge not found' });
    }
  } catch (err) {
    console.error('Coinbase Commerce check error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    shippoConfigured,
    coinbaseConfigured,
    mode: {
      shippo: shippoConfigured ? 'live' : 'demo',
      coinbase: coinbaseConfigured ? 'live' : 'demo'
    },
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🔪 Sharp Shoppe Label & Payment Server — port ${PORT}`);
  console.log(`   Shippo:   ${shippoConfigured ? '✅ Configured (live mode)' : '⚠️  Demo mode — add SHIPPO_API_KEY to .env'}`);
  console.log(`   Coinbase: ${coinbaseConfigured ? '✅ Configured (live mode)' : '⚠️  Demo mode — add COINBASE_COMMERCE_API_KEY to .env'}`);
  console.log(`   POST /create-label          — Generate USPS prepaid label`);
  console.log(`   POST /create-crypto-charge   — Create Coinbase Commerce charge`);
  console.log(`   GET  /check-crypto-charge/:id — Check crypto charge status`);
  console.log(`   GET  /health                — Server status\n`);
});
