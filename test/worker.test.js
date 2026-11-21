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
});
