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
    if (inlineWebAppButton?.url) {
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

  if (user?.telegram_id && /^\d+$/.test(user.telegram_id)) {
    const cfg = getTelegramBotConfig();
    const sent = await sendTelegramBotMessage(
      user.telegram_id,
      `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
      cfg.miniAppUrl ? { label: 'Open SOFUMER', url: cfg.miniAppUrl } : undefined
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

export async function createTelegramInvoiceLink(params: {
  title: string;
  description: string;
  payload: string;
  starsAmount: number;
}): Promise<{ ok: true; invoiceUrl: string } | { ok: false; error: string }> {
  const { botToken } = getTelegramBotConfig();
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
      return { ok: false, error: data.description || 'Failed to create Telegram Stars invoice link.' };
    }
    return { ok: true, invoiceUrl: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Telegram Bot API error.' };
  }
}

export async function answerPreCheckoutQuery(
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string
): Promise<boolean> {
  const { botToken } = getTelegramBotConfig();
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

export async function fulfillStarsPreCheckoutLocal(query: {
  id: string;
  from?: { id?: number };
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
}): Promise<{ valid: boolean; reason?: string; answered: boolean }> {
  let valid = true;
  let reason = '';

  if (query.currency !== 'XTR') {
    valid = false;
    reason = 'Only Telegram Stars (XTR) payments are accepted.';
  }

  const payload = String(query.invoice_payload || '');
  const payment = payload
    ? (db.prepare('SELECT * FROM telegram_stars_payments WHERE payload_token = ?').get(payload) as
        | Record<string, unknown>
        | undefined)
    : undefined;

  if (valid && !payment) {
    valid = false;
    reason = 'Payment invoice not found.';
  }
  if (valid && payment && payment.status !== 'pending') {
    valid = false;
    reason = `Invoice is no longer pending (status: ${String(payment.status)}).`;
  }
  if (valid && payment && new Date(String(payment.expires_at)).getTime() <= Date.now()) {
    db.prepare(
      "UPDATE telegram_stars_payments SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(payment.id);
    valid = false;
    reason = 'This invoice has expired. Please request a new checkout link.';
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

  const answered = await answerPreCheckoutQuery(query.id, valid, valid ? undefined : reason);
  return { valid, reason: valid ? undefined : reason, answered };
}

export async function fulfillStarsSuccessfulPaymentLocal(
  sp: {
    currency?: string;
    total_amount?: number;
    invoice_payload?: string;
    telegram_payment_charge_id?: string;
    provider_payment_charge_id?: string;
  },
  payerTelegramId?: string
): Promise<{ status: string; paymentId?: string }> {
  const chargeId = String(sp.telegram_payment_charge_id || '').trim();
  const providerChargeId = String(sp.provider_payment_charge_id || '').trim();
  const payload = String(sp.invoice_payload || '').trim();

  if (sp.currency !== 'XTR' || !chargeId || !payload) {
    return { status: 'invalid_payment_payload' };
  }

  const dupCharge = db
    .prepare('SELECT id FROM telegram_stars_payments WHERE telegram_payment_charge_id = ? LIMIT 1')
    .get(chargeId) as { id: string } | undefined;
  if (dupCharge) {
    return { status: 'duplicate_charge_ignored', paymentId: dupCharge.id };
  }

  const payment = db
    .prepare('SELECT * FROM telegram_stars_payments WHERE payload_token = ?')
    .get(payload) as Record<string, unknown> | undefined;
  if (!payment) return { status: 'invoice_not_found' };
  if (payment.status === 'paid') return { status: 'already_paid', paymentId: String(payment.id) };
  if (Number(sp.total_amount) !== Number(payment.stars_amount)) {
    return { status: 'amount_mismatch', paymentId: String(payment.id) };
  }
  if (payerTelegramId && String(payment.payer_telegram_id) !== payerTelegramId) {
    return { status: 'payer_mismatch', paymentId: String(payment.id) };
  }

  let updated = false;
  let notifyInfo: { userId: string; type: string; title: string; body: string } | null = null;

  db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE telegram_stars_payments
         SET status = 'paid',
             telegram_payment_charge_id = ?,
             provider_payment_charge_id = ?,
             paid_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(chargeId, providerChargeId, payment.id);

    if (info.changes === 0) return;
    updated = true;

    const userId = String(payment.user_id);
    if (payment.target_type === 'subscription') {
      const subRow = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(payment.target_id) as
        | Record<string, unknown>
        | undefined;
      if (subRow) {
        const days = subRow.billing_cycle === 'annual' ? 365 : 30;
        const endsAt = new Date(Date.now() + days * 86400_000).toISOString();
        db.prepare(
          "UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active' AND id != ?"
        ).run(subRow.seller_id, subRow.id);
        db.prepare(
          `UPDATE subscriptions
           SET status = 'active', starts_at = datetime('now'), ends_at = ?, payment_reference = ?
           WHERE id = ?`
        ).run(endsAt, chargeId, subRow.id);
      }
      notifyInfo = {
        userId,
        type: 'subscription',
        title: `SOFUMER Plan Activated: ${String(payment.plan_code || 'PRO')}`,
        body: `Telegram Stars payment confirmed (${Number(payment.stars_amount)} XTR). Your ${String(payment.plan_code)} (${String(payment.billing_cycle)}) plan is active.`,
      };
    } else if (payment.target_type === 'promotion') {
      const promo = db.prepare('SELECT * FROM promotions WHERE id = ?').get(payment.target_id) as
        | Record<string, unknown>
        | undefined;
      if (promo) {
        const days = Math.max(1, Number(promo.duration_days || 7));
        const endsAt = new Date(Date.now() + days * 86400_000).toISOString();
        db.prepare(
          "UPDATE promotions SET status = 'active', starts_at = datetime('now'), ends_at = ? WHERE id = ?"
        ).run(endsAt, promo.id);
        db.prepare(
          "UPDATE promotion_transactions SET status = 'recorded', reference = ? WHERE promotion_id = ?"
        ).run(chargeId, promo.id);
        if (promo.product_id) {
          if (promo.promo_type === 'sponsored_placement') {
            db.prepare('UPDATE products SET is_sponsored = 1 WHERE id = ?').run(promo.product_id);
          } else {
            db.prepare('UPDATE products SET is_featured = 1 WHERE id = ?').run(promo.product_id);
          }
        }
        notifyInfo = {
          userId,
          type: 'promotion',
          title: `Promotion Live: ${String(promo.title)}`,
          body: `Telegram Stars payment confirmed (${Number(payment.stars_amount)} XTR). Your promotion is active for ${days} days.`,
        };
      }
    }
  })();

  if (!updated) {
    return { status: 'already_processed', paymentId: String(payment.id) };
  }
  if (notifyInfo) {
    const n = notifyInfo as { userId: string; type: string; title: string; body: string };
    await notifyUserAndTelegram(n.userId, n.type, n.title, n.body);
  }
  return { status: 'paid', paymentId: String(payment.id) };
}

export async function processTelegramWebhookUpdate(update: Record<string, unknown>) {
  const updateId = Number(update.update_id);

  const preCheckout = update.pre_checkout_query as
    | {
        id: string;
        from?: { id?: number };
        currency?: string;
        total_amount?: number;
        invoice_payload?: string;
      }
    | undefined;

  if (preCheckout?.id) {
    const result = await fulfillStarsPreCheckoutLocal(preCheckout);
    if (updateId) {
      db.prepare('INSERT OR IGNORE INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)').run(
        updateId,
        String(preCheckout.from?.id || ''),
        result.valid ? 'pre_checkout_ok' : 'pre_checkout_rejected'
      );
    }
    return { status: 'pre_checkout_answered', valid: result.valid, updateId: updateId || null };
  }

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
  const from = message?.from as Record<string, unknown> | undefined;
  const successfulPayment = message?.successful_payment as
    | {
        currency?: string;
        total_amount?: number;
        invoice_payload?: string;
        telegram_payment_charge_id?: string;
        provider_payment_charge_id?: string;
      }
    | undefined;

  if (successfulPayment) {
    const chatId = chat?.id ? String(chat.id) : '';
    const payerId = from?.id ? String(from.id) : chatId;
    db.prepare('INSERT INTO telegram_updates (update_id, chat_id, command) VALUES (?, ?, ?)').run(
      updateId,
      chatId,
      'successful_payment'
    );
    const fulfillment = await fulfillStarsSuccessfulPaymentLocal(successfulPayment, payerId);
    return { status: 'payment_processed', paymentStatus: fulfillment.status, updateId };
  }

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
      cfg.miniAppUrl ? { label: 'Launch SOFUMER Marketplace', url: cfg.miniAppUrl } : undefined
    );
  } else if (command === '/sell') {
    await sendTelegramBotMessage(
      chatId,
      `Launch your global storefront on <b>SOFUMER</b>. List physical products, digital downloads, or services directly to international buyers.`,
      cfg.miniAppUrl ? { label: 'Open Seller Center', url: `${cfg.miniAppUrl}?tab=account&view=seller` } : undefined
    );
  } else if (command === '/explore') {
    await sendTelegramBotMessage(
      chatId,
      `Browse global categories, verified shops, and AI-assisted product discovery on <b>SOFUMER</b>.`,
      cfg.miniAppUrl ? { label: 'Explore Marketplace', url: `${cfg.miniAppUrl}?tab=explore` } : undefined
    );
  } else if (command === '/help') {
    await sendTelegramBotMessage(
      chatId,
      `<b>SOFUMER Help</b>\n\n/start — Open SOFUMER Mini App\n/explore — Browse global listings\n/sell — Open Seller Center\n\nNeed assistance? Open the Mini App → Account → Help and Support.`,
      cfg.miniAppUrl ? { label: 'Open SOFUMER', url: cfg.miniAppUrl } : undefined
    );
  }

  return { status: 'processed', updateId, command };
}
