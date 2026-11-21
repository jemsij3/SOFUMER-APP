import {
  SELF,
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('SOFUMER Cloudflare Worker (sofumer-app)', () => {
  beforeAll(async () => {
    if (env.DB && Array.isArray(env.TEST_MIGRATIONS)) {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    }
  });

  it('1. Worker starts successfully and serves /api/health', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');

    const body = await res.json();
    expect(body.service).toBe('SOFUMER');
    expect(body.status).toBe('ok');
    expect(body.runtime).toBe('cloudflare-workers');
    expect(body.dbBound).toBe(true);
    expect(body.r2Bound).toBeUndefined();

    const r2Res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/r2/sample.png');
    expect(r2Res.status).toBe(404);
    expect(r2Res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
  });

  it('2 & 3. Main application responds with real SOFUMER HTML and text/html;charset=UTF-8', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html;charset=UTF-8');

    const text = await res.text();
    expect(text).toContain('SOFUMER');
    expect(text).not.toContain('Hello World');
  });

  it('4. JSON responses include application/json;charset=UTF-8 and D1 marketplace bootstrap works', async () => {
    const res = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');

    const data = await res.json();
    expect(data.botName).toBe('SOFUMER');
    expect(data.botUsername).toBe('SofumerBot');

    const boot = await SELF.fetch('https://sofumer-app.derartuaman8.workers.dev/api/marketplace/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
    const bootJson = await boot.json();
    expect(Array.isArray(bootJson.categories)).toBe(true);
    expect(bootJson.categories.length).toBeGreaterThan(0);
  });

  it('5. Unknown API routes return 404 JSON and unsupported HTTP methods return 405', async () => {
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

  it('6. Missing required environment variables are handled safely without leaking secrets or stack traces', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: 'user=%7B%22id%22%3A1%7D&hash=00' }),
      }),
      { ...env, TELEGRAM_BOT_TOKEN: '' },
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
    const body = await res.json();
    expect(body.error).toContain('TELEGRAM_BOT_TOKEN');
    expect(JSON.stringify(body)).not.toContain('at ');

    // Missing webhook secret
    const ctx2 = createExecutionContext();
    const whRes = await worker.fetch(
      new Request('https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 100 }),
      }),
      { ...env, TELEGRAM_WEBHOOK_SECRET: '' },
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(whRes.status).toBe(503);
  });

  it('7. Telegram webhook authentication enforces X-Telegram-Bot-Api-Secret-Token and persists update safely', async () => {
    const testEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: 'test-token-not-real',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32chars',
    };

    // Unauthorized without header
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

    // Wrong secret header
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

    // Malformed JSON with valid secret -> 400
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

    // Valid secret + valid update -> prompt 200 JSON and recorded in D1
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
});
