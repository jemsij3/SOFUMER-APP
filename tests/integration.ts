import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildSignedSandboxInitData, verifyTelegramInitData } from '../server/security.ts';
import { db } from '../server/db.ts';
import worker, { type Env as WorkerEnv, type D1Database } from '../cloudflare/worker.ts';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/**
 * Lightweight D1 adapter backed by the local SQLite instance so we can execute
 * the actual `cloudflare/worker.ts` entrypoint directly in tests and verify `env.AI.run(...)`.
 */
function createSqliteD1Adapter(): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const stmtApi = {
        bind(...values: unknown[]) {
          bound = values;
          return stmtApi;
        },
        async first<T = Record<string, unknown>>() {
          const row = db.prepare(query).get(...bound) as T | undefined;
          return row ?? null;
        },
        async all<T = Record<string, unknown>>() {
          const rows = db.prepare(query).all(...bound) as T[];
          return { results: rows };
        },
        async run() {
          db.prepare(query).run(...bound);
          return { success: true };
        },
      };
      return stmtApi;
    },
  };
}

async function runTests() {
  console.log('Running SOFUMER integration, security, and Cloudflare Workers AI test suite against', BASE);
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

  await test('No Gemini SDK or GEMINI_API_KEY references remain in codebase config/source', async () => {
    const pkg = fs.readFileSync('package.json', 'utf-8');
    const envEx = fs.readFileSync('.env.example', 'utf-8');
    const wrangler = fs.readFileSync('wrangler.toml', 'utf-8');
    const workerSrc = fs.readFileSync('cloudflare/worker.ts', 'utf-8');
    const serverAi = fs.readFileSync('server/ai.ts', 'utf-8');
    assert.ok(!pkg.includes('@google/genai'));
    assert.ok(!envEx.includes('GEMINI_API_KEY'));
    assert.ok(!workerSrc.includes('GEMINI_API_KEY'));
    assert.ok(!serverAi.includes('@google/genai'));
    assert.ok(wrangler.includes('[ai]') && wrangler.includes('binding = "AI"'));
    assert.ok(wrangler.includes('@cf/meta/llama-3.1-8b-instruct'));
  });

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

    assert.throws(() => verifyTelegramInitData(valid.replace(/hash=[0-9a-f]{4}/, 'hash=0000'), botToken));

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

  await test('Seller registration, shop creation, and physical product publishing', async () => {
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

    const intruderRead = await req(`/api/conversations/${createdConvId}/messages`, {
      headers: { Authorization: `Bearer ${intruderToken}` },
    });
    assert.equal(intruderRead.status, 403);
  });

  await test('Direct transaction order lifecycle & verified review', async () => {
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

    const c1 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(c1.status, 200);

    const c2 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
      body: JSON.stringify({ status: 'Shipped', note: 'AWB-99102' }),
    });
    assert.equal(c2.status, 200);

    const c3 = await req(`/api/orders/${createdOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ status: 'Completed' }),
    });
    assert.equal(c3.status, 200);

    const rev = await req(`/api/orders/${createdOrderId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ rating: 5, comment: 'Fast shipping and exact hardware.' }),
    });
    assert.equal(rev.status, 201);
  });

  await test('Cloudflare Worker env.AI & R2 MEDIA_BUCKET execute AI routes and media uploads on Free-tier bindings (no Queues)', async () => {
    const botToken = '123456:EDGE_TEST_TOKEN';
    const sessionSecret = 'edge-test-secret';
    const aiCalls: Array<{ model: string; userPrompt: string }> = [];
    const r2Objects = new Map<string, { data: ArrayBuffer; contentType: string }>();

    const mockEnv: WorkerEnv = {
      DB: createSqliteD1Adapter(),
      MEDIA_BUCKET: {
        put: async (key, value, options) => {
          const data =
            value instanceof ArrayBuffer
              ? value
              : typeof value === 'string'
              ? new TextEncoder().encode(value).buffer
              : await new Response(value).arrayBuffer();
          r2Objects.set(key, {
            data,
            contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
          });
          return {};
        },
        get: async (key) => {
          const found = r2Objects.get(key);
          if (!found) return null;
          return {
            body: new Response(found.data).body!,
            httpMetadata: { contentType: found.contentType },
          };
        },
      },
      AI: {
        async run(model, inputs) {
          const userMsg = inputs.messages.find((m) => m.role === 'user')?.content || '';
          aiCalls.push({ model, userPrompt: userMsg });
          if (userMsg.includes('Buyer query:')) {
            return {
              response: JSON.stringify({
                answer: 'Found Precision USB-C Logic Analyzer in the catalog.',
                matchedProductIds: [createdProductId],
                suggestedFollowUps: ['Ask about international shipping'],
              }),
            };
          }
          if (userMsg.includes('Target:')) {
            return {
              response: JSON.stringify({
                translatedTitle: 'Analyseur Logique USB-C',
                translatedDescription: 'Analyseur 16 canaux.',
              }),
            };
          }
          if (userMsg.includes('Available Categories:') || userMsg.includes('Categories:')) {
            return {
              response: JSON.stringify({
                suggestedTitle: 'Precision USB-C 16-Channel Analyzer',
                improvedDescription: 'Compact 16-channel analyzer.',
                suggestedCategoryId: 'cat_electronics',
                keywords: ['logic analyzer', 'usb-c'],
                faqs: [{ question: 'Ships globally?', answer: 'Yes.' }],
              }),
            };
          }
          return { response: 'Cloudflare Workers AI response based on real catalog data.' };
        },
      },
      ASSETS: { fetch: async () => new Response('ok') },
      TELEGRAM_BOT_NAME: 'SOFUMER',
      TELEGRAM_BOT_USERNAME: 'SofumerBot',
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_WEBHOOK_SECRET: 'wh_secret',
      SESSION_SECRET: sessionSecret,
      ADMIN_BOOTSTRAP_SECRET: 'adm_secret',
      CLOUDFLARE_AI_MODEL: '@cf/meta/llama-3.1-8b-instruct',
    };

    const initData = buildSignedSandboxInitData({ id: 888001, first_name: 'EdgeBuyer', username: 'edge_buyer' }, botToken);
    const authResp = await worker.fetch(
      new Request('https://sofumer.example/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      }),
      mockEnv
    );
    assert.equal(authResp.status, 200);
    const authJson = (await authResp.json()) as { token: string };
    const edgeToken = authJson.token;

    // 0. R2 Media Upload + Retrieval
    const unauthUpload = await worker.fetch(
      new Request('https://sofumer.example/api/uploads', { method: 'POST' }),
      mockEnv
    );
    assert.equal(unauthUpload.status, 401);

    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'sample.png', { type: 'image/png' }));
    const uploadResp = await worker.fetch(
      new Request('https://sofumer.example/api/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${edgeToken}` },
        body: fd,
      }),
      mockEnv
    );
    assert.equal(uploadResp.status, 201);
    const uploaded = (await uploadResp.json()) as { url: string; mimeType: string };
    assert.ok(uploaded.url.startsWith('/r2/'));
    assert.equal(uploaded.mimeType, 'image/png');

    const r2Get = await worker.fetch(new Request(`https://sofumer.example${uploaded.url}`), mockEnv);
    assert.equal(r2Get.status, 200);
    assert.equal(r2Get.headers.get('Content-Type'), 'image/png');

    // 1. Buyer discovery
    const r1 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/buyer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edgeToken}` },
        body: JSON.stringify({ query: 'logic analyzer' }),
      }),
      mockEnv
    );
    assert.equal(r1.status, 200);
    const j1 = (await r1.json()) as { provider: string; model: string; matchedProducts: Array<{ id: string }> };
    assert.equal(j1.provider, 'cloudflare-workers-ai');
    assert.equal(j1.model, '@cf/meta/llama-3.1-8b-instruct');
    assert.equal(j1.matchedProducts[0].id, createdProductId);

    // 2. Compare
    const r2 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/buyer/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edgeToken}` },
        body: JSON.stringify({ productIds: [createdProductId] }),
      }),
      mockEnv
    );
    assert.equal(r2.status, 200);

    // 3. Seller listing & translate
    const r3 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edgeToken}` },
        body: JSON.stringify({ action: 'generate_listing', title: 'Analyzer', notes: '16ch' }),
      }),
      mockEnv
    );
    assert.equal(r3.status, 200);

    const r4 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edgeToken}` },
        body: JSON.stringify({ action: 'translate', title: 'Analyzer', notes: '16ch', targetLanguage: 'French' }),
      }),
      mockEnv
    );
    assert.equal(r4.status, 200);

    // 4. Platform support
    const r5 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/platform/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edgeToken}` },
        body: JSON.stringify({ question: 'How do direct orders work?' }),
      }),
      mockEnv
    );
    assert.equal(r5.status, 200);

    assert.equal(aiCalls.length, 5);
    assert.ok(aiCalls.every((c) => c.model === '@cf/meta/llama-3.1-8b-instruct'));
  });

  await test('Ordinary buyer cannot access admin APIs; admin disables user & global AI -> backend returns 403', async () => {
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

    // Restore user AI, then test Global AI OFF
    await req(`/api/admin/users/${buyerUserId}/ai-access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ aiEnabled: true }),
    });

    await req('/api/admin/ai/features/global_ai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        isEnabled: false,
        modelName: '@cf/meta/llama-3.1-8b-instruct',
        dailyLimitPerUser: 100,
      }),
    });

    const globalBlocked = await req('/api/ai/platform/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ question: 'hello' }),
    });
    assert.equal(globalBlocked.status, 403);

    // Restore global AI ON
    await req('/api/admin/ai/features/global_ai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        isEnabled: true,
        modelName: '@cf/meta/llama-3.1-8b-instruct',
        dailyLimitPerUser: 100,
      }),
    });

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
