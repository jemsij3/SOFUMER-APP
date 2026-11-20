/**
 * SOFUMER — Cloudflare Workers Edge Runtime Entrypoint
 * Target Bindings:
 * - DB: Cloudflare D1 Relational Database
 * - MEDIA_BUCKET: Cloudflare R2 Object Storage
 * - AI: Cloudflare Workers AI
 * - SOFUMER_QUEUE: Cloudflare Queues for asynchronous Telegram/in-app notifications
 * - ASSETS: Static React SPA build (./dist)
 * - Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SESSION_SECRET, ADMIN_BOOTSTRAP_SECRET, GEMINI_API_KEY
 */

export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  AI: Ai;
  SOFUMER_QUEUE: Queue<NotificationJob>;
  ASSETS: Fetcher;
  TELEGRAM_BOT_NAME: string;
  TELEGRAM_BOT_USERNAME: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MINI_APP_URL?: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_SECRET: string;
  GEMINI_API_KEY?: string;
  ALLOW_DEV_SANDBOX?: string;
}

interface NotificationJob {
  userId: string;
  title: string;
  body: string;
  telegramId?: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}

interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface Queue<T> {
  send(message: T): Promise<void>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function hmacSha256(keyData: BufferSource | string, message: string): Promise<ArrayBuffer> {
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

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyTelegramInitDataEdge(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing Telegram signature hash');

  const pairs: string[] = [];
  params.forEach((v, k) => {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmacSha256('WebAppData', botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (expected !== hash.toLowerCase()) {
    throw new Error('Telegram initData signature mismatch');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > 86400) {
    throw new Error('Telegram auth timestamp expired');
  }

  const user = JSON.parse(params.get('user') || '{}');
  if (!user?.id) throw new Error('Telegram user missing');
  return user;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/api/health') {
      return json({ service: 'SOFUMER', runtime: 'cloudflare-workers', status: 'ok' });
    }

    // R2 media retrieval
    if (url.pathname.startsWith('/r2/')) {
      const key = url.pathname.slice(4);
      const obj = await env.MEDIA_BUCKET.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // Telegram Bot Webhook with Secret Verification & D1 Deduplication
    if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ error: 'Unauthorized webhook' }, 401);
      }
      const update = (await request.json()) as { update_id?: number; message?: { chat?: { id?: number }; text?: string } };
      if (!update.update_id) return json({ status: 'ignored' });

      const existing = await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id = ?')
        .bind(update.update_id)
        .first();
      if (existing) return json({ status: 'duplicate_skipped' });

      const chatId = update.message?.chat?.id ? String(update.message.chat.id) : '';
      const cmd = (update.message?.text || '').split(' ')[0].toLowerCase();
      await env.DB.prepare('INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)')
        .bind(update.update_id, chatId, cmd)
        .run();

      if (chatId && env.TELEGRAM_BOT_TOKEN && cmd === '/start') {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '<b>SOFUMER</b> — AI-Powered Global Marketplace\n<i>Buy Smarter. Sell Faster.</i>',
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: 'Launch SOFUMER', web_app: { url: env.MINI_APP_URL || url.origin } }]],
            },
          }),
        });
      }
      return json({ status: 'processed' });
    }

    // Telegram Auth on Edge
    if (url.pathname === '/api/auth/telegram' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { initData?: string };
        const tgUser = await verifyTelegramInitDataEdge(body.initData || '', env.TELEGRAM_BOT_TOKEN);
        const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const rawToken = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        const tokenHash = toHex(await hmacSha256(env.SESSION_SECRET, rawToken));

        let existing = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
          .bind(String(tgUser.id))
          .first<{ id: string }>();

        let userId = existing?.id;
        if (!userId) {
          userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          await env.DB.prepare(
            `INSERT INTO users (id, telegram_id, telegram_username, first_name, display_name) VALUES (?, ?, ?, ?, ?)`
          )
            .bind(userId, String(tgUser.id), tgUser.username || '', tgUser.first_name || 'Member', tgUser.first_name || 'Member')
            .run();
        }

        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, session_type, expires_at) VALUES (?, ?, ?, 'telegram', ?)`
        )
          .bind(
            `sess_${crypto.randomUUID().slice(0, 12)}`,
            userId,
            tokenHash,
            new Date(Date.now() + 7 * 86400_000).toISOString()
          )
          .run();

        return json(
          { authenticated: true, token: rawToken },
          200,
          { 'Set-Cookie': `sofumer_session=${rawToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800` }
        );
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'Auth failed' }, 401);
      }
    }

    // Bootstrap / Catalog read on Edge D1
    if (url.pathname === '/api/marketplace/bootstrap' && request.method === 'GET') {
      const [categories, countries, currencies, plans] = await Promise.all([
        env.DB.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC').all(),
        env.DB.prepare('SELECT * FROM countries WHERE is_enabled = 1 ORDER BY name ASC').all(),
        env.DB.prepare('SELECT * FROM currencies WHERE is_active = 1 ORDER BY code ASC').all(),
        env.DB.prepare('SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY monthly_price ASC').all(),
      ]);
      return json({
        categories: categories.results,
        countries: countries.results,
        currencies: currencies.results,
        plans: plans.results,
      });
    }

    // Serve SPA Assets
    return env.ASSETS.fetch(request);
  },

  async queue(batch: { messages: Array<{ body: NotificationJob }> }, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      if (job.telegramId && env.TELEGRAM_BOT_TOKEN) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: job.telegramId,
            text: `<b>${job.title}</b>\n${job.body}`,
            parse_mode: 'HTML',
          }),
        });
      }
    }
  },
};
