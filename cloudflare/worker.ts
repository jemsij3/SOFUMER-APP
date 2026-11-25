/**
 * SOFUMER — AI-Powered Global Marketplace
 * Complete Cloudflare Workers Edge Runtime Entrypoint
 */
import {
  type Env,
  type ExecutionContextLike,
  type TelegramPreCheckoutQuery,
  type TelegramSuccessfulPayment,
  DEFAULT_CF_AI_MODEL,
  VALID_CF_MODELS,
  checkEdgeRateLimit,
  ensureTelegramMenuButtonEdge,
  fulfillStarsPreCheckoutEdge,
  fulfillStarsSuccessfulPaymentEdge,
  getTelegramBotInfoEdge,
  hashSessionIdentifier,
  html,
  json,
  methodNotAllowed,
  newId,
  parseJsonBody,
  requireEdgeUser,
  resolveEdgeAdminContext,
  resolveEdgeUserSessionDetailed,
  resolveSafeMiniAppUrlEdge,
  sanitizeSafeUrl,
  sanitizeText,
  sendTelegramBotMessageEdge,
  signJwtEdge,
  timingSafeEqualStr,
  verifyCookieCsrfEdge,
  verifyTelegramInitDataEdge,
} from './helpers.ts';
import { handleMarketplaceRoutes } from './routes-marketplace.ts';
import { handleSellerRoutes } from './routes-seller.ts';
import { handleCommerceAndAccountRoutes } from './routes-commerce.ts';
import { handleAdminRoutes } from './routes-admin.ts';
import { handleAiRoutes } from './routes-ai.ts';
import { ensureD1Schema, isD1Initialized } from './d1-bootstrap.ts';

export type { Env, D1Database, WorkersAiBinding } from './helpers.ts';

const SOFUMER_FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SOFUMER — AI-Powered Global Marketplace</title>
    <meta name="description" content="Buy Smarter. Sell Faster. Global AI-powered multi-vendor marketplace Telegram Mini App." />
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body style="background:#070B14;color:#F8FAFC;font-family:system-ui,sans-serif;margin:0;padding:24px;">
    <main style="max-width:680px;margin:48px auto;padding:28px;border:1px solid #1E293B;border-radius:16px;background:#0E1525;">
      <h1 style="margin:0 0 8px;font-size:24px;">SOFUMER</h1>
      <p style="margin:0 0 12px;color:#94A3B8;">AI-Powered Global Marketplace — Buy Smarter. Sell Faster.</p>
      <p style="margin:0;color:#CBD5E1;font-size:14px;">Frontend static bundle (./dist) is not built or bound yet. Run <code>npm run build</code> before <code>npx wrangler deploy</code>.</p>
    </main>
  </body>
</html>`;

async function handleTelegramWebhook(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContextLike
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return json(
      { error: 'TELEGRAM_WEBHOOK_SECRET is not configured on the Worker.' },
      503
    );
  }

  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secretHeader || !timingSafeEqualStr(secretHeader, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: 'Unauthorized webhook request.' }, 401);
  }

  const parsed = await parseJsonBody<{
    update_id?: number;
    pre_checkout_query?: TelegramPreCheckoutQuery;
    message?: {
      chat?: { id?: number };
      from?: { id?: number };
      text?: string;
      successful_payment?: TelegramSuccessfulPayment;
    };
  }>(request);
  if (!parsed.ok) return parsed.error;

  const update = parsed.data;
  const updateId = Number(update.update_id);

  // Telegram requires pre_checkout_query to be answered synchronously within 10 seconds
  if (update.pre_checkout_query?.id) {
    const result = await fulfillStarsPreCheckoutEdge(env, update.pre_checkout_query);
    if (env.DB && updateId) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)'
      )
        .bind(
          updateId,
          String(update.pre_checkout_query.from?.id || ''),
          result.valid ? 'pre_checkout_ok' : 'pre_checkout_rejected'
        )
        .run();
    }
    return json({ status: 'pre_checkout_answered', valid: result.valid, updateId: updateId || null }, 200);
  }

  if (!updateId) {
    return json({ status: 'ignored' }, 200);
  }

  if (update.message?.successful_payment) {
    if (env.DB) {
      const existing = await env.DB.prepare(
        'SELECT update_id FROM telegram_updates WHERE update_id = ?'
      )
        .bind(updateId)
        .first();
      if (existing) {
        return json({ status: 'duplicate_skipped', updateId }, 200);
      }
      const chatId = update.message.chat?.id ? String(update.message.chat.id) : '';
      const payerId = update.message.from?.id ? String(update.message.from.id) : chatId;
      await env.DB.prepare(
        'INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)'
      )
        .bind(updateId, chatId, 'successful_payment')
        .run();
      const fulfillment = await fulfillStarsSuccessfulPaymentEdge(
        env,
        update.message.successful_payment,
        payerId,
        url.origin
      );
      return json({ status: 'payment_processed', paymentStatus: fulfillment.status, updateId }, 200);
    }
  }

  const processUpdate = async () => {
    try {
      if (env.DB) {
        const existing = await env.DB.prepare(
          'SELECT update_id FROM telegram_updates WHERE update_id = ?'
        )
          .bind(updateId)
          .first();
        if (existing) return;

        const chatId = update.message?.chat?.id ? String(update.message.chat.id) : '';
        const text = String(update.message?.text || '').trim();
        const cmd = text.startsWith('/') ? text.split(' ')[0].toLowerCase() : '';

        await env.DB.prepare(
          'INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)'
        )
          .bind(updateId, chatId, cmd)
          .run();

        if (!chatId || !(env.TELEGRAM_BOT_TOKEN || '').trim()) return;

        const miniAppUrl = resolveSafeMiniAppUrlEdge(env, url.origin) || url.origin;
        if (cmd === '/start') {
          await ensureTelegramMenuButtonEdge(env, miniAppUrl);
          await sendTelegramBotMessageEdge(
            env,
            chatId,
            '<b>SOFUMER</b> — AI-Powered Global Marketplace\n<i>Buy Smarter. Sell Faster.</i>\n\nDiscover physical goods, digital products, software, and professional services worldwide.',
            { label: 'Launch SOFUMER Marketplace', url: miniAppUrl }
          );
        } else if (cmd === '/sell') {
          await sendTelegramBotMessageEdge(
            env,
            chatId,
            'Launch your global storefront on <b>SOFUMER</b>. List physical products, digital downloads, or services directly.',
            { label: 'Open Seller Center', url: `${miniAppUrl}?tab=account&view=seller` }
          );
        } else if (cmd === '/explore') {
          await sendTelegramBotMessageEdge(
            env,
            chatId,
            'Browse global categories, verified shops, and AI-assisted product discovery on <b>SOFUMER</b>.',
            { label: 'Explore Marketplace', url: `${miniAppUrl}?tab=explore` }
          );
        } else if (cmd === '/help') {
          await sendTelegramBotMessageEdge(
            env,
            chatId,
            '<b>SOFUMER Help</b>\n\n/start — Open SOFUMER Mini App\n/explore — Browse global listings\n/sell — Open Seller Center',
            { label: 'Open SOFUMER', url: miniAppUrl }
          );
        }
      }
    } catch (err) {
      console.error('Telegram background update processing error:', err instanceof Error ? err.message : 'unknown');
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(processUpdate());
  } else {
    await processUpdate();
  }

  return json({ status: 'accepted', updateId }, 200);
}

const AUTH_NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
};

function buildSessionCookie(token: string, isHttps: boolean, maxAgeSeconds: number): string {
  if (isHttps) {
    return `sofumer_session=${token}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${maxAgeSeconds}`;
  }
  return `sofumer_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

async function handleAuthRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/auth/')) return null;

  const isHttps = url.protocol === 'https:' || request.headers.get('X-Forwarded-Proto') === 'https';

  if (url.pathname === '/api/auth/config') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const botInfo = await getTelegramBotInfoEdge(env);
    const miniAppUrl = resolveSafeMiniAppUrlEdge(env, url.origin) || url.origin;
    return json(
      {
        botName: botInfo.botName,
        botUsername: botInfo.botUsername,
        miniAppUrl,
        launchUrl: botInfo.botUsername ? `https://t.me/${botInfo.botUsername}?startapp` : null,
        telegramConfigured: Boolean((env.TELEGRAM_BOT_TOKEN || '').trim()),
        jwtConfigured: Boolean((env.JWT_SECRET || '').trim()),
        telegramOnly: true,
      },
      200,
      AUTH_NO_STORE_HEADERS
    );
  }

  if (url.pathname === '/api/auth/telegram') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const rateRes = await checkEdgeRateLimit(request, env, 'auth', 60, 60);
    if (rateRes) return rateRes;

    const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken) {
      return json(
        {
          error: 'TELEGRAM_BOT_TOKEN is not configured on the Worker.',
          diagnostics: { receivedInitData: false, signatureVerified: false, sessionCreated: false },
        },
        503,
        AUTH_NO_STORE_HEADERS
      );
    }
    const jwtSecret = (env.JWT_SECRET || '').trim();
    if (!jwtSecret) {
      return json(
        {
          error: 'JWT_SECRET is not configured on the Worker.',
          diagnostics: { receivedInitData: false, signatureVerified: false, sessionCreated: false },
        },
        503,
        AUTH_NO_STORE_HEADERS
      );
    }
    if (!env.DB) {
      return json({ error: 'Database binding (DB) is not configured.' }, 503, AUTH_NO_STORE_HEADERS);
    }

    const parsed = await parseJsonBody<{ initData?: string }>(request);
    if (!parsed.ok) return parsed.error;

    const rawInitData = typeof parsed.data.initData === 'string' ? parsed.data.initData : '';
    const receivedInitData = rawInitData.length > 0;
    const paramKeys: string[] = [];
    if (receivedInitData) {
      try {
        new URLSearchParams(rawInitData).forEach((_v, k) => {
          paramKeys.push(k === 'hash' ? 'hash(present)' : k);
        });
      } catch {
        // Ignore parse failure here; verifyTelegramInitDataEdge reports exact error
      }
    }
    console.info(
      '[SOFUMER Worker Auth]',
      JSON.stringify({
        stage: 'E_received',
        receivedInitData,
        initDataLength: rawInitData.length,
        keys: paramKeys,
      })
    );

    try {
      const verified = await verifyTelegramInitDataEdge(rawInitData, botToken);
      const tgUser = verified.user;
      const tgId = String(tgUser.id);
      const adminCtx = await resolveEdgeAdminContext(env, tgId);
      const isAdmin = Boolean(adminCtx);

      let existing = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?')
        .bind(tgId)
        .first<Record<string, unknown>>();

      const displayName =
        [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
        tgUser.username ||
        `User ${tgId}`;

      const safePhotoUrl = sanitizeSafeUrl(tgUser.photo_url || '', 300);

      let userId: string;
      if (!existing) {
        userId = newId('usr');
        try {
          await env.DB.prepare(
            `INSERT INTO users (id, telegram_id, telegram_username, first_name, last_name, display_name, avatar_url, preferred_language, last_login_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
            .bind(
              userId,
              tgId,
              sanitizeText(tgUser.username || '', 64),
              sanitizeText(tgUser.first_name || 'Member', 64),
              sanitizeText(tgUser.last_name || '', 64),
              sanitizeText(displayName, 80),
              safePhotoUrl,
              sanitizeText(tgUser.language_code || 'en', 10)
            )
            .run();
        } catch {
          existing = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?')
            .bind(tgId)
            .first<Record<string, unknown>>();
          if (!existing) {
            throw new Error('Failed to create or retrieve user account.');
          }
          userId = String(existing.id);
        }

        await env.DB.prepare(
          `INSERT OR IGNORE INTO user_roles (id, user_id, role, granted_by) VALUES (?, ?, 'buyer', 'telegram_auth')`
        )
          .bind(newId('role'), userId)
          .run();

        await env.DB.prepare(`INSERT OR IGNORE INTO ai_permissions (user_id, ai_enabled) VALUES (?, 1)`)
          .bind(userId)
          .run();
      } else {
        userId = String(existing.id);
        if (existing.status === 'suspended') {
          return json(
            { error: 'This account has been suspended by platform moderation.' },
            403,
            AUTH_NO_STORE_HEADERS
          );
        }
        await env.DB.prepare(
          `UPDATE users
           SET telegram_username = ?, first_name = ?, last_name = ?, avatar_url = CASE WHEN ? != '' THEN ? ELSE avatar_url END, last_login_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        )
          .bind(
            sanitizeText(tgUser.username || '', 64),
            sanitizeText(tgUser.first_name || String(existing.first_name), 64),
            sanitizeText(tgUser.last_name || '', 64),
            safePhotoUrl,
            safePhotoUrl,
            userId
          )
          .run();
      }

      const clientIp = request.headers.get('CF-Connecting-IP') || '';
      const userAgent = (request.headers.get('User-Agent') || '').slice(0, 200);
      const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

      // Reuse an active session for the same user on Retry / reload instead of creating duplicates
      let sessionId: string | null = null;
      const currentSess = await resolveEdgeUserSessionDetailed(request, env);
      if (currentSess.user && currentSess.user.id === userId && currentSess.user.sessionType === 'telegram') {
        sessionId = currentSess.user.sessionId;
      } else {
        const recentRow = await env.DB.prepare(
          `SELECT id, expires_at FROM sessions
           WHERE user_id = ?
             AND session_type = 'telegram'
             AND revoked_at IS NULL
             AND user_agent = ?
             AND created_at >= datetime('now', '-10 minutes')
           ORDER BY created_at DESC
           LIMIT 1`
        )
          .bind(userId, userAgent)
          .first<{ id: string; expires_at: string }>();
        if (recentRow && new Date(recentRow.expires_at).getTime() > Date.now()) {
          sessionId = recentRow.id;
        }
      }

      if (sessionId) {
        await env.DB.prepare('UPDATE sessions SET expires_at = ?, ip_address = ? WHERE id = ?')
          .bind(expiresAt, clientIp, sessionId)
          .run();
      } else {
        sessionId = newId('sess');
        const tokenHash = await hashSessionIdentifier(sessionId, jwtSecret);
        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, session_type, ip_address, user_agent, expires_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?)`
        )
          .bind(sessionId, userId, tokenHash, clientIp, userAgent, expiresAt)
          .run();
      }

      const jwtToken = await signJwtEdge(
        { sub: userId, tid: tgId, sid: sessionId, adm: isAdmin },
        jwtSecret,
        7 * 86400
      );

      console.info(
        '[SOFUMER Worker Auth]',
        JSON.stringify({
          stage: 'G_session_created',
          receivedInitData: true,
          signatureVerified: true,
          sessionCreated: true,
          isAdmin,
        })
      );

      return json(
        {
          authenticated: true,
          token: jwtToken,
          expiresAt,
          isAdmin,
          diagnostics: {
            receivedInitData: true,
            initDataLength: rawInitData.length,
            signatureVerified: true,
            sessionCreated: true,
          },
        },
        200,
        {
          ...AUTH_NO_STORE_HEADERS,
          'Set-Cookie': buildSessionCookie(jwtToken, isHttps, 604800),
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Telegram authentication failed';
      console.warn(
        '[SOFUMER Worker Auth]',
        JSON.stringify({
          stage: 'F_verification_failed',
          receivedInitData,
          initDataLength: rawInitData.length,
          signatureVerified: false,
          reason: msg,
        })
      );
      if (msg === 'Telegram initData signature mismatch') {
        const botInfo = await getTelegramBotInfoEdge(env);
        if (botInfo.botUsername) {
          return json(
            {
              error: `Telegram initData signature mismatch. Server bot token belongs to @${botInfo.botUsername} — verify the Mini App was launched from @${botInfo.botUsername}.`,
              diagnostics: {
                receivedInitData,
                initDataLength: rawInitData.length,
                signatureVerified: false,
                sessionCreated: false,
                botUsername: botInfo.botUsername,
              },
            },
            401,
            AUTH_NO_STORE_HEADERS
          );
        }
      }
      return json(
        {
          error: msg,
          diagnostics: {
            receivedInitData,
            initDataLength: rawInitData.length,
            signatureVerified: false,
            sessionCreated: false,
          },
        },
        401,
        AUTH_NO_STORE_HEADERS
      );
    }
  }

  if (url.pathname === '/api/auth/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const sessionRes = await resolveEdgeUserSessionDetailed(request, env);

    if (!sessionRes.user || sessionRes.reason === 'user_suspended' || !env.DB) {
      const reason = !env.DB ? 'db_not_configured' : sessionRes.reason || 'missing_token';
      const status =
        reason === 'db_not_configured' || reason === 'jwt_secret_missing'
          ? 503
          : reason === 'db_error'
          ? 500
          : reason === 'user_suspended'
          ? 403
          : 401;

      const errorMessages: Record<string, string> = {
        db_not_configured: 'Database binding (DB) is not configured.',
        jwt_secret_missing: 'JWT_SECRET is not configured on the Worker.',
        missing_token: 'No active session token or cookie was received.',
        invalid_jwt: 'Session token signature or expiration check failed.',
        session_not_found: 'Session record was not found in the database.',
        session_revoked: 'Session has been revoked.',
        session_expired: 'Session has expired.',
        telegram_id_mismatch: 'Session identity mismatch.',
        user_suspended: 'Your account is currently suspended.',
        db_error: 'Database lookup failed while checking your session.',
      };

      console.warn(
        '[SOFUMER Worker /api/auth/me]',
        JSON.stringify({
          authenticated: false,
          status,
          reason,
          tokenSource: sessionRes.tokenSource,
          hasBearer: sessionRes.hasBearer,
          hasCookie: sessionRes.hasCookie,
        })
      );

      return json(
        {
          authenticated: false,
          user: null,
          reason,
          error: errorMessages[reason] || 'Authentication session could not be verified.',
          diagnostics: {
            tokenSource: sessionRes.tokenSource,
            hasBearer: sessionRes.hasBearer,
            hasCookie: sessionRes.hasCookie,
            jwtConfigured: Boolean((env.JWT_SECRET || '').trim()),
          },
        },
        status,
        AUTH_NO_STORE_HEADERS
      );
    }

    const user = sessionRes.user;
    const db = env.DB;

    const safeQuery = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    };

    const sellerProfile = await safeQuery(
      () =>
        db
          .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
          .bind(user.id)
          .first<Record<string, unknown>>(),
      null
    );
    const shop = sellerProfile
      ? await safeQuery(
          () =>
            db
              .prepare(
                "SELECT * FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1"
              )
              .bind(sellerProfile.id)
              .first(),
          null
        )
      : null;

    const [unreadMsgs, unreadNotifs, favorites, aiPerm] = await Promise.all([
      safeQuery(async () => {
        try {
          return await db
            .prepare(
              'SELECT COALESCE(SUM(unread_count), 0) as cnt FROM conversation_participants WHERE user_id = ? AND is_hidden = 0'
            )
            .bind(user.id)
            .first<{ cnt: number }>();
        } catch {
          return await db
            .prepare(
              'SELECT COALESCE(SUM(unread_count), 0) as cnt FROM conversation_participants WHERE user_id = ?'
            )
            .bind(user.id)
            .first<{ cnt: number }>();
        }
      }, { cnt: 0 }),
      safeQuery(
        () =>
          db
            .prepare(
              "SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR scope = 'global') AND is_read = 0"
            )
            .bind(user.id)
            .first<{ cnt: number }>(),
        { cnt: 0 }
      ),
      safeQuery(
        () =>
          db
            .prepare('SELECT product_id FROM product_favorites WHERE user_id = ?')
            .bind(user.id)
            .all<{ product_id: string }>(),
        { results: [] as Array<{ product_id: string }> }
      ),
      safeQuery(
        () =>
          db
            .prepare('SELECT ai_enabled FROM ai_permissions WHERE user_id = ?')
            .bind(user.id)
            .first<{ ai_enabled: number }>(),
        null
      ),
    ]);

    return json(
      {
        authenticated: true,
        user: {
          ...user,
          aiEnabled: aiPerm ? Boolean(aiPerm.ai_enabled) : true,
        },
        sellerProfile: sellerProfile || null,
        shop: shop || null,
        unreadMessages: unreadMsgs?.cnt || 0,
        unreadNotifications: unreadNotifs?.cnt || 0,
        favoriteProductIds: (favorites?.results || []).map((f) => f.product_id),
      },
      200,
      AUTH_NO_STORE_HEADERS
    );
  }

  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    await env.DB!.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?")
      .bind(auth.user.sessionId)
      .run();
    return json(
      { loggedOut: true },
      200,
      {
        ...AUTH_NO_STORE_HEADERS,
        'Set-Cookie': buildSessionCookie('', isHttps, 0),
      }
    );
  }

  return json({ error: 'Auth API endpoint not found.' }, 404, AUTH_NO_STORE_HEADERS);
}

async function handleMediaRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (url.pathname.startsWith('/r2/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return methodNotAllowed(['GET', 'HEAD']);
    }
    // Never allow public exposure of private digital asset keys under /r2/digital/*
    if (url.pathname.startsWith('/r2/digital/')) {
      return json({ error: 'Protected digital assets require authenticated order delivery.' }, 403);
    }
    return json({ error: 'Media storage (R2) is currently disabled and will be added later.' }, 404);
  }

  if (url.pathname === '/api/uploads') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    return json(
      { error: 'Media upload storage (R2) is temporarily disabled and will be added later.' },
      503
    );
  }

  return null;
}

async function handleFrontendAssets(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(['GET', 'HEAD']);
  }

  if (env.ASSETS) {
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status !== 404) {
      const contentType = assetRes.headers.get('Content-Type') || '';
      if (contentType.includes('text/html')) {
        const headers = new Headers(assetRes.headers);
        headers.set('Content-Type', 'text/html;charset=UTF-8');
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(assetRes.body, { status: assetRes.status, headers });
      }
      return assetRes;
    }

    // SPA fallback to index.html for client navigation routes
    const indexRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString(), request));
    if (indexRes.status === 200) {
      const headers = new Headers(indexRes.headers);
      headers.set('Content-Type', 'text/html;charset=UTF-8');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(indexRes.body, { status: 200, headers });
    }
  }

  return html(SOFUMER_FALLBACK_HTML, 200);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (env.DB && url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
        const schemaOk = await ensureD1Schema(env.DB);
        if (!schemaOk) {
          return json({ error: 'Database schema initialization failed. Please retry shortly.' }, 503);
        }
      }

      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        const dbInitialized = await isD1Initialized(env.DB);
        return json({
          service: 'SOFUMER',
          slogan: 'BUY SMARTER. SELL FASTER.',
          runtime: 'cloudflare-workers',
          aiProvider: 'cloudflare-workers-ai',
          aiModel: VALID_CF_MODELS.has(env.CLOUDFLARE_AI_MODEL || '')
            ? env.CLOUDFLARE_AI_MODEL
            : DEFAULT_CF_AI_MODEL,
          telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
          dbBound: Boolean(env.DB),
          dbInitialized,
          aiBound: Boolean(env.AI),
          status: 'ok',
        });
      }

      if (url.pathname === '/api/telegram/webhook') {
        return await handleTelegramWebhook(request, env, url, ctx);
      }

      const csrfErr = verifyCookieCsrfEdge(request, env, url);
      if (csrfErr) return csrfErr;

      const mediaResp = await handleMediaRoutes(request, env, url);
      if (mediaResp) return mediaResp;

      const authResp = await handleAuthRoutes(request, env, url);
      if (authResp) return authResp;

      const mktResp = await handleMarketplaceRoutes(request, env, url);
      if (mktResp) return mktResp;

      const sellerResp = await handleSellerRoutes(request, env, url);
      if (sellerResp) return sellerResp;

      const commerceResp = await handleCommerceAndAccountRoutes(request, env, url);
      if (commerceResp) return commerceResp;

      const aiResp = await handleAiRoutes(request, env, url);
      if (aiResp) return aiResp;

      const adminResp = await handleAdminRoutes(request, env, url);
      if (adminResp) return adminResp;

      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'API endpoint not found.' }, 404);
      }

      return await handleFrontendAssets(request, env, url);
    } catch (err) {
      // Never leak secrets or internal stack traces to HTTP clients
      console.error('Unhandled SOFUMER Worker error:', err instanceof Error ? err.message : 'unknown');
      return json({ error: 'Internal server error.' }, 500);
    }
  },
};
