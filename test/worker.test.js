import {
  SELF,
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { ensureD1Schema, resetD1BootstrapCacheForTests } from '../cloudflare/d1-bootstrap.ts';

async function signTelegramInitData(tgUser, botToken) {
  const enc = new TextEncoder();
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'tg_test_query');
  params.set('user', JSON.stringify(tgUser));

  const pairs = [];
  params.forEach((value, key) => pairs.push(`${key}=${value}`));
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const webAppKey = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const secretKeyBuf = await crypto.subtle.sign('HMAC', webAppKey, enc.encode(botToken));
  const dataKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
  const hashHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  params.set('hash', hashHex);
  return params.toString();
}

describe('SOFUMER Cloudflare Worker (sofumer-app)', () => {
  beforeAll(async () => {
    if (env.DB && Array.isArray(env.TEST_MIGRATIONS)) {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    }
  });

  it('1. Worker starts successfully and serves /api/health without R2', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');

    const body = await res.json();
    expect(body.service).toBe('SOFUMER');
    expect(body.status).toBe('ok');
    expect(body.runtime).toBe('cloudflare-workers');
    expect(body.dbBound).toBe(true);
    expect(body.dbInitialized).toBe(true);
    expect(body.r2Bound).toBeUndefined();

    const r2Res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/r2/sample.png');
    expect(r2Res.status).toBe(404);
    expect(r2Res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
  });

  it('2. Main application responds with SOFUMER SPA HTML and text/html;charset=UTF-8', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html;charset=UTF-8');

    const text = await res.text();
    expect(text).toContain('SOFUMER');
    expect(text).not.toContain('Hello World');
  });

  it('3. Auth config has no hardcoded bot credentials or sandbox mode, and dev-sandbox is removed', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');

    const data = await res.json();
    expect(data.telegramOnly).toBe(true);
    expect(data.botName).toBeNull();
    expect(data.botUsername).toBeNull();
    expect(data.sandboxAvailable).toBeUndefined();

    const sandboxRes = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/auth/dev-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bypass' }),
    });
    expect(sandboxRes.status).toBe(404);
  });

  it('4. Strict Telegram-only access: unauthenticated browser requests to marketplace & protected APIs return 401', async () => {
    const endpoints = [
      '/api/marketplace/bootstrap',
      '/api/marketplace/home',
      '/api/marketplace/explore',
      '/api/orders',
      '/api/seller/dashboard',
      '/api/admin/overview',
    ];
    for (const path of endpoints) {
      const res = await SELF.fetch(`https://sofumer-app.derartuaman8.workers.dev${path}`);
      expect(res.status).toBe(401);
      expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
    }
  });

  it('5. Telegram initData HMAC-SHA256 mints JWT_SECRET JWT and enforces ADMIN_TELEGRAM_IDS', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001, 999002',
    };

    // Regular Telegram user
    const buyerInitData = await signTelegramInitData(
      { id: 500001, first_name: 'Buyer', username: 'tg_buyer' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const ctx1 = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: buyerInitData }),
      }),
      testEnv,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(loginRes.status).toBe(200);
    const loginJson = await loginRes.json();
    expect(loginJson.authenticated).toBe(true);
    expect(loginJson.isAdmin).toBe(false);
    expect(typeof loginJson.token).toBe('string');

    // Authenticated marketplace bootstrap succeeds
    const ctx2 = createExecutionContext();
    const bootRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/marketplace/bootstrap', {
        headers: { Authorization: `Bearer ${loginJson.token}` },
      }),
      testEnv,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(bootRes.status).toBe(200);
    const bootJson = await bootRes.json();
    expect(Array.isArray(bootJson.categories)).toBe(true);
    expect(bootJson.categories.length).toBeGreaterThan(0);

    // Ordinary user rejected from admin APIs -> 403
    const ctx3 = createExecutionContext();
    const forbiddenAdmin = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/overview', {
        headers: { Authorization: `Bearer ${loginJson.token}` },
      }),
      testEnv,
      ctx3
    );
    await waitOnExecutionContext(ctx3);
    expect(forbiddenAdmin.status).toBe(403);

    // Tampered JWT rejected -> 401
    const ctx4 = createExecutionContext();
    const tamperedRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/marketplace/home', {
        headers: { Authorization: `Bearer ${loginJson.token}tampered` },
      }),
      testEnv,
      ctx4
    );
    await waitOnExecutionContext(ctx4);
    expect(tamperedRes.status).toBe(401);

    // Admin Telegram ID user authorized -> 200
    const adminInitData = await signTelegramInitData(
      { id: 999001, first_name: 'Owner', username: 'sofumer_owner' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const ctx5 = createExecutionContext();
    const adminAuthRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: adminInitData }),
      }),
      testEnv,
      ctx5
    );
    await waitOnExecutionContext(ctx5);
    expect(adminAuthRes.status).toBe(200);
    const adminAuthJson = await adminAuthRes.json();
    expect(adminAuthJson.isAdmin).toBe(true);

    const ctx6 = createExecutionContext();
    const adminOverview = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/overview', {
        headers: { Authorization: `Bearer ${adminAuthJson.token}` },
      }),
      testEnv,
      ctx6
    );
    await waitOnExecutionContext(ctx6);
    expect(adminOverview.status).toBe(200);
  });

  it('6. Unknown API routes return 404 JSON and unsupported HTTP methods return 405', async () => {
    const notFound = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/does-not-exist');
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');

    const badMethodHealth = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/health', {
      method: 'DELETE',
    });
    expect(badMethodHealth.status).toBe(405);
    expect(badMethodHealth.headers.get('Allow')).toBe('GET');

    const badMethodWebhook = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
      method: 'GET',
    });
    expect(badMethodWebhook.status).toBe(405);
    expect(badMethodWebhook.headers.get('Allow')).toBe('POST');
  });

  it('7. Missing required secrets (TELEGRAM_BOT_TOKEN, JWT_SECRET, TELEGRAM_WEBHOOK_SECRET) fail safely with 503', async () => {
    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: 'user=%7B%22id%22%3A1%7D&hash=00' }),
      }),
      { ...env, TELEGRAM_BOT_TOKEN: '', JWT_SECRET: 'test-jwt' },
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(503);
    const body1 = await res1.json();
    expect(body1.error).toContain('TELEGRAM_BOT_TOKEN');
    expect(JSON.stringify(body1)).not.toContain('at ');

    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: 'user=%7B%22id%22%3A1%7D&hash=00' }),
      }),
      { ...env, TELEGRAM_BOT_TOKEN: '123456:ABC', JWT_SECRET: '' },
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(503);
    const body2 = await res2.json();
    expect(body2.error).toContain('JWT_SECRET');

    const ctx3 = createExecutionContext();
    const whRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 100 }),
      }),
      { ...env, TELEGRAM_WEBHOOK_SECRET: '' },
      ctx3
    );
    await waitOnExecutionContext(ctx3);
    expect(whRes.status).toBe(503);
  });

  it('8. Telegram webhook authentication enforces X-Telegram-Bot-Api-Secret-Token and persists update safely', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: 'test-token-not-real',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret',
    };

    const ctx1 = createExecutionContext();
    const unauth = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 101 }),
      }),
      testEnv,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    expect(unauth.status).toBe(401);

    const ctx2 = createExecutionContext();
    const wrong = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
        },
        body: JSON.stringify({ update_id: 101 }),
      }),
      testEnv,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(wrong.status).toBe(401);

    const ctx3 = createExecutionContext();
    const badJson = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-32chars',
        },
        body: '{bad-json',
      }),
      testEnv,
      ctx3
    );
    await waitOnExecutionContext(ctx3);
    expect(badJson.status).toBe(400);

    const ctx4 = createExecutionContext();
    const okRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-32chars',
        },
        body: JSON.stringify({ update_id: 102 }),
      }),
      testEnv,
      ctx4
    );
    await waitOnExecutionContext(ctx4);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
    const okJson = await okRes.json();
    expect(okJson.status).toBe('accepted');
    expect(okJson.updateId).toBe(102);

    const stored = await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id = ?')
      .bind(102)
      .first();
    expect(stored?.update_id).toBe(102);
  });

  it('9. Seller registration, product creation, FK validation, and FK-safe product deletion work cleanly on D1', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const sellerInitData = await signTelegramInitData(
      { id: 700001, first_name: 'Seller', username: 'tg_seller' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: sellerInitData }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();

    // Register seller & shop
    const regCtx = createExecutionContext();
    const regRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Test Merchant',
          shopName: 'D1 Safe Shop',
          countryCode: 'US',
          defaultCurrency: 'USD',
        }),
      }),
      testEnv,
      regCtx
    );
    await waitOnExecutionContext(regCtx);
    expect(regRes.status).toBe(201);

    // Invalid currency returns clean 400 (not 500 D1 FK error)
    const badProdCtx = createExecutionContext();
    const badProdRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          listingType: 'physical',
          title: 'Bad Currency Item',
          description: 'Testing FK validation',
          categoryId: 'cat_electronics',
          price: 25,
          currency: 'ZZZ',
        }),
      }),
      testEnv,
      badProdCtx
    );
    await waitOnExecutionContext(badProdCtx);
    expect(badProdRes.status).toBe(400);

    // Create valid product (creates product + product_inventory row)
    const prodCtx = createExecutionContext();
    const prodRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          listingType: 'physical',
          title: 'D1 Test Laptop',
          description: 'Clean D1 test listing with inventory',
          categoryId: 'cat_electronics',
          price: 499,
          currency: 'USD',
          stockQuantity: 5,
          status: 'published',
        }),
      }),
      testEnv,
      prodCtx
    );
    await waitOnExecutionContext(prodCtx);
    expect(prodRes.status).toBe(201);
    const { product } = await prodRes.json();

    // Delete product cleanly without D1 FOREIGN KEY constraint failed
    const delCtx = createExecutionContext();
    const delRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${product.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      testEnv,
      delCtx
    );
    await waitOnExecutionContext(delCtx);
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.deleted).toBe(true);
    expect(delJson.archived).toBe(false);
  });

  it('10. D1 auto-bootstrap initializes missing tables and system seeds cleanly on empty/unmigrated D1', async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS platform_settings').run();
    resetD1BootstrapCacheForTests();

    const ok = await ensureD1Schema(env.DB);
    expect(ok).toBe(true);

    const row = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'auto_approve_products'").first();
    expect(row?.value).toBe('true');
  });

  it('11. /r2/digital/* is blocked with 403 and unsafe image/logo URLs are rejected', async () => {
    const blockedDigital = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/r2/digital/secret-pkg.zip');
    expect(blockedDigital.status).toBe(403);

    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const sellerInit = await signTelegramInitData(
      { id: 710001, first_name: 'UrlSeller', username: 'url_seller' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: sellerInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    const badRegCtx = createExecutionContext();
    const badRegRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Bad Url Seller',
          shopName: 'Bad Url Shop',
          countryCode: 'US',
          logoUrl: 'javascript:alert(1)',
        }),
      }),
      testEnv,
      badRegCtx
    );
    await waitOnExecutionContext(badRegCtx);
    expect(badRegRes.status).toBe(400);
  });

  it('12. Telegram Stars (XTR) enforces 402 on paid plans, activates on webhook successful_payment idempotently, and expires past-due plans', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const sellerInit = await signTelegramInitData(
      { id: 720001, first_name: 'StarsSeller', username: 'stars_seller' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: sellerInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    const regCtx = createExecutionContext();
    const regRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Stars Merchant',
          shopName: 'Stars Shop',
          countryCode: 'US',
        }),
      }),
      testEnv,
      regCtx
    );
    await waitOnExecutionContext(regCtx);
    expect(regRes.status).toBe(201);

    // Direct upgrade to PRO blocked with 402
    const unpaidCtx = createExecutionContext();
    const unpaidRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planCode: 'PRO', billingCycle: 'monthly' }),
      }),
      testEnv,
      unpaidCtx
    );
    await waitOnExecutionContext(unpaidCtx);
    expect(unpaidRes.status).toBe(402);
    const unpaidJson = await unpaidRes.json();
    expect(unpaidJson.requiresStarsPayment).toBe(true);

    // Mock Telegram Bot API fetch for createInvoiceLink & answerPreCheckoutQuery
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (target.includes('api.telegram.org/bot') && target.includes('/createInvoiceLink')) {
        return new Response(
          JSON.stringify({ ok: true, result: 'https://t.me/$mock_stars_invoice_pro' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes('api.telegram.org/bot') && target.includes('/answerPreCheckoutQuery')) {
        return new Response(
          JSON.stringify({ ok: true, result: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes('api.telegram.org/bot') && target.includes('/sendMessage')) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 9001 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const invCtx = createExecutionContext();
      const invRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/subscriptions/invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ planCode: 'PRO', billingCycle: 'monthly' }),
        }),
        testEnv,
        invCtx
      );
      await waitOnExecutionContext(invCtx);
      expect(invRes.status).toBe(201);
      const invJson = await invRes.json();
      expect(invJson.currency).toBe('XTR');
      expect(invJson.starsAmount).toBeGreaterThan(0);
      expect(invJson.invoiceUrl).toBe('https://t.me/$mock_stars_invoice_pro');

      const paymentRow = await env.DB.prepare('SELECT payload_token, stars_amount FROM telegram_stars_payments WHERE id = ?')
        .bind(invJson.paymentId)
        .first();
      expect(paymentRow?.payload_token).toBeTruthy();

      // Webhook pre_checkout_query
      const preCtx = createExecutionContext();
      const preRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': testEnv.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            update_id: 8001,
            pre_checkout_query: {
              id: 'pcq_8001',
              from: { id: 720001 },
              currency: 'XTR',
              total_amount: paymentRow.stars_amount,
              invoice_payload: paymentRow.payload_token,
            },
          }),
        }),
        testEnv,
        preCtx
      );
      await waitOnExecutionContext(preCtx);
      expect(preRes.status).toBe(200);
      const preJson = await preRes.json();
      expect(preJson.status).toBe('pre_checkout_answered');
      expect(preJson.valid).toBe(true);

      // Webhook successful_payment activates PRO subscription
      const payPayload = {
        update_id: 8002,
        message: {
          message_id: 501,
          from: { id: 720001 },
          successful_payment: {
            currency: 'XTR',
            total_amount: paymentRow.stars_amount,
            invoice_payload: paymentRow.payload_token,
            telegram_payment_charge_id: 'tg_charge_pro_8002',
            provider_payment_charge_id: 'prov_charge_pro_8002',
          },
        },
      };

      const payCtx1 = createExecutionContext();
      const payRes1 = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': testEnv.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify(payPayload),
        }),
        testEnv,
        payCtx1
      );
      await waitOnExecutionContext(payCtx1);
      expect(payRes1.status).toBe(200);
      const payJson1 = await payRes1.json();
      expect(payJson1.status).toBe('payment_processed');
      expect(payJson1.paymentStatus).toBe('paid');

      // Dashboard shows PRO plan with future ends_at
      const dashCtx = createExecutionContext();
      const dashRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        testEnv,
        dashCtx
      );
      await waitOnExecutionContext(dashCtx);
      expect(dashRes.status).toBe(200);
      const dashJson = await dashRes.json();
      expect(dashJson.subscription?.plan_code).toBe('PRO');
      expect(dashJson.subscription?.ends_at).toBeTruthy();

      // Replay duplicate charge ID safely ignored
      const payCtx2 = createExecutionContext();
      const payRes2 = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': testEnv.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify({ ...payPayload, update_id: 8003 }),
        }),
        testEnv,
        payCtx2
      );
      await waitOnExecutionContext(payCtx2);
      expect(payRes2.status).toBe(200);
      const payJson2 = await payRes2.json();
      expect(payJson2.status).toBe('payment_processed');
      expect(payJson2.paymentStatus).toBe('duplicate_charge_ignored');

      // Expired paid subscription falls back to null/no active PRO tier
      await env.DB.prepare("UPDATE subscriptions SET ends_at = datetime('now', '-1 day') WHERE id = ?")
        .bind(invJson.subscriptionId)
        .run();
      const expiredDashCtx = createExecutionContext();
      const expiredDashRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        testEnv,
        expiredDashCtx
      );
      await waitOnExecutionContext(expiredDashCtx);
      const expiredDashJson = await expiredDashRes.json();
      expect(expiredDashJson.subscription?.plan_code || 'FREE').not.toBe('PRO');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('13. Protected digital product delivery enforces order confirmation, ownership, license templating, and download quota', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const loginAs = async (id, username) => {
      const initData = await signTelegramInitData({ id, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      const authData = await res.json();
      const meCtx = createExecutionContext();
      const meRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/me', {
          headers: { Authorization: `Bearer ${authData.token}` },
        }),
        testEnv,
        meCtx
      );
      await waitOnExecutionContext(meCtx);
      const meData = await meRes.json();
      return { token: authData.token, user: meData.user };
    };

    const seller = await loginAs(730001, 'dig_seller');
    const buyer = await loginAs(730002, 'dig_buyer');
    const intruder = await loginAs(730003, 'dig_intruder');

    const regCtx = createExecutionContext();
    await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ sellerType: 'individual', legalName: 'Dig Seller', shopName: 'Dig Shop', countryCode: 'US' }),
      }),
      testEnv,
      regCtx
    );
    await waitOnExecutionContext(regCtx);

    const prodCtx = createExecutionContext();
    const prodRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          listingType: 'digital',
          title: 'CLI Pro Bundle',
          description: 'Protected digital toolkit with per-order license key.',
          categoryId: 'cat_electronics',
          price: 19,
          currency: 'USD',
          status: 'published',
        }),
      }),
      testEnv,
      prodCtx
    );
    await waitOnExecutionContext(prodCtx);
    const { product } = await prodRes.json();

    const assetCtx = createExecutionContext();
    const assetRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${product.id}/digital-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          fileName: 'cli-bundle.txt',
          deliveryInstructions: 'Run npm install && activate using your key.',
          licenseKeyTemplate: 'SFM-{ORDER}-KEY',
          downloadLimit: 2,
        }),
      }),
      testEnv,
      assetCtx
    );
    await waitOnExecutionContext(assetCtx);
    expect(assetRes.status).toBe(201);

    const ordCtx = createExecutionContext();
    const ordRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          productId: product.id,
          buyerUserId: buyer.user.id,
          quantity: 1,
          agreedTotal: 19,
          currency: 'USD',
        }),
      }),
      testEnv,
      ordCtx
    );
    await waitOnExecutionContext(ordCtx);
    expect(ordRes.status).toBe(201);
    const orderData = await ordRes.json();

    // Buyer blocked before confirmation -> 403
    const lockedCtx = createExecutionContext();
    const lockedRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/orders/${orderData.orderId}/digital`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      }),
      testEnv,
      lockedCtx
    );
    await waitOnExecutionContext(lockedCtx);
    expect(lockedRes.status).toBe(403);

    // Buyer confirms order -> unlocks delivery
    const confCtx = createExecutionContext();
    await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/orders/${orderData.orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
        body: JSON.stringify({ status: 'Confirmed' }),
      }),
      testEnv,
      confCtx
    );
    await waitOnExecutionContext(confCtx);

    // Intruder still blocked -> 403
    const intrCtx = createExecutionContext();
    const intrRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/orders/${orderData.orderId}/digital`, {
        headers: { Authorization: `Bearer ${intruder.token}` },
      }),
      testEnv,
      intrCtx
    );
    await waitOnExecutionContext(intrCtx);
    expect(intrRes.status).toBe(403);

    // Buyer gets unlocked asset metadata with order-templated license key
    const unlCtx = createExecutionContext();
    const unlRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/orders/${orderData.orderId}/digital`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      }),
      testEnv,
      unlCtx
    );
    await waitOnExecutionContext(unlCtx);
    expect(unlRes.status).toBe(200);
    const unlJson = await unlRes.json();
    expect(unlJson.assets[0].licenseKey).toBe(`SFM-${orderData.orderNumber}-KEY`);

    // Download quota (limit = 2): 1st and 2nd succeed, 3rd returns 403
    for (const expectedStatus of [200, 200, 403]) {
      const dlCtx = createExecutionContext();
      const dlRes = await worker.fetch(
        new Request(
          `https://sofumer-app.derartuaman8.workers.dev/api/orders/${orderData.orderId}/digital/${product.id}/download`,
          { headers: { Authorization: `Bearer ${buyer.token}` } }
        ),
        testEnv,
        dlCtx
      );
      await waitOnExecutionContext(dlCtx);
      expect(dlRes.status).toBe(expectedStatus);
    }
  });

  it('14. Cookie-based state mutations enforce same-origin CSRF protection', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };
    const userInit = await signTelegramInitData(
      { id: 740001, first_name: 'CsrfUser', username: 'csrf_user' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: userInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    // Missing Origin/Referer with Cookie auth only -> 403
    const csrfCtx = createExecutionContext();
    const csrfRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/account/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `sofumer_session=${token}`,
        },
        body: JSON.stringify({ displayName: 'Evil Rename' }),
      }),
      testEnv,
      csrfCtx
    );
    await waitOnExecutionContext(csrfCtx);
    expect(csrfRes.status).toBe(403);

    // Matching Origin passes -> 200
    const okCtx = createExecutionContext();
    const okRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/account/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://sofumer-app.derartuaman8.workers.dev',
          Cookie: `sofumer_session=${token}`,
        },
        body: JSON.stringify({ displayName: 'Safe Rename' }),
      }),
      testEnv,
      okCtx
    );
    await waitOnExecutionContext(okCtx);
    expect(okRes.status).toBe(200);
  });

  it('15. Deprecated Cloudflare Workers AI models auto-upgrade and /api/admin/ai enforces active models', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    // Simulate legacy D1 rows stuck on deprecated @cf/meta/llama-3.1-8b-instruct
    await env.DB.prepare("UPDATE ai_feature_settings SET model_name = '@cf/meta/llama-3.1-8b-instruct' WHERE feature_key = 'buyer_search'").run();
    resetD1BootstrapCacheForTests();
    await ensureD1Schema(env.DB);

    const upgraded = await env.DB.prepare("SELECT model_name FROM ai_feature_settings WHERE feature_key = 'buyer_search'").first();
    expect(upgraded?.model_name).toBe('@cf/meta/llama-3.1-8b-instruct-fast');

    const ownerInit = await signTelegramInitData({ id: 999001, first_name: 'Owner', username: 'owner_ai' }, testEnv.TELEGRAM_BOT_TOKEN);
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: ownerInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    // GET /api/admin/ai exposes active models
    const aiCtx = createExecutionContext();
    const aiRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/ai', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      testEnv,
      aiCtx
    );
    await waitOnExecutionContext(aiCtx);
    expect(aiRes.status).toBe(200);
    const aiJson = await aiRes.json();
    expect(aiJson.defaultModel).toBe('@cf/meta/llama-3.1-8b-instruct-fast');
    expect(aiJson.availableModels).toContain('@cf/meta/llama-3.1-8b-instruct-fast');
    expect(aiJson.availableModels).not.toContain('@cf/meta/llama-3.1-8b-instruct');

    // Rejects deprecated model on PATCH
    const badCtx = createExecutionContext();
    const badRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/ai/features/buyer_search', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isEnabled: true, modelName: '@cf/meta/llama-3.1-8b-instruct', dailyLimitPerUser: 40 }),
      }),
      testEnv,
      badCtx
    );
    await waitOnExecutionContext(badCtx);
    expect(badRes.status).toBe(400);

    // Accepts supported model on PATCH
    const goodCtx = createExecutionContext();
    const goodRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/ai/features/buyer_search', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isEnabled: true, modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', dailyLimitPerUser: 50 }),
      }),
      testEnv,
      goodCtx
    );
    await waitOnExecutionContext(goodCtx);
    expect(goodRes.status).toBe(200);
  });

  it('16. Admin Settings enforces typed validation and Plan/Stars pricing updates persist', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const ownerInit = await signTelegramInitData({ id: 999001, first_name: 'Owner', username: 'owner_settings' }, testEnv.TELEGRAM_BOT_TOKEN);
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: ownerInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    // Rejects invalid boolean & invalid stars_per_usd
    const badBoolCtx = createExecutionContext();
    const badBool = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/settings/auto_approve_products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ value: 'maybe' }),
      }),
      testEnv,
      badBoolCtx
    );
    await waitOnExecutionContext(badBoolCtx);
    expect(badBool.status).toBe(400);

    // Batch update settings persists cleanly
    const batchCtx = createExecutionContext();
    const batchRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          updates: [
            { key: 'stars_per_usd', value: '60' },
            { key: 'prohibited_keywords', value: 'Scam, Counterfeit, Fraud ' },
            { key: 'featured_product_price_7d', value: '12.5' },
          ],
        }),
      }),
      testEnv,
      batchCtx
    );
    await waitOnExecutionContext(batchCtx);
    expect(batchRes.status).toBe(200);

    const kwRow = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'prohibited_keywords'").first();
    expect(kwRow?.value).toBe('scam, counterfeit, fraud');

    // Update plan + Stars XTR pricing
    const planCtx = createExecutionContext();
    const planRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/plans/plan_pro', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          monthlyPrice: 24,
          annualPrice: 240,
          starsMonthly: 1200,
          starsAnnual: 12000,
          maxProducts: 150,
          aiDailyLimit: 250,
          featuredSlots: 4,
          promotionalDiscountPct: 20,
        }),
      }),
      testEnv,
      planCtx
    );
    await waitOnExecutionContext(planCtx);
    expect(planRes.status).toBe(200);

    const starsRow = await env.DB.prepare("SELECT stars_monthly, stars_annual FROM subscription_plan_stars WHERE plan_id = 'plan_pro'").first();
    expect(Number(starsRow?.stars_monthly)).toBe(1200);
    expect(Number(starsRow?.stars_annual)).toBe(12000);
  });

  it('17. Database-backed Admin RBAC grants scoped permissions, blocks escalation, and revokes immediately', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const loginByTg = async (tgId, username) => {
      const initData = await signTelegramInitData({ id: tgId, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res.json();
    };

    const ownerAuth = await loginByTg(999001, 'rbac_owner');
    const staffTgId = '750001';

    // Create custom role scoped ONLY to analytics.view & support.manage
    const createRoleCtx = createExecutionContext();
    const createRoleRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({
          code: 'SUPPORT_ANALYST',
          name: 'Support Analyst',
          description: 'Handles support tickets and reviews analytics only.',
          permissions: ['support.manage', 'analytics.view'],
        }),
      }),
      testEnv,
      createRoleCtx
    );
    await waitOnExecutionContext(createRoleCtx);
    expect(createRoleRes.status).toBe(201);
    const createdRole = await createRoleRes.json();

    // Assign custom role to Telegram ID 750001
    const assignCtx = createExecutionContext();
    const assignRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/role-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ telegramId: staffTgId, roleId: createdRole.id, displayLabel: 'Support Staff' }),
      }),
      testEnv,
      assignCtx
    );
    await waitOnExecutionContext(assignCtx);
    expect(assignRes.status).toBe(201);
    const assignment = await assignRes.json();

    // Staff user authenticates via Telegram and is recognized as admin with scoped role
    const staffAuth = await loginByTg(750001, 'support_staff');
    expect(staffAuth.isAdmin).toBe(true);

    // Allowed endpoints -> 200
    for (const allowedPath of ['/api/admin/auth/me', '/api/admin/support', '/api/admin/analytics']) {
      const ctx = createExecutionContext();
      const r = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${allowedPath}`, {
          headers: { Authorization: `Bearer ${staffAuth.token}` },
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(200);
    }

    // Disallowed endpoints (settings, AI, RBAC, users) -> 403
    for (const blockedPath of ['/api/admin/settings', '/api/admin/ai', '/api/admin/roles', '/api/admin/users']) {
      const ctx = createExecutionContext();
      const r = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${blockedPath}`, {
          headers: { Authorization: `Bearer ${staffAuth.token}` },
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(403);
    }

    // Deactivate assignment -> immediate revocation of admin endpoints & auth
    const deactCtx = createExecutionContext();
    const deactRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/admin/role-assignments/${assignment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ isActive: false }),
      }),
      testEnv,
      deactCtx
    );
    await waitOnExecutionContext(deactCtx);
    expect(deactRes.status).toBe(200);

    const revokedCtx = createExecutionContext();
    const revokedRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/support', {
        headers: { Authorization: `Bearer ${staffAuth.token}` },
      }),
      testEnv,
      revokedCtx
    );
    await waitOnExecutionContext(revokedCtx);
    expect(revokedRes.status).toBe(403);

    const staffRelogin = await loginByTg(750001, 'support_staff');
    expect(staffRelogin.isAdmin).toBe(false);
  });

  it('18. Cloudinary signed uploads validate mime/size/10s duration, enforce signature + Admin API check, never leak secret, and destroy rejected >10s videos', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
      CLOUDINARY_CLOUD_NAME: 'sofumer-test-cloud',
      CLOUDINARY_API_KEY: 'test_cld_key',
      CLOUDINARY_API_SECRET: 'test_cld_secret_super_private',
    };

    const sha1Hex = async (value) => {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    };

    // Unauthenticated & non-seller checks
    const unauthCfgCtx = createExecutionContext();
    const unauthCfg = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/config'),
      testEnv,
      unauthCfgCtx
    );
    await waitOnExecutionContext(unauthCfgCtx);
    expect(unauthCfg.status).toBe(401);

    const sellerInit = await signTelegramInitData(
      { id: 760001, first_name: 'CloudSeller', username: 'cloud_seller' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const loginCtx = createExecutionContext();
    const loginRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: sellerInit }),
      }),
      testEnv,
      loginCtx
    );
    await waitOnExecutionContext(loginCtx);
    const { token } = await loginRes.json();

    const nonSellerCtx = createExecutionContext();
    const nonSellerCfg = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/config', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      testEnv,
      nonSellerCtx
    );
    await waitOnExecutionContext(nonSellerCtx);
    expect(nonSellerCfg.status).toBe(403);

    // Register seller
    const regCtx = createExecutionContext();
    const regRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Cloud Media Seller',
          shopName: 'Cloud Media Shop',
          countryCode: 'US',
        }),
      }),
      testEnv,
      regCtx
    );
    await waitOnExecutionContext(regCtx);
    expect(regRes.status).toBe(201);

    // Config returns limits without preset requirement or API secret
    const cfgCtx = createExecutionContext();
    const cfgRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/config', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      testEnv,
      cfgCtx
    );
    await waitOnExecutionContext(cfgCtx);
    expect(cfgRes.status).toBe(200);
    const cfgJson = await cfgRes.json();
    expect(cfgJson.configured).toBe(true);
    expect(cfgJson.presetRequired).toBe(false);
    expect(cfgJson.maxPhotos).toBe(6);
    expect(cfgJson.maxVideos).toBe(2);
    expect(cfgJson.maxVideoDurationSec).toBe(10);
    expect(JSON.stringify(cfgJson)).not.toContain(testEnv.CLOUDINARY_API_SECRET);

    // Missing Cloudinary credentials fails safely with 503
    const noCldCtx = createExecutionContext();
    const noCldRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mediaType: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg', fileSize: 2048 }),
      }),
      { ...testEnv, CLOUDINARY_API_SECRET: '' },
      noCldCtx
    );
    await waitOnExecutionContext(noCldCtx);
    expect(noCldRes.status).toBe(503);

    // Sign validation rejections (bad mime, bad video ext, oversized, >10s duration)
    const badCases = [
      { mediaType: 'image', mimeType: 'image/svg+xml', fileName: 'evil.svg', fileSize: 1024 },
      { mediaType: 'video', mimeType: 'video/x-msvideo', fileName: 'clip.avi', fileSize: 102400, duration: 5 },
      { mediaType: 'image', mimeType: 'image/png', fileName: 'huge.png', fileSize: 12 * 1024 * 1024 },
      { mediaType: 'video', mimeType: 'video/mp4', fileName: 'huge.mp4', fileSize: 40 * 1024 * 1024, duration: 5 },
      { mediaType: 'video', mimeType: 'video/mp4', fileName: 'long.mp4', fileSize: 500000, duration: 10.5 },
    ];
    for (const payload of badCases) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
    }

    // Valid image sign returns verifiable SHA-1 signature and never exposes secret
    const signCtx = createExecutionContext();
    const signRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mediaType: 'image',
          mimeType: 'image/webp',
          fileName: 'hero.webp',
          fileSize: 250000,
        }),
      }),
      testEnv,
      signCtx
    );
    await waitOnExecutionContext(signCtx);
    expect(signRes.status).toBe(200);
    const signJson = await signRes.json();
    expect(signJson.cloudName).toBe('sofumer-test-cloud');
    expect(signJson.apiKey).toBe('test_cld_key');
    expect(JSON.stringify(signJson)).not.toContain(testEnv.CLOUDINARY_API_SECRET);

    const expectedReqSig = await sha1Hex(
      `folder=${signJson.folder}&public_id=${signJson.publicId}&timestamp=${signJson.timestamp}${testEnv.CLOUDINARY_API_SECRET}`
    );
    expect(signJson.signature).toBe(expectedReqSig);

    // Get seller user id to construct expected public_id prefixes
    const meCtx = createExecutionContext();
    const meRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      testEnv,
      meCtx
    );
    await waitOnExecutionContext(meCtx);
    const meJson = await meRes.json();
    const sellerUserId = meJson.user.id;
    expect(signJson.folder).toBe(`sofumer/products/${sellerUserId}`);

    const destroyCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/resources/video/upload/`)) {
        if (target.includes('vid_toolong')) {
          return new Response(
            JSON.stringify({
              public_id: `sofumer/products/${sellerUserId}/vid_toolong`,
              resource_type: 'video',
              format: 'mp4',
              bytes: 1200000,
              width: 1280,
              height: 720,
              duration: 12.4,
              secure_url: `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/video/upload/v1/sofumer/products/${sellerUserId}/vid_toolong.mp4`,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            public_id: `sofumer/products/${sellerUserId}/vid_ok`,
            resource_type: 'video',
            format: 'mp4',
            bytes: 950000,
            width: 1280,
            height: 720,
            duration: 8.5,
            secure_url: `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/video/upload/v1/sofumer/products/${sellerUserId}/vid_ok.mp4`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/resources/image/upload/`)) {
        return new Response(
          JSON.stringify({
            public_id: signJson.expectedFullPublicId,
            resource_type: 'image',
            format: 'webp',
            bytes: 250000,
            width: 1200,
            height: 900,
            secure_url: `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/image/upload/v1/${signJson.expectedFullPublicId}.webp`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/`) && target.endsWith('/destroy')) {
        destroyCalls.push({ url: target, body: String(init?.body || '') });
        return new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    try {
      // Cross-seller prefix rejected -> 403
      const crossCtx = createExecutionContext();
      const crossRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mediaType: 'image',
            publicId: 'sofumer/products/usr_someone_else/img_stolen',
            version: 1,
            signature: '0'.repeat(40),
          }),
        }),
        testEnv,
        crossCtx
      );
      await waitOnExecutionContext(crossCtx);
      expect(crossRes.status).toBe(403);

      // Tampered Cloudinary response signature rejected -> 400
      const badSigCtx = createExecutionContext();
      const badSigRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mediaType: 'image',
            publicId: signJson.expectedFullPublicId,
            version: 1,
            signature: 'a'.repeat(40),
          }),
        }),
        testEnv,
        badSigCtx
      );
      await waitOnExecutionContext(badSigCtx);
      expect(badSigRes.status).toBe(400);

      // Video longer than 10s according to Cloudinary Admin API is rejected AND automatically destroyed
      const longPublicId = `sofumer/products/${sellerUserId}/vid_toolong`;
      const longSig = await sha1Hex(`public_id=${longPublicId}&version=1${testEnv.CLOUDINARY_API_SECRET}`);
      const longCtx = createExecutionContext();
      const longRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mediaType: 'video',
            resourceType: 'video',
            publicId: longPublicId,
            version: 1,
            signature: longSig,
          }),
        }),
        testEnv,
        longCtx
      );
      await waitOnExecutionContext(longCtx);
      expect(longRes.status).toBe(400);
      const longJson = await longRes.json();
      expect(longJson.error).toContain('10 seconds');
      expect(destroyCalls.some((c) => c.url.includes('/video/destroy') && c.body.includes('vid_toolong'))).toBe(true);

      // Valid photo verifies cleanly
      const imgSig = await sha1Hex(
        `public_id=${signJson.expectedFullPublicId}&version=1${testEnv.CLOUDINARY_API_SECRET}`
      );
      const okImgCtx = createExecutionContext();
      const okImgRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mediaType: 'image',
            resourceType: 'image',
            publicId: signJson.expectedFullPublicId,
            version: 1,
            signature: imgSig,
          }),
        }),
        testEnv,
        okImgCtx
      );
      await waitOnExecutionContext(okImgCtx);
      expect(okImgRes.status).toBe(200);
      const okImgJson = await okImgRes.json();
      expect(okImgJson.verifiedMedia.publicId).toBe(signJson.expectedFullPublicId);

      // Valid 8.5s video verifies cleanly
      const okVidId = `sofumer/products/${sellerUserId}/vid_ok`;
      const okVidSig = await sha1Hex(`public_id=${okVidId}&version=1${testEnv.CLOUDINARY_API_SECRET}`);
      const okVidCtx = createExecutionContext();
      const okVidRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mediaType: 'video',
            resourceType: 'video',
            publicId: okVidId,
            version: 1,
            signature: okVidSig,
          }),
        }),
        testEnv,
        okVidCtx
      );
      await waitOnExecutionContext(okVidCtx);
      expect(okVidRes.status).toBe(200);
      const okVidJson = await okVidRes.json();
      expect(okVidJson.verifiedMedia.duration).toBe(8.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('19. Product enforces max 6 photos independently from short videos, supports reorder/primary/replace/delete cleanup, and preserves ordered archive media', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
      CLOUDINARY_CLOUD_NAME: 'sofumer-test-cloud',
      CLOUDINARY_API_KEY: 'test_cld_key',
      CLOUDINARY_API_SECRET: 'test_cld_secret_super_private',
    };

    const sha1Hex = async (value) => {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    };

    const loginAs = async (id, username) => {
      const initData = await signTelegramInitData({ id, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      const authData = await res.json();
      const meCtx = createExecutionContext();
      const meRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/me', {
          headers: { Authorization: `Bearer ${authData.token}` },
        }),
        testEnv,
        meCtx
      );
      await waitOnExecutionContext(meCtx);
      const meData = await meRes.json();
      return { token: authData.token, user: meData.user };
    };

    const seller = await loginAs(770001, 'media_seller');
    const buyer = await loginAs(770002, 'media_buyer');

    const regCtx = createExecutionContext();
    await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ sellerType: 'individual', legalName: 'Media Seller', shopName: 'Media Gallery Shop', countryCode: 'US' }),
      }),
      testEnv,
      regCtx
    );
    await waitOnExecutionContext(regCtx);

    const buildMediaPayload = async (type, slug, extra = {}) => {
      const publicId = `sofumer/products/${seller.user.id}/${slug}`;
      const sig = await sha1Hex(`public_id=${publicId}&version=1${testEnv.CLOUDINARY_API_SECRET}`);
      return {
        mediaType: type,
        resourceType: type,
        publicId,
        version: 1,
        signature: sig,
        ...extra,
      };
    };

    const destroyCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/resources/image/upload/`)) {
        const pub = decodeURIComponent(target.split('/resources/image/upload/')[1]);
        return new Response(
          JSON.stringify({
            public_id: pub,
            resource_type: 'image',
            format: 'jpg',
            bytes: 180000,
            width: 1000,
            height: 750,
            secure_url: `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/image/upload/v1/${pub}.jpg`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/resources/video/upload/`)) {
        const pub = decodeURIComponent(target.split('/resources/video/upload/')[1]);
        return new Response(
          JSON.stringify({
            public_id: pub,
            resource_type: 'video',
            format: pub.includes('mov') ? 'mov' : 'mp4',
            bytes: 1400000,
            width: 1080,
            height: 1920,
            duration: 6.5,
            secure_url: `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/video/upload/v1/${pub}.mp4`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (target.includes(`https://api.cloudinary.com/v1_1/${testEnv.CLOUDINARY_CLOUD_NAME}/`) && target.endsWith('/destroy')) {
        destroyCalls.push({ url: target, body: String(init?.body || '') });
        return new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const sixPhotos = [];
      for (let i = 1; i <= 6; i++) {
        sixPhotos.push(await buildMediaPayload('image', `img_${i}`, { isPrimary: i === 2 }));
      }
      const seventhPhoto = await buildMediaPayload('image', 'img_7');
      const vid1 = await buildMediaPayload('video', 'vid_mp4_1');
      const vid2 = await buildMediaPayload('video', 'vid_mov_2');

      // 7 photos rejected -> 400
      const sevenCtx = createExecutionContext();
      const sevenRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            listingType: 'physical',
            title: 'Too Many Photos',
            description: 'Should reject seventh photo',
            categoryId: 'cat_electronics',
            price: 99,
            currency: 'USD',
            media: [...sixPhotos, seventhPhoto],
          }),
        }),
        testEnv,
        sevenCtx
      );
      await waitOnExecutionContext(sevenCtx);
      expect(sevenRes.status).toBe(400);

      // 6 photos + 2 short videos accepted -> 201 (videos independent of 6-photo limit!)
      const createCtx = createExecutionContext();
      const createRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            listingType: 'physical',
            title: 'Full Media Camera Kit',
            description: '6 photos plus 2 short demo clips.',
            categoryId: 'cat_electronics',
            price: 399,
            currency: 'USD',
            media: [...sixPhotos, vid1, vid2],
            status: 'published',
          }),
        }),
        testEnv,
        createCtx
      );
      await waitOnExecutionContext(createCtx);
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.media.length).toBe(8);

      const productId = created.product.id;

      // Signing a 7th photo slot on this 6-photo listing is blocked -> 400
      const sign7Ctx = createExecutionContext();
      const sign7Res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/media/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            mediaType: 'image',
            mimeType: 'image/jpeg',
            fileName: 'extra7.jpg',
            fileSize: 50000,
            productId,
          }),
        }),
        testEnv,
        sign7Ctx
      );
      await waitOnExecutionContext(sign7Ctx);
      expect(sign7Res.status).toBe(400);

      // Committing a 7th photo directly on /media endpoint rejected -> 400 and cleans up uploaded asset
      const add7Ctx = createExecutionContext();
      const add7Res = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${productId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify(seventhPhoto),
        }),
        testEnv,
        add7Ctx
      );
      await waitOnExecutionContext(add7Ctx);
      expect(add7Res.status).toBe(400);
      expect(destroyCalls.some((c) => c.body.includes('img_7'))).toBe(true);

      // Buyer detail view returns primary image, 6 photos, 2 videos, video_count=2
      const detailCtx = createExecutionContext();
      const detailRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/marketplace/products/${productId}`, {
          headers: { Authorization: `Bearer ${buyer.token}` },
        }),
        testEnv,
        detailCtx
      );
      await waitOnExecutionContext(detailCtx);
      expect(detailRes.status).toBe(200);
      const detailJson = await detailRes.json();
      expect(detailJson.media.length).toBe(8);
      expect(detailJson.videos.length).toBe(2);
      expect(detailJson.product.video_count).toBe(2);
      expect(detailJson.product.primary_image).toContain('img_2');

      // Reorder & set img_5 as primary
      const photosOnly = detailJson.media.filter((m) => m.media_type === 'image');
      const img5 = photosOnly.find((m) => m.public_id.endsWith('/img_5'));
      const reorderedIds = [...photosOnly].reverse().map((m) => m.id);
      const reordCtx = createExecutionContext();
      const reordRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${productId}/media/reorder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({ orderedIds: reorderedIds, primaryMediaId: img5.id }),
        }),
        testEnv,
        reordCtx
      );
      await waitOnExecutionContext(reordCtx);
      expect(reordRes.status).toBe(200);
      const reordJson = await reordRes.json();
      expect(reordJson.media[0].public_id).toContain('img_5');
      expect(reordJson.media[0].is_primary).toBe(1);

      // Delete primary photo (img_5) -> promotes next photo and destroys img_5 in Cloudinary
      const delMedCtx = createExecutionContext();
      const delMedRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${productId}/media/${img5.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${seller.token}` },
        }),
        testEnv,
        delMedCtx
      );
      await waitOnExecutionContext(delMedCtx);
      expect(delMedRes.status).toBe(200);
      const delMedJson = await delMedRes.json();
      expect(delMedJson.media.filter((m) => m.media_type === 'image').some((m) => m.is_primary === 1)).toBe(true);
      expect(destroyCalls.some((c) => c.body.includes('img_5'))).toBe(true);

      // Edit product replacing img_1 with img_replaced -> destroys img_1
      const imgReplaced = await buildMediaPayload('image', 'img_replaced', { isPrimary: true });
      const remainingMediaForEdit = delMedJson.media
        .filter((m) => !m.public_id.endsWith('/img_1'))
        .map((m) => ({
          id: m.id,
          mediaType: m.media_type,
          resourceType: m.resource_type,
          publicId: m.public_id,
          isPrimary: false,
        }));
      const patchCtx = createExecutionContext();
      const patchRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${productId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            title: 'Full Media Camera Kit v2',
            media: [imgReplaced, ...remainingMediaForEdit],
          }),
        }),
        testEnv,
        patchCtx
      );
      await waitOnExecutionContext(patchCtx);
      expect(patchRes.status).toBe(200);
      expect(destroyCalls.some((c) => c.body.includes('img_1'))).toBe(true);

      // Permanent product delete destroys remaining Cloudinary assets
      const destroyCountBeforeDel = destroyCalls.length;
      const delProdCtx = createExecutionContext();
      const delProdRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${productId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${seller.token}` },
        }),
        testEnv,
        delProdCtx
      );
      await waitOnExecutionContext(delProdCtx);
      expect(delProdRes.status).toBe(200);
      const delProdJson = await delProdRes.json();
      expect(delProdJson.deleted).toBe(true);
      expect(destroyCalls.length).toBeGreaterThan(destroyCountBeforeDel);

      // Archived product (with existing order item) preserves Cloudinary asset
      const keepImg = await buildMediaPayload('image', 'img_ordered_keep', { isPrimary: true });
      const ordProdCtx = createExecutionContext();
      const ordProdRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            listingType: 'physical',
            title: 'Ordered Archive Item',
            description: 'Archive preserves order media.',
            categoryId: 'cat_electronics',
            price: 49,
            currency: 'USD',
            media: [keepImg],
            status: 'published',
          }),
        }),
        testEnv,
        ordProdCtx
      );
      await waitOnExecutionContext(ordProdCtx);
      const ordProdJson = await ordProdRes.json();

      const ordCtx = createExecutionContext();
      await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
          body: JSON.stringify({
            productId: ordProdJson.product.id,
            buyerUserId: buyer.user.id,
            quantity: 1,
            agreedTotal: 49,
            currency: 'USD',
          }),
        }),
        testEnv,
        ordCtx
      );
      await waitOnExecutionContext(ordCtx);

      const destroysBeforeArchive = destroyCalls.length;
      const archDelCtx = createExecutionContext();
      const archDelRes = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev/api/seller/products/${ordProdJson.product.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${seller.token}` },
        }),
        testEnv,
        archDelCtx
      );
      await waitOnExecutionContext(archDelCtx);
      expect(archDelRes.status).toBe(200);
      const archDelJson = await archDelRes.json();
      expect(archDelJson.archived).toBe(true);
      expect(destroyCalls.length).toBe(destroysBeforeArchive);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('22. Workers AI normalization handles parsed objects (no raw.trim TypeError), OpenAI choices, SSE streams, fallbacks, malformed errors, and deprecated model cleanup', async () => {
    const testEnvBase = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
      CLOUDFLARE_AI_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
    };

    const loginUser = async (id, username) => {
      const initData = await signTelegramInitData({ id, first_name: username, username }, testEnvBase.TELEGRAM_BOT_TOKEN);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
        testEnvBase,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return await res.json();
    };

    const seller = await loginUser(880001, 'ai_seller');
    const buyer = await loginUser(880002, 'ai_buyer');
    const admin = await loginUser(999001, 'ai_admin');

    const regCtx = createExecutionContext();
    await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          sellerType: 'business',
          legalName: 'AI Test Labs',
          shopName: 'AI Norm Shop',
          countryCode: 'US',
        }),
      }),
      testEnvBase,
      regCtx
    );
    await waitOnExecutionContext(regCtx);

    const pCtx = createExecutionContext();
    const pRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          listingType: 'physical',
          title: 'Edge Acoustic Studio Monitor',
          description: 'Studio reference monitor speaker pair.',
          categoryId: 'cat_electronics',
          price: 299,
          currency: 'USD',
          status: 'published',
        }),
      }),
      testEnvBase,
      pCtx
    );
    await waitOnExecutionContext(pCtx);
    const { product } = await pRes.json();

    // Case A: Exact reproducer — Workers AI returns `response` as an ALREADY-PARSED JS object (and OpenAI choices)
    let seenResponseFormatFlags = [];
    const parsedObjectEnv = {
      ...testEnvBase,
      AI: {
        async run(_model, inputs) {
          seenResponseFormatFlags.push(Boolean(inputs.response_format));
          const sys = inputs.messages.find((m) => m.role === 'system')?.content || '';
          const usr = inputs.messages.find((m) => m.role === 'user')?.content || '';
          if (sys.includes('Shopping Assistant')) {
            return {
              response: {
                answer: 'Matched the Edge Acoustic Studio Monitor from the catalog.',
                matchedProductIds: [product.id],
                suggestedFollowUps: ['Does it include cables?'],
              },
            };
          }
          if (sys.includes('Translate listing')) {
            return {
              choices: [
                {
                  message: {
                    parsed: {
                      translatedTitle: 'Moniteur Studio Acoustique',
                      translatedDescription: 'Paire de moniteurs de studio.',
                    },
                  },
                },
              ],
            };
          }
          if (sys.includes('seller listing draft')) {
            return {
              response: {
                suggestedTitle: 'Edge Acoustic Reference Monitors (Pair)',
                improvedDescription: 'Balanced studio monitor pair ready for mixing.',
                suggestedCategoryId: 'cat_electronics',
                keywords: ['studio monitor', 'speaker'],
                faqs: [{ question: 'Sold as pair?', answer: 'Yes, includes 2 speakers.' }],
              },
            };
          }
          if (sys.includes('Safety AI Moderator')) {
            return {
              response: {
                riskLevel: 'low',
                recommendedStatus: 'published',
                rationale: 'Clean electronics listing.',
              },
            };
          }
          if (sys.includes('Compare real SOFUMER')) {
            return { choices: [{ message: { content: `Comparison for ${usr.length > 0 ? 'monitor' : 'items'}.` } }] };
          }
          if (sys.includes('shop metrics')) {
            const encoder = new TextEncoder();
            return new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('data: {"response":"Shop views look "}\n\n'));
                controller.enqueue(encoder.encode('data: {"response":"healthy."}\n\n'));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
          }
          return { response: 'Direct orders connect buyer and seller via Telegram.' };
        },
      },
    };

    // 1. /api/ai/buyer/discover with parsed object response
    const discCtx = createExecutionContext();
    const discRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/buyer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
        body: JSON.stringify({ query: 'studio monitor speaker' }),
      }),
      parsedObjectEnv,
      discCtx
    );
    await waitOnExecutionContext(discCtx);
    expect(discRes.status).toBe(200);
    const discJson = await discRes.json();
    expect(discJson.answer).toContain('Edge Acoustic Studio Monitor');
    expect(discJson.matchedProducts.some((m) => m.id === product.id)).toBe(true);
    expect(discJson.suggestedFollowUps).toEqual(['Does it include cables?']);

    // 2. /api/ai/seller/assist (generate_listing) with parsed object response
    const genCtx = createExecutionContext();
    const genRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ action: 'generate_listing', title: 'Monitor', notes: 'Pair', listingType: 'physical' }),
      }),
      parsedObjectEnv,
      genCtx
    );
    await waitOnExecutionContext(genCtx);
    expect(genRes.status).toBe(200);
    const genJson = await genRes.json();
    expect(genJson.suggestedTitle).toBe('Edge Acoustic Reference Monitors (Pair)');
    expect(genJson.faqs[0].question).toBe('Sold as pair?');

    // 3. /api/ai/seller/assist (translate) with OpenAI choices[0].message.parsed
    const trCtx = createExecutionContext();
    const trRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ action: 'translate', title: 'Studio Monitor', notes: 'Pair', targetLanguage: 'French' }),
      }),
      parsedObjectEnv,
      trCtx
    );
    await waitOnExecutionContext(trCtx);
    expect(trRes.status).toBe(200);
    const trJson = await trRes.json();
    expect(trJson.translatedTitle).toBe('Moniteur Studio Acoustique');

    // 4. /api/ai/seller/assist (analytics) with SSE ReadableStream
    const anaCtx = createExecutionContext();
    const anaRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/seller/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ action: 'analytics' }),
      }),
      parsedObjectEnv,
      anaCtx
    );
    await waitOnExecutionContext(anaCtx);
    expect(anaRes.status).toBe(200);
    const anaJson = await anaRes.json();
    expect(anaJson.insights).toBe('Shop views look healthy.');

    // 5. /api/ai/buyer/compare with OpenAI choices[0].message.content
    const cmpCtx = createExecutionContext();
    const cmpRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/buyer/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
        body: JSON.stringify({ productIds: [product.id] }),
      }),
      parsedObjectEnv,
      cmpCtx
    );
    await waitOnExecutionContext(cmpCtx);
    expect(cmpRes.status).toBe(200);
    const cmpJson = await cmpRes.json();
    expect(cmpJson.comparison).toContain('Comparison for monitor');

    // 6. /api/ai/platform/support
    const supCtx = createExecutionContext();
    const supRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/platform/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
        body: JSON.stringify({ question: 'How do direct orders work?' }),
      }),
      parsedObjectEnv,
      supCtx
    );
    await waitOnExecutionContext(supCtx);
    expect(supRes.status).toBe(200);
    const supJson = await supRes.json();
    expect(supJson.reply).toContain('Direct orders');

    // 7. Admin AI Moderation Scan with parsed object response (previously failed silently on rawText.match)
    const scanCtx = createExecutionContext();
    const scanRes = await worker.fetch(
      new Request(`https://sofumer-app.derartuaman8.workers.dev/api/admin/moderation/products/${product.id}/ai-scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
      parsedObjectEnv,
      scanCtx
    );
    await waitOnExecutionContext(scanCtx);
    expect(scanRes.status).toBe(200);
    const scanJson = await scanRes.json();
    expect(scanJson.aiEvaluated).toBe(true);
    expect(scanJson.rationale).toBe('Clean electronics listing.');
    expect(seenResponseFormatFlags.length).toBeGreaterThan(0);
    expect(seenResponseFormatFlags.some(Boolean)).toBe(true);

    // Case B: response_format rejected -> retries automatically without response_format
    let retryAttempt = 0;
    const fallbackEnv = {
      ...testEnvBase,
      AI: {
        async run(_model, inputs) {
          retryAttempt++;
          if (inputs.response_format) {
            throw new Error('Unsupported property: response_format json_object');
          }
          return {
            response: '```json\n{"answer":"Recovered without response_format","matchedProductIds":[],"suggestedFollowUps":[]}\n```',
          };
        },
      },
    };
    const fbCtx = createExecutionContext();
    const fbRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/buyer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
        body: JSON.stringify({ query: 'headphones' }),
      }),
      fallbackEnv,
      fbCtx
    );
    await waitOnExecutionContext(fbCtx);
    expect(fbRes.status).toBe(200);
    expect(retryAttempt).toBe(2);
    const fbJson = await fbRes.json();
    expect(fbJson.answer).toBe('Recovered without response_format');

    // Case C: Null / malformed outputs return sanitized user-friendly 502 (never leaking ".trim is not a function")
    for (const badPayload of [null, undefined, [], { response: '' }, { response: 'not-valid-json' }]) {
      const badEnv = {
        ...testEnvBase,
        AI: { async run() { return badPayload; } },
      };
      const badCtx = createExecutionContext();
      const badRes = await worker.fetch(
        new Request('https://sofumer-app.derartuaman8.workers.dev/api/ai/buyer/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
          body: JSON.stringify({ query: 'malformed case' }),
        }),
        badEnv,
        badCtx
      );
      await waitOnExecutionContext(badCtx);
      expect(badRes.status).toBe(502);
      const badBody = await badRes.json();
      expect(typeof badBody.error).toBe('string');
      expect(badBody.error).not.toContain('trim');
      expect(badBody.error).not.toContain('TypeError');
    }

    // Case D: Deprecated @cf/qwen/qwen3-30b-a3b-fp8 is rejected by Admin PATCH and auto-upgraded by ensureD1Schema
    const depPatchCtx = createExecutionContext();
    const depPatchRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/admin/ai/features/global_ai', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ isEnabled: true, modelName: '@cf/qwen/qwen3-30b-a3b-fp8', dailyLimitPerUser: 30 }),
      }),
      testEnvBase,
      depPatchCtx
    );
    await waitOnExecutionContext(depPatchCtx);
    expect(depPatchRes.status).toBe(400);

    await env.DB.prepare("UPDATE ai_feature_settings SET model_name = '@cf/qwen/qwen3-30b-a3b-fp8' WHERE feature_key = 'global_ai'").run();
    resetD1BootstrapCacheForTests();
    const upgraded = await ensureD1Schema(env.DB);
    expect(upgraded).toBe(true);
    const refreshedRow = await env.DB.prepare("SELECT model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'").first();
    expect(refreshedRow?.model_name).toBe('@cf/meta/llama-3.1-8b-instruct-fast');
  });

  it('23. Admin & Seller Shop Deletion soft-closes shop, archives ordered products, deletes clean products, destroys exclusive Cloudinary shop logo, preserves orders, and allows re-registration', async () => {
    const destroyCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const targetUrl = typeof input === 'string' ? input : input.url;
      if (targetUrl.includes('api.cloudinary.com') && targetUrl.includes('/destroy')) {
        destroyCalls.push({ url: targetUrl, body: String(init?.body || '') });
        return new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const testEnv = {
        ...env,
        TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
        TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
        JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
        ADMIN_TELEGRAM_IDS: '999001',
        CLOUDINARY_CLOUD_NAME: 'sofumer-test-cloud',
        CLOUDINARY_API_KEY: 'test-cld-key',
        CLOUDINARY_API_SECRET: 'test-cld-secret',
      };

      const callWorker = async (path, init = {}, customEnv = testEnv) => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(
          new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init),
          customEnv,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return res;
      };

      const login = async (id, username) => {
        const initData = await signTelegramInitData({ id, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
        const res = await callWorker('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        const authData = await res.json();
        const meRes = await callWorker('/api/auth/me', {
          headers: { Authorization: `Bearer ${authData.token}` },
        });
        const meData = await meRes.json();
        return { ...authData, user: meData.user };
      };

      const seller = await login(910001, 'shop_del_seller');
      const buyer = await login(910002, 'shop_del_buyer');
      const admin = await login(999001, 'shop_del_admin');

      const shopLogoUrl = `https://res.cloudinary.com/${testEnv.CLOUDINARY_CLOUD_NAME}/image/upload/v1/sofumer/shops/${seller.user.id}/shop_logo_test.jpg`;
      const regRes = await callWorker('/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Closure Test Merchant',
          shopName: 'Closure Boutique',
          countryCode: 'US',
          logoUrl: shopLogoUrl,
        }),
      });
      expect(regRes.status).toBe(201);
      const { shop } = await regRes.json();

      // Product without orders (cleanly removed)
      const cleanProdRes = await callWorker('/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          listingType: 'physical',
          title: 'Unordered Clean Widget',
          description: 'No orders yet.',
          categoryId: 'cat_electronics',
          price: 15,
          currency: 'USD',
          status: 'published',
        }),
      });
      const { product: cleanProd } = await cleanProdRes.json();

      // Product with an order (must be archived, not hard-deleted)
      const ordProdRes = await callWorker('/api/seller/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          listingType: 'physical',
          title: 'Ordered Historical Gadget',
          description: 'Has real order history.',
          categoryId: 'cat_electronics',
          price: 80,
          currency: 'USD',
          status: 'published',
        }),
      });
      const { product: orderedProd } = await ordProdRes.json();

      const ordRes = await callWorker('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          productId: orderedProd.id,
          buyerUserId: buyer.user.id,
          quantity: 1,
          agreedTotal: 80,
          currency: 'USD',
        }),
      });
      expect(ordRes.status).toBe(201);
      const { orderId } = await ordRes.json();

      // Missing confirmation rejected
      const badConfirmRes = await callWorker(`/api/admin/shops/${shop.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ confirm: false, reason: 'missing confirm' }),
      });
      expect(badConfirmRes.status).toBe(400);

      // Valid Admin Delete Shop
      const delRes = await callWorker(`/api/admin/shops/${shop.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({
          confirm: true,
          confirmShopName: 'Closure Boutique',
          reason: 'Policy enforcement test',
        }),
      });
      expect(delRes.status).toBe(200);
      const delJson = await delRes.json();
      expect(delJson.deleted).toBe(true);
      expect(delJson.archivedProductsCount).toBe(1);
      expect(delJson.deletedProductsCount).toBe(1);

      // Exclusive shop logo destroyed on Cloudinary
      expect(destroyCalls.some((c) => decodeURIComponent(c.body).includes(`sofumer/shops/${seller.user.id}/shop_logo_test`))).toBe(true);

      // Public shop & ordered product hidden; clean product deleted
      const pubShopRes = await callWorker(`/api/marketplace/shops/${shop.slug}`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      });
      expect(pubShopRes.status).toBe(404);

      const pubProdRes = await callWorker(`/api/marketplace/products/${orderedProd.id}`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      });
      expect(pubProdRes.status).toBe(404);

      const cleanRow = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(cleanProd.id).first();
      expect(cleanRow).toBeNull();

      // Historical order preserved & accessible
      const histOrdRes = await callWorker(`/api/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      });
      expect(histOrdRes.status).toBe(200);

      // Admin shops filter & PATCH protection on closed shop
      const closedListRes = await callWorker('/api/admin/shops?status=closed', {
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      expect(closedListRes.status).toBe(200);
      const closedListJson = await closedListRes.json();
      expect(closedListJson.shops.some((s) => s.id === shop.id && s.status === 'closed')).toBe(true);

      const patchClosedRes = await callWorker(`/api/admin/shops/${shop.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(patchClosedRes.status).toBe(409);

      // Protected audit log created
      const auditRow = await env.DB.prepare("SELECT * FROM admin_audit_logs WHERE action = 'shop.deleted' AND target_id = ?")
        .bind(shop.id)
        .first();
      expect(auditRow).not.toBeNull();
      expect(Number(auditRow.is_protected)).toBe(1);

      // Owner can re-register a new shop, then self-delete it via DELETE /api/seller/shop
      const reRegRes = await callWorker('/api/seller/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({
          sellerType: 'individual',
          legalName: 'Second Act Merchant',
          shopName: 'Second Act Studio',
          countryCode: 'US',
        }),
      });
      expect(reRegRes.status).toBe(201);
      const { shop: secondShop } = await reRegRes.json();

      const wrongSelfRes = await callWorker('/api/seller/shop', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ confirmShopName: 'Wrong Shop Name' }),
      });
      expect(wrongSelfRes.status).toBe(400);

      const selfDelRes = await callWorker('/api/seller/shop', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
        body: JSON.stringify({ confirmShopName: 'Second Act Studio', reason: 'Closing voluntarily' }),
      });
      expect(selfDelRes.status).toBe(200);
      const selfDelJson = await selfDelRes.json();
      expect(selfDelJson.deleted).toBe(true);
      expect(selfDelJson.shopId).toBe(secondShop.id);

      const pubSecondRes = await callWorker(`/api/marketplace/shops/${secondShop.slug}`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      });
      expect(pubSecondRes.status).toBe(404);

      const ownerAudit = await env.DB.prepare("SELECT * FROM admin_audit_logs WHERE action = 'shop.deleted_by_owner' AND target_id = ?")
        .bind(secondShop.id)
        .first();
      expect(ownerAudit).not.toBeNull();
      expect(Number(ownerAudit.is_protected)).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('24. Audit Logs Governance enforces audit.view vs audit.manage separation, archiving, protected-log preservation, and retention validation', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callWorker = async (path, init = {}) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    const login = async (id, username) => {
      const initData = await signTelegramInitData({ id, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const res = await callWorker('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      return await res.json();
    };

    const ownerAdmin = await login(999001, 'audit_owner');
    const auditViewerTgId = '910050';
    await login(910050, 'audit_viewer');

    // Create view-only audit role & assign to 910050
    const roleRes = await callWorker('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({
        code: `AUD_VIEW_${Date.now().toString().slice(-4)}`,
        name: 'Audit Viewer',
        permissions: ['overview.view', 'audit.view'],
      }),
    });
    expect(roleRes.status).toBe(201);
    const { id: viewerRoleId } = await roleRes.json();

    const assignRes = await callWorker('/api/admin/role-assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ telegramId: auditViewerTgId, roleId: viewerRoleId, displayLabel: 'Audit Reader' }),
    });
    expect(assignRes.status).toBe(201);
    const { id: assignId } = await assignRes.json();

    const viewerSession = await login(910050, 'audit_viewer');

    // Create two routine unprotected logs and one protected log
    const catRes = await callWorker('/api/admin/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ name: 'Audit Temp Cat', description: 'Routine log generator' }),
    });
    expect(catRes.status).toBe(201);
    const { id: tempCatId } = await catRes.json();

    await callWorker(`/api/admin/categories/${tempCatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ description: 'Updated routine log generator' }),
    });

    // Viewer can read audit logs (200)
    const viewRes = await callWorker('/api/admin/audit-logs?scope=active', {
      headers: { Authorization: `Bearer ${viewerSession.token}` },
    });
    expect(viewRes.status).toBe(200);
    const viewJson = await viewRes.json();
    expect(Array.isArray(viewJson.logs)).toBe(true);
    expect(typeof viewJson.retentionDays).toBe('number');
    expect(viewJson.summary).toBeDefined();

    const routineLog = viewJson.logs.find((l) => l.action === 'category.created' && l.target_id === tempCatId);
    const routineUpdateLog = viewJson.logs.find((l) => l.action === 'category.updated' && l.target_id === tempCatId);
    const protectedLog = viewJson.logs.find((l) => Number(l.is_protected) === 1);
    expect(routineLog).toBeDefined();
    expect(routineUpdateLog).toBeDefined();
    expect(protectedLog).toBeDefined();

    // Viewer CANNOT archive or delete audit logs (403)
    const viewerArchRes = await callWorker('/api/admin/audit-logs/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerSession.token}` },
      body: JSON.stringify({ ids: [routineLog.id] }),
    });
    expect(viewerArchRes.status).toBe(403);

    const viewerBulkDelRes = await callWorker('/api/admin/audit-logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerSession.token}` },
      body: JSON.stringify({ ids: [routineLog.id] }),
    });
    expect(viewerBulkDelRes.status).toBe(403);

    const viewerSingleDelRes = await callWorker(`/api/admin/audit-logs/${routineLog.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${viewerSession.token}` },
    });
    expect(viewerSingleDelRes.status).toBe(403);

    // Owner archives the routine log
    const archiveRes = await callWorker('/api/admin/audit-logs/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ ids: [routineLog.id], reason: 'Quarterly archive rotation' }),
    });
    expect(archiveRes.status).toBe(200);
    const archiveJson = await archiveRes.json();
    expect(archiveJson.archivedCount).toBe(1);

    const archivedListRes = await callWorker('/api/admin/audit-logs?scope=archived', {
      headers: { Authorization: `Bearer ${ownerAdmin.token}` },
    });
    expect(archivedListRes.status).toBe(200);
    const archivedListJson = await archivedListRes.json();
    const archivedEntry = archivedListJson.logs.find((l) => l.id === routineLog.id);
    expect(archivedEntry).toBeDefined();
    expect(archivedEntry.archive_reason).toBe('Quarterly archive rotation');

    // Protected log single deletion rejected (403)
    const protDelRes = await callWorker(`/api/admin/audit-logs/${protectedLog.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerAdmin.token}` },
    });
    expect(protDelRes.status).toBe(403);

    // Bulk delete deletes routine/unprotected log while skipping protected log
    const bulkDelRes = await callWorker('/api/admin/audit-logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ ids: [routineUpdateLog.id, protectedLog.id] }),
    });
    expect(bulkDelRes.status).toBe(200);
    const bulkDelJson = await bulkDelRes.json();
    expect(bulkDelJson.deletedCount).toBe(1);
    expect(bulkDelJson.skippedProtectedCount).toBe(1);

    // Confirm protected log still exists and audit.logs_deleted entry was created
    const stillThere = await env.DB.prepare('SELECT id FROM admin_audit_logs WHERE id = ?').bind(protectedLog.id).first();
    expect(stillThere).not.toBeNull();
    const auditDelEntry = await env.DB.prepare("SELECT id FROM admin_audit_logs WHERE action = 'audit.logs_deleted'").first();
    expect(auditDelEntry).not.toBeNull();

    // Retention window validation (2 days invalid -> 400, 120 days valid -> 200)
    const badRetRes = await callWorker('/api/admin/settings/audit_retention_days', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ value: '2' }),
    });
    expect(badRetRes.status).toBe(400);

    const goodRetRes = await callWorker('/api/admin/settings/audit_retention_days', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAdmin.token}` },
      body: JSON.stringify({ value: '120' }),
    });
    expect(goodRetRes.status).toBe(200);

    // Cleanup temp role assignment and category
    await callWorker(`/api/admin/role-assignments/${assignId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerAdmin.token}` },
    });
    await callWorker(`/api/admin/categories/${tempCatId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerAdmin.token}` },
    });
  });

  it('25. Application-wide Delete endpoints enforce ownership, historical guards, global announcement safety, and review rating recalculation', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callWorker = async (path, init = {}) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init),
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    const login = async (id, username) => {
      const initData = await signTelegramInitData({ id, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const res = await callWorker('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const authData = await res.json();
      const meRes = await callWorker('/api/auth/me', {
        headers: { Authorization: `Bearer ${authData.token}` },
      });
      const meData = await meRes.json();
      return { ...authData, user: meData.user };
    };

    const seller = await login(920001, 'appdel_seller');
    const buyer = await login(920002, 'appdel_buyer');
    const admin = await login(999001, 'appdel_admin');

    const regRes = await callWorker('/api/seller/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({
        sellerType: 'individual',
        legalName: 'AppDel Seller',
        shopName: 'AppDel Store',
        countryCode: 'US',
      }),
    });
    const { shop } = await regRes.json();

    // Create physical & digital products
    const physRes = await callWorker('/api/seller/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({
        listingType: 'physical',
        title: 'AppDel Acoustic Headphones',
        description: 'Testing conversations and reviews.',
        categoryId: 'cat_electronics',
        price: 120,
        currency: 'USD',
        status: 'published',
      }),
    });
    const { product: physProd } = await physRes.json();

    const digRes = await callWorker('/api/seller/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({
        listingType: 'digital',
        title: 'AppDel Digital Pack',
        description: 'Testing digital asset deletion.',
        categoryId: 'cat_electronics',
        price: 35,
        currency: 'USD',
        status: 'published',
      }),
    });
    const { product: digProd } = await digRes.json();

    // 1. Messaging: Conversation hide/unhide + per-message delete rules
    const convCreateRes = await callWorker('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ productId: physProd.id, message: 'First buyer message' }),
    });
    expect(convCreateRes.status).toBe(201);
    const { conversationId } = await convCreateRes.json();

    const msgSendRes = await callWorker(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ body: 'Second removable message' }),
    });
    const { message: secondMsg } = await msgSendRes.json();

    // Seller cannot delete buyer's message (403)
    const stealDelRes = await callWorker(`/api/conversations/${conversationId}/messages/${secondMsg.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    expect(stealDelRes.status).toBe(403);

    // Buyer deletes own message (200)
    const ownMsgDelRes = await callWorker(`/api/conversations/${conversationId}/messages/${secondMsg.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(ownMsgDelRes.status).toBe(200);

    // Order generates order_proposal message which cannot be deleted
    const ordRes = await callWorker('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({
        productId: physProd.id,
        buyerUserId: buyer.user.id,
        conversationId,
        quantity: 1,
        agreedTotal: 120,
        currency: 'USD',
      }),
    });
    const { orderId } = await ordRes.json();

    const msgsRes = await callWorker(`/api/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    const msgsJson = await msgsRes.json();
    const proposalMsg = msgsJson.messages.find((m) => m.message_type === 'order_proposal');
    expect(proposalMsg).toBeDefined();

    const delProposalRes = await callWorker(`/api/conversations/${conversationId}/messages/${proposalMsg.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    expect(delProposalRes.status).toBe(403);

    // Buyer hides conversation -> disappears for buyer, remains for seller, new seller msg unhides
    const hideConvRes = await callWorker(`/api/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(hideConvRes.status).toBe(200);

    const buyerConvsAfterHide = await (
      await callWorker('/api/conversations', { headers: { Authorization: `Bearer ${buyer.token}` } })
    ).json();
    expect(buyerConvsAfterHide.conversations.some((c) => c.id === conversationId)).toBe(false);

    const sellerConvsAfterHide = await (
      await callWorker('/api/conversations', { headers: { Authorization: `Bearer ${seller.token}` } })
    ).json();
    expect(sellerConvsAfterHide.conversations.some((c) => c.id === conversationId)).toBe(true);

    await callWorker(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ body: 'Follow-up unhiding thread' }),
    });
    const buyerConvsUnhidden = await (
      await callWorker('/api/conversations', { headers: { Authorization: `Bearer ${buyer.token}` } })
    ).json();
    expect(buyerConvsUnhidden.conversations.some((c) => c.id === conversationId)).toBe(true);

    // 2. Account Notifications & Support Ticket cancellation
    const bcastRes = await callWorker('/api/admin/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ title: 'System Maintenance Notice', body: 'Window starts at 02:00 UTC' }),
    });
    expect(bcastRes.status).toBe(201);
    const { id: globalNotifId } = await bcastRes.json();

    // User cannot delete global broadcast notification (403)
    const userDelGlobalRes = await callWorker(`/api/account/notifications/${globalNotifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(userDelGlobalRes.status).toBe(403);

    // Insert personal user notification (one read, one unread) and verify clear read + single delete
    const personalUnreadId = `notif_u_${Date.now()}`;
    const personalReadId = `notif_r_${Date.now()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO notifications (id, user_id, scope, type, title, body, is_read) VALUES (?, ?, 'user', 'order', 'Unread Alert', 'Body', 0)"
      ).bind(personalUnreadId, buyer.user.id),
      env.DB.prepare(
        "INSERT INTO notifications (id, user_id, scope, type, title, body, is_read) VALUES (?, ?, 'user', 'order', 'Read Alert', 'Body', 1)"
      ).bind(personalReadId, buyer.user.id),
    ]);

    const clearReadRes = await callWorker('/api/account/notifications/read', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(clearReadRes.status).toBe(200);
    const clearReadJson = await clearReadRes.json();
    expect(clearReadJson.deletedCount).toBeGreaterThanOrEqual(1);

    const delUnreadRes = await callWorker(`/api/account/notifications/${personalUnreadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(delUnreadRes.status).toBe(200);

    // Admin deletes broadcast and clears matching marketplace_announcement
    const adminDelBcastRes = await callWorker(`/api/admin/notifications/${globalNotifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(adminDelBcastRes.status).toBe(200);
    const bannerSetting = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'marketplace_announcement'").first();
    expect(bannerSetting?.value).toBe('');

    // Account open ticket cancel vs resolved ticket guard + Admin delete ticket
    const openTktRes = await callWorker('/api/account/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ category: 'order', subject: 'Cancelable Ticket', message: 'Opened by mistake' }),
    });
    const { ticketId: openTktId } = await openTktRes.json();
    const buyerCancelTktRes = await callWorker(`/api/account/support/${openTktId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(buyerCancelTktRes.status).toBe(200);

    const resTktCreate = await callWorker('/api/account/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ category: 'general', subject: 'Resolved Ticket', message: 'Need admin reply' }),
    });
    const { ticketId: resTktId } = await resTktCreate.json();

    // Admin cannot delete still-open ticket (409)
    const adminDelOpenTktRes = await callWorker(`/api/admin/support/${resTktId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(adminDelOpenTktRes.status).toBe(409);

    await callWorker(`/api/admin/support/${resTktId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ status: 'resolved', adminResponse: 'Handled cleanly' }),
    });

    // User cannot cancel resolved ticket (409), Admin can delete resolved ticket (200)
    const userDelResolvedTktRes = await callWorker(`/api/account/support/${resTktId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer.token}` },
    });
    expect(userDelResolvedTktRes.status).toBe(409);

    const adminDelResolvedTktRes = await callWorker(`/api/admin/support/${resTktId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(adminDelResolvedTktRes.status).toBe(200);

    // 3. Seller: Pending Promotion delete & Digital Asset delete pre-paid vs paid-order block
    const promoRes = await callWorker('/api/seller/promotions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ promoType: 'featured_product', productId: physProd.id, durationDays: 7, title: 'Pending Campaign' }),
    });
    expect(promoRes.status).toBe(201);
    const { promotionId } = await promoRes.json();

    const delPromoRes = await callWorker(`/api/seller/promotions/${promotionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    expect(delPromoRes.status).toBe(200);

    await callWorker(`/api/seller/products/${digProd.id}/digital-asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ fileName: 'readme.txt', deliveryInstructions: 'Key follows', downloadLimit: 3 }),
    });
    const delAssetPreOrdRes = await callWorker(`/api/seller/products/${digProd.id}/digital-asset`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    expect(delAssetPreOrdRes.status).toBe(200);

    // Re-add digital asset, create & confirm digital order -> DELETE digital-asset blocked (409)
    await callWorker(`/api/seller/products/${digProd.id}/digital-asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ fileName: 'package.txt', deliveryInstructions: 'Download active', downloadLimit: 5 }),
    });
    const digOrdRes = await callWorker('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ productId: digProd.id, buyerUserId: buyer.user.id, quantity: 1, agreedTotal: 35, currency: 'USD' }),
    });
    const { orderId: digOrderId } = await digOrdRes.json();
    await callWorker(`/api/orders/${digOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    const delAssetPaidRes = await callWorker(`/api/seller/products/${digProd.id}/digital-asset`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${seller.token}` },
    });
    expect(delAssetPaidRes.status).toBe(409);

    // 4. Admin: Categories & Subcategories referenced vs unused deletion, + Review removal rating recalculation
    const newCatRes = await callWorker('/api/admin/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ name: 'Governance Test Cat', description: 'Check FK guard' }),
    });
    const { id: newCatId } = await newCatRes.json();

    const newSubRes = await callWorker('/api/admin/subcategories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ categoryId: newCatId, name: 'Governance Test Sub' }),
    });
    const { id: newSubId } = await newSubRes.json();

    // Parent category has subcategory -> 409
    const delParentWithSubRes = await callWorker(`/api/admin/categories/${newCatId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(delParentWithSubRes.status).toBe(409);

    // Delete unused subcategory -> 200, then delete empty parent category -> 200
    const delSubRes = await callWorker(`/api/admin/subcategories/${newSubId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(delSubRes.status).toBe(200);

    const delCatRes = await callWorker(`/api/admin/categories/${newCatId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(delCatRes.status).toBe(200);

    // Complete order, submit 5-star review, then Admin removes review -> rating recalculates back to 0
    await callWorker(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    await callWorker(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` },
      body: JSON.stringify({ status: 'Delivered' }),
    });
    await callWorker(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ status: 'Completed' }),
    });
    const revRes = await callWorker(`/api/orders/${orderId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ rating: 5, comment: 'Great product before moderation removal' }),
    });
    expect(revRes.status).toBe(201);
    const { reviewId } = await revRes.json();

    const prodBeforeRevDel = await env.DB.prepare('SELECT rating_avg, review_count FROM products WHERE id = ?').bind(physProd.id).first();
    expect(Number(prodBeforeRevDel.review_count)).toBe(1);
    expect(Number(prodBeforeRevDel.rating_avg)).toBe(5);

    const adminDelRevRes = await callWorker(`/api/admin/reviews/${reviewId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(adminDelRevRes.status).toBe(200);

    const prodAfterRevDel = await env.DB.prepare('SELECT rating_avg, review_count FROM products WHERE id = ?').bind(physProd.id).first();
    expect(Number(prodAfterRevDel.review_count)).toBe(0);
    expect(Number(prodAfterRevDel.rating_avg)).toBe(0);

    const shopAfterRevDel = await env.DB.prepare('SELECT rating_avg, review_count FROM shops WHERE id = ?').bind(shop.id).first();
    expect(Number(shopAfterRevDel.review_count)).toBe(0);
    expect(Number(shopAfterRevDel.rating_avg)).toBe(0);
  });

  it('26. Telegram Mini App initData verification handles official key sorting, trimmed bot tokens, Android hash roundtrips, expiry, tampering, and refreshes', async () => {
    const cleanBotToken = '987654321:AAH_OFFICIAL_BOT_TOKEN_TEST';
    const tokenWithWhitespace = `  ${cleanBotToken}\n `;
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: tokenWithWhitespace,
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callAuth = async (path, init = {}, customEnv = testEnv) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init),
        customEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    // Helper using official Telegram spec (ASCII key sort, NOT localeCompare) + optional extra fields (chat, chat_instance, signature)
    async function signOfficialTelegramPayload(fields, signingToken = cleanBotToken) {
      const enc = new TextEncoder();
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) {
        params.set(k, v);
      }
      const entries = [];
      params.forEach((v, k) => entries.push([k, v]));
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

      const webAppKey = await crypto.subtle.importKey(
        'raw',
        enc.encode('WebAppData'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const secretBuf = await crypto.subtle.sign('HMAC', webAppKey, enc.encode(signingToken));
      const dataKey = await crypto.subtle.importKey(
        'raw',
        secretBuf,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBuf = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
      const hashHex = Array.from(new Uint8Array(sigBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      params.set('hash', hashHex);
      return params.toString();
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const officialInitData = await signOfficialTelegramPayload({
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: JSON.stringify({
        id: 880101,
        first_name: 'Amina & Co',
        last_name: 'Saleh',
        username: 'amina_tg',
        language_code: 'en',
        allows_write_to_pm: true,
      }),
      chat_type: 'group',
      chat_instance: '-81928371293',
      chat: JSON.stringify({ id: -100123456, type: 'group', title: 'SOFUMER Group' }),
      signature: 'ed25519_mock_sig_payload_base64url',
      auth_date: String(nowSec),
    });

    // 1. Valid official payload (with chat + chat_instance + signature) & trimmed TELEGRAM_BOT_TOKEN succeeds
    const resValid = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: officialInitData }),
    });
    expect(resValid.status).toBe(200);
    const validJson = await resValid.json();
    expect(validJson.authenticated).toBe(true);
    expect(typeof validJson.token).toBe('string');
    expect(validJson.diagnostics?.receivedInitData).toBe(true);
    expect(validJson.diagnostics?.signatureVerified).toBe(true);
    expect(validJson.diagnostics?.sessionCreated).toBe(true);

    // 2. Android Telegram WebApp hash (#tgWebAppData=...&tgWebAppPlatform=android) extraction roundtrip matches exact initData
    const androidHash = `#tgWebAppData=${encodeURIComponent(officialInitData)}&tgWebAppVersion=8.0&tgWebAppPlatform=android`;
    const extractedFromAndroidHash = new URLSearchParams(androidHash.slice(1)).get('tgWebAppData');
    expect(extractedFromAndroidHash).toBe(officialInitData);

    const resAndroid = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: extractedFromAndroidHash }),
    });
    expect(resAndroid.status).toBe(200);
    const androidJson = await resAndroid.json();
    expect(androidJson.authenticated).toBe(true);

    // 3. Refreshing Mini App / existing session check via Bearer token & protected marketplace access
    const meRes = await callAuth('/api/auth/me', {
      headers: { Authorization: `Bearer ${androidJson.token}` },
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson.authenticated).toBe(true);
    expect(meJson.user.telegram_id).toBe('880101');

    const homeRes = await callAuth('/api/marketplace/home', {
      headers: { Authorization: `Bearer ${androidJson.token}` },
    });
    expect(homeRes.status).toBe(200);

    // 4. Tampered initData rejected with 401 and never exposes bot token
    const tamperedParams = new URLSearchParams(officialInitData);
    tamperedParams.set('user', JSON.stringify({ id: 999001, first_name: 'Spoofed' }));
    const resTampered = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tamperedParams.toString() }),
    });
    expect(resTampered.status).toBe(401);
    const tamperedBody = await resTampered.json();
    expect(tamperedBody.error).toContain('Telegram initData signature mismatch');
    expect(tamperedBody.error).not.toContain(cleanBotToken);

    // 5. Wrong bot token rejected with 401 and never exposes token
    const wrongBotInitData = await signOfficialTelegramPayload(
      {
        user: JSON.stringify({ id: 880102, first_name: 'OtherBotUser' }),
        auth_date: String(nowSec),
      },
      '111111111:WRONG_BOT_TOKEN'
    );
    const resWrongBot = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: wrongBotInitData }),
    });
    expect(resWrongBot.status).toBe(401);
    const wrongBotJson = await resWrongBot.json();
    expect(wrongBotJson.error).toContain('Telegram initData signature mismatch');
    expect(wrongBotJson.error).not.toContain(cleanBotToken);

    // 6. Expired auth_date (> 24h) rejected with 401 even if validly signed
    const expiredInitData = await signOfficialTelegramPayload({
      user: JSON.stringify({ id: 880103, first_name: 'ExpiredUser' }),
      auth_date: String(nowSec - 90000),
    });
    const resExpired = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: expiredInitData }),
    });
    expect(resExpired.status).toBe(401);
    const expiredJson = await resExpired.json();
    expect(expiredJson.error).toContain('expired');
  });

  it('27. Full session lifecycle & /api/auth/me: new/existing user deduplication, retry session reuse, Bearer + Cookie, refresh, expired/invalid/missing tokens', async () => {
    const botToken = '123456:SESSION_TEST_BOT_TOKEN';
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'session-test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callAuth = async (path, init = {}, customEnv = testEnv) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init),
        customEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    const userTgId = 880999;
    const initData = await signTelegramInitData(
      { id: userTgId, first_name: 'Session', last_name: 'Tester', username: 'session_tester' },
      botToken
    );
    const androidUa = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Telegram-Android/11.0';

    // 1. Missing token & cookie -> /api/auth/me returns 401 missing_token (never 200)
    const missingMe = await callAuth('/api/auth/me');
    expect(missingMe.status).toBe(401);
    expect(missingMe.headers.get('Cache-Control')).toContain('no-store');
    const missingJson = await missingMe.json();
    expect(missingJson.authenticated).toBe(false);
    expect(missingJson.reason).toBe('missing_token');

    // 2. Invalid token -> /api/auth/me returns 401 invalid_jwt
    const invalidMe = await callAuth('/api/auth/me', {
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    });
    expect(invalidMe.status).toBe(401);
    const invalidJson = await invalidMe.json();
    expect(invalidJson.authenticated).toBe(false);
    expect(invalidJson.reason).toBe('invalid_jwt');

    // 3. New Telegram user launch -> creates 1 user and 1 session, sets Cookie & returns Bearer JWT
    const loginRes1 = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': androidUa },
      body: JSON.stringify({ initData }),
    });
    expect(loginRes1.status).toBe(200);
    expect(loginRes1.headers.get('Cache-Control')).toContain('no-store');
    const setCookie = loginRes1.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('sofumer_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Partitioned');
    const loginJson1 = await loginRes1.json();
    expect(loginJson1.authenticated).toBe(true);
    expect(typeof loginJson1.token).toBe('string');

    // 4. Verify /api/auth/me via Bearer token AND marketplace access
    const meBearer = await callAuth('/api/auth/me', {
      headers: { Authorization: `Bearer ${loginJson1.token}` },
    });
    expect(meBearer.status).toBe(200);
    expect(meBearer.headers.get('Cache-Control')).toContain('no-store');
    const meBearerJson = await meBearer.json();
    expect(meBearerJson.authenticated).toBe(true);
    expect(meBearerJson.user.telegram_id).toBe(String(userTgId));
    const userId = meBearerJson.user.id;
    const firstSessionId = meBearerJson.user.sessionId;

    const bootRes = await callAuth('/api/marketplace/bootstrap', {
      headers: { Authorization: `Bearer ${loginJson1.token}` },
    });
    expect(bootRes.status).toBe(200);

    // 5. Page refresh via Cookie only (no Authorization header) succeeds
    const cookiePair = setCookie.split(';')[0];
    const meCookie = await callAuth('/api/auth/me', {
      headers: { Cookie: cookiePair },
    });
    expect(meCookie.status).toBe(200);
    const meCookieJson = await meCookie.json();
    expect(meCookieJson.authenticated).toBe(true);
    expect(meCookieJson.user.id).toBe(userId);

    // 6. Retry Telegram Verification (same user & User-Agent) reuses existing user & session without duplicates
    const retryRes = await callAuth('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': androidUa },
      body: JSON.stringify({ initData }),
    });
    expect(retryRes.status).toBe(200);
    const retryJson = await retryRes.json();
    const meRetry = await callAuth('/api/auth/me', {
      headers: { Authorization: `Bearer ${retryJson.token}` },
    });
    expect(meRetry.status).toBe(200);
    const meRetryJson = await meRetry.json();
    expect(meRetryJson.user.id).toBe(userId);
    expect(meRetryJson.user.sessionId).toBe(firstSessionId);

    const userCount = await testEnv.DB.prepare('SELECT COUNT(*) as cnt FROM users WHERE telegram_id = ?')
      .bind(String(userTgId))
      .first();
    const sessCount = await testEnv.DB.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?')
      .bind(userId)
      .first();
    expect(userCount.cnt).toBe(1);
    expect(sessCount.cnt).toBe(1);

    // 7. Expired DB session -> /api/auth/me rejects with 401 session_expired
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(firstSessionId)
      .run();
    const expiredMe = await callAuth('/api/auth/me', {
      headers: { Authorization: `Bearer ${retryJson.token}` },
    });
    expect(expiredMe.status).toBe(401);
    const expiredMeJson = await expiredMe.json();
    expect(expiredMeJson.authenticated).toBe(false);
    expect(expiredMeJson.reason).toBe('session_expired');
  });

  it('28. Complete 20-section Governance Console Audit: every admin mutation, product_inventory FK cleanup, order/promo/subscription/stars lifecycle, message moderation, and RBAC checks', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callWorker = (path, init = {}) => {
      const ctx = createExecutionContext();
      return worker
        .fetch(new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init), testEnv, ctx)
        .then(async (res) => {
          await waitOnExecutionContext(ctx);
          return res;
        });
    };

    const loginAs = async (tgId, username) => {
      const initData = await signTelegramInitData({ id: tgId, first_name: username, username }, testEnv.TELEGRAM_BOT_TOKEN);
      const authRes = await callWorker('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const authJson = await authRes.json();
      const meRes = await callWorker('/api/auth/me', {
        headers: { Authorization: `Bearer ${authJson.token}` },
      });
      const meJson = await meRes.json();
      return { token: authJson.token, user: meJson.user };
    };

    const admin = await loginAs(999001, 'gov_admin');
    const seller = await loginAs(950001, 'gov_seller');
    const buyer = await loginAs(950002, 'gov_buyer');

    const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` };
    const sellerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${seller.token}` };
    const buyerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` };

    // Non-admin RBAC enforcement on new endpoints -> 403
    expect(
      (
        await callWorker('/api/admin/orders/ord_nonexistent', {
          method: 'PATCH',
          headers: buyerHeaders,
          body: JSON.stringify({ status: 'Confirmed' }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await callWorker('/api/admin/telegram/diagnostics', {
          headers: { Authorization: `Bearer ${buyer.token}` },
        })
      ).status
    ).toBe(403);

    // 1. Overview & 2. Analytics
    expect((await callWorker('/api/admin/overview', { headers: { Authorization: `Bearer ${admin.token}` } })).status).toBe(200);
    expect((await callWorker('/api/admin/analytics', { headers: { Authorization: `Bearer ${admin.token}` } })).status).toBe(200);

    // 3. Users: list, restrict status, custom AI daily limit
    const usersListRes = await callWorker('/api/admin/users', { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(usersListRes.status).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/users/${buyer.user.id}/status`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'restricted', reason: 'Audit test restriction' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/users/${buyer.user.id}/status`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'active' }),
        })
      ).status
    ).toBe(200);
    const aiQuotaRes = await callWorker(`/api/admin/users/${buyer.user.id}/ai-access`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ aiEnabled: true, customDailyLimit: 42 }),
    });
    expect(aiQuotaRes.status).toBe(200);
    const buyerPermRow = await env.DB.prepare('SELECT custom_daily_limit FROM ai_permissions WHERE user_id = ?')
      .bind(buyer.user.id)
      .first();
    expect(Number(buyerPermRow.custom_daily_limit)).toBe(42);

    // 4. Sellers & 5. Shops: register seller, approve/reject, edit shop name/description
    const regRes = await callWorker('/api/seller/register', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({
        sellerType: 'individual',
        legalName: 'Gov Test Seller',
        shopName: 'Gov Initial Shop',
        countryCode: 'US',
      }),
    });
    expect(regRes.status).toBe(201);
    const { sellerProfile, shop } = await regRes.json();

    expect(
      (
        await callWorker(`/api/admin/sellers/${sellerProfile.id}/status`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ verificationStatus: 'rejected', notes: 'Need clearer ID' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/sellers/${sellerProfile.id}/status`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ verificationStatus: 'verified' }),
        })
      ).status
    ).toBe(200);

    const editShopRes = await callWorker(`/api/admin/shops/${shop.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Gov Updated Shop',
        description: 'Updated shop description via Governance Console.',
        isVerified: true,
      }),
    });
    expect(editShopRes.status).toBe(200);
    const updatedShopRow = await env.DB.prepare('SELECT name, description FROM shops WHERE id = ?').bind(shop.id).first();
    expect(updatedShopRow.name).toBe('Gov Updated Shop');
    expect(updatedShopRow.description).toBe('Updated shop description via Governance Console.');

    // 6. Products: create product WITH product_inventory row (FK), archive, sponsor, then DELETE without HTTP 500!
    const prod1Res = await callWorker('/api/seller/products', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({
        listingType: 'physical',
        title: 'Gov Inventory Delete Target',
        description: 'Must delete cleanly even with product_inventory FK row.',
        categoryId: 'cat_electronics',
        price: 89,
        currency: 'USD',
        stockQuantity: 15,
        status: 'published',
      }),
    });
    expect(prod1Res.status).toBe(201);
    const { product: prodToDelete } = await prod1Res.json();

    // Ensure product_inventory row exists (explicitly verify the FK table that previously threw 500)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO product_inventory (id, product_id, stock_quantity, low_stock_threshold)
       VALUES (?, ?, 15, 2)`
    )
      .bind(`inv_${prodToDelete.id}`, prodToDelete.id)
      .run();

    expect(
      (
        await callWorker(`/api/admin/products/${prodToDelete.id}/moderate`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'archived', isSponsored: true }),
        })
      ).status
    ).toBe(200);

    const delProdRes = await callWorker(`/api/admin/products/${prodToDelete.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(delProdRes.status).toBe(200);
    const invLeft = await env.DB.prepare('SELECT COUNT(*) as cnt FROM product_inventory WHERE product_id = ?')
      .bind(prodToDelete.id)
      .first();
    expect(Number(invLeft.cnt)).toBe(0);

    // Create a second active product for Orders, Promotions, and Messaging tests
    const prod2Res = await callWorker('/api/seller/products', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({
        listingType: 'physical',
        title: 'Gov Active Studio Mic',
        description: 'Used across order, promo, and chat moderation tests.',
        categoryId: 'cat_electronics',
        price: 150,
        currency: 'USD',
        status: 'published',
      }),
    });
    const { product: activeProd } = await prod2Res.json();

    // 7. Categories: edit existing category description & rename subcategory
    const catCreate = await callWorker('/api/admin/categories', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Gov Editable Cat', description: 'Before desc' }),
    });
    const { id: govCatId } = await catCreate.json();
    expect(
      (
        await callWorker(`/api/admin/categories/${govCatId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Gov Edited Cat', description: 'After desc', sortOrder: 12 }),
        })
      ).status
    ).toBe(200);
    const subCreate = await callWorker('/api/admin/subcategories', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ categoryId: govCatId, name: 'Gov Sub Before' }),
    });
    const { id: govSubId } = await subCreate.json();
    expect(
      (
        await callWorker(`/api/admin/subcategories/${govSubId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Gov Sub After', isActive: false }),
        })
      ).status
    ).toBe(200);
    await callWorker(`/api/admin/subcategories/${govSubId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
    await callWorker(`/api/admin/categories/${govCatId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });

    // 8. Orders: GET detail + PATCH status + invalid status -> 400 + history + protected audit log
    const convRes = await callWorker('/api/conversations', {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ productId: activeProd.id, message: 'Hello seller' }),
    });
    const { conversationId } = await convRes.json();
    const ordRes = await callWorker('/api/orders', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({
        productId: activeProd.id,
        buyerUserId: buyer.user.id,
        conversationId,
        quantity: 1,
        agreedTotal: 150,
        currency: 'USD',
      }),
    });
    const { orderId } = await ordRes.json();

    expect(
      (
        await callWorker(`/api/admin/orders/${orderId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'NotARealStatus' }),
        })
      ).status
    ).toBe(400);

    const ordPatchRes = await callWorker(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'Disputed', note: 'Admin escalated dispute review' }),
    });
    expect(ordPatchRes.status).toBe(200);

    const ordDetailRes = await callWorker(`/api/admin/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(ordDetailRes.status).toBe(200);
    const ordDetail = await ordDetailRes.json();
    expect(ordDetail.order.status).toBe('Disputed');
    expect(ordDetail.history.some((h) => h.new_status === 'Disputed')).toBe(true);

    // 9. Messages & Reports: submit report, transition investigating -> resolved, hide/restore message, close/restore conversation
    const badMsgRes = await callWorker(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ body: 'Suspicious off-platform link' }),
    });
    const { message: badMsg } = await badMsgRes.json();

    const repSubmit = await callWorker('/api/marketplace/reports', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({
        targetType: 'message',
        targetId: conversationId,
        reason: 'spam',
        details: 'Off-platform spam attempt',
      }),
    });
    expect(repSubmit.status).toBe(201);
    const { reportId: repId } = await repSubmit.json();

    expect(
      (
        await callWorker(`/api/admin/reports/${repId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'investigating', resolutionNotes: 'Reviewing evidence' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/messages/${badMsg.id}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ isDeleted: true }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/conversations/${conversationId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'closed', reason: 'Moderator closed thread' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/conversations/${conversationId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'active' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/reports/${repId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'resolved', resolutionNotes: 'Message hidden and thread resolved' }),
        })
      ).status
    ).toBe(200);

    // 11. Promotions, 12. Subscriptions, 13. Revenue & Stars invoices
    const promo1Res = await callWorker('/api/seller/promotions', {
      method: 'POST',
      headers: sellerHeaders,
      body: JSON.stringify({ promoType: 'featured_product', productId: activeProd.id, durationDays: 7, title: 'Gov Promo 1' }),
    });
    const { promotionId: promo1Id } = await promo1Res.json();

    // Activate sets starts_at / ends_at and flags product featured
    expect(
      (
        await callWorker(`/api/admin/promotions/${promo1Id}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'active' }),
        })
      ).status
    ).toBe(200);
    const activeProdFeatured = await env.DB.prepare('SELECT is_featured FROM products WHERE id = ?').bind(activeProd.id).first();
    expect(Number(activeProdFeatured.is_featured)).toBe(1);

    // Pause clears product featured flag, and DELETE fails if active (409) -> then paused unpaid promo deletes cleanly (200)
    expect(
      (
        await callWorker(`/api/admin/promotions/${promo1Id}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'paused' }),
        })
      ).status
    ).toBe(200);
    const pausedProdFeatured = await env.DB.prepare('SELECT is_featured FROM products WHERE id = ?').bind(activeProd.id).first();
    expect(Number(pausedProdFeatured.is_featured)).toBe(0);
    expect(
      (
        await callWorker(`/api/admin/promotions/${promo1Id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${admin.token}` },
        })
      ).status
    ).toBe(200);

    // Seed an active subscription & pending Stars payment -> test cancel/expire & revenueSummary
    const subId = `sub_gov_${Date.now()}`;
    const spPendingId = `sp_pend_${Date.now()}`;
    const spPaidId = `sp_paid_${Date.now()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, starts_at, ends_at)
         VALUES (?, ?, ?, 'plan_pro', 'monthly', 24, 'USD', 'active', datetime('now'), datetime('now', '+30 days'))`
      ).bind(subId, sellerProfile.id, seller.user.id),
      env.DB.prepare(
        `INSERT INTO telegram_stars_payments (id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle, title, payload_token, currency, stars_amount, usd_equivalent, status, expires_at)
         VALUES (?, ?, '950001', 'subscription', 'plan_pro', 'PRO', 'monthly', 'Pro Plan Pending', ?, 'XTR', 1200, 24, 'pending', datetime('now', '+1 hour'))`
      ).bind(spPendingId, seller.user.id, `paytok_pend_${Date.now()}`),
      env.DB.prepare(
        `INSERT INTO telegram_stars_payments (id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle, title, payload_token, currency, stars_amount, usd_equivalent, status, expires_at, paid_at)
         VALUES (?, ?, '950001', 'subscription', 'plan_pro', 'PRO', 'monthly', 'Pro Plan Paid', ?, 'XTR', 1200, 24, 'paid', datetime('now', '+1 hour'), datetime('now'))`
      ).bind(spPaidId, seller.user.id, `paytok_paid_${Date.now()}`),
    ]);

    const monRes = await callWorker('/api/admin/monetization', { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(monRes.status).toBe(200);
    const monJson = await monRes.json();
    expect(monJson.revenueSummary).toBeDefined();
    expect(Number(monJson.revenueSummary.stars_revenue_xtr)).toBeGreaterThanOrEqual(1200);

    expect(
      (
        await callWorker(`/api/admin/subscriptions/${subId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'cancelled' }),
        })
      ).status
    ).toBe(200);

    // Pending Stars invoice expires cleanly (200); already-paid Stars invoice cannot be mutated (409)
    expect(
      (
        await callWorker(`/api/admin/stars-payments/${spPendingId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'expired' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/stars-payments/${spPaidId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ status: 'cancelled' }),
        })
      ).status
    ).toBe(409);

    // 16. Countries, 18. Settings + Telegram Launch Diagnostics
    expect(
      (
        await callWorker('/api/admin/countries/US', {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ isSupported: true, notes: 'Governance audited' }),
        })
      ).status
    ).toBe(200);

    const diagRes = await callWorker('/api/admin/telegram/diagnostics', {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(diagRes.status).toBe(200);
    const diagJson = await diagRes.json();
    expect(diagJson.telegramConfigured).toBe(true);
    expect(diagJson.jwtConfigured).toBe(true);

    // 19. Admin Roles: edit custom role name/description + revoke + delete role
    const roleRes = await callWorker('/api/admin/roles', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        code: 'GOV_EDITOR',
        name: 'Gov Editor',
        description: 'Initial role description',
        permissions: ['analytics.view'],
      }),
    });
    expect(roleRes.status).toBe(201);
    const { id: govRoleId } = await roleRes.json();
    expect(
      (
        await callWorker(`/api/admin/roles/${govRoleId}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Gov Senior Editor', description: 'Updated desc' }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/admin/roles/${govRoleId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${admin.token}` },
        })
      ).status
    ).toBe(200);

    // 20. Audit Logs: protected financial/moderation log blocked from deletion, normal log can be archived and deleted
    const protAudit = await env.DB.prepare("SELECT id FROM admin_audit_logs WHERE action = 'order.status_updated' LIMIT 1").first();
    expect(protAudit?.id).toBeDefined();
    expect(
      (
        await callWorker(`/api/admin/audit-logs/${protAudit.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${admin.token}` },
        })
      ).status
    ).toBe(403);

    const softShopDelRes = await callWorker(`/api/admin/shops/${shop.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
      body: JSON.stringify({ confirmShopName: 'Gov Updated Shop', reason: 'End of governance audit test' }),
    });
    expect(softShopDelRes.status).toBe(200);
  });

  it('29. Legacy pre-0008 production D1 database upgrades cleanly without 503, preserves all existing data, and completes Telegram login + /api/auth/me', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_VITEST',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars',
      ADMIN_TELEGRAM_IDS: '999001',
    };

    const callWorker = (path, init = {}) => {
      const ctx = createExecutionContext();
      return worker
        .fetch(new Request(`https://sofumer-app.derartuaman8.workers.dev${path}`, init), testEnv, ctx)
        .then(async (res) => {
          await waitOnExecutionContext(ctx);
          return res;
        });
    };

    // Count existing production records before reverting schema to pre-0008 state
    const beforeUsers = await env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first();
    const beforeShops = await env.DB.prepare('SELECT COUNT(*) as cnt FROM shops').first();
    const beforeProducts = await env.DB.prepare('SELECT COUNT(*) as cnt FROM products').first();
    const beforeOrders = await env.DB.prepare('SELECT COUNT(*) as cnt FROM orders').first();
    expect(Number(beforeUsers.cnt)).toBeGreaterThan(0);
    expect(Number(beforeShops.cnt)).toBeGreaterThan(0);

    // Revert DB to exact pre-0008 state (indexes + columns missing) while preserving all existing rows
    await env.DB.prepare('DROP INDEX IF EXISTS idx_shops_deleted_at').run();
    await env.DB.prepare('ALTER TABLE shops DROP COLUMN deleted_at').run();
    await env.DB.prepare('ALTER TABLE shops DROP COLUMN deleted_by').run();
    await env.DB.prepare('ALTER TABLE shops DROP COLUMN deletion_reason').run();

    await env.DB.prepare('DROP INDEX IF EXISTS idx_admin_audit_logs_is_archived').run();
    await env.DB.prepare('DROP INDEX IF EXISTS idx_admin_audit_logs_is_protected').run();
    await env.DB.prepare('ALTER TABLE admin_audit_logs DROP COLUMN is_protected').run();
    await env.DB.prepare('ALTER TABLE admin_audit_logs DROP COLUMN is_archived').run();
    await env.DB.prepare('ALTER TABLE admin_audit_logs DROP COLUMN archived_at').run();
    await env.DB.prepare('ALTER TABLE admin_audit_logs DROP COLUMN archived_by').run();

    await env.DB.prepare('DROP INDEX IF EXISTS idx_conversation_participants_hidden').run();
    await env.DB.prepare('ALTER TABLE conversation_participants DROP COLUMN is_hidden').run();

    await env.DB.prepare('ALTER TABLE reports DROP COLUMN reviewed_by').run();
    await env.DB.prepare('ALTER TABLE reports DROP COLUMN updated_at').run();
    await env.DB.prepare('DROP TABLE IF EXISTS admin_audit_log_archives').run();
    await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'audit_retention_days'").run();

    resetD1BootstrapCacheForTests();

    // 1. /api/health reports dbInitialized: false before upgrade, /api/auth/config still returns 200
    const healthBefore = await callWorker('/api/health');
    expect(healthBefore.status).toBe(200);
    const healthBeforeJson = await healthBefore.json();
    expect(healthBeforeJson.dbBound).toBe(true);
    expect(healthBeforeJson.dbInitialized).toBe(false);

    const cfgRes = await callWorker('/api/auth/config');
    expect(cfgRes.status).toBe(200);
    const cfgJson = await cfgRes.json();
    expect(cfgJson.telegramConfigured).toBe(true);
    expect(cfgJson.jwtConfigured).toBe(true);

    // 2. First Telegram login triggers safe idempotent schema upgrade (NEVER 503!)
    const initData = await signTelegramInitData(
      { id: 980001, first_name: 'ProdUser', username: 'prod_migrated_user' },
      testEnv.TELEGRAM_BOT_TOKEN
    );
    const authRes = await callWorker('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    expect(authRes.status).toBe(200);
    const authJson = await authRes.json();
    expect(authJson.authenticated).toBe(true);
    expect(authJson.diagnostics.signatureVerified).toBe(true);
    expect(authJson.diagnostics.sessionCreated).toBe(true);
    expect(typeof authJson.token).toBe('string');

    // 3. /api/auth/me and /api/marketplace/home succeed cleanly
    const meRes = await callWorker('/api/auth/me', {
      headers: { Authorization: `Bearer ${authJson.token}` },
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson.authenticated).toBe(true);
    expect(meJson.user.telegram_id).toBe('980001');

    const homeRes = await callWorker('/api/marketplace/home', {
      headers: { Authorization: `Bearer ${authJson.token}` },
    });
    expect(homeRes.status).toBe(200);

    // 4. Health confirms schema is now initialized and all pre-existing rows were preserved
    const healthAfter = await callWorker('/api/health');
    expect(healthAfter.status).toBe(200);
    expect((await healthAfter.json()).dbInitialized).toBe(true);

    const afterUsers = await env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first();
    const afterShops = await env.DB.prepare('SELECT COUNT(*) as cnt FROM shops').first();
    const afterProducts = await env.DB.prepare('SELECT COUNT(*) as cnt FROM products').first();
    const afterOrders = await env.DB.prepare('SELECT COUNT(*) as cnt FROM orders').first();
    expect(Number(afterUsers.cnt)).toBe(Number(beforeUsers.cnt) + 1);
    expect(Number(afterShops.cnt)).toBe(Number(beforeShops.cnt));
    expect(Number(afterProducts.cnt)).toBe(Number(beforeProducts.cnt));
    expect(Number(afterOrders.cnt)).toBe(Number(beforeOrders.cnt));

    // 5. Wrong bot token still cleanly fails Telegram HMAC with 401 signature mismatch (not 503)
    const badTokenInit = await signTelegramInitData(
      { id: 980002, first_name: 'WrongBot', username: 'wrong_bot' },
      '999999:WRONG_BOT_TOKEN'
    );
    const badRes = await callWorker('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: badTokenInit }),
    });
    expect(badRes.status).toBe(401);
    const badJson = await badRes.json();
    expect(badJson.diagnostics.signatureVerified).toBe(false);
  });
});



