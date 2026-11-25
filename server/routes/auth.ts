import { Router, type Request } from 'express';
import { db, newId } from '../db.ts';
import {
  getJwtSecret,
  hashSessionId,
  rateLimit,
  requireAuth,
  resolveAdminContext,
  resolveUserSessionDetailed,
  sanitizeSafeUrl,
  sanitizeText,
  signJwt,
  verifyTelegramInitData,
} from '../security.ts';
import { getTelegramBotConfig, getTelegramBotInfo } from '../telegram.ts';

export const authRouter = Router();

const AUTH_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
};

function createSessionForTelegramUser(
  req: Request,
  tgUser: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
  },
  ipAddress: string,
  userAgent: string
) {
  const tgId = String(tgUser.id);
  const isAdmin = Boolean(resolveAdminContext(tgId));
  const existing = db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .get(tgId) as Record<string, unknown> | undefined;

  const displayName = [tgUser.first_name, tgUser.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || tgUser.username || `User ${tgId}`;

  const safePhotoUrl = sanitizeSafeUrl(tgUser.photo_url || '', 300);

  let userId: string;
  if (!existing) {
    userId = newId('usr');
    db.prepare(
      `INSERT INTO users (id, telegram_id, telegram_username, first_name, last_name, display_name, avatar_url, preferred_language, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      userId,
      tgId,
      sanitizeText(tgUser.username || '', 64),
      sanitizeText(tgUser.first_name || 'Member', 64),
      sanitizeText(tgUser.last_name || '', 64),
      sanitizeText(displayName, 80),
      safePhotoUrl,
      sanitizeText(tgUser.language_code || 'en', 10)
    );
    db.prepare(
      `INSERT OR IGNORE INTO ai_permissions (user_id, ai_enabled) VALUES (?, 1)`
    ).run(userId);
    if (!isAdmin) {
      db.prepare(
        `INSERT OR IGNORE INTO user_roles (id, user_id, role, granted_by) VALUES (?, ?, 'buyer', 'telegram_auth')`
      ).run(newId('role'), userId);
    }
  } else {
    userId = String(existing.id);
    if (existing.status === 'suspended') {
      throw Object.assign(new Error('This account has been suspended by platform moderation.'), {
        statusCode: 403,
      });
    }
    db.prepare(
      `UPDATE users
       SET telegram_username = ?, first_name = ?, last_name = ?, avatar_url = CASE WHEN ? != '' THEN ? ELSE avatar_url END, last_login_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      sanitizeText(tgUser.username || '', 64),
      sanitizeText(tgUser.first_name || String(existing.first_name), 64),
      sanitizeText(tgUser.last_name || '', 64),
      safePhotoUrl,
      safePhotoUrl,
      userId
    );
  }

  if (isAdmin) {
    db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role = 'buyer'").run(userId);
  }

  const existingSess = resolveUserSessionDetailed(req);
  let sessionId: string | null = null;
  if (existingSess.user && existingSess.user.id === userId && existingSess.user.sessionType === 'telegram') {
    sessionId = existingSess.user.sessionId;
  } else {
    const recentRow = db
      .prepare(
        `SELECT id, expires_at FROM sessions
         WHERE user_id = ? AND session_type = 'telegram' AND revoked_at IS NULL
           AND user_agent = ? AND created_at >= datetime('now', '-10 minutes')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId, userAgent.slice(0, 200)) as { id: string; expires_at: string } | undefined;
    if (recentRow && new Date(recentRow.expires_at).getTime() > Date.now()) {
      sessionId = recentRow.id;
    }
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (sessionId) {
    db.prepare('UPDATE sessions SET expires_at = ?, ip_address = ? WHERE id = ?').run(
      expiresAt,
      ipAddress,
      sessionId
    );
  } else {
    sessionId = newId('sess');
    const tokenHash = hashSessionId(sessionId);
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, session_type, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, 'telegram', ?, ?, ?)`
    ).run(sessionId, userId, tokenHash, ipAddress, userAgent.slice(0, 200), expiresAt);
  }

  const jwtToken = signJwt({ sub: userId, tid: tgId, sid: sessionId, adm: isAdmin }, 7 * 86400);

  return { userId, jwtToken, expiresAt, isAdmin };
}

authRouter.get('/config', async (req, res) => {
  res.set(AUTH_NO_STORE_HEADERS);
  const cfg = getTelegramBotConfig();
  const botInfo = await getTelegramBotInfo();
  const origin = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  res.json({
    botName: botInfo.botName,
    botUsername: botInfo.botUsername,
    miniAppUrl: cfg.miniAppUrl || origin,
    launchUrl: botInfo.botUsername ? `https://t.me/${botInfo.botUsername}?startapp` : null,
    telegramConfigured: Boolean(cfg.botToken),
    jwtConfigured: Boolean(getJwtSecret()),
    telegramOnly: true,
  });
});

// Official Telegram Mini App authentication
authRouter.post('/telegram', rateLimit(30, 60_000, 'auth'), (req, res) => {
  res.set(AUTH_NO_STORE_HEADERS);
  const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
  const botToken = getTelegramBotConfig().botToken;
  if (!botToken) {
    return res.status(503).json({
      error: 'TELEGRAM_BOT_TOKEN is not configured on the server.',
      diagnostics: { receivedInitData: false, signatureVerified: false, sessionCreated: false },
    });
  }
  if (!getJwtSecret()) {
    return res.status(503).json({
      error: 'JWT_SECRET is not configured on the server.',
      diagnostics: { receivedInitData: false, signatureVerified: false, sessionCreated: false },
    });
  }

  try {
    const verified = verifyTelegramInitData(initData, botToken);
    const { jwtToken, expiresAt, isAdmin } = createSessionForTelegramUser(
      req,
      verified.user,
      req.ip || '',
      String(req.headers['user-agent'] || '')
    );

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('sofumer_session', jwtToken, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      ...(isHttps ? { partitioned: true } : {}),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      authenticated: true,
      token: jwtToken,
      expiresAt,
      isAdmin,
      mode: isAdmin ? 'admin' : 'marketplace',
      diagnostics: {
        receivedInitData: initData.length > 0,
        initDataLength: initData.length,
        signatureVerified: true,
        sessionCreated: true,
      },
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 401;
    return res.status(status).json({
      error: err instanceof Error ? err.message : 'Telegram authentication failed',
      diagnostics: {
        receivedInitData: initData.length > 0,
        initDataLength: initData.length,
        signatureVerified: false,
        sessionCreated: false,
      },
    });
  }
});

authRouter.get('/me', (req, res) => {
  res.set(AUTH_NO_STORE_HEADERS);
  const sessionRes = resolveUserSessionDetailed(req);
  if (!sessionRes.user || sessionRes.reason === 'user_suspended') {
    const reason = sessionRes.reason || 'missing_token';
    const status =
      reason === 'jwt_secret_missing'
        ? 503
        : reason === 'db_error'
        ? 500
        : reason === 'user_suspended'
        ? 403
        : 401;
    return res.status(status).json({
      authenticated: false,
      user: null,
      reason,
      error:
        reason === 'user_suspended'
          ? 'Your account is currently suspended.'
          : 'Authentication session could not be verified.',
      diagnostics: {
        tokenSource: sessionRes.tokenSource,
        hasBearer: sessionRes.hasBearer,
        hasCookie: sessionRes.hasCookie,
        jwtConfigured: Boolean(getJwtSecret()),
      },
    });
  }
  const user = sessionRes.user;



  const sellerProfile = db
    .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .get(user.id) as Record<string, unknown> | undefined;

  const shop = sellerProfile
    ? (db
        .prepare("SELECT * FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
        .get(sellerProfile.id) as Record<string, unknown> | undefined)
    : undefined;

  const unreadMessagesRow = db
    .prepare('SELECT COALESCE(SUM(unread_count), 0) as cnt FROM conversation_participants WHERE user_id = ? AND is_hidden = 0')
    .get(user.id) as { cnt: number };

  const unreadNotifsRow = db
    .prepare("SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR scope = 'global') AND is_read = 0")
    .get(user.id) as { cnt: number };

  const favoriteRows = db
    .prepare('SELECT product_id FROM product_favorites WHERE user_id = ?')
    .all(user.id) as { product_id: string }[];

  const aiPerm = db
    .prepare('SELECT ai_enabled FROM ai_permissions WHERE user_id = ?')
    .get(user.id) as { ai_enabled: number } | undefined;

  res.json({
    authenticated: true,
    mode: 'marketplace',
    user: {
      ...user,
      mode: 'marketplace',
      aiEnabled: aiPerm ? Boolean(aiPerm.ai_enabled) : true,
    },
    sellerProfile: sellerProfile || null,
    shop: shop || null,
    unreadMessages: unreadMessagesRow.cnt,
    unreadNotifications: unreadNotifsRow.cnt,
    favoriteProductIds: favoriteRows.map((f) => f.product_id),
  });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  if (req.authUser?.sessionId) {
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(
      req.authUser.sessionId
    );
  }
  res.clearCookie('sofumer_session', { sameSite: 'none', secure: true, partitioned: true });
  res.json({ loggedOut: true });
});
