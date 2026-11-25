import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, newId } from './db.ts';

// Runtime-ephemeral secret fallback only for local non-production dev when JWT_SECRET is omitted.
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

import { DEFAULT_CF_AI_MODEL, VALID_CF_MODELS } from '../cloudflare/ai-normalizer.ts';

export { DEFAULT_CF_AI_MODEL, VALID_CF_MODELS };

export const ADMIN_PERMISSION_CATALOG = [
  { key: '*', label: 'Full Platform Owner', description: 'Unrestricted access to every system capability and RBAC management' },
  { key: 'overview.view', label: 'Dashboard Overview', description: 'View marketplace KPIs and operational counters' },
  { key: 'analytics.view', label: 'Marketplace Analytics', description: 'View catalog, order, revenue, and AI telemetry breakdowns' },
  { key: 'users.manage', label: 'Users & Per-User AI Access', description: 'Restrict or suspend users and override per-user AI quotas' },
  { key: 'sellers.manage', label: 'Sellers & Verification', description: 'Approve shop verifications, feature shops, and manage seller profiles' },
  { key: 'sellers.suspend', label: 'Seller Suspension', description: 'Suspend or reactivate seller profiles and storefronts' },
  { key: 'shops.manage', label: 'Shops Governance', description: 'Manage public storefronts and featured status' },
  { key: 'moderation.manage', label: 'Product Moderation & AI Scan', description: 'Approve, reject, feature, or AI-scan marketplace listings' },
  { key: 'catalog.manage', label: 'Categories & Subcategories', description: 'Create, rename, and toggle marketplace categories' },
  { key: 'orders.manage', label: 'Orders & Disputes', description: 'Inspect marketplace orders and disputed transactions' },
  { key: 'reports.manage', label: 'Abuse Reports', description: 'Investigate and resolve user/listing reports' },
  { key: 'reviews.manage', label: 'Reviews Moderation', description: 'Publish, hide, or remove marketplace product reviews' },
  { key: 'messages.moderate', label: 'Message Investigation', description: 'Inspect flagged buyer-seller conversations' },
  { key: 'monetization.manage', label: 'Subscriptions, Promos & Revenue', description: 'Edit plans, Stars pricing, promotions, and inspect ledgers' },
  { key: 'ai.manage', label: 'AI Model & Feature Control', description: 'Configure active Cloudflare Workers AI models and daily limits' },
  { key: 'countries.manage', label: 'Countries & Currencies', description: 'Toggle supported countries and edit shipping/verification notes' },
  { key: 'support.manage', label: 'Support Tickets', description: 'Respond to and resolve user support requests' },
  { key: 'notifications.manage', label: 'Global Notifications', description: 'Send announcements and inspect broadcast history' },
  { key: 'settings.manage', label: 'Platform Settings', description: 'Edit platform switches, Stars conversion rate, promo pricing, and keywords' },
  { key: 'rbac.manage', label: 'Admin Roles & Permissions', description: 'Manage admin roles, permissions, and Telegram ID assignments' },
  { key: 'audit.view', label: 'Audit Logs (View)', description: 'Inspect administrative audit trail' },
  { key: 'audit.manage', label: 'Audit Logs Lifecycle', description: 'Configure retention, archive older logs, and delete eligible non-critical audit logs' },
] as const;

export const VALID_PERMISSION_KEYS = new Set<string>(ADMIN_PERMISSION_CATALOG.map((p) => p.key));
export const OWNER_ONLY_PERMISSIONS = new Set<string>(['*', 'rbac.manage', 'settings.manage', 'ai.manage', 'audit.manage']);

export function isAuditActionProtected(action: string): boolean {
  const act = String(action || '').toLowerCase();
  if (!act) return false;
  if (
    act.startsWith('audit.') ||
    act.startsWith('rbac.') ||
    act.startsWith('setting') ||
    act.startsWith('plan.') ||
    act.startsWith('ai.') ||
    act.startsWith('shop.deleted')
  ) {
    return true;
  }
  return [
    'user.status_updated',
    'seller.updated',
    'promotion.updated',
    'notification.broadcast',
    'notification.deleted',
    'order.status_updated',
  ].includes(act);
}

export const PAID_ORDER_STATUSES = ['Confirmed', 'Processing', 'Shipped', 'Delivered', 'Completed'] as const;

export function getJwtSecret(): string {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? '' : EPHEMERAL_DEV_SECRET;
}

export function isTelegramIdAdmin(telegramId: string): boolean {
  const raw = [process.env.ADMIN_TELEGRAM_IDS, process.env.ADMIN_TELEGRAM_ID].filter(Boolean).join(',');
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
  const cleanBotToken = typeof botToken === 'string' ? botToken.trim() : '';
  if (typeof initDataRaw !== 'string' || !initDataRaw || !cleanBotToken) {
    throw new Error('Missing Telegram initData or bot token');
  }

  const params = new URLSearchParams(initDataRaw);
  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-f]{64}$/i.test(providedHash)) {
    throw new Error('Invalid Telegram signature format');
  }

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      entries.push([key, value]);
    }
  });
  entries.sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(cleanBotToken)
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
  if (
    !Number.isFinite(authDate) ||
    authDate <= 0 ||
    nowSec - authDate > maxAgeSeconds ||
    authDate - nowSec > 300
  ) {
    throw new Error('Telegram authentication timestamp expired');
  }

  const userJson = params.get('user');
  if (!userJson) {
    throw new Error('Telegram user payload missing');
  }

  let user: TelegramInitUser;
  try {
    user = JSON.parse(userJson) as TelegramInitUser;
  } catch {
    throw new Error('Invalid Telegram user identity');
  }
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
  const cleanBotToken = typeof botToken === 'string' ? botToken.trim() : '';
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `tg_${crypto.randomBytes(6).toString('hex')}`);
  params.set('user', JSON.stringify(tgUser));

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  entries.sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(cleanBotToken)
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
  mode?: 'admin' | 'marketplace';
  adminRole?: string;
  adminPermissions?: string[];
  roles: string[];
  sessionType: string;
  sessionId: string;
}

export interface AdminContext {
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  isOwner: boolean;
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
        roleId: string;
        roleName: string;
        permissions: string[];
        isOwner: boolean;
      };
    }
  }
}

export interface SessionTokenCandidate {
  token: string;
  source: 'bearer' | 'cookie';
}

export function extractAllSessionTokens(
  req: Request,
  cookieName: string
): SessionTokenCandidate[] {
  const candidates: SessionTokenCandidate[] = [];
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && bearerMatch[1]) {
    const token = bearerMatch[1].trim();
    if (token) candidates.push({ token, source: 'bearer' });
  }
  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const parts = rawCookie.split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === cookieName && v) {
          let decoded = v;
          try {
            decoded = decodeURIComponent(v);
          } catch {
            decoded = v;
          }
          if (decoded && !candidates.some((c) => c.token === decoded)) {
            candidates.push({ token: decoded, source: 'cookie' });
          }
        }
      }
    }
  }
  return candidates;
}

export function extractBearerOrCookie(req: Request, cookieName: string): string | null {
  const candidates = extractAllSessionTokens(req, cookieName);
  return candidates.length > 0 ? candidates[0].token : null;
}

export function resolveAdminContext(telegramId: string): AdminContext | null {
  const tgId = String(telegramId || '').trim();
  if (!/^\d+$/.test(tgId)) return null;

  if (isTelegramIdAdmin(tgId)) {
    return {
      roleId: 'role_owner',
      roleCode: 'OWNER',
      roleName: 'Platform Owner',
      permissions: ['*'],
      isOwner: true,
    };
  }

  try {
    const assignment = db
      .prepare(
        `SELECT ara.role_id, ar.code as role_code, ar.name as role_name
         FROM admin_role_assignments ara
         JOIN admin_roles ar ON ar.id = ara.role_id
         WHERE ara.telegram_id = ? AND ara.is_active = 1
         LIMIT 1`
      )
      .get(tgId) as { role_id: string; role_code: string; role_name: string } | undefined;

    if (!assignment) return null;

    const permsRows = db
      .prepare('SELECT permission_key FROM admin_permissions WHERE role_id = ?')
      .all(assignment.role_id) as Array<{ permission_key: string }>;
    const permissions = permsRows.map((p) => p.permission_key);
    const isOwner = assignment.role_code === 'OWNER' || permissions.includes('*');

    return {
      roleId: assignment.role_id,
      roleCode: assignment.role_code,
      roleName: assignment.role_name,
      permissions,
      isOwner,
    };
  } catch {
    return null;
  }
}

export function hasAdminPermission(
  admin: { isOwner: boolean; permissions: string[] },
  required?: string | string[]
): boolean {
  if (!required) return true;
  if (admin.isOwner || admin.permissions.includes('*')) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.some((perm) => admin.permissions.includes(perm));
}

export type SessionFailureReason =
  | 'jwt_secret_missing'
  | 'missing_token'
  | 'invalid_jwt'
  | 'session_not_found'
  | 'session_revoked'
  | 'session_expired'
  | 'telegram_id_mismatch'
  | 'user_suspended'
  | 'db_error';

export interface NodeSessionResolution {
  user: AuthUser | null;
  reason: SessionFailureReason | null;
  tokenSource: 'bearer' | 'cookie' | 'none';
  hasBearer: boolean;
  hasCookie: boolean;
}

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(' ', 'T') + 'Z'
    : trimmed;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function resolveUserSessionDetailed(req: Request): NodeSessionResolution {
  const candidates = extractAllSessionTokens(req, 'sofumer_session');
  const hasBearer = candidates.some((c) => c.source === 'bearer');
  const hasCookie = candidates.some((c) => c.source === 'cookie');

  if (!getJwtSecret()) {
    return { user: null, reason: 'jwt_secret_missing', tokenSource: 'none', hasBearer, hasCookie };
  }
  if (candidates.length === 0) {
    return { user: null, reason: 'missing_token', tokenSource: 'none', hasBearer, hasCookie };
  }

  let lastReason: SessionFailureReason = 'invalid_jwt';
  let lastSource: 'bearer' | 'cookie' | 'none' = candidates[0].source;

  for (const candidate of candidates) {
    lastSource = candidate.source;
    const claims = verifyJwt(candidate.token);
    if (!claims) {
      lastReason = 'invalid_jwt';
      continue;
    }

    let row: Record<string, string | null> | undefined;
    try {
      row = db
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
    } catch {
      return { user: null, reason: 'db_error', tokenSource: candidate.source, hasBearer, hasCookie };
    }

    if (!row) {
      lastReason = 'session_not_found';
      continue;
    }
    if (row.revoked_at) {
      lastReason = 'session_revoked';
      continue;
    }
    const expMs = parseTimestampMs(row.expires_at);
    if (expMs !== null && expMs < Date.now()) {
      lastReason = 'session_expired';
      continue;
    }
    if (String(row.telegram_id) !== claims.tid) {
      lastReason = 'telegram_id_mismatch';
      continue;
    }

    const tgId = String(row.telegram_id);
    const adminCtx = resolveAdminContext(tgId);
    const isAdmin = Boolean(adminCtx);
    const roleRows = isAdmin
      ? []
      : (db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(row.id) as { role: string }[]);

    const user: AuthUser = {
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
      isAdmin,
      mode: isAdmin ? 'admin' : 'marketplace',
      adminRole: adminCtx?.roleCode,
      adminPermissions: adminCtx?.permissions,
      roles: isAdmin ? [] : roleRows.map((r) => r.role),
      sessionType: String(row.session_type || 'telegram'),
      sessionId: String(row.session_id),
    };

    if (user.status === 'suspended') {
      return { user, reason: 'user_suspended', tokenSource: candidate.source, hasBearer, hasCookie };
    }

    return { user, reason: null, tokenSource: candidate.source, hasBearer, hasCookie };
  }

  return { user: null, reason: lastReason, tokenSource: lastSource, hasBearer, hasCookie };
}

export function resolveUserSession(req: Request): AuthUser | null {
  return resolveUserSessionDetailed(req).user;
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

export const ADMIN_EXCLUSIVE_MODE_ERROR =
  'Administrator accounts operate exclusively in Governance Mode and cannot use buyer or seller marketplace endpoints.';

export function requireNonAdminMarketplaceUser(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    next();
  });
}

export function requireSeller(req: Request, res: Response, next: NextFunction) {
  requireNonAdminMarketplaceUser(req, res, () => {
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
    const activeShop = db
      .prepare("SELECT id FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
      .get(seller.id);
    if (!activeShop) {
      return res.status(403).json({ error: 'Active shop required. Register a new storefront to manage seller tools.' });
    }
    next();
  });
}

export function requireAdminPermission(requiredPermission?: string | string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, () => {
      const user = req.authUser!;
      const adminCtx = resolveAdminContext(user.telegram_id);
      if (!adminCtx) {
        return res.status(403).json({
          error:
            'Administrator privileges required. Your Telegram ID is not authorized in ADMIN_TELEGRAM_IDS or active admin role assignments.',
        });
      }
      const adminSession = {
        sessionId: user.sessionId,
        userId: user.id,
        telegramId: user.telegram_id,
        adminIdentifier: user.telegram_username
          ? `@${user.telegram_username}`
          : user.display_name || user.telegram_id,
        role: adminCtx.roleCode,
        roleId: adminCtx.roleId,
        roleName: adminCtx.roleName,
        permissions: adminCtx.permissions,
        isOwner: adminCtx.isOwner,
      };
      if (requiredPermission && !hasAdminPermission(adminSession, requiredPermission)) {
        return res.status(403).json({
          error: 'Insufficient administrative permissions for this operation.',
          requiredPermission,
        });
      }
      req.adminSession = adminSession;
      next();
    });
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  return requireAdminPermission()(req, res, next);
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

export function isSafeUrlOrEmpty(value: unknown, maxLen = 400): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const cleaned = sanitizeText(value, maxLen);
  if (!cleaned) return true;
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) {
    return !/[\s<>"'`]/.test(cleaned);
  }
  try {
    const parsed = new URL(cleaned);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function sanitizeSafeUrl(value: unknown, maxLen = 400): string {
  if (typeof value !== 'string') return '';
  const cleaned = sanitizeText(value, maxLen);
  if (!cleaned) return '';
  return isSafeUrlOrEmpty(cleaned, maxLen) ? cleaned : '';
}

export function escapeSqlLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function verifyCookieCsrf(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/telegram/webhook' || req.path === '/api/auth/telegram') return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim()) {
    return next();
  }

  const rawCookie = req.headers.cookie || '';
  if (!rawCookie.includes('sofumer_session=')) {
    return next();
  }

  const reqOrigin = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  const allowedOrigins = new Set<string>([reqOrigin]);
  const miniAppUrl = process.env.MINI_APP_URL || process.env.APP_URL || '';
  if (miniAppUrl) {
    try {
      allowedOrigins.add(new URL(miniAppUrl).origin);
    } catch {
      // Ignore invalid MINI_APP_URL
    }
  }

  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Cross-site request origin rejected.' });
    }
    return next();
  }

  const referer = req.headers.referer;
  if (referer) {
    try {
      if (allowedOrigins.has(new URL(referer).origin)) {
        return next();
      }
    } catch {
      // Fall through to reject
    }
  }

  return res.status(403).json({ error: 'Missing Origin header for cookie-authenticated state mutation.' });
}

export function getActiveSubscriptionLocal(opts: { sellerId?: string; userId?: string }) {
  const whereField = opts.sellerId ? 'seller_id' : 'user_id';
  const whereVal = opts.sellerId || opts.userId || '';
  if (!whereVal) return undefined;

  db.prepare(
    `UPDATE subscriptions
     SET status = 'expired'
     WHERE ${whereField} = ? AND status = 'active' AND ends_at IS NOT NULL AND datetime(ends_at) <= datetime('now')`
  ).run(whereVal);

  return db
    .prepare(
      `SELECT s.*, sp.code as plan_code, sp.name as plan_name, sp.max_products, sp.ai_daily_limit,
              sp.featured_slots, sp.promotional_discount_pct, sp.analytics_level
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.${whereField} = ? AND s.status = 'active'
         AND (s.ends_at IS NULL OR datetime(s.ends_at) > datetime('now'))
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(whereVal) as Record<string, unknown> | undefined;
}

export function getStarsPerUsdLocal(): number {
  const row = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'stars_per_usd'")
    .get() as { value: string } | undefined;
  const parsed = Number(row?.value || 50);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

export function computeStarsFromUsd(usdAmount: number, starsPerUsd = 50): number {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0;
  return Math.max(1, Math.round(usdAmount * starsPerUsd));
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
  ipAddress = '',
  forceProtected = false
) {
  const isProtected = forceProtected || isAuditActionProtected(action) ? 1 : 0;
  db.prepare(
    `INSERT INTO admin_audit_logs (id, admin_identifier, action, target_type, target_id, details_json, ip_address, is_protected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('audit'),
    adminIdentifier,
    action,
    targetType,
    targetId,
    JSON.stringify(details),
    ipAddress,
    isProtected
  );
}
