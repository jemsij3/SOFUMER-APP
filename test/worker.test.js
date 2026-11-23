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
});
