/**
 * SOFUMER — AI-Powered Global Marketplace
 * Complete Cloudflare Workers Edge Runtime Entrypoint
 */
import {
  type Env,
  type ExecutionContextLike,
  hashSessionToken,
  html,
  json,
  methodNotAllowed,
  newId,
  parseJsonBody,
  requireEdgeUser,
  resolveEdgeUserSession,
  sanitizeText,
  sendTelegramBotMessageEdge,
  timingSafeEqualStr,
  verifyTelegramInitDataEdge,
} from './helpers.ts';
import { handleMarketplaceRoutes } from './routes-marketplace.ts';
import { handleSellerRoutes } from './routes-seller.ts';
import { handleCommerceAndAccountRoutes } from './routes-commerce.ts';
import { handleAdminRoutes } from './routes-admin.ts';
import { handleAiRoutes } from './routes-ai.ts';

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
    message?: { chat?: { id?: number }; text?: string };
  }>(request);
  if (!parsed.ok) return parsed.error;

  const update = parsed.data;
  const updateId = Number(update.update_id);
  if (!updateId) {
    return json({ status: 'ignored' }, 200);
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

        if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;

        const miniAppUrl = env.MINI_APP_URL || url.origin;
        if (cmd === '/start') {
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

async function handleAuthRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/auth/')) return null;

  if (url.pathname === '/api/auth/config') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json({
      botName: env.TELEGRAM_BOT_NAME || 'SOFUMER',
      botUsername: env.TELEGRAM_BOT_USERNAME || 'SofumerBot',
      miniAppUrl: env.MINI_APP_URL || url.origin,
      sandboxAvailable: env.ALLOW_DEV_SANDBOX === 'true',
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
    });
  }

  if (url.pathname === '/api/auth/telegram') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    if (!env.TELEGRAM_BOT_TOKEN) {
      return json(
        { error: 'TELEGRAM_BOT_TOKEN is not configured on the Worker.' },
        503
      );
    }
    if (!env.DB) {
      return json({ error: 'Database binding (DB) is not configured.' }, 503);
    }

    const parsed = await parseJsonBody<{ initData?: string }>(request);
    if (!parsed.ok) return parsed.error;

    try {
      const verified = await verifyTelegramInitDataEdge(
        typeof parsed.data.initData === 'string' ? parsed.data.initData : '',
        env.TELEGRAM_BOT_TOKEN
      );
      const tgUser = verified.user;
      const tgId = String(tgUser.id);

      const existing = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?')
        .bind(tgId)
        .first<Record<string, unknown>>();

      const displayName =
        [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
        tgUser.username ||
        `User ${tgId}`;

      let userId: string;
      if (!existing) {
        userId = newId('usr');
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
            sanitizeText(tgUser.photo_url || '', 300),
            sanitizeText(tgUser.language_code || 'en', 10)
          )
          .run();

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
          return json({ error: 'This account has been suspended by platform moderation.' }, 403);
        }
        await env.DB.prepare(
          `UPDATE users
           SET telegram_username = ?, first_name = ?, last_name = ?, last_login_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        )
          .bind(
            sanitizeText(tgUser.username || '', 64),
            sanitizeText(tgUser.first_name || String(existing.first_name), 64),
            sanitizeText(tgUser.last_name || '', 64),
            userId
          )
          .run();
      }

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const rawToken = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const tokenHash = await hashSessionToken(rawToken, env);
      const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

      await env.DB.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, session_type, ip_address, user_agent, expires_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?)`
      )
        .bind(
          newId('sess'),
          userId,
          tokenHash,
          request.headers.get('CF-Connecting-IP') || '',
          (request.headers.get('User-Agent') || '').slice(0, 200),
          expiresAt
        )
        .run();

      return json(
        { authenticated: true, token: rawToken, expiresAt },
        200,
        {
          'Set-Cookie': `sofumer_session=${rawToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`,
        }
      );
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : 'Telegram authentication failed' },
        401
      );
    }
  }

  if (url.pathname === '/api/auth/dev-sandbox') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    if (env.ALLOW_DEV_SANDBOX !== 'true') {
      return json({ error: 'Sandbox authentication is disabled in production.' }, 403);
    }
    return json({ error: 'Use Telegram Mini App authentication in Workers production.' }, 403);
  }

  if (url.pathname === '/api/auth/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const user = await resolveEdgeUserSession(request, env);
    if (!user || !env.DB) {
      return json({ authenticated: false, user: null });
    }

    const sellerProfile = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
      .bind(user.id)
      .first<Record<string, unknown>>();
    const shop = sellerProfile
      ? await env.DB.prepare('SELECT * FROM shops WHERE seller_id = ?').bind(sellerProfile.id).first()
      : null;

    const [unreadMsgs, unreadNotifs, favorites, aiPerm] = await Promise.all([
      env.DB.prepare(
        'SELECT COALESCE(SUM(unread_count), 0) as cnt FROM conversation_participants WHERE user_id = ?'
      )
        .bind(user.id)
        .first<{ cnt: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR scope = 'global') AND is_read = 0"
      )
        .bind(user.id)
        .first<{ cnt: number }>(),
      env.DB.prepare('SELECT product_id FROM product_favorites WHERE user_id = ?')
        .bind(user.id)
        .all<{ product_id: string }>(),
      env.DB.prepare('SELECT ai_enabled FROM ai_permissions WHERE user_id = ?')
        .bind(user.id)
        .first<{ ai_enabled: number }>(),
    ]);

    return json({
      authenticated: true,
      user: {
        ...user,
        aiEnabled: aiPerm ? Boolean(aiPerm.ai_enabled) : true,
      },
      sellerProfile: sellerProfile || null,
      shop: shop || null,
      unreadMessages: unreadMsgs?.cnt || 0,
      unreadNotifications: unreadNotifs?.cnt || 0,
      favoriteProductIds: favorites.results.map((f) => f.product_id),
    });
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
      { 'Set-Cookie': 'sofumer_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0' }
    );
  }

  return json({ error: 'Auth API endpoint not found.' }, 404);
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

      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return json({
          service: 'SOFUMER',
          slogan: 'BUY SMARTER. SELL FASTER.',
          runtime: 'cloudflare-workers',
          aiProvider: 'cloudflare-workers-ai',
          aiModel: env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct',
          telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
          dbBound: Boolean(env.DB),
          aiBound: Boolean(env.AI),
          status: 'ok',
        });
      }

      if (url.pathname === '/api/telegram/webhook') {
        return await handleTelegramWebhook(request, env, url, ctx);
      }

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
