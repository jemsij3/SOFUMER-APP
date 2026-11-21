import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, newId } from './db.ts';

// Runtime-ephemeral secret fallback only for local non-production dev when JWT_SECRET is omitted.
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

export function getJwtSecret(): string {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? '' : EPHEMERAL_DEV_SECRET;
}

export function isTelegramIdAdmin(telegramId: string): boolean {
  const raw = process.env.ADMIN_TELEGRAM_IDS || '';
  const target = telegramId.trim();
  if (!target || !/^\d+$/.test(target) || !raw) return false;

  const allowedIds = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));

  const targetBuf = Buffer.from(target, 'utf8');
  for (const allowed of allowedIds) {
    const allowedBuf = Buffer.from(allowed, 'utf8');
    if (targetBuf.length === allowedBuf.length && crypto.timingSafeEqual(targetBuf, allowedBuf)) {
      return true;
    }
  }
  return false;
}

export function hashSessionId(sessionId: string): string {
  const secret = getJwtSecret() || EPHEMERAL_DEV_SECRET;
  return crypto.createHmac('sha256', secret).update(sessionId).digest('hex');
}

export interface JwtClaims {
  sub: string;
  tid: string;
  sid: string;
  adm: boolean;
  iat: number;
  exp: number;
}

export function signJwt(
  claims: Omit<JwtClaims, 'iat' | 'exp'>,
  ttlSeconds = 7 * 86400
): string {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error('JWT_SECRET is not configured on the server.');
  }
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: JwtClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(fullClaims)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sigB64}`;
}

export function verifyJwt(token: string): JwtClaims | null {
  const secret = getJwtSecret();
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSigB64 = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  const a = Buffer.from(sigB64, 'utf8');
  const b = Buffer.from(expectedSigB64, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;

    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Partial<JwtClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.tid !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= now
    ) {
      return null;
    }
    return {
      sub: claims.sub,
      tid: claims.tid,
      sid: claims.sid,
      adm: Boolean(claims.adm),
      iat: Number(claims.iat || 0),
      exp: claims.exp,
    };
  } catch {
    return null;
  }
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
 * Generates a cryptographically signed Telegram initData payload (used by automated tests).
 */
export function buildSignedTelegramInitData(
  tgUser: TelegramInitUser,
  botToken: string
): string {
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `tg_${crypto.randomBytes(6).toString('hex')}`);
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
  isAdmin: boolean;
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
        userId: string;
        telegramId: string;
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

  const claims = verifyJwt(token);
  if (!claims) return null;

  const row = db
    .prepare(
      `SELECT s.id as session_id, s.session_type, s.expires_at, s.revoked_at,
              u.id, u.telegram_id, u.telegram_username, u.first_name, u.last_name,
              u.display_name, u.avatar_url, u.bio, u.phone, u.country_code,
              u.preferred_currency, u.preferred_language, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.user_id = ?`
    )
    .get(claims.sid, claims.sub) as Record<string, string | null> | undefined;

  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  if (String(row.telegram_id) !== claims.tid) {
    return null;
  }

  const tgId = String(row.telegram_id);
  const roleRows = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ?')
    .all(row.id) as { role: string }[];

  return {
    id: String(row.id),
    telegram_id: tgId,
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
    isAdmin: isTelegramIdAdmin(tgId),
    roles: roleRows.map((r) => r.role),
    sessionType: String(row.session_type || 'telegram'),
    sessionId: String(row.session_id),
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = resolveUserSession(req);
  if (!user) {
    return res
      .status(401)
      .json({ error: 'Telegram authentication required. Open SOFUMER inside its official Telegram Mini App.' });
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
  requireAuth(req, res, () => {
    const user = req.authUser!;
    if (!isTelegramIdAdmin(user.telegram_id)) {
      return res.status(403).json({
        error: 'Administrator privileges required. Your Telegram ID is not authorized in ADMIN_TELEGRAM_IDS.',
      });
    }
    req.adminSession = {
      sessionId: user.sessionId,
      userId: user.id,
      telegramId: user.telegram_id,
      adminIdentifier: user.telegram_username
        ? `@${user.telegram_username}`
        : user.display_name || user.telegram_id,
      role: 'super_admin',
    };
    next();
  });
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
