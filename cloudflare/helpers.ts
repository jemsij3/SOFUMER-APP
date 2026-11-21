/**
 * Shared Edge types, cryptography, Telegram verification, and D1 authorization helpers
 * for the SOFUMER Cloudflare Worker runtime.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
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

export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface Env {
  DB?: D1Database;
  AI?: WorkersAiBinding;
  ASSETS?: Fetcher;
  TELEGRAM_BOT_NAME?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MINI_APP_URL?: string;
  SESSION_SECRET?: string;
  ADMIN_BOOTSTRAP_SECRET?: string;
  CLOUDFLARE_AI_MODEL?: string;
  ALLOW_DEV_SANDBOX?: string;
}

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
  sessionId: string;
  sessionType: string;
}

export interface EdgeAdminSession {
  sessionId: string;
  adminIdentifier: string;
  role: string;
}

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

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

export async function hashSessionToken(token: string, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN || 'sofumer-edge-ephemeral-session-key';
  return toHex(await hmacSha256(secret, token));
}

export function extractBearerOrCookie(request: Request, cookieName: string): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const rawCookie = request.headers.get('Cookie');
  if (rawCookie) {
    for (const part of rawCookie.split(';')) {
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
  if (!initDataRaw || !botToken) {
    throw new Error('Missing Telegram initData or bot token');
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('Invalid Telegram signature format');
  }

  const pairs: string[] = [];
  params.forEach((v, k) => {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmacSha256('WebAppData', botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!timingSafeEqualStr(expected, hash.toLowerCase())) {
    throw new Error('Telegram initData signature mismatch');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > maxAgeSeconds || authDate - nowSec > 300) {
    throw new Error('Telegram authentication timestamp expired');
  }

  const user = JSON.parse(params.get('user') || '{}') as {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
  };
  if (typeof user.id !== 'number') {
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

export async function resolveEdgeUserSession(
  request: Request,
  env: Env
): Promise<EdgeAuthUser | null> {
  if (!env.DB) return null;
  const token = extractBearerOrCookie(request, 'sofumer_session');
  if (!token) return null;
  const tokenHash = await hashSessionToken(token, env);

  const row = await env.DB.prepare(
    `SELECT s.id as session_id, s.session_type, s.expires_at, s.revoked_at,
            u.id, u.telegram_id, u.telegram_username, u.first_name, u.last_name,
            u.display_name, u.avatar_url, u.bio, u.phone, u.country_code,
            u.preferred_currency, u.preferred_language, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<Record<string, string | null>>();

  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

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
    sessionId: String(row.session_id),
    sessionType: String(row.session_type || 'telegram'),
  };
}

export async function requireEdgeUser(
  request: Request,
  env: Env
): Promise<{ user: EdgeAuthUser } | { error: Response }> {
  if (!env.DB) {
    return { error: json({ error: 'Database binding (DB) is not configured.' }, 503) };
  }
  const user = await resolveEdgeUserSession(request, env);
  if (!user) {
    return { error: json({ error: 'Authentication required. Please launch SOFUMER via Telegram.' }, 401) };
  }
  if (user.status === 'suspended') {
    return { error: json({ error: 'Your account is currently suspended.' }, 403) };
  }
  return { user };
}

export async function requireEdgeSeller(
  request: Request,
  env: Env
): Promise<
  | { user: EdgeAuthUser; seller: Record<string, unknown> }
  | { error: Response }
> {
  const auth = await requireEdgeUser(request, env);
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
  return { user: auth.user, seller };
}

export async function requireEdgeAdmin(
  request: Request,
  env: Env
): Promise<{ admin: EdgeAdminSession } | { error: Response }> {
  if (!env.DB) {
    return { error: json({ error: 'Database binding (DB) is not configured.' }, 503) };
  }
  const adminToken = extractBearerOrCookie(request, 'sofumer_admin_session');
  if (!adminToken) {
    return { error: json({ error: 'Admin authentication required.' }, 401) };
  }
  const tokenHash = await hashSessionToken(adminToken, env);
  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.display_name, u.telegram_username
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.session_type = 'admin'`
  )
    .bind(tokenHash)
    .first<Record<string, string | null>>();

  if (!session || session.revoked_at) {
    return { error: json({ error: 'Invalid or revoked admin session.' }, 401) };
  }
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    return { error: json({ error: 'Admin session expired.' }, 401) };
  }

  const rolesRes = await env.DB.prepare('SELECT role FROM user_roles WHERE user_id = ?')
    .bind(session.user_id)
    .all<{ role: string }>();
  const adminRole = rolesRes.results.find((r) =>
    ['super_admin', 'admin', 'moderator'].includes(r.role)
  );
  if (!adminRole) {
    return { error: json({ error: 'Insufficient administrative privileges.' }, 403) };
  }

  return {
    admin: {
      sessionId: String(session.id),
      adminIdentifier: String(session.telegram_username || session.display_name || session.user_id),
      role: adminRole.role,
    },
  };
}

export async function recordEdgeAdminAudit(
  env: Env,
  adminIdentifier: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
  ipAddress = ''
) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO admin_audit_logs (id, admin_identifier, action, target_type, target_id, details_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('audit'),
      adminIdentifier,
      action,
      targetType,
      targetId,
      JSON.stringify(details),
      ipAddress
    )
    .run();
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegramBotMessageEdge(
  env: Env,
  chatId: string | number,
  text: string,
  inlineWebAppButton?: { label: string; url: string }
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
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
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
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
  originUrl = 'https://sofumer-app.derartuaman8.workers.dev'
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

  if (
    user?.telegram_id &&
    !user.telegram_id.startsWith('admin_') &&
    !user.telegram_id.startsWith('sandbox_')
  ) {
    const miniAppUrl = env.MINI_APP_URL || originUrl;
    const sent = await sendTelegramBotMessageEdge(
      env,
      user.telegram_id,
      `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
      { label: 'Open SOFUMER', url: miniAppUrl }
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
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && lower.includes(k));
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
