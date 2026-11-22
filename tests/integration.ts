import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildSignedTelegramInitData, verifyTelegramInitData } from '../server/security.ts';
import { db } from '../server/db.ts';
import worker, { type Env as WorkerEnv, type D1Database } from '../cloudflare/worker.ts';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const TEST_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST_BOT_TOKEN';

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
          const info = db.prepare(query).run(...bound);
          return { success: true, meta: { changes: info.changes } };
        },
      };
      return stmtApi;
    },
    async batch<T = unknown>(statements: Array<{ run(): Promise<{ success: boolean; meta?: { changes?: number } }> }>) {
      const results: Array<{ success: boolean; results?: T[]; meta?: { changes?: number } }> = [];
      for (const stmt of statements) {
        const res = await stmt.run();
        results.push({ success: res.success, meta: res.meta });
      }
      return results;
    },
  };
}

async function runTests() {
  console.log('Running SOFUMER integration, Telegram-only security, and Cloudflare Workers AI test suite against', BASE);
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

  await test('No hardcoded bot credentials, sandbox flags, legacy secrets, or Gemini SDK remain in config/source', async () => {
    const pkg = fs.readFileSync('package.json', 'utf-8');
    const envEx = fs.readFileSync('.env.example', 'utf-8');
    const devVarsEx = fs.readFileSync('.dev.vars.example', 'utf-8');
    const wrangler = fs.readFileSync('wrangler.jsonc', 'utf-8');
    const workerSrc = fs.readFileSync('cloudflare/worker.ts', 'utf-8');
    const serverAi = fs.readFileSync('server/ai.ts', 'utf-8');
    assert.ok(!pkg.includes('@google/genai'));
    assert.ok(!envEx.includes('GEMINI_API_KEY'));
    assert.ok(!workerSrc.includes('GEMINI_API_KEY'));
    assert.ok(!serverAi.includes('@google/genai'));
    assert.ok(wrangler.includes('"binding": "AI"') && wrangler.includes('"binding": "DB"'));
    assert.ok(!wrangler.includes('r2_buckets'));
    assert.ok(wrangler.includes('@cf/meta/llama-3.1-8b-instruct-fast'));

    for (const content of [wrangler, envEx, devVarsEx, workerSrc]) {
      assert.ok(!content.includes('TELEGRAM_BOT_NAME'));
      assert.ok(!content.includes('TELEGRAM_BOT_USERNAME'));
      assert.ok(!content.includes('ALLOW_DEV_SANDBOX'));
      assert.ok(!content.includes('SESSION_SECRET'));
      assert.ok(!content.includes('ADMIN_BOOTSTRAP_SECRET'));
      assert.ok(!content.includes('SofumerBot'));
      assert.ok(!content.includes('sofumerbot'));
      assert.ok(!content.includes('dev-sandbox'));
    }
    for (const requiredSecret of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'JWT_SECRET', 'ADMIN_TELEGRAM_IDS']) {
      assert.ok(envEx.includes(requiredSecret));
      assert.ok(devVarsEx.includes(requiredSecret));
    }
  });

  await test('Health endpoint responds ok and /api/auth/dev-sandbox is removed (404)', async () => {
    const r = await req('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'SOFUMER');

    const sandbox = await req('/api/auth/dev-sandbox', { method: 'POST' });
    assert.equal(sandbox.status, 404);
  });

  await test('Telegram initData HMAC-SHA256 verification accepts valid & rejects tampered/expired', async () => {
    const valid = buildSignedTelegramInitData({ id: 777001, first_name: 'Alice', username: 'alice_tg' }, TEST_BOT_TOKEN);
    const verified = verifyTelegramInitData(valid, TEST_BOT_TOKEN);
    assert.equal(verified.user.id, 777001);

    assert.throws(() => verifyTelegramInitData(valid.replace(/hash=[0-9a-f]{4}/, 'hash=0000'), TEST_BOT_TOKEN));

    const oldParams = new URLSearchParams(valid);
    oldParams.set('auth_date', '1000000');
    assert.throws(() => verifyTelegramInitData(oldParams.toString(), TEST_BOT_TOKEN));
  });

  await test('Unauthorized browser requests to marketplace & protected APIs are rejected with 401', async () => {
    for (const path of [
      '/api/marketplace/bootstrap',
      '/api/marketplace/home',
      '/api/marketplace/explore',
      '/api/seller/products',
      '/api/orders',
      '/api/admin/overview',
    ]) {
      const r = await req(path);
      assert.equal(r.status, 401, `Expected 401 for ${path}, got ${r.status}`);
    }
    const aiRes = await req('/api/ai/buyer/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'laptop' }),
    });
    assert.equal(aiRes.status, 401);
  });

  await test('Telegram webhook rejects missing/invalid secret token', async () => {
    const r = await req('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
      body: JSON.stringify({ update_id: 999 }),
    });
    assert.equal(r.status, 401);
  });

  let createdProductId = '';

  await test('Cloudflare Worker enforces Telegram-only auth, JWT_SECRET, ADMIN_TELEGRAM_IDS, D1 marketplace, and env.AI', async () => {
    const botToken = '123456:EDGE_TEST_TOKEN';
    const jwtSecret = 'edge-test-jwt-secret-key-at-least-32-chars';
    const aiCalls: Array<{ model: string; userPrompt: string }> = [];

    const mockEnv: WorkerEnv = {
      DB: createSqliteD1Adapter(),
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
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_WEBHOOK_SECRET: 'wh_secret',
      JWT_SECRET: jwtSecret,
      ADMIN_TELEGRAM_IDS: '999001',
      CLOUDFLARE_AI_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
    };

    const runSuffix = Number(crypto.randomInt(100000, 899999));
    const sellerInit = buildSignedTelegramInitData({ id: 1000000 + runSuffix, first_name: 'EdgeSeller', username: `edge_seller_${runSuffix}` }, botToken);
    const buyerInit = buildSignedTelegramInitData({ id: 2000000 + runSuffix, first_name: 'EdgeBuyer', username: `edge_buyer_${runSuffix}` }, botToken);
    const intruderInit = buildSignedTelegramInitData({ id: 3000000 + runSuffix, first_name: 'Intruder', username: `edge_intruder_${runSuffix}` }, botToken);
    const adminInit = buildSignedTelegramInitData({ id: 999001, first_name: 'EdgeAdmin', username: 'edge_admin' }, botToken);

    const authCall = async (initData: string) => {
      const r = await worker.fetch(
        new Request('https://sofumer.example/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
        mockEnv
      );
      assert.equal(r.status, 200);
      return (await r.json()) as { token: string; isAdmin: boolean };
    };

    const sellerAuth = await authCall(sellerInit);
    const buyerAuth = await authCall(buyerInit);
    const intruderAuth = await authCall(intruderInit);
    const adminAuth = await authCall(adminInit);

    assert.equal(sellerAuth.isAdmin, false);
    assert.equal(buyerAuth.isAdmin, false);
    assert.equal(adminAuth.isAdmin, true);

    const buyerMeRes = await worker.fetch(
      new Request('https://sofumer.example/api/auth/me', {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    const buyerMeJson = (await buyerMeRes.json()) as { user: { id: string } };
    const buyerUserId = buyerMeJson.user.id;

    // 1. Authenticated bootstrap returns categories, countries, currencies, plans
    const bootRes = await worker.fetch(
      new Request('https://sofumer.example/api/marketplace/bootstrap', {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(bootRes.status, 200);
    const bootJson = (await bootRes.json()) as { categories: unknown[]; countries: unknown[]; currencies: unknown[]; plans: unknown[] };
    assert.ok(bootJson.categories.length >= 10);
    assert.ok(bootJson.countries.length >= 10);
    assert.ok(bootJson.currencies.length >= 10);
    assert.equal(bootJson.plans.length, 3);

    // 2. Seller registration, shop creation, and physical product publishing
    const regRes = await worker.fetch(
      new Request('https://sofumer.example/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({
          sellerType: 'business',
          legalName: 'Test Global Hardware LLC',
          shopName: `GlobalTech_${crypto.randomBytes(3).toString('hex')}`,
          countryCode: 'DE',
          description: 'Testing verified industrial hardware.',
        }),
      }),
      mockEnv
    );
    assert.equal(regRes.status, 201);

    const pubRes = await worker.fetch(
      new Request('https://sofumer.example/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
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
      }),
      mockEnv
    );
    assert.equal(pubRes.status, 201);
    const pubJson = (await pubRes.json()) as { product: { id: string } };
    createdProductId = pubJson.product.id;

    // 3. Authenticated explore search
    const searchRes = await worker.fetch(
      new Request('https://sofumer.example/api/marketplace/explore?q=Logic+Analyzer&mode=products', {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(searchRes.status, 200);
    const searchJson = (await searchRes.json()) as { items: Array<{ id: string }> };
    assert.ok(searchJson.items.some((p) => p.id === createdProductId));

    // 4. Wishlist & conversation isolation
    const favRes = await worker.fetch(
      new Request(`https://sofumer.example/api/marketplace/favorites/${createdProductId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(favRes.status, 200);

    const convRes = await worker.fetch(
      new Request('https://sofumer.example/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ productId: createdProductId, message: 'Can you ship to Canada?' }),
      }),
      mockEnv
    );
    assert.equal(convRes.status, 201);
    const convJson = (await convRes.json()) as { conversationId: string };

    const intruderRead = await worker.fetch(
      new Request(`https://sofumer.example/api/conversations/${convJson.conversationId}/messages`, {
        headers: { Authorization: `Bearer ${intruderAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(intruderRead.status, 403);

    // 5. Direct order lifecycle & review
    const ordRes = await worker.fetch(
      new Request('https://sofumer.example/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({
          productId: createdProductId,
          buyerUserId,
          conversationId: convJson.conversationId,
          quantity: 1,
          agreedTotal: 249.5,
          currency: 'USD',
          deliveryArrangement: 'DHL Express 3-day',
        }),
      }),
      mockEnv
    );
    assert.equal(ordRes.status, 201);
    const ordJson = (await ordRes.json()) as { orderId: string };

    for (const [actorToken, status] of [
      [buyerAuth.token, 'Confirmed'],
      [sellerAuth.token, 'Shipped'],
      [buyerAuth.token, 'Completed'],
    ]) {
      const stRes = await worker.fetch(
        new Request(`https://sofumer.example/api/orders/${ordJson.orderId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
          body: JSON.stringify({ status }),
        }),
        mockEnv
      );
      assert.equal(stRes.status, 200);
    }

    const revRes = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${ordJson.orderId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ rating: 5, comment: 'Fast shipping and exact hardware.' }),
      }),
      mockEnv
    );
    assert.equal(revRes.status, 201);

    // 6. R2 disabled checks
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'sample.png', { type: 'image/png' }));
    const uploadResp = await worker.fetch(
      new Request('https://sofumer.example/api/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
        body: fd,
      }),
      mockEnv
    );
    assert.equal(uploadResp.status, 503);

    // 7. Workers AI endpoints
    const r1 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/buyer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ query: 'logic analyzer' }),
      }),
      mockEnv
    );
    assert.equal(r1.status, 200);
    const j1 = (await r1.json()) as { provider: string; model: string; matchedProducts: Array<{ id: string }> };
    assert.equal(j1.provider, 'cloudflare-workers-ai');
    assert.equal(j1.matchedProducts[0].id, createdProductId);

    const r2 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/buyer/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ productIds: [createdProductId] }),
      }),
      mockEnv
    );
    assert.equal(r2.status, 200);

    const r3 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ action: 'generate_listing', title: 'Analyzer', notes: '16ch' }),
      }),
      mockEnv
    );
    assert.equal(r3.status, 200);

    const r4 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ action: 'translate', title: 'Analyzer', notes: '16ch', targetLanguage: 'French' }),
      }),
      mockEnv
    );
    assert.equal(r4.status, 200);

    const r5 = await worker.fetch(
      new Request('https://sofumer.example/api/ai/platform/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ question: 'How do direct orders work?' }),
      }),
      mockEnv
    );
    assert.equal(r5.status, 200);
    assert.equal(aiCalls.length, 5);

    // 8. Admin isolation & AI governance via ADMIN_TELEGRAM_IDS
    const denied = await worker.fetch(
      new Request('https://sofumer.example/api/admin/overview', {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(denied.status, 403);

    const adminOverview = await worker.fetch(
      new Request('https://sofumer.example/api/admin/overview', {
        headers: { Authorization: `Bearer ${adminAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(adminOverview.status, 200);

    const disableAi = await worker.fetch(
      new Request(`https://sofumer.example/api/admin/users/${buyerUserId}/ai-access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ aiEnabled: false, reason: 'Integration test restriction' }),
      }),
      mockEnv
    );
    assert.equal(disableAi.status, 200);

    const aiBlocked = await worker.fetch(
      new Request('https://sofumer.example/api/ai/buyer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ query: 'analyzer' }),
      }),
      mockEnv
    );
    assert.equal(aiBlocked.status, 403);

    await worker.fetch(
      new Request(`https://sofumer.example/api/admin/users/${buyerUserId}/ai-access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ aiEnabled: true }),
      }),
      mockEnv
    );

    const archiveRes = await worker.fetch(
      new Request(`https://sofumer.example/api/seller/products/${createdProductId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({ status: 'archived' }),
      }),
      mockEnv
    );
    assert.equal(archiveRes.status, 200);

    // 9. Analytics RBAC, Telegram Stars 402 enforcement, protected digital delivery & review moderation recalculation
    const buyerAnalytics = await worker.fetch(
      new Request('https://sofumer.example/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ action: 'analytics' }),
      }),
      mockEnv
    );
    assert.equal(buyerAnalytics.status, 403);

    const paidPlanBlocked = await worker.fetch(
      new Request('https://sofumer.example/api/seller/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({ planCode: 'PRO', billingCycle: 'monthly' }),
      }),
      mockEnv
    );
    assert.equal(paidPlanBlocked.status, 402);

    const digPubRes = await worker.fetch(
      new Request('https://sofumer.example/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({
          listingType: 'digital',
          title: 'Integration Digital Guide',
          description: 'Protected PDF and license key delivery test.',
          categoryId: 'cat_electronics',
          price: 15,
          currency: 'USD',
          status: 'published',
        }),
      }),
      mockEnv
    );
    assert.equal(digPubRes.status, 201);
    const digPubJson = (await digPubRes.json()) as { product: { id: string } };

    const digAssetRes = await worker.fetch(
      new Request(`https://sofumer.example/api/seller/products/${digPubJson.product.id}/digital-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({
          fileName: 'guide.txt',
          deliveryInstructions: 'Extract archive and run setup.',
          licenseKeyTemplate: 'INT-{ORDER}',
          downloadLimit: 1,
        }),
      }),
      mockEnv
    );
    assert.equal(digAssetRes.status, 201);

    const digOrdRes = await worker.fetch(
      new Request('https://sofumer.example/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerAuth.token}` },
        body: JSON.stringify({
          productId: digPubJson.product.id,
          buyerUserId,
          quantity: 1,
          agreedTotal: 15,
          currency: 'USD',
        }),
      }),
      mockEnv
    );
    assert.equal(digOrdRes.status, 201);
    const digOrdJson = (await digOrdRes.json()) as { orderId: string; orderNumber: string };

    const lockedDigital = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${digOrdJson.orderId}/digital`, {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(lockedDigital.status, 403);

    const confirmDig = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${digOrdJson.orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerAuth.token}` },
        body: JSON.stringify({ status: 'Confirmed' }),
      }),
      mockEnv
    );
    assert.equal(confirmDig.status, 200);

    const unlockedDigital = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${digOrdJson.orderId}/digital`, {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(unlockedDigital.status, 200);

    const dl1 = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${digOrdJson.orderId}/digital/${digPubJson.product.id}/download`, {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(dl1.status, 200);
    const dl2 = await worker.fetch(
      new Request(`https://sofumer.example/api/orders/${digOrdJson.orderId}/digital/${digPubJson.product.id}/download`, {
        headers: { Authorization: `Bearer ${buyerAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(dl2.status, 403);

    // Admin hiding a review recalculates product rating_avg & review_count
    const revRow = db.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').get(createdProductId) as
      | { id: string }
      | undefined;
    assert.ok(revRow?.id);
    const hideRevRes = await worker.fetch(
      new Request(`https://sofumer.example/api/admin/reviews/${revRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ status: 'hidden', reason: 'Moderation test' }),
      }),
      mockEnv
    );
    assert.equal(hideRevRes.status, 200);
    const prodRatingAfterHide = db
      .prepare('SELECT rating_avg, review_count FROM products WHERE id = ?')
      .get(createdProductId) as { rating_avg: number; review_count: number };
    assert.equal(prodRatingAfterHide.review_count, 0);
    assert.equal(prodRatingAfterHide.rating_avg, 0);

    // 10. Active Cloudflare Workers AI model list + Settings validation + DB RBAC enforcement
    const aiCfgRes = await worker.fetch(
      new Request('https://sofumer.example/api/admin/ai', {
        headers: { Authorization: `Bearer ${adminAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(aiCfgRes.status, 200);
    const aiCfgJson = (await aiCfgRes.json()) as {
      defaultModel: string;
      availableModels: string[];
      features: Array<{ model_name: string }>;
    };
    assert.equal(aiCfgJson.defaultModel, '@cf/meta/llama-3.1-8b-instruct-fast');
    assert.ok(aiCfgJson.availableModels.includes('@cf/meta/llama-3.1-8b-instruct-fast'));
    assert.ok(!aiCfgJson.availableModels.includes('@cf/meta/llama-3.1-8b-instruct'));

    const badSettingRes = await worker.fetch(
      new Request('https://sofumer.example/api/admin/settings/stars_per_usd', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ value: '0' }),
      }),
      mockEnv
    );
    assert.equal(badSettingRes.status, 400);

    const goodSettingRes = await worker.fetch(
      new Request('https://sofumer.example/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ updates: [{ key: 'stars_per_usd', value: '55' }] }),
      }),
      mockEnv
    );
    assert.equal(goodSettingRes.status, 200);

    // Assign MODERATOR role to intruderInit user (3000000 + runSuffix)
    const modTgId = String(3000000 + runSuffix);
    const assignRes = await worker.fetch(
      new Request('https://sofumer.example/api/admin/role-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ telegramId: modTgId, roleId: 'role_mod', displayLabel: 'Test Mod' }),
      }),
      mockEnv
    );
    assert.equal(assignRes.status, 201);
    const assignJson = (await assignRes.json()) as { id: string };

    const modAuth = await authCall(intruderInit);
    assert.equal(modAuth.isAdmin, true);

    const modAllowed = await worker.fetch(
      new Request('https://sofumer.example/api/admin/reports', {
        headers: { Authorization: `Bearer ${modAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(modAllowed.status, 200);

    const modBlocked = await worker.fetch(
      new Request('https://sofumer.example/api/admin/settings', {
        headers: { Authorization: `Bearer ${modAuth.token}` },
      }),
      mockEnv
    );
    assert.equal(modBlocked.status, 403);

    await worker.fetch(
      new Request(`https://sofumer.example/api/admin/role-assignments/${assignJson.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminAuth.token}` },
      }),
      mockEnv
    );
  });

  console.log(`\nTest Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
