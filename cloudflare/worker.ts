/**
 * SOFUMER — Cloudflare Workers Edge Runtime Entrypoint
 * Bindings:
 * - DB: Cloudflare D1 Relational Database
 * - MEDIA_BUCKET: Cloudflare R2 Object Storage
 * - AI: Cloudflare Workers AI (`env.AI`)
 * - ASSETS: Static React SPA build (./dist)
 * - Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SESSION_SECRET, ADMIN_BOOTSTRAP_SECRET
 */

export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  AI: WorkersAiBinding;
  ASSETS: Fetcher;
  TELEGRAM_BOT_NAME: string;
  TELEGRAM_BOT_USERNAME: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MINI_APP_URL?: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_SECRET: string;
  CLOUDFLARE_AI_MODEL?: string;
  ALLOW_DEV_SANDBOX?: string;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}

export interface WorkersAiBinding {
  run(
    model: string,
    inputs: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      max_tokens?: number;
      temperature?: number;
      response_format?: { type: 'json_object' };
    }
  ): Promise<{ response?: string; result?: { response?: string } }>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

const ALLOWED_UPLOAD_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function hmacSha256(keyData: BufferSource | string, message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyBytes = typeof keyData === 'string' ? enc.encode(keyData) : keyData;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyTelegramInitDataEdge(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing Telegram signature hash');

  const pairs: string[] = [];
  params.forEach((v, k) => {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmacSha256('WebAppData', botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (expected !== hash.toLowerCase()) {
    throw new Error('Telegram initData signature mismatch');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > 86400) {
    throw new Error('Telegram auth timestamp expired');
  }

  const user = JSON.parse(params.get('user') || '{}');
  if (!user?.id) throw new Error('Telegram user missing');
  return user;
}

async function authenticateEdgeRequest(request: Request, env: Env): Promise<string | null> {
  let token = '';
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/(?:^|;\s*)sofumer_session=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }
  if (!token) return null;

  const tokenHash = toHex(await hmacSha256(env.SESSION_SECRET, token));
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, s.revoked_at, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: string; revoked_at: string | null; status: string }>();

  if (!session || session.revoked_at || session.status === 'suspended') return null;
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) return null;
  return session.user_id;
}

async function checkEdgeAiPermission(env: Env, userId: string, featureKey: string) {
  const defaultModel = env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';

  const globalSetting = await env.DB.prepare(
    "SELECT is_enabled, model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'"
  ).first<{ is_enabled: number; model_name: string }>();

  if (!globalSetting || !globalSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'AI services are currently disabled globally by platform administrators.',
      modelName: globalSetting?.model_name || defaultModel,
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const featureSetting = await env.DB.prepare(
    'SELECT is_enabled, model_name, daily_limit_per_user FROM ai_feature_settings WHERE feature_key = ?'
  )
    .bind(featureKey)
    .first<{ is_enabled: number; model_name: string; daily_limit_per_user: number }>();

  if (featureSetting && !featureSetting.is_enabled) {
    return {
      allowed: false,
      reason: `The "${featureKey}" AI feature is currently disabled by administrators.`,
      modelName: featureSetting.model_name || defaultModel,
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const userPerm = await env.DB.prepare(
    'SELECT ai_enabled, custom_daily_limit, reason FROM ai_permissions WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ ai_enabled: number; custom_daily_limit: number | null; reason: string }>();

  if (userPerm && !userPerm.ai_enabled) {
    return {
      allowed: false,
      reason: userPerm.reason || 'Your AI access has been restricted by an administrator.',
      modelName: featureSetting?.model_name || defaultModel,
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const subRow = await env.DB.prepare(
    `SELECT sp.ai_daily_limit FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ ai_daily_limit: number }>();

  const dailyLimit =
    userPerm?.custom_daily_limit ??
    subRow?.ai_daily_limit ??
    featureSetting?.daily_limit_per_user ??
    25;

  const usedRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM ai_usage
     WHERE user_id = ? AND status = 'success' AND date(created_at) = date('now')`
  )
    .bind(userId)
    .first<{ cnt: number }>();

  const usedToday = usedRow?.cnt || 0;
  if (usedToday >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily AI usage limit reached (${usedToday}/${dailyLimit}).`,
      modelName: featureSetting?.model_name || defaultModel,
      dailyLimit,
      usedToday,
    };
  }

  return {
    allowed: true,
    modelName: env.CLOUDFLARE_AI_MODEL || featureSetting?.model_name || globalSetting.model_name || defaultModel,
    dailyLimit,
    usedToday,
  };
}

async function logEdgeAiUsage(
  env: Env,
  userId: string,
  featureKey: string,
  modelName: string,
  promptSummary: string,
  status: 'success' | 'denied' | 'error',
  latencyMs: number,
  tokensEstimated = 0,
  errorMessage = ''
) {
  await env.DB.prepare(
    `INSERT INTO ai_usage (id, user_id, feature_key, model_name, prompt_summary, tokens_estimated, status, error_message, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      `ai_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      userId,
      featureKey,
      modelName,
      promptSummary.slice(0, 240),
      tokensEstimated,
      status,
      errorMessage.slice(0, 400),
      latencyMs
    )
    .run();
}

function parseJsonFromAi(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(candidate) as Record<string, unknown>;
}

async function runEdgeAi(
  env: Env,
  modelName: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  expectJson = false
): Promise<string> {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding (env.AI) is not configured.');
  }
  const out = await env.AI.run(modelName, {
    messages,
    max_tokens: 900,
    temperature: 0.2,
    ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
  });
  return out?.response ?? out?.result?.response ?? '';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/api/health') {
      return json({
        service: 'SOFUMER',
        runtime: 'cloudflare-workers',
        aiProvider: 'cloudflare-workers-ai',
        aiModel: env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct',
        status: 'ok',
      });
    }

    // R2 media retrieval
    if (url.pathname.startsWith('/r2/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const key = decodeURIComponent(url.pathname.slice(4)).replace(/^\/+/, '');
      if (!key || key.includes('..') || !env.MEDIA_BUCKET) {
        return new Response('Not found', { status: 404 });
      }
      const obj = await env.MEDIA_BUCKET.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // Authenticated R2 media upload (compatible with R2 Free Tier)
    if (url.pathname === '/api/uploads' && request.method === 'POST') {
      const userId = await authenticateEdgeRequest(request, env);
      if (!userId) {
        return json({ error: 'Authentication required. Please launch SOFUMER via Telegram.' }, 401);
      }
      if (!env.MEDIA_BUCKET) {
        return json({ error: 'Cloudflare R2 bucket (MEDIA_BUCKET) is not bound.' }, 503);
      }

      const formData = await request.formData().catch(() => null);
      const uploaded = formData?.get('file');
      if (!uploaded || typeof uploaded === 'string') {
        return json({ error: 'No file provided.' }, 400);
      }

      const ext = ALLOWED_UPLOAD_MIME[uploaded.type];
      if (!ext) {
        return json({ error: 'Unsupported file type. Allowed: JPEG, PNG, WebP, GIF (max 5MB).' }, 400);
      }
      if (uploaded.size <= 0 || uploaded.size > MAX_UPLOAD_BYTES) {
        return json({ error: 'File must be between 1 byte and 5MB.' }, 400);
      }

      const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const key = `${Date.now()}-${randomHex}${ext}`;

      await env.MEDIA_BUCKET.put(key, await uploaded.arrayBuffer(), {
        httpMetadata: { contentType: uploaded.type },
      });

      return json(
        { url: `/r2/${key}`, size: uploaded.size, mimeType: uploaded.type },
        201
      );
    }

    // Telegram Bot Webhook with Secret Verification & D1 Deduplication
    if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ error: 'Unauthorized webhook' }, 401);
      }
      const update = (await request.json()) as {
        update_id?: number;
        message?: { chat?: { id?: number }; text?: string };
      };
      if (!update.update_id) return json({ status: 'ignored' });

      const existing = await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id = ?')
        .bind(update.update_id)
        .first();
      if (existing) return json({ status: 'duplicate_skipped' });

      const chatId = update.message?.chat?.id ? String(update.message.chat.id) : '';
      const cmd = (update.message?.text || '').split(' ')[0].toLowerCase();
      await env.DB.prepare('INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)')
        .bind(update.update_id, chatId, cmd)
        .run();

      if (chatId && env.TELEGRAM_BOT_TOKEN && cmd === '/start') {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '<b>SOFUMER</b> — AI-Powered Global Marketplace\n<i>Buy Smarter. Sell Faster.</i>',
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: 'Launch SOFUMER', web_app: { url: env.MINI_APP_URL || url.origin } }]],
            },
          }),
        });
      }
      return json({ status: 'processed' });
    }

    // Telegram Auth on Edge
    if (url.pathname === '/api/auth/telegram' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { initData?: string };
        const tgUser = await verifyTelegramInitDataEdge(body.initData || '', env.TELEGRAM_BOT_TOKEN);
        const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const rawToken = Array.from(tokenBytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const tokenHash = toHex(await hmacSha256(env.SESSION_SECRET, rawToken));

        const existing = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
          .bind(String(tgUser.id))
          .first<{ id: string }>();

        let userId = existing?.id;
        if (!userId) {
          userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          await env.DB.prepare(
            `INSERT INTO users (id, telegram_id, telegram_username, first_name, display_name) VALUES (?, ?, ?, ?, ?)`
          )
            .bind(userId, String(tgUser.id), tgUser.username || '', tgUser.first_name || 'Member', tgUser.first_name || 'Member')
            .run();
        }

        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, session_type, expires_at) VALUES (?, ?, ?, 'telegram', ?)`
        )
          .bind(
            `sess_${crypto.randomUUID().slice(0, 12)}`,
            userId,
            tokenHash,
            new Date(Date.now() + 7 * 86400_000).toISOString()
          )
          .run();

        return json(
          { authenticated: true, token: rawToken },
          200,
          { 'Set-Cookie': `sofumer_session=${rawToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800` }
        );
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'Auth failed' }, 401);
      }
    }

    // Cloudflare Workers AI Routes (`/api/ai/*`) using native `env.AI` binding
    if (url.pathname.startsWith('/api/ai/')) {
      const userId = await authenticateEdgeRequest(request, env);
      if (!userId) {
        return json({ error: 'Authentication required. Please launch SOFUMER via Telegram.' }, 401);
      }

      if (url.pathname === '/api/ai/status' && request.method === 'GET') {
        const featuresRes = await env.DB.prepare(
          'SELECT feature_key, label, is_enabled, daily_limit_per_user, model_name FROM ai_feature_settings'
        ).all();
        const check = await checkEdgeAiPermission(env, userId, 'buyer_search');
        return json({
          allowed: check.allowed,
          reason: check.reason || null,
          dailyLimit: check.dailyLimit,
          usedToday: check.usedToday,
          modelName: check.modelName,
          features: featuresRes.results,
        });
      }

      if (url.pathname === '/api/ai/buyer/discover' && request.method === 'POST') {
        const start = Date.now();
        const body = (await request.json().catch(() => ({}))) as { query?: string };
        const query = String(body.query || '').trim().slice(0, 600);
        if (!query) return json({ error: 'Search prompt is required.' }, 400);

        const perm = await checkEdgeAiPermission(env, userId, 'buyer_search');
        if (!perm.allowed) {
          await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
          return json({ error: perm.reason || 'AI access denied' }, 403);
        }

        const catalogRes = await env.DB.prepare(
          `SELECT p.id, p.title, p.description, p.price, p.currency, p.listing_type, p.condition,
                  p.country_code, p.international_shipping, c.name as category_name, s.name as shop_name
           FROM products p
           JOIN categories c ON c.id = p.category_id
           JOIN shops s ON s.id = p.shop_id
           WHERE p.status = 'published' AND s.status = 'active'
           ORDER BY p.is_featured DESC, p.created_at DESC LIMIT 120`
        ).all<Record<string, unknown>>();
        const catalog = catalogRes.results;

        try {
          const raw = await runEdgeAi(
            env,
            perm.modelName,
            [
              {
                role: 'system',
                content:
                  'You are the SOFUMER Marketplace AI Shopping Assistant. STRICT RULE: Only reference products present in the provided SOFUMER catalog JSON. NEVER invent products, prices, ratings, or sellers. Respond ONLY with valid JSON: {"answer": string, "matchedProductIds": string[], "suggestedFollowUps": string[]}.',
              },
              {
                role: 'user',
                content: `Buyer query: "${query}"\n\nCatalog JSON:\n${JSON.stringify(catalog)}`,
              },
            ],
            true
          );
          const parsed = parseJsonFromAi(raw);
          const validIds = new Set(catalog.map((c) => String(c.id)));
          const matchedIds = Array.isArray(parsed.matchedProductIds)
            ? parsed.matchedProductIds.filter((id: unknown) => validIds.has(String(id)))
            : [];
          const matchedProducts = catalog.filter((c) => matchedIds.includes(String(c.id)));

          await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'success', Date.now() - start, Math.ceil(raw.length / 4));
          return json({
            answer: String(parsed.answer || ''),
            matchedProducts,
            suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) ? parsed.suggestedFollowUps.slice(0, 3) : [],
            catalogCount: catalog.length,
            provider: 'cloudflare-workers-ai',
            model: perm.modelName,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Workers AI error';
          await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, msg);
          return json({ error: msg }, 502);
        }
      }

      if (url.pathname === '/api/ai/buyer/compare' && request.method === 'POST') {
        const start = Date.now();
        const body = (await request.json().catch(() => ({}))) as { productIds?: string[]; focusQuestion?: string };
        const productIds = Array.isArray(body.productIds) ? body.productIds.slice(0, 4) : [];
        if (!productIds.length) return json({ error: 'Select 1 to 4 listings to compare.' }, 400);

        const perm = await checkEdgeAiPermission(env, userId, 'buyer_compare');
        if (!perm.allowed) {
          await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, 'compare', 'denied', Date.now() - start, 0, perm.reason || 'Denied');
          return json({ error: perm.reason || 'AI access denied' }, 403);
        }

        const placeholders = productIds.map(() => '?').join(',');
        const productsRes = await env.DB.prepare(
          `SELECT p.*, c.name as category_name, s.name as shop_name FROM products p
           JOIN categories c ON c.id = p.category_id JOIN shops s ON s.id = p.shop_id
           WHERE p.id IN (${placeholders}) AND p.status = 'published'`
        )
          .bind(...productIds)
          .all<Record<string, unknown>>();
        if (!productsRes.results.length) return json({ error: 'No published listings found.' }, 404);

        try {
          const comparison = await runEdgeAi(env, perm.modelName, [
            {
              role: 'system',
              content: 'Compare real SOFUMER listings strictly using the provided JSON fields without inventing specs.',
            },
            {
              role: 'user',
              content: `Compare these listings.${body.focusQuestion ? ` Focus: ${body.focusQuestion}` : ''}\n${JSON.stringify(productsRes.results)}`,
            },
          ]);
          await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'success', Date.now() - start, Math.ceil(comparison.length / 4));
          return json({ comparison, products: productsRes.results, provider: 'cloudflare-workers-ai', model: perm.modelName });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Workers AI comparison error';
          await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, msg);
          return json({ error: msg }, 502);
        }
      }

      if (url.pathname === '/api/ai/seller/assist' && request.method === 'POST') {
        const start = Date.now();
        const body = (await request.json().catch(() => ({}))) as {
          action?: 'generate_listing' | 'translate' | 'analytics';
          title?: string;
          notes?: string;
          listingType?: string;
          targetLanguage?: string;
        };
        if (!body.action || !['generate_listing', 'translate', 'analytics'].includes(body.action)) {
          return json({ error: 'Invalid seller AI action.' }, 400);
        }

        const featureKey =
          body.action === 'translate'
            ? 'seller_translate'
            : body.action === 'analytics'
            ? 'seller_analytics'
            : 'seller_listing';

        const perm = await checkEdgeAiPermission(env, userId, featureKey);
        if (!perm.allowed) {
          await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.action, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
          return json({ error: perm.reason || 'AI access denied' }, 403);
        }

        try {
          if (body.action === 'translate') {
            const raw = await runEdgeAi(
              env,
              perm.modelName,
              [
                {
                  role: 'system',
                  content: 'Translate listing accurately. Respond ONLY with JSON: {"translatedTitle": string, "translatedDescription": string}.',
                },
                {
                  role: 'user',
                  content: `Target: ${body.targetLanguage || 'French'}\nTitle: ${body.title || ''}\nDescription: ${body.notes || ''}`,
                },
              ],
              true
            );
            await logEdgeAiUsage(env, userId, featureKey, perm.modelName, `translate:${body.targetLanguage}`, 'success', Date.now() - start, Math.ceil(raw.length / 4));
            return json(parseJsonFromAi(raw));
          }

          if (body.action === 'analytics') {
            const stats = await env.DB.prepare(
              `SELECT s.name,
                      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as published_products,
                      (SELECT COALESCE(SUM(view_count), 0) FROM products p WHERE p.shop_id = s.id) as total_views,
                      (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) as total_orders
               FROM shops s WHERE s.user_id = ? LIMIT 1`
            )
              .bind(userId)
              .first();
            const insights = await runEdgeAi(env, perm.modelName, [
              { role: 'system', content: 'Interpret real SOFUMER shop metrics without inventing numbers.' },
              { role: 'user', content: JSON.stringify(stats || {}) },
            ]);
            await logEdgeAiUsage(env, userId, featureKey, perm.modelName, 'shop_analytics', 'success', Date.now() - start, Math.ceil(insights.length / 4));
            return json({ insights, stats, provider: 'cloudflare-workers-ai', model: perm.modelName });
          }

          const cats = await env.DB.prepare('SELECT id, name FROM categories WHERE is_active = 1').all();
          const raw = await runEdgeAi(
            env,
            perm.modelName,
            [
              {
                role: 'system',
                content:
                  'Generate a seller listing draft for review. Respond ONLY with valid JSON: {"suggestedTitle": string, "improvedDescription": string, "suggestedCategoryId": string, "keywords": string[], "faqs": [{"question": string, "answer": string}]}.',
              },
              {
                role: 'user',
                content: `Type: ${body.listingType || 'physical'}\nTitle: ${body.title || ''}\nNotes: ${body.notes || ''}\nCategories: ${JSON.stringify(cats.results)}`,
              },
            ],
            true
          );
          await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.title || 'listing_draft', 'success', Date.now() - start, Math.ceil(raw.length / 4));
          return json(parseJsonFromAi(raw));
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Workers AI seller assist failed';
          await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.action, 'error', Date.now() - start, 0, msg);
          return json({ error: msg }, 502);
        }
      }

      if (url.pathname === '/api/ai/platform/support' && request.method === 'POST') {
        const start = Date.now();
        const body = (await request.json().catch(() => ({}))) as { question?: string };
        const question = String(body.question || '').trim().slice(0, 800);
        if (!question) return json({ error: 'Question is required.' }, 400);

        const perm = await checkEdgeAiPermission(env, userId, 'platform_support');
        if (!perm.allowed) {
          await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
          return json({ error: perm.reason || 'AI access denied' }, 403);
        }

        try {
          const reply = await runEdgeAi(env, perm.modelName, [
            {
              role: 'system',
              content:
                'You are SOFUMER Platform Support AI. Explain SOFUMER marketplace features accurately: direct buyer-to-seller transactions (no escrow), physical/digital/service listings, Free/Pro/Business plans, and listing moderation reporting.',
            },
            { role: 'user', content: question },
          ]);
          await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'success', Date.now() - start, Math.ceil(reply.length / 4));
          return json({ reply, provider: 'cloudflare-workers-ai', model: perm.modelName });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Workers AI support failed';
          await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, msg);
          return json({ error: msg }, 502);
        }
      }
    }

    // Bootstrap / Catalog read on Edge D1
    if (url.pathname === '/api/marketplace/bootstrap' && request.method === 'GET') {
      const [categories, countries, currencies, plans] = await Promise.all([
        env.DB.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC').all(),
        env.DB.prepare('SELECT * FROM countries WHERE is_enabled = 1 ORDER BY name ASC').all(),
        env.DB.prepare('SELECT * FROM currencies WHERE is_active = 1 ORDER BY code ASC').all(),
        env.DB.prepare('SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY monthly_price ASC').all(),
      ]);
      return json({
        categories: categories.results,
        countries: countries.results,
        currencies: currencies.results,
        plans: plans.results,
      });
    }

    // Serve SPA Assets
    return env.ASSETS.fetch(request);
  },
};
