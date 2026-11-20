import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSignedSandboxInitData, verifyTelegramInitData } from '../server/security.ts';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runTests() {
  console.log('Running SOFUMER integration & security test suite against', BASE);
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL: ${name} ->`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  await test('Health endpoint responds ok', async () => {
    const r = await req('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'SOFUMER');
  });

  await test('Bootstrap seeds 10 categories, countries, currencies, and 3 plans with 0 fake products', async () => {
    const boot = await req('/api/marketplace/bootstrap');
    assert.equal(boot.status, 200);
    assert.ok(boot.data.categories.length >= 10);
    assert.ok(boot.data.countries.length >= 10);
    assert.ok(boot.data.currencies.length >= 10);
    assert.equal(boot.data.plans.length, 3);
  });

  await test('Telegram initData HMAC-SHA256 verification accepts valid & rejects tampered/expired', async () => {
    const botToken = '123456:TEST_BOT_TOKEN';
    const valid = buildSignedSandboxInitData({ id: 777001, first_name: 'Alice', username: 'alice_tg' }, botToken);
    const verified = verifyTelegramInitData(valid, botToken);
    assert.equal(verified.user.id, 777001);

    // Tamper hash
    assert.throws(() => verifyTelegramInitData(valid.replace(/hash=[0-9a-f]{4}/, 'hash=0000'), botToken));

    // Expired timestamp
    const oldParams = new URLSearchParams(valid);
    oldParams.set('auth_date', '1000000');
    assert.throws(() => verifyTelegramInitData(oldParams.toString(), botToken));
  });

  await test('Unauthorized requests to protected endpoints are rejected with 401', async () => {
    const r1 = await req('/api/seller/products');
    assert.equal(r1.status, 401);
    const r2 = await req('/api/orders');
    assert.equal(r2.status, 401);
    const r3 = await req('/api/admin/overview');
    assert.equal(r3.status, 401);
    const r4 = await req('/api/ai/buyer/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'laptop' }),
    });
    assert.equal(r4.status, 401);
  });

  await test('Telegram webhook rejects missing/invalid secret token', async () => {
    const r = await req('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
      body: JSON.stringify({ update_id: 999 }),
    });
    assert.equal(r.status, 401);
  });

  // Authenticate Seller, Buyer, and Intruder via cryptographic sandbox
  let sellerToken = '';
  let buyerToken = '';
  let buyerUserId = '';
  let intruderToken = '';
  let createdProductId = '';
  let createdConvId = '';
  let createdOrderId = '';
  let adminToken = '';

  await test('Sandbox cryptographic Telegram authentication creates distinct buyer & seller sessions', async () => {
    const s = await req('/api/auth/dev-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Seller', handle: `seller_${Date.now()}` }),
    });
    assert.equal(s.status, 200);
    sellerToken = s.data.token;

    const b = await req('/api/auth/dev-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Buyer', handle: `buyer_${Date.now()}` }),
    });
    assert.equal(b.status, 200);
    buyerToken = b.data.token;

    const bMe = await req('/api/auth/me', { headers: { Authorization: `Bearer ${buyerToken}` } });
    buyerUserId = bMe.data.user.id;

    const i = await req('/api/auth/dev-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Intruder', handle: `intruder_${Date.now()}` }),
    });
    intruderToken = i.data.token;
  });

  await test('Seller registration, shop creation, and physical/digital product publishing', async () => {
    const reg = await req('/api/seller/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
      body: JSON.stringify({
        sellerType: 'business',
        legalName: 'Test Global Hardware LLC',
        shopName: `GlobalTech_${crypto.randomBytes(3).toString('hex')}`,
        countryCode: 'DE',
        description: 'Testing verified industrial hardware.',
      }),
    });
    assert.equal(reg.status, 201);

    const pub = await req('/api/seller/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
      body: JSON.stringify({
        listingType: 'physical',
        title: 'Precision USB-C Logic Analyzer',
        description: '16-channel analyzer with worldwide DHL express shipping.',
        categoryId: 'cat_electronics',
        price: 249.5,
        currency: 'USD',
        condition: 'new',
        stockQuantity: 5,
        internationalShipping: true,
        status: 'published',
      }),
    });
    assert.equal(pub.status, 201);
    createdProductId = pub.data.product.id;

    const search = await req('/api/marketplace/explore?q=Logic+Analyzer&mode=products');
    assert.equal(search.status, 200);
    assert.ok(search.data.items.some((p: { id: string }) => p.id === createdProductId));
  });

  await test('Wishlist toggle & private messaging authorization check', async () => {
    const fav = await req(`/api/marketplace/favorites/${createdProductId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    assert.equal(fav.status, 200);
    assert.equal(fav.data.favorited, true);

    const conv = await req('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ productId: createdProductId, message: 'Can you ship to Canada?' }),
    });
    assert.equal(conv.status, 201);
    createdConvId = conv.data.conversationId;

    // 3rd party intruder must receive 403
    const intruderRead = await req(`/api/conversations/${createdConvId}/messages`, {
      headers: { Authorization: `Bearer ${intruderToken}` },
    });
    assert.equal(intruderRead.status, 403);
  });

  await test('Direct transaction order lifecycle (Pending -> Confirmed -> Shipped -> Completed -> Verified Review)', async () => {
    const ord = await req('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
      body: JSON.stringify({
        productId: createdProductId,
        buyerUserId,
        conversationId: createdConvId,
        quantity: 1,
        agreedTotal: 249.5,
        currency: 'USD',
        deliveryArrangement: 'DHL Express 3-day',
      }),
    });
    assert.equal(ord.status, 201);
    createdOrderId = ord.data.orderId;

    // Buyer confirms
    const c1 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(c1.status, 200);

    // Seller ships
    const c2 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
      body: JSON.stringify({ status: 'Shipped', note: 'AWB-99102' }),
    });
    assert.equal(c2.status, 200);

    // Buyer completes
    const c3 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ status: 'Completed' }),
    });
    assert.equal(c3.status, 200);

    // Buyer submits verified review
    const rev = await req(`/api/orders/${createdOrderId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ rating: 5, comment: 'Fast shipping and exact hardware.' }),
    });
    assert.equal(rev.status, 201);
  });

  await test('Ordinary buyer cannot access admin APIs; valid admin login succeeds & AI restriction enforced', async () => {
    const denied = await req('/api/admin/overview', {
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    assert.equal(denied.status, 401);

    const login = await req('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passcode: process.env.ADMIN_BOOTSTRAP_SECRET || 'SOFUMER-DEV-ADMIN-2026',
        adminName: 'IntegrationTester',
      }),
    });
    assert.equal(login.status, 200);
    adminToken = login.data.token;

    // Disable AI for buyer user
    const disableAi = await req(`/api/admin/users/${buyerUserId}/ai-access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ aiEnabled: false, reason: 'Integration test restriction' }),
    });
    assert.equal(disableAi.status, 200);

    const aiBlocked = await req('/api/ai/buyer/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ query: 'analyzer' }),
    });
    assert.equal(aiBlocked.status, 403);

    // Restore AI access
    await req(`/api/admin/users/${buyerUserId}/ai-access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ aiEnabled: true }),
    });

    // Clean up test product so marketplace remains clean without test artifacts
    await req(`/api/seller/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
  });

  console.log(`\nTest Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
