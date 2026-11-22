import { Router } from 'express';
import { db, newId } from '../db.ts';
import {
  getJwtSecret,
  hashSessionId,
  isTelegramIdAdmin,
  rateLimit,
  requireAuth,
  resolveUserSession,
  sanitizeSafeUrl,
  sanitizeText,
  signJwt,
  verifyTelegramInitData,
} from '../security.ts';
import { getTelegramBotConfig, getTelegramBotInfo } from '../telegram.ts';

export const authRouter = Router();

function createSessionForTelegramUser(
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
      `INSERT OR IGNORE INTO user_roles (id, user_id, role, granted_by) VALUES (?, ?, 'buyer', 'telegram_auth')`
    ).run(newId('role'), userId);
    db.prepare(
      `INSERT OR IGNORE INTO ai_permissions (user_id, ai_enabled) VALUES (?, 1)`
    ).run(userId);
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

  const sessionId = newId('sess');
  const tokenHash = hashSessionId(sessionId);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, session_type, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, 'telegram', ?, ?, ?)`
  ).run(sessionId, userId, tokenHash, ipAddress, userAgent.slice(0, 200), expiresAt);

  const isAdmin = isTelegramIdAdmin(tgId);
  const jwtToken = signJwt({ sub: userId, tid: tgId, sid: sessionId, adm: isAdmin }, 7 * 86400);

  return { userId, jwtToken, expiresAt, isAdmin };
}

authRouter.get('/config', async (req, res) => {
  const cfg = getTelegramBotConfig();
  const botInfo = await getTelegramBotInfo();
  const origin = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  res.json({
    botName: botInfo.botName,
    botUsername: botInfo.botUsername,
    miniAppUrl: cfg.miniAppUrl || origin,
    telegramConfigured: Boolean(cfg.botToken),
    jwtConfigured: Boolean(getJwtSecret()),
    telegramOnly: true,
  });
});

// Official Telegram Mini App authentication
authRouter.post('/telegram', rateLimit(30, 60_000, 'auth'), (req, res) => {
  const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
  const botToken = getTelegramBotConfig().botToken;
  if (!botToken) {
    return res.status(503).json({
      error: 'TELEGRAM_BOT_TOKEN is not configured on the server.',
    });
  }
  if (!getJwtSecret()) {
    return res.status(503).json({
      error: 'JWT_SECRET is not configured on the server.',
    });
  }

  try {
    const verified = verifyTelegramInitData(initData, botToken);
    const { jwtToken, expiresAt, isAdmin } = createSessionForTelegramUser(
      verified.user,
      req.ip || '',
      String(req.headers['user-agent'] || '')
    );

    res.cookie('sofumer_session', jwtToken, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      partitioned: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ authenticated: true, token: jwtToken, expiresAt, isAdmin });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 401;
    return res.status(status).json({
      error: err instanceof Error ? err.message : 'Telegram authentication failed',
    });
  }
});

authRouter.get('/me', (req, res) => {
  const user = resolveUserSession(req);
  if (!user) {
    return res.json({ authenticated: false, user: null });
  }

  const sellerProfile = db
    .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .get(user.id) as Record<string, unknown> | undefined;

  const shop = sellerProfile
    ? (db.prepare('SELECT * FROM shops WHERE seller_id = ?').get(sellerProfile.id) as Record<string, unknown> | undefined)
    : undefined;

  const unreadMessagesRow = db
    .prepare('SELECT COALESCE(SUM(unread_count), 0) as cnt FROM conversation_participants WHERE user_id = ?')
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
    user: {
      ...user,
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
