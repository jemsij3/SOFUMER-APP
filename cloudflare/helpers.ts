/**
 * Shared Edge types, cryptography, JWT auth, Telegram verification, Stars payments,
 * rate limiting, URL safety, and D1 authorization helpers for the SOFUMER Cloudflare Worker.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(
    statements: D1PreparedStatement[]
  ): Promise<Array<{ success: boolean; results?: T[]; meta?: { changes?: number } }>>;
}

export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size?: number;
  httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

import {
  DEFAULT_CF_AI_MODEL,
  VALID_CF_MODELS,
  type WorkersAiBinding,
} from './ai-normalizer.ts';

export { DEFAULT_CF_AI_MODEL, VALID_CF_MODELS, type WorkersAiBinding };

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface Env {
  DB?: D1Database;
  AI?: WorkersAiBinding;
  ASSETS?: AssetsBinding;
  MEDIA_BUCKET?: R2BucketLike;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  JWT_SECRET?: string;
  ADMIN_TELEGRAM_IDS?: string;
  ADMIN_TELEGRAM_ID?: string;
  MINI_APP_URL?: string;
  CLOUDFLARE_AI_MODEL?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_URL?: string;
}

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

export interface EdgeAuthUser {
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
  roles?: string[];
  adminRole?: string;
  adminPermissions?: string[];
  sessionId: string;
  sessionType: string;
}

export interface EdgeAdminSession {
  sessionId: string;
  userId: string;
  telegramId: string;
  adminIdentifier: string;
  role: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  isOwner: boolean;
}

export interface EdgeAdminContext {
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  isOwner: boolean;
}

export interface TelegramBotPublicInfo {
  botName: string | null;
  botUsername: string | null;
}

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const botInfoCache = new Map<string, { info: TelegramBotPublicInfo; expiresAt: number }>();

export function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...BASE_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function html(
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      ...BASE_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allowedMethods: string[]): Response {
  return json(
    { error: `Method not allowed. Supported methods: ${allowedMethods.join(', ')}.` },
    405,
    { Allow: allowedMethods.join(', ') }
  );
}

export function newId(prefix = ''): string {
  const raw = crypto.randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${raw.slice(0, 16)}` : raw;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'item';
}

export function sanitizeText(value: unknown, maxLen = 2000): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
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

export async function hmacSha256(
  keyData: BufferSource | string,
  message: string
): Promise<ArrayBuffer> {
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

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(str: string): Uint8Array | null {
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export interface JwtClaims {
  sub: string;
  tid: string;
  sid: string;
  adm: boolean;
  iat: number;
  exp: number;
}

export async function signJwtEdge(
  claims: Omit<JwtClaims, 'iat' | 'exp'>,
  jwtSecret: string,
  ttlSeconds = 7 * 86400
): Promise<string> {
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required to sign authentication tokens.');
  }
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: JwtClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };
  const enc = new TextEncoder();
  const headerB64 = bytesToBase64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(fullClaims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await hmacSha256(jwtSecret, signingInput);
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${signingInput}.${sigB64}`;
}

export async function verifyJwtEdge(token: string, jwtSecret: string): Promise<JwtClaims | null> {
  if (!token || !jwtSecret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSigBuf = await hmacSha256(jwtSecret, signingInput);
  const expectedSigB64 = bytesToBase64Url(new Uint8Array(expectedSigBuf));
  if (!timingSafeEqualStr(sigB64, expectedSigB64)) return null;

  const headerBytes = base64UrlToBytes(headerB64);
  const payloadBytes = base64UrlToBytes(payloadB64);
  if (!headerBytes || !payloadBytes) return null;

  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(headerBytes)) as { alg?: string; typ?: string };
    if (header.alg !== 'HS256') return null;

    const claims = JSON.parse(dec.decode(payloadBytes)) as Partial<JwtClaims>;
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

export async function hashSessionIdentifier(sessionId: string, jwtSecret: string): Promise<string> {
  return toHex(await hmacSha256(jwtSecret, sessionId));
}

export function isTelegramIdAdmin(telegramId: string, adminTelegramIdsRaw?: string): boolean {
  if (!telegramId || !adminTelegramIdsRaw) return false;
  const normalizedTarget = telegramId.trim();
  if (!/^\d+$/.test(normalizedTarget)) return false;

  const configuredIds = adminTelegramIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));

  for (const allowedId of configuredIds) {
    if (timingSafeEqualStr(normalizedTarget, allowedId)) {
      return true;
    }
  }
  return false;
}

export function verifyCookieCsrfEdge(request: Request, env: Env, url: URL): Response | null {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return null;
  if (!url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/api/telegram/webhook' || url.pathname === '/api/auth/telegram') return null;

  const authHeader = request.headers.get('Authorization') || '';
  if (/^Bearer\s+\S+/i.test(authHeader)) {
    return null;
  }

  const rawCookie = request.headers.get('Cookie') || '';
  if (!rawCookie.includes('sofumer_session=')) {
    return null;
  }

  const allowedOrigins = new Set<string>([url.origin]);
  if (env.MINI_APP_URL) {
    try {
      allowedOrigins.add(new URL(env.MINI_APP_URL).origin);
    } catch {
      // Ignore malformed MINI_APP_URL
    }
  }

  const origin = request.headers.get('Origin');
  if (origin) {
    if (!allowedOrigins.has(origin)) {
      return json({ error: 'Cross-site request origin rejected.' }, 403);
    }
    return null;
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      if (allowedOrigins.has(new URL(referer).origin)) {
        return null;
      }
    } catch {
      // Fall through to reject
    }
  }

  return json({ error: 'Missing Origin header for cookie-authenticated state mutation.' }, 403);
}

export async function checkEdgeRateLimit(
  request: Request,
  env: Env,
  scope: string,
  maxRequests: number,
  windowSeconds: number,
  actorKey?: string
): Promise<Response | null> {
  if (!env.DB) return null;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'anon';
  const rateKey = `${scope}:${actorKey || ip}`.slice(0, 120);
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const existing = await env.DB.prepare('SELECT count, reset_at FROM edge_rate_limits WHERE rate_key = ?')
      .bind(rateKey)
      .first<{ count: number; reset_at: number }>();

    if (!existing || existing.reset_at <= nowSec) {
      await env.DB.prepare(
        `INSERT INTO edge_rate_limits (rate_key, count, reset_at)
         VALUES (?, 1, ?)
         ON CONFLICT(rate_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
      )
        .bind(rateKey, nowSec + windowSeconds)
        .run();
      return null;
    }

    if (existing.count >= maxRequests) {
      return json({ error: 'Too many requests. Please wait a moment and try again.' }, 429);
    }

    await env.DB.prepare('UPDATE edge_rate_limits SET count = count + 1 WHERE rate_key = ?')
      .bind(rateKey)
      .run();
    return null;
  } catch {
    return null;
  }
}

export async function getTelegramBotInfoEdge(env: Env): Promise<TelegramBotPublicInfo> {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) {
    return { botName: null, botUsername: null };
  }

  const cacheKeyBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
  const cacheKey = toHex(cacheKeyBuffer);
  const cached = botInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: 'GET',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined,
    });
    if (!resp.ok) {
      return { botName: null, botUsername: null };
    }
    const data = (await resp.json()) as {
      ok?: boolean;
      result?: { first_name?: string; username?: string };
    };
    if (!data?.ok || !data.result) {
      return { botName: null, botUsername: null };
    }
    const info: TelegramBotPublicInfo = {
      botName: data.result.first_name ? sanitizeText(data.result.first_name, 80) : null,
      botUsername: data.result.username ? sanitizeText(data.result.username, 64) : null,
    };
    botInfoCache.set(cacheKey, { info, expiresAt: Date.now() + 10 * 60_000 });
    return info;
  } catch {
    return { botName: null, botUsername: null };
  }
}

export interface SessionTokenCandidate {
  token: string;
  source: 'bearer' | 'cookie';
}

export function extractAllSessionTokens(
  request: Request,
  cookieName: string
): SessionTokenCandidate[] {
  const candidates: SessionTokenCandidate[] = [];
  const authHeader = request.headers.get('Authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && bearerMatch[1]) {
    const token = bearerMatch[1].trim();
    if (token) candidates.push({ token, source: 'bearer' });
  }
  const rawCookie = request.headers.get('Cookie');
  if (rawCookie) {
    for (const part of rawCookie.split(';')) {
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

export function extractBearerOrCookie(request: Request, cookieName: string): string | null {
  const candidates = extractAllSessionTokens(request, cookieName);
  return candidates.length > 0 ? candidates[0].token : null;
}

export async function verifyTelegramInitDataEdge(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds = 86400
): Promise<{
  user: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
  };
  authDate: number;
}> {
  const cleanBotToken = typeof botToken === 'string' ? botToken.trim() : '';
  if (typeof initDataRaw !== 'string' || !initDataRaw || !cleanBotToken) {
    throw new Error('Missing Telegram initData or bot token');
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('Invalid Telegram signature format');
  }

  const entries: Array<[string, string]> = [];
  params.forEach((v, k) => {
    if (k !== 'hash') entries.push([k, v]);
  });
  // Telegram official spec: sort keys alphabetically in byte/UTF-16 code-unit order (never localeCompare)
  entries.sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = await hmacSha256('WebAppData', cleanBotToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!timingSafeEqualStr(expected, hash.toLowerCase())) {
    throw new Error('Telegram initData signature mismatch');
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

  const userRaw = params.get('user');
  if (!userRaw) {
    throw new Error('Telegram user payload missing');
  }

  let user: {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
  };
  try {
    user = JSON.parse(userRaw) as typeof user;
  } catch {
    throw new Error('Invalid Telegram user identity');
  }

  if (!user || typeof user.id !== 'number') {
    throw new Error('Invalid Telegram user identity');
  }

  return {
    user: {
      id: user.id,
      first_name: user.first_name || 'Member',
      last_name: user.last_name,
      username: user.username,
      language_code: user.language_code,
      photo_url: user.photo_url,
    },
    authDate,
  };
}

export async function resolveEdgeAdminContext(
  env: Env,
  telegramId: string
): Promise<EdgeAdminContext | null> {
  const tgId = String(telegramId || '').trim();
  if (!/^\d+$/.test(tgId)) return null;

  const configuredAdminIds = [env.ADMIN_TELEGRAM_IDS, env.ADMIN_TELEGRAM_ID]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(',');
  if (isTelegramIdAdmin(tgId, configuredAdminIds)) {
    return {
      roleId: 'role_owner',
      roleCode: 'OWNER',
      roleName: 'Platform Owner',
      permissions: ['*'],
      isOwner: true,
    };
  }

  if (!env.DB) return null;
  try {
    const assignment = await env.DB.prepare(
      `SELECT ara.role_id, ar.code as role_code, ar.name as role_name
       FROM admin_role_assignments ara
       JOIN admin_roles ar ON ar.id = ara.role_id
       WHERE ara.telegram_id = ? AND ara.is_active = 1
       LIMIT 1`
    )
      .bind(tgId)
      .first<{ role_id: string; role_code: string; role_name: string }>();

    if (!assignment) return null;

    const permsRes = await env.DB.prepare(
      'SELECT permission_key FROM admin_permissions WHERE role_id = ?'
    )
      .bind(assignment.role_id)
      .all<{ permission_key: string }>();

    const permissions = permsRes.results.map((r: { permission_key: string }) => r.permission_key);
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

export function hasEdgeAdminPermission(
  admin: Pick<EdgeAdminSession, 'isOwner' | 'permissions'>,
  required?: string | string[]
): boolean {
  if (!required) return true;
  if (admin.isOwner || admin.permissions.includes('*')) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.some((perm) => admin.permissions.includes(perm));
}

export type SessionFailureReason =
  | 'db_not_configured'
  | 'jwt_secret_missing'
  | 'missing_token'
  | 'invalid_jwt'
  | 'session_not_found'
  | 'session_revoked'
  | 'session_expired'
  | 'telegram_id_mismatch'
  | 'user_suspended'
  | 'db_error';

export interface EdgeSessionResolution {
  user: EdgeAuthUser | null;
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

export async function resolveEdgeUserSessionDetailed(
  request: Request,
  env: Env
): Promise<EdgeSessionResolution> {
  const candidates = extractAllSessionTokens(request, 'sofumer_session');
  const hasBearer = candidates.some((c) => c.source === 'bearer');
  const hasCookie = candidates.some((c) => c.source === 'cookie');

  if (!env.DB) {
    return { user: null, reason: 'db_not_configured', tokenSource: 'none', hasBearer, hasCookie };
  }
  const jwtSecret = (env.JWT_SECRET || '').trim();
  if (!jwtSecret) {
    return { user: null, reason: 'jwt_secret_missing', tokenSource: 'none', hasBearer, hasCookie };
  }
  if (candidates.length === 0) {
    return { user: null, reason: 'missing_token', tokenSource: 'none', hasBearer, hasCookie };
  }

  let lastReason: SessionFailureReason = 'invalid_jwt';
  let lastSource: 'bearer' | 'cookie' | 'none' = candidates[0].source;

  for (const candidate of candidates) {
    lastSource = candidate.source;
    const claims = await verifyJwtEdge(candidate.token, jwtSecret);
    if (!claims) {
      lastReason = 'invalid_jwt';
      continue;
    }

    let row: Record<string, string | null> | null = null;
    try {
      row = await env.DB.prepare(
        `SELECT s.id as session_id, s.session_type, s.expires_at, s.revoked_at,
                u.id, u.telegram_id, u.telegram_username, u.first_name, u.last_name,
                u.display_name, u.avatar_url, u.bio, u.phone, u.country_code,
                u.preferred_currency, u.preferred_language, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.user_id = ?`
      )
        .bind(claims.sid, claims.sub)
        .first<Record<string, string | null>>();
    } catch (err) {
      console.error(
        '[SOFUMER Session Lookup Error]',
        err instanceof Error ? err.message : 'D1 query failed'
      );
      return {
        user: null,
        reason: 'db_error',
        tokenSource: candidate.source,
        hasBearer,
        hasCookie,
      };
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
    const adminCtx = await resolveEdgeAdminContext(env, tgId);
    const user: EdgeAuthUser = {
      id: String(row.id),
      telegram_id: tgId,
      telegram_username: String(row.telegram_username || ''),
      first_name: String(row.first_name || ''),
      last_name: String(row.last_name || ''),
      display_name: String(row.display_name || ''),
      avatar_url: sanitizeSafeUrl(row.avatar_url || '', 300),
      bio: String(row.bio || ''),
      phone: String(row.phone || ''),
      country_code: String(row.country_code || 'US'),
      preferred_currency: String(row.preferred_currency || 'USD'),
      preferred_language: String(row.preferred_language || 'en'),
      status: String(row.status || 'active'),
      mode: adminCtx ? 'admin' : 'marketplace',
      isAdmin: Boolean(adminCtx),
      adminRole: adminCtx?.roleCode,
      adminPermissions: adminCtx?.permissions,
      sessionId: String(row.session_id),
      sessionType: String(row.session_type || 'telegram'),
    };

    if (user.status === 'suspended') {
      return {
        user,
        reason: 'user_suspended',
        tokenSource: candidate.source,
        hasBearer,
        hasCookie,
      };
    }

    return {
      user,
      reason: null,
      tokenSource: candidate.source,
      hasBearer,
      hasCookie,
    };
  }

  return {
    user: null,
    reason: lastReason,
    tokenSource: lastSource,
    hasBearer,
    hasCookie,
  };
}

export async function resolveEdgeUserSession(
  request: Request,
  env: Env
): Promise<EdgeAuthUser | null> {
  const res = await resolveEdgeUserSessionDetailed(request, env);
  return res.user;
}

export async function requireEdgeUser(
  request: Request,
  env: Env
): Promise<{ user: EdgeAuthUser } | { error: Response }> {
  if (!env.DB) {
    return { error: json({ error: 'Database binding (DB) is not configured.' }, 503) };
  }
  const res = await resolveEdgeUserSessionDetailed(request, env);
  if (!res.user) {
    const status = res.reason === 'db_error' ? 500 : 401;
    return {
      error: json(
        {
          error: 'Telegram authentication required. Open SOFUMER inside its official Telegram Mini App.',
          reason: res.reason,
        },
        status
      ),
    };
  }
  if (res.user.status === 'suspended' || res.reason === 'user_suspended') {
    return { error: json({ error: 'Your account is currently suspended.' }, 403) };
  }
  return { user: res.user };
}

export const ADMIN_EXCLUSIVE_MODE_ERROR =
  'Administrator accounts operate exclusively in Governance Mode and cannot use buyer or seller marketplace endpoints.';

export async function requireEdgeNonAdminUser(
  request: Request,
  env: Env
): Promise<{ user: EdgeAuthUser } | { error: Response }> {
  const auth = await requireEdgeUser(request, env);
  if ('error' in auth) return auth;
  if (auth.user.isAdmin) {
    return {
      error: json(
        {
          error: ADMIN_EXCLUSIVE_MODE_ERROR,
          code: 'ADMIN_MODE_EXCLUSIVE',
        },
        403
      ),
    };
  }
  return auth;
}

export async function requireEdgeSeller(
  request: Request,
  env: Env
): Promise<
  | { user: EdgeAuthUser; seller: Record<string, unknown>; shop: Record<string, unknown> }
  | { error: Response }
> {
  const auth = await requireEdgeNonAdminUser(request, env);
  if ('error' in auth) return auth;
  const seller = await env.DB!.prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .bind(auth.user.id)
    .first<Record<string, unknown>>();
  if (!seller) {
    return { error: json({ error: 'Seller profile required. Please register as a seller first.' }, 403) };
  }
  if (seller.status === 'suspended') {
    return { error: json({ error: 'Seller account is suspended.' }, 403) };
  }
  const shop = await env.DB!.prepare(
    "SELECT * FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1"
  )
    .bind(seller.id)
    .first<Record<string, unknown>>();
  if (!shop) {
    return { error: json({ error: 'Active shop required. Register a new storefront to manage seller tools.' }, 403) };
  }
  return { user: auth.user, seller, shop };
}

export async function requireEdgeAdmin(
  request: Request,
  env: Env,
  requiredPermission?: string | string[]
): Promise<{ admin: EdgeAdminSession } | { error: Response }> {
  const auth = await requireEdgeUser(request, env);
  if ('error' in auth) return auth;

  const adminCtx = await resolveEdgeAdminContext(env, auth.user.telegram_id);
  if (!adminCtx) {
    return {
      error: json(
        {
          error:
            'Administrator privileges required. Your Telegram ID is not authorized in ADMIN_TELEGRAM_IDS or active admin role assignments.',
        },
        403
      ),
    };
  }

  const adminSession: EdgeAdminSession = {
    sessionId: auth.user.sessionId,
    userId: auth.user.id,
    telegramId: auth.user.telegram_id,
    adminIdentifier: auth.user.telegram_username
      ? `@${auth.user.telegram_username}`
      : auth.user.display_name || auth.user.telegram_id,
    role: adminCtx.roleCode,
    roleId: adminCtx.roleId,
    roleName: adminCtx.roleName,
    permissions: adminCtx.permissions,
    isOwner: adminCtx.isOwner,
  };

  if (requiredPermission && !hasEdgeAdminPermission(adminSession, requiredPermission)) {
    return {
      error: json(
        {
          error: 'Insufficient administrative permissions for this operation.',
          requiredPermission,
        },
        403
      ),
    };
  }

  return { admin: adminSession };
}

export async function recordEdgeAdminAudit(
  env: Env,
  adminIdentifier: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
  ipAddress = '',
  forceProtected = false
) {
  if (!env.DB) return;
  const isProtected = forceProtected || isAuditActionProtected(action) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO admin_audit_logs (id, admin_identifier, action, target_type, target_id, details_json, ip_address, is_protected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('audit'),
      adminIdentifier,
      action,
      targetType,
      targetId,
      JSON.stringify(details),
      ipAddress,
      isProtected
    )
    .run();
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const menuButtonSyncCache = new Map<string, number>();

export function resolveSafeMiniAppUrlEdge(env: Env, fallbackOrigin: string): string {
  const candidates = [(env.MINI_APP_URL || '').trim(), (fallbackOrigin || '').trim()];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      if (host === 't.me' || host.endsWith('.t.me') || host === 'telegram.me') {
        continue;
      }
      if (parsed.protocol === 'https:') {
        return parsed.origin + (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '');
      }
      if (parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
        return parsed.origin;
      }
      if (parsed.protocol === 'http:') {
        return `https://${parsed.host}`;
      }
    } catch {
      // Try next candidate
    }
  }
  return '';
}

export async function ensureTelegramMenuButtonEdge(
  env: Env,
  miniAppUrl: string,
  force = false
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken || !miniAppUrl || !miniAppUrl.startsWith('https://')) {
    return { ok: false, error: 'Missing HTTPS miniAppUrl or TELEGRAM_BOT_TOKEN.' };
  }

  const cacheKey = `${miniAppUrl}:${botToken.slice(-8)}`;
  const cachedUntil = menuButtonSyncCache.get(cacheKey) || 0;
  if (!force && cachedUntil > Date.now()) {
    return { ok: true, skipped: true };
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: 'Open SOFUMER',
          web_app: { url: miniAppUrl },
        },
      }),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined,
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!resp.ok || !data?.ok) {
      return { ok: false, error: data.description || `setChatMenuButton failed (${resp.status})` };
    }
    menuButtonSyncCache.set(cacheKey, Date.now() + 30 * 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Telegram Bot API error.' };
  }
}

export async function getTelegramBotLaunchDiagnosticsEdge(env: Env, fallbackOrigin: string) {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const miniAppUrl = resolveSafeMiniAppUrlEdge(env, fallbackOrigin);
  const botInfo = await getTelegramBotInfoEdge(env);

  if (!botToken) {
    return {
      telegramConfigured: false,
      jwtConfigured: Boolean((env.JWT_SECRET || '').trim()),
      webhookSecretConfigured: Boolean((env.TELEGRAM_WEBHOOK_SECRET || '').trim()),
      botName: null,
      botUsername: null,
      miniAppUrl,
      menuButton: null,
      webhookInfo: null,
    };
  }

  const [menuRes, webhookRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${botToken}/getChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined,
    })
      .then((r) => r.json() as Promise<{ ok?: boolean; result?: Record<string, unknown> }>)
      .catch(() => null),
    fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      method: 'GET',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined,
    })
      .then((r) => r.json() as Promise<{ ok?: boolean; result?: Record<string, unknown> }>)
      .catch(() => null),
  ]);

  const webhookResult = webhookRes?.ok ? webhookRes.result || null : null;
  return {
    telegramConfigured: true,
    jwtConfigured: Boolean((env.JWT_SECRET || '').trim()),
    webhookSecretConfigured: Boolean((env.TELEGRAM_WEBHOOK_SECRET || '').trim()),
    botName: botInfo.botName,
    botUsername: botInfo.botUsername,
    miniAppUrl,
    directMiniAppLink: botInfo.botUsername ? `https://t.me/${botInfo.botUsername}?startapp` : null,
    menuButton: menuRes?.ok ? menuRes.result || null : null,
    webhookInfo: webhookResult
      ? {
          url: webhookResult.url || '',
          pendingUpdateCount: webhookResult.pending_update_count || 0,
          lastErrorMessage: webhookResult.last_error_message || null,
        }
      : null,
  };
}

export async function sendTelegramBotMessageEdge(
  env: Env,
  chatId: string | number,
  text: string,
  inlineWebAppButton?: { label: string; url: string }
): Promise<boolean> {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken || !chatId) return false;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (inlineWebAppButton) {
      body.reply_markup = {
        inline_keyboard: [[{ text: inlineWebAppButton.label, web_app: { url: inlineWebAppButton.url } }]],
      };
    }
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function notifyUserAndTelegramEdge(
  env: Env,
  userId: string,
  type: string,
  title: string,
  body: string,
  originUrl = ''
) {
  if (!env.DB) return;
  const notifId = newId('notif');
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, scope, type, title, body, link_url)
     VALUES (?, ?, 'user', ?, ?, ?, '')`
  )
    .bind(notifId, userId, type, title, body)
    .run();

  const user = await env.DB.prepare('SELECT telegram_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ telegram_id: string }>();

  if (user?.telegram_id && /^\d+$/.test(user.telegram_id)) {
    const miniAppUrl = resolveSafeMiniAppUrlEdge(env, originUrl);
    const button = miniAppUrl ? { label: 'Open SOFUMER', url: miniAppUrl } : undefined;
    const sent = await sendTelegramBotMessageEdge(
      env,
      user.telegram_id,
      `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
      button
    );
    if (sent) {
      await env.DB.prepare('UPDATE notifications SET telegram_delivered = 1 WHERE id = ?')
        .bind(notifId)
        .run();
    }
  }
}

export async function checkProhibitedKeywordsEdge(env: Env, text: string): Promise<string[]> {
  if (!env.DB) return [];
  const row = await env.DB.prepare(
    "SELECT value FROM platform_settings WHERE key = 'prohibited_keywords'"
  ).first<{ value: string }>();
  if (!row?.value) return [];
  const lower = text.toLowerCase();
  return row.value
    .split(',')
    .map((k: string) => k.trim().toLowerCase())
    .filter((k: string) => k.length > 0 && lower.includes(k));
}

export async function parseJsonBody<T = Record<string, unknown>>(
  request: Request
): Promise<{ ok: true; data: T } | { ok: false; error: Response }> {
  try {
    const data = (await request.json()) as T;
    return { ok: true, data: data || ({} as T) };
  } catch {
    return { ok: false, error: json({ error: 'Invalid JSON request body.' }, 400) };
  }
}

export async function getActiveSubscriptionEdge(
  db: D1Database,
  opts: { sellerId?: string; userId?: string }
): Promise<Record<string, unknown> | null> {
  const whereField = opts.sellerId ? 'seller_id' : 'user_id';
  const whereVal = opts.sellerId || opts.userId || '';
  if (!whereVal) return null;

  await db
    .prepare(
      `UPDATE subscriptions
       SET status = 'expired'
       WHERE ${whereField} = ? AND status = 'active' AND ends_at IS NOT NULL AND datetime(ends_at) <= datetime('now')`
    )
    .bind(whereVal)
    .run();

  return await db
    .prepare(
      `SELECT s.*, sp.code as plan_code, sp.name as plan_name, sp.max_products, sp.ai_daily_limit,
              sp.featured_slots, sp.promotional_discount_pct, sp.analytics_level
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.${whereField} = ? AND s.status = 'active'
         AND (s.ends_at IS NULL OR datetime(s.ends_at) > datetime('now'))
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .bind(whereVal)
    .first<Record<string, unknown>>();
}

export async function getStarsPerUsdEdge(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM platform_settings WHERE key = 'stars_per_usd'")
    .first<{ value: string }>();
  const parsed = Number(row?.value || 50);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

export function computeStarsFromUsd(usdAmount: number, starsPerUsd = 50): number {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0;
  return Math.max(1, Math.round(usdAmount * starsPerUsd));
}

export async function createTelegramInvoiceLinkEdge(
  env: Env,
  params: {
    title: string;
    description: string;
    payload: string;
    starsAmount: number;
  }
): Promise<{ ok: true; invoiceUrl: string } | { ok: false; error: string }> {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured.' };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: params.title.slice(0, 32),
        description: params.description.slice(0, 255),
        payload: params.payload.slice(0, 128),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: params.title.slice(0, 32), amount: Math.max(1, Math.round(params.starsAmount)) }],
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: string;
      description?: string;
    };
    if (!resp.ok || !data?.ok || typeof data.result !== 'string') {
      return { ok: false, error: data.description || 'Failed to generate Telegram Stars invoice link.' };
    }
    return { ok: true, invoiceUrl: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Telegram Bot API error.' };
  }
}

export async function answerPreCheckoutQueryEdge(
  env: Env,
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string
): Promise<boolean> {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken || !preCheckoutQueryId) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pre_checkout_query_id: preCheckoutQueryId,
        ok,
        ...(ok ? {} : { error_message: (errorMessage || 'Invoice invalid or expired.').slice(0, 200) }),
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface TelegramPreCheckoutQuery {
  id: string;
  from?: { id?: number };
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
}

export async function fulfillStarsPreCheckoutEdge(
  env: Env,
  query: TelegramPreCheckoutQuery
): Promise<{ valid: boolean; reason?: string; answered: boolean }> {
  if (!env.DB) {
    const answered = await answerPreCheckoutQueryEdge(env, query.id, false, 'Service unavailable.');
    return { valid: false, reason: 'db_missing', answered };
  }

  let valid = true;
  let reason = '';

  if (query.currency !== 'XTR') {
    valid = false;
    reason = 'Only Telegram Stars (XTR) payments are accepted.';
  }

  const payload = String(query.invoice_payload || '');
  const payment = payload
    ? await env.DB.prepare('SELECT * FROM telegram_stars_payments WHERE payload_token = ?')
        .bind(payload)
        .first<Record<string, unknown>>()
    : null;

  if (valid && !payment) {
    valid = false;
    reason = 'Payment invoice not found.';
  }
  if (valid && payment && payment.status !== 'pending') {
    valid = false;
    reason = `Invoice is no longer pending (status: ${String(payment.status)}).`;
  }
  if (valid && payment && new Date(String(payment.expires_at)).getTime() <= Date.now()) {
    await env.DB.prepare(
      "UPDATE telegram_stars_payments SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
      .bind(payment.id)
      .run();
    valid = false;
    reason = 'This invoice has expired. Please request a fresh checkout link.';
  }
  if (valid && payment && Number(query.total_amount) !== Number(payment.stars_amount)) {
    valid = false;
    reason = 'Invoice Star amount mismatch.';
  }
  if (
    valid &&
    payment &&
    query.from?.id !== undefined &&
    String(query.from.id) !== String(payment.payer_telegram_id)
  ) {
    valid = false;
    reason = 'This invoice belongs to a different Telegram account.';
  }

  const answered = await answerPreCheckoutQueryEdge(env, query.id, valid, valid ? undefined : reason);
  return { valid, reason: valid ? undefined : reason, answered };
}

export interface TelegramSuccessfulPayment {
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
  telegram_payment_charge_id?: string;
  provider_payment_charge_id?: string;
}

export async function fulfillStarsSuccessfulPaymentEdge(
  env: Env,
  sp: TelegramSuccessfulPayment,
  payerTelegramId?: string,
  originUrl = ''
): Promise<{ status: string; paymentId?: string }> {
  if (!env.DB) return { status: 'db_missing' };
  const chargeId = String(sp.telegram_payment_charge_id || '').trim();
  const providerChargeId = String(sp.provider_payment_charge_id || '').trim();
  const payload = String(sp.invoice_payload || '').trim();

  if (sp.currency !== 'XTR' || !chargeId || !payload) {
    return { status: 'invalid_payment_payload' };
  }

  const dupCharge = await env.DB.prepare(
    'SELECT id FROM telegram_stars_payments WHERE telegram_payment_charge_id = ? LIMIT 1'
  )
    .bind(chargeId)
    .first<{ id: string }>();
  if (dupCharge) {
    return { status: 'duplicate_charge_ignored', paymentId: dupCharge.id };
  }

  const payment = await env.DB.prepare('SELECT * FROM telegram_stars_payments WHERE payload_token = ?')
    .bind(payload)
    .first<Record<string, unknown>>();
  if (!payment) return { status: 'invoice_not_found' };
  if (payment.status === 'paid') return { status: 'already_paid', paymentId: String(payment.id) };
  if (Number(sp.total_amount) !== Number(payment.stars_amount)) {
    return { status: 'amount_mismatch', paymentId: String(payment.id) };
  }
  if (payerTelegramId && String(payment.payer_telegram_id) !== payerTelegramId) {
    return { status: 'payer_mismatch', paymentId: String(payment.id) };
  }

  const updateRes = await env.DB.prepare(
    `UPDATE telegram_stars_payments
     SET status = 'paid',
         telegram_payment_charge_id = ?,
         provider_payment_charge_id = ?,
         paid_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  )
    .bind(chargeId, providerChargeId, payment.id)
    .run();

  if ((updateRes.meta?.changes ?? 0) === 0) {
    return { status: 'already_processed', paymentId: String(payment.id) };
  }

  const userId = String(payment.user_id);
  if (payment.target_type === 'subscription') {
    const subRow = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?')
      .bind(payment.target_id)
      .first<Record<string, unknown>>();
    if (subRow) {
      const days = subRow.billing_cycle === 'annual' ? 365 : 30;
      const endsAt = new Date(Date.now() + days * 86400_000).toISOString();
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active' AND id != ?"
      )
        .bind(subRow.seller_id, subRow.id)
        .run();
      await env.DB.prepare(
        `UPDATE subscriptions
         SET status = 'active',
             starts_at = datetime('now'),
             ends_at = ?,
             payment_reference = ?
         WHERE id = ?`
      )
        .bind(endsAt, chargeId, subRow.id)
        .run();
    }
    await notifyUserAndTelegramEdge(
      env,
      userId,
      'subscription',
      `SOFUMER Plan Activated: ${String(payment.plan_code || 'PRO')}`,
      `Telegram Stars payment received (${Number(payment.stars_amount)} XTR). Your ${String(payment.plan_code)} (${String(payment.billing_cycle)}) plan is now active.`,
      originUrl
    );
  } else if (payment.target_type === 'promotion') {
    const promo = await env.DB.prepare('SELECT * FROM promotions WHERE id = ?')
      .bind(payment.target_id)
      .first<Record<string, unknown>>();
    if (promo) {
      const days = Math.max(1, Number(promo.duration_days || 7));
      const endsAt = new Date(Date.now() + days * 86400_000).toISOString();
      await env.DB.prepare(
        `UPDATE promotions
         SET status = 'active',
             starts_at = datetime('now'),
             ends_at = ?
         WHERE id = ?`
      )
        .bind(endsAt, promo.id)
        .run();
      await env.DB.prepare(
        `UPDATE promotion_transactions
         SET status = 'recorded',
             reference = ?
         WHERE promotion_id = ?`
      )
        .bind(chargeId, promo.id)
        .run();
      if (promo.product_id) {
        if (promo.promo_type === 'sponsored_placement') {
          await env.DB.prepare('UPDATE products SET is_sponsored = 1 WHERE id = ?')
            .bind(promo.product_id)
            .run();
        } else {
          await env.DB.prepare('UPDATE products SET is_featured = 1 WHERE id = ?')
            .bind(promo.product_id)
            .run();
        }
      }
      await notifyUserAndTelegramEdge(
        env,
        userId,
        'promotion',
        `Promotion Live: ${String(promo.title)}`,
        `Telegram Stars payment confirmed (${Number(payment.stars_amount)} XTR). Your promotion is active for ${days} days.`,
        originUrl
      );
    }
  }

  return { status: 'paid', paymentId: String(payment.id) };
}
