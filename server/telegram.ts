import crypto from 'crypto';
import { db, newId } from './db.ts';
import { sanitizeText } from './security.ts';

const botInfoCache = new Map<string, { botName: string | null; botUsername: string | null; expiresAt: number }>();

export function getTelegramBotConfig() {
  return {
    botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
    miniAppUrl: process.env.MINI_APP_URL || process.env.APP_URL || '',
  };
}

export async function getTelegramBotInfo(): Promise<{
  botName: string | null;
  botUsername: string | null;
}> {
  const { botToken } = getTelegramBotConfig();
  if (!botToken) {
    return { botName: null, botUsername: null };
  }

  const cacheKey = crypto.createHash('sha256').update(botToken).digest('hex');
  const cached = botInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { botName: cached.botName, botUsername: cached.botUsername };
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(3500),
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
    const info = {
      botName: data.result.first_name ? sanitizeText(data.result.first_name, 80) : null,
      botUsername: data.result.username ? sanitizeText(data.result.username, 64) : null,
      expiresAt: Date.now() + 10 * 60_000,
    };
    botInfoCache.set(cacheKey, info);
    return { botName: info.botName, botUsername: info.botUsername };
  } catch {
    return { botName: null, botUsername: null };
  }
}

export async function sendTelegramBotMessage(
  chatId: string | number,
  text: string,
  inlineWebAppButton?: { label: string; url: string }
): Promise<boolean> {
  const cfg = getTelegramBotConfig();
  if (!cfg.botToken || !chatId) {
    return false;
  }

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (inlineWebAppButton) {
      body.reply_markup = {
        inline_keyboard: [
          [
            {
              text: inlineWebAppButton.label,
              web_app: { url: inlineWebAppButton.url },
            },
          ],
        ],
      };
    }

    const resp = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function notifyUserAndTelegram(
  userId: string,
  type: string,
  title: string,
  body: string,
  linkUrl = ''
) {
  const notifId = newId('notif');
  db.prepare(
    `INSERT INTO notifications (id, user_id, scope, type, title, body, link_url)
     VALUES (?, ?, 'user', ?, ?, ?, ?)`
  ).run(notifId, userId, type, title, body, linkUrl);

  const user = db
    .prepare('SELECT telegram_id FROM users WHERE id = ?')
    .get(userId) as { telegram_id: string } | undefined;

  if (user?.telegram_id && !user.telegram_id.startsWith('admin_') && !user.telegram_id.startsWith('sandbox_')) {
    const cfg = getTelegramBotConfig();
    const sent = await sendTelegramBotMessage(
      user.telegram_id,
      `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
      { label: 'Open SOFUMER', url: cfg.miniAppUrl }
    );
    if (sent) {
      db.prepare('UPDATE notifications SET telegram_delivered = 1 WHERE id = ?').run(notifId);
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function verifyWebhookSecret(headerSecret: string | undefined): boolean {
  const configured = getTelegramBotConfig().webhookSecret;
  if (!configured) return false;
  if (!headerSecret) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(headerSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function processTelegramWebhookUpdate(update: Record<string, unknown>) {
  const updateId = Number(update.update_id);
  if (!updateId) return { status: 'ignored' };

  // Deduplicate Telegram webhook retries safely
  const existing = db
    .prepare('SELECT update_id FROM telegram_updates WHERE update_id = ?')
    .get(updateId);
  if (existing) {
    return { status: 'duplicate_skipped', updateId };
  }

  const message = update.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const text = String(message?.text || '').trim();
  const chatId = chat?.id ? String(chat.id) : '';
  const command = text.startsWith('/') ? text.split(' ')[0].toLowerCase() : '';

  db.prepare(
    `INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)`
  ).run(updateId, chatId, command);

  if (!chatId) return { status: 'recorded', updateId };

  const cfg = getTelegramBotConfig();
  if (command === '/start') {
    await sendTelegramBotMessage(
      chatId,
      `Welcome to <b>SOFUMER</b> — AI-Powered Global Marketplace.\n\n<i>Buy Smarter. Sell Faster.</i>\n\nDiscover physical goods, digital products, software, and professional services worldwide with direct buyer-to-seller messaging.`,
      { label: 'Launch SOFUMER Marketplace', url: cfg.miniAppUrl }
    );
  } else if (command === '/sell') {
    await sendTelegramBotMessage(
      chatId,
      `Launch your global storefront on <b>SOFUMER</b>. List physical products, digital downloads, or services directly to international buyers.`,
      { label: 'Open Seller Center', url: `${cfg.miniAppUrl}?tab=account&view=seller` }
    );
  } else if (command === '/explore') {
    await sendTelegramBotMessage(
      chatId,
      `Browse global categories, verified shops, and AI-assisted product discovery on <b>SOFUMER</b>.`,
      { label: 'Explore Marketplace', url: `${cfg.miniAppUrl}?tab=explore` }
    );
  } else if (command === '/help') {
    await sendTelegramBotMessage(
      chatId,
      `<b>SOFUMER Help</b>\n\n/start — Open SOFUMER Mini App\n/explore — Browse global listings\n/sell — Open Seller Center\n\nNeed assistance? Open the Mini App → Account → Help and Support.`,
      { label: 'Open SOFUMER', url: cfg.miniAppUrl }
    );
  }

  return { status: 'processed', updateId, command };
}
