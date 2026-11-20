import { Router } from 'express';
import crypto from 'crypto';
import { db, newId } from '../db.ts';
import {
  buildSignedSandboxInitData,
  getSessionSecret,
  hashToken,
  optionalAuth,
  rateLimit,
  requireAuth,
  sanitizeText,
  verifyTelegramInitData,
} from '../security.ts';
import { getTelegramBotConfig } from '../telegram.ts';

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
  sessionType: 'telegram' | 'sandbox',
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
      sanitizeText(tgUser.photo_url || '', 300),
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
       SET telegram_username = ?, first_name = ?, last_name = ?, last_login_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      sanitizeText(tgUser.username || '', 64),
      sanitizeText(tgUser.first_name || String(existing.first_name), 64),
      sanitizeText(tgUser.last_name || '', 64),
      userId
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, session_type, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('sess'), userId, tokenHash, sessionType, ipAddress, userAgent.slice(0, 200), expiresAt);

  return { userId, rawToken, expiresAt };
}

authRouter.get('/config', (_req, res) => {
  const cfg = getTelegramBotConfig();
  const sandboxAllowed =
    process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_SANDBOX !== 'false';
  res.json({
    botName: cfg.botName,
    botUsername: cfg.botUsername,
    miniAppUrl: cfg.miniAppUrl,
    sandboxAvailable: sandboxAllowed,
  });
});

// Official Telegram Mini App authentication
authRouter.post('/telegram', rateLimit(30, 60_000, 'auth'), (req, res) => {
  const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
  const botToken = getTelegramBotConfig().botToken;
  if (!botToken) {
    return res.status(503).json({
      error: 'SOFUMER Telegram Bot token is not configured on the server yet.',
    });
  }

  try {
    const verified = verifyTelegramInitData(initData, botToken);
    const { rawToken, expiresAt } = createSessionForTelegramUser(
      verified.user,
      'telegram',
      req.ip || '',
      String(req.headers['user-agent'] || '')
    );

    res.cookie('sofumer_session', rawToken, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ authenticated: true, token: rawToken, expiresAt });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 401;
    return res.status(status).json({
      error: err instanceof Error ? err.message : 'Telegram authentication failed',
    });
  }
});

// Non-production cryptographic Telegram sandbox session for browser preview testing
authRouter.post('/dev-sandbox', rateLimit(20, 60_000, 'auth'), (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_SANDBOX === 'false') {
    return res.status(403).json({ error: 'Sandbox authentication is disabled in production.' });
  }

  const label = sanitizeText(req.body?.name || 'Preview Buyer', 40) || 'Preview Buyer';
  const handle = sanitizeText(req.body?.handle || 'preview_member', 32).replace(/[^a-zA-Z0-9_]/g, '') || 'preview_member';
  const numericId = Number(
    BigInt('0x' + crypto.createHash('sha256').update(handle).digest('hex').slice(0, 10)) % 900000000n + 100000000n
  );

  const sandboxBotSecret = getSessionSecret();
  const signedInitData = buildSignedSandboxInitData(
    {
      id: numericId,
      first_name: label.split(' ')[0] || 'Member',
      last_name: label.split(' ').slice(1).join(' ') || '',
      username: handle,
      language_code: 'en',
    },
    sandboxBotSecret
  );

  // Verify through the exact same cryptographic HMAC-SHA256 verification function
  const verified = verifyTelegramInitData(signedInitData, sandboxBotSecret);
  const { rawToken, expiresAt } = createSessionForTelegramUser(
    verified.user,
    'sandbox',
    req.ip || '',
    String(req.headers['user-agent'] || '')
  );

  res.cookie('sofumer_session', rawToken, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({ authenticated: true, token: rawToken, expiresAt, mode: 'sandbox' });
});

authRouter.get('/me', optionalAuth, (req, res) => {
  if (!req.authUser) {
    return res.json({ authenticated: false, user: null });
  }
  const user = req.authUser;

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
    .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR scope = \'global\') AND is_read = 0')
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
  res.clearCookie('sofumer_session', { sameSite: 'none', secure: true });
  res.json({ loggedOut: true });
});
