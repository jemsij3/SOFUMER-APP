import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, newId } from './db.ts';

// Runtime-ephemeral secret fallback only for local dev when SESSION_SECRET env is omitted.
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || EPHEMERAL_DEV_SECRET;
}

export function getAdminBootstrapSecret(): string {
  if (process.env.ADMIN_BOOTSTRAP_SECRET) {
    return process.env.ADMIN_BOOTSTRAP_SECRET;
  }
  // In development/AI Studio preview, derive a deterministic workspace admin passcode only when env is unset,
  // and mark it clearly as requiring explicit production configuration.
  return process.env.NODE_ENV === 'production' ? '' : 'SOFUMER-DEV-ADMIN-2026';
}

export function hashToken(token: string): string {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(token)
    .digest('hex');
}

export interface TelegramInitUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface VerifiedTelegramInitData {
  user: TelegramInitUser;
  authDate: number;
  queryId?: string;
}

/**
 * Official Telegram Mini App initData verification procedure:
 * 1. Parse URLSearchParams, extract `hash`, sort remaining key=value pairs alphabetically.
 * 2. Compute secret_key = HMAC_SHA256("WebAppData", bot_token).
 * 3. Compute expected_hash = HMAC_SHA256(secret_key, data_check_string).
 * 4. Constant-time compare expected_hash === hash and verify auth_date freshness.
 */
export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds = 86400
): VerifiedTelegramInitData {
  if (!initDataRaw || !botToken) {
    throw new Error('Missing Telegram initData or bot token');
  }

  const params = new URLSearchParams(initDataRaw);
  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-f]{64}$/i.test(providedHash)) {
    throw new Error('Invalid Telegram signature format');
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(providedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Telegram initData signature verification failed');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > maxAgeSeconds || authDate - nowSec > 300) {
    throw new Error('Telegram authentication timestamp expired');
  }

  const userJson = params.get('user');
  if (!userJson) {
    throw new Error('Telegram user payload missing');
  }

  const user = JSON.parse(userJson) as TelegramInitUser;
  if (!user || typeof user.id !== 'number') {
    throw new Error('Invalid Telegram user identity');
  }

  return {
    user,
    authDate,
    queryId: params.get('query_id') || undefined,
  };
}

/**
 * Generates a cryptographically valid signed Telegram initData payload for dev sandbox verification.
 * Uses the exact same HMAC-SHA256 signing procedure so the real verifier runs end-to-end.
 */
export function buildSignedSandboxInitData(
  tgUser: TelegramInitUser,
  botToken: string
): string {
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `sandbox_${crypto.randomBytes(6).toString('hex')}`);
  params.set('user', JSON.stringify(tgUser));

  const pairs: string[] = [];
  params.forEach((value, key) => pairs.push(`${key}=${value}`));
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  params.set('hash', hash);
  return params.toString();
}

export interface AuthUser {
  id: string;
  telegram_id: string;
  telegram_username: string;
  first_name: string;
  last_name: string;
  display_name: string;
  avatar_url: string;
  bio: string;
  phone: string;
  country_code: string;
  preferred_currency: string;
  preferred_language: string;
  status: string;
  roles: string[];
  sessionType: string;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      adminSession?: {
        sessionId: string;
        adminIdentifier: string;
        role: string;
      };
    }
  }
}

export function extractBearerOrCookie(req: Request, cookieName: string): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const parts = rawCookie.split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === cookieName) {
          return decodeURIComponent(v);
        }
      }
    }
  }
  return null;
}

export function resolveUserSession(req: Request): AuthUser | null {
  const token = extractBearerOrCookie(req, 'sofumer_session');
  if (!token) return null;
  const tokenHash = hashToken(token);

  const row = db
    .prepare(
      `SELECT s.id as session_id, s.session_type, s.expires_at, s.revoked_at,
              u.id, u.telegram_id, u.telegram_username, u.first_name, u.last_name,
              u.display_name, u.avatar_url, u.bio, u.phone, u.country_code,
              u.preferred_currency, u.preferred_language, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as Record<string, string | null> | undefined;

  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }

  const roleRows = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ?')
    .all(row.id) as { role: string }[];

  return {
    id: String(row.id),
    telegram_id: String(row.telegram_id),
    telegram_username: String(row.telegram_username || ''),
    first_name: String(row.first_name || ''),
    last_name: String(row.last_name || ''),
    display_name: String(row.display_name || ''),
    avatar_url: String(row.avatar_url || ''),
    bio: String(row.bio || ''),
    phone: String(row.phone || ''),
    country_code: String(row.country_code || 'US'),
    preferred_currency: String(row.preferred_currency || 'USD'),
    preferred_language: String(row.preferred_language || 'en'),
    status: String(row.status || 'active'),
    roles: roleRows.map((r) => r.role),
    sessionType: String(row.session_type || 'telegram'),
    sessionId: String(row.session_id),
  };
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.authUser = resolveUserSession(req) || undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = resolveUserSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required. Please launch SOFUMER via Telegram.' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Your account is currently suspended.' });
  }
  req.authUser = user;
  next();
}

export function requireSeller(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = req.authUser!;
    const seller = db
      .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
      .get(user.id) as Record<string, unknown> | undefined;
    if (!seller) {
      return res.status(403).json({ error: 'Seller profile required. Please register as a seller first.' });
    }
    if (seller.status === 'suspended') {
      return res.status(403).json({ error: 'Seller account is suspended.' });
    }
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminToken = extractBearerOrCookie(req, 'sofumer_admin_session');
  if (!adminToken) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  const tokenHash = hashToken(adminToken);
  const session = db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.display_name, u.telegram_username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.session_type = 'admin'`
    )
    .get(tokenHash) as Record<string, string | null> | undefined;

  if (!session || session.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked admin session.' });
  }
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Admin session expired.' });
  }

  const roles = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ?')
    .all(session.user_id) as { role: string }[];
  const adminRole = roles.find((r) =>
    ['super_admin', 'admin', 'moderator'].includes(r.role)
  );
  if (!adminRole) {
    return res.status(403).json({ error: 'Insufficient administrative privileges.' });
  }

  req.adminSession = {
    sessionId: String(session.id),
    adminIdentifier: String(session.telegram_username || session.display_name || session.user_id),
    role: adminRole.role,
  };
  next();
}

// Simple sliding-window in-memory rate limiter for API protection
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number, scope = 'api') {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${req.authUser?.id || req.ip || 'anon'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests. Please slow down and try again shortly.',
      });
    }
    bucket.count += 1;
    next();
  };
}

export function sanitizeText(value: unknown, maxLen = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

export function checkProhibitedKeywords(text: string): string[] {
  const row = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'prohibited_keywords'")
    .get() as { value: string } | undefined;
  if (!row || !row.value) return [];
  const lower = text.toLowerCase();
  return row.value
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && lower.includes(k));
}

export function recordAdminAudit(
  adminIdentifier: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
  ipAddress = ''
) {
  db.prepare(
    `INSERT INTO admin_audit_logs (id, admin_identifier, action, target_type, target_id, details_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('audit'),
    adminIdentifier,
    action,
    targetType,
    targetId,
    JSON.stringify(details),
    ipAddress
  );
}
