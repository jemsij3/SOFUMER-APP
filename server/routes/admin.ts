import { Router } from 'express';
import { db, newId, slugify } from '../db.ts';
import {
  recordAdminAudit,
  requireAdmin,
  sanitizeText,
} from '../security.ts';
import { notifyUserAndTelegram } from '../telegram.ts';

export const adminRouter = Router();

// ============================================================================
// ADMIN AUTHENTICATION (TELEGRAM JWT + ADMIN_TELEGRAM_IDS)
// ============================================================================

adminRouter.get('/auth/me', requireAdmin, (req, res) => {
  res.json({ authenticated: true, admin: req.adminSession });
});

adminRouter.post('/auth/logout', requireAdmin, (req, res) => {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(
    req.adminSession!.sessionId
  );
  res.clearCookie('sofumer_session', { sameSite: 'none', secure: true, partitioned: true });
  res.json({ loggedOut: true });
});

// ============================================================================
// OVERVIEW & ANALYTICS
// ============================================================================

adminRouter.get('/overview', requireAdmin, (_req, res) => {
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) as total_users,
         (SELECT COUNT(*) FROM seller_profiles) as total_sellers,
         (SELECT COUNT(*) FROM shops) as total_shops,
         (SELECT COUNT(*) FROM products) as total_products,
         (SELECT COUNT(*) FROM products WHERE status = 'pending_review') as pending_products,
         (SELECT COUNT(*) FROM orders) as total_orders,
         (SELECT COUNT(*) FROM orders WHERE status = 'Disputed') as disputed_orders,
         (SELECT COUNT(*) FROM reports WHERE status IN ('open', 'investigating')) as open_reports,
         (SELECT COUNT(*) FROM support_tickets WHERE status IN ('open', 'in_progress')) as open_tickets,
         (SELECT COALESCE(SUM(amount_recorded), 0) FROM subscriptions WHERE status = 'active') as subscription_revenue_usd,
         (SELECT COALESCE(SUM(amount), 0) FROM promotion_transactions WHERE status = 'recorded') as promotion_revenue_usd,
         (SELECT COUNT(*) FROM ai_usage WHERE date(created_at) = date('now')) as ai_calls_today,
         (SELECT COUNT(*) FROM ai_usage WHERE status = 'error' AND date(created_at) = date('now')) as ai_errors_today`
    )
    .get();

  res.json({ overview: counts });
});

// ============================================================================
// USERS & INDIVIDUAL AI ACCESS
// ============================================================================

adminRouter.get('/users', requireAdmin, (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.*, COALESCE(ap.ai_enabled, 1) as ai_enabled, ap.custom_daily_limit,
              (SELECT GROUP_CONCAT(role) FROM user_roles ur WHERE ur.user_id = u.id) as roles
       FROM users u
       LEFT JOIN ai_permissions ap ON ap.user_id = u.id
       ORDER BY u.created_at DESC`
    )
    .all();
  res.json({ users });
});

adminRouter.patch('/users/:id/status', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  const reason = sanitizeText(req.body?.reason || '', 300);
  if (!['active', 'restricted', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid user status.' });
  }
  db.prepare("UPDATE users SET status = ?, restriction_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    reason,
    req.params.id
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'user.status_updated', 'user', req.params.id, { status, reason }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.patch('/users/:id/ai-access', requireAdmin, (req, res) => {
  const aiEnabled = req.body?.aiEnabled ? 1 : 0;
  const customDailyLimit =
    req.body?.customDailyLimit !== undefined && req.body?.customDailyLimit !== ''
      ? Number(req.body.customDailyLimit)
      : null;
  const reason = sanitizeText(req.body?.reason || '', 300);

  db.prepare(
    `INSERT INTO ai_permissions (user_id, ai_enabled, custom_daily_limit, reason, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       ai_enabled = excluded.ai_enabled,
       custom_daily_limit = excluded.custom_daily_limit,
       reason = excluded.reason,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`
  ).run(req.params.id, aiEnabled, customDailyLimit, reason, req.adminSession!.adminIdentifier);

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'user.ai_access_updated',
    'user',
    req.params.id,
    { aiEnabled: Boolean(aiEnabled), customDailyLimit, reason },
    req.ip || ''
  );
  res.json({ updated: true });
});

// ============================================================================
// SELLERS & SHOPS
// ============================================================================

adminRouter.get('/sellers', requireAdmin, (_req, res) => {
  const sellers = db
    .prepare(
      `SELECT sp.*, u.display_name, u.telegram_username, s.id as shop_id, s.name as shop_name,
              s.slug as shop_slug, s.status as shop_status, s.is_featured, s.verification_status as shop_verification_status
       FROM seller_profiles sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN shops s ON s.seller_id = sp.id
       ORDER BY sp.created_at DESC`
    )
    .all();
  res.json({ sellers });
});

adminRouter.patch('/sellers/:id/status', requireAdmin, async (req, res) => {
  const status = String(req.body?.status || '');
  const verificationStatus = req.body?.verificationStatus ? String(req.body.verificationStatus) : null;
  const isFeatured = req.body?.isFeatured;

  const seller = db.prepare('SELECT * FROM seller_profiles WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!seller) return res.status(404).json({ error: 'Seller not found.' });

  if (['active', 'suspended'].includes(status)) {
    db.prepare("UPDATE seller_profiles SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, seller.id);
    db.prepare("UPDATE shops SET status = ?, updated_at = datetime('now') WHERE seller_id = ?").run(status, seller.id);
  }
  if (verificationStatus && ['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) {
    db.prepare('UPDATE seller_profiles SET verification_status = ? WHERE id = ?').run(verificationStatus, seller.id);
    db.prepare('UPDATE shops SET verification_status = ? WHERE seller_id = ?').run(verificationStatus, seller.id);
    await notifyUserAndTelegram(
      String(seller.user_id),
      'verification',
      `Shop Verification: ${verificationStatus.toUpperCase()}`,
      `Your SOFUMER shop verification status is now ${verificationStatus}.`
    );
  }
  if (typeof isFeatured === 'boolean') {
    db.prepare('UPDATE shops SET is_featured = ? WHERE seller_id = ?').run(isFeatured ? 1 : 0, seller.id);
  }

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'seller.updated',
    'seller',
    req.params.id,
    { status, verificationStatus, isFeatured },
    req.ip || ''
  );
  res.json({ updated: true });
});

// ============================================================================
// PRODUCTS MODERATION
// ============================================================================

adminRouter.get('/products', requireAdmin, (_req, res) => {
  const products = db
    .prepare(
      `SELECT p.*, s.name as shop_name, c.name as category_name, u.display_name as seller_name
       FROM products p
       JOIN shops s ON s.id = p.shop_id
       JOIN categories c ON c.id = p.category_id
       JOIN users u ON u.id = p.seller_user_id
       ORDER BY CASE WHEN p.status = 'pending_review' THEN 0 ELSE 1 END, p.created_at DESC`
    )
    .all();
  res.json({ products });
});

adminRouter.patch('/products/:id/moderate', requireAdmin, async (req, res) => {
  const status = String(req.body?.status || '');
  const notes = sanitizeText(req.body?.notes || '', 400);
  const isFeatured = req.body?.isFeatured;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  if (['published', 'rejected', 'pending_review', 'archived'].includes(status)) {
    db.prepare("UPDATE products SET status = ?, moderation_notes = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      notes,
      product.id
    );
    await notifyUserAndTelegram(
      String(product.seller_user_id),
      'moderation',
      `Listing ${status.replace('_', ' ')}: ${String(product.title)}`,
      notes || `Your listing status was updated to ${status}.`
    );
  }
  if (typeof isFeatured === 'boolean') {
    db.prepare('UPDATE products SET is_featured = ? WHERE id = ?').run(isFeatured ? 1 : 0, product.id);
  }

  db.prepare(
    `INSERT INTO moderation_actions (id, target_type, target_id, action, reason, performed_by)
     VALUES (?, 'product', ?, ?, ?, ?)`
  ).run(newId('mod'), product.id, status || 'feature_toggle', notes, req.adminSession!.adminIdentifier);

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'product.moderated',
    'product',
    req.params.id,
    { status, notes, isFeatured },
    req.ip || ''
  );
  res.json({ updated: true });
});

// ============================================================================
// CATEGORIES & SUBCATEGORIES
// ============================================================================

adminRouter.get('/categories', requireAdmin, (_req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
  const subcategories = db.prepare('SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC').all();
  res.json({ categories, subcategories });
});

adminRouter.post('/categories', requireAdmin, (req, res) => {
  const name = sanitizeText(req.body?.name || '', 80);
  const description = sanitizeText(req.body?.description || '', 240);
  const sortOrder = Number(req.body?.sortOrder || 99);
  if (!name) return res.status(400).json({ error: 'Category name required.' });

  const id = newId('cat');
  const slug = slugify(name);
  db.prepare('INSERT INTO categories (id, slug, name, description, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    id,
    slug,
    name,
    description,
    sortOrder
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'category.created', 'category', id, { name }, req.ip || '');
  res.status(201).json({ id, slug, name });
});

adminRouter.post('/subcategories', requireAdmin, (req, res) => {
  const categoryId = sanitizeText(req.body?.categoryId || '', 64);
  const name = sanitizeText(req.body?.name || '', 80);
  if (!categoryId || !name) return res.status(400).json({ error: 'Category ID and name required.' });

  const id = newId('sub');
  const slug = slugify(name);
  db.prepare('INSERT INTO subcategories (id, category_id, slug, name) VALUES (?, ?, ?, ?)').run(
    id,
    categoryId,
    slug,
    name
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'subcategory.created', 'subcategory', id, { categoryId, name }, req.ip || '');
  res.status(201).json({ id, categoryId, slug, name });
});

// ============================================================================
// ORDERS, REPORTS, REVIEWS, SUPPORT, MESSAGES INVESTIGATION
// ============================================================================

adminRouter.get('/orders', requireAdmin, (_req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, s.name as shop_name, bu.display_name as buyer_name, su.display_name as seller_name
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id
       JOIN users su ON su.id = o.seller_user_id
       ORDER BY o.updated_at DESC LIMIT 100`
    )
    .all();
  res.json({ orders });
});

adminRouter.get('/reports', requireAdmin, (_req, res) => {
  const reports = db
    .prepare(
      `SELECT r.*, u.display_name as reporter_name
       FROM reports r
       JOIN users u ON u.id = r.reporter_user_id
       ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC`
    )
    .all();
  const flaggedConversations = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
       FROM conversations c WHERE c.status = 'flagged' ORDER BY c.created_at DESC`
    )
    .all();
  res.json({ reports, flaggedConversations });
});

adminRouter.get('/conversations/:id/messages', requireAdmin, (req, res) => {
  const messages = db
    .prepare(
      `SELECT m.*, u.display_name as sender_name
       FROM messages m JOIN users u ON u.id = m.sender_user_id
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC`
    )
    .all(req.params.id);
  recordAdminAudit(req.adminSession!.adminIdentifier, 'conversation.investigated', 'conversation', req.params.id, {}, req.ip || '');
  res.json({ messages });
});

adminRouter.patch('/reports/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || 'resolved');
  const resolutionNotes = sanitizeText(req.body?.resolutionNotes || '', 500);
  if (!['open', 'investigating', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid report status.' });
  }
  db.prepare(
    `UPDATE reports SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`
  ).run(status, resolutionNotes, req.adminSession!.adminIdentifier, req.params.id);
  recordAdminAudit(req.adminSession!.adminIdentifier, 'report.updated', 'report', req.params.id, { status, resolutionNotes }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.get('/reviews', requireAdmin, (_req, res) => {
  const reviews = db
    .prepare(
      `SELECT r.*, u.display_name as reviewer_name, p.title as product_title, s.name as shop_name
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       JOIN products p ON p.id = r.product_id
       JOIN shops s ON s.id = r.shop_id
       ORDER BY r.created_at DESC`
    )
    .all();
  res.json({ reviews });
});

adminRouter.patch('/reviews/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || 'published');
  if (!['published', 'hidden', 'removed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid review status.' });
  }
  db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, req.params.id);
  recordAdminAudit(req.adminSession!.adminIdentifier, 'review.moderated', 'review', req.params.id, { status }, req.ip || '');
  res.json({ updated: true });
});

// ============================================================================
// MONETIZATION: SUBSCRIPTIONS, PROMOTIONS, REVENUE
// ============================================================================

adminRouter.get('/monetization', requireAdmin, (_req, res) => {
  const plans = db.prepare('SELECT * FROM subscription_plans ORDER BY monthly_price ASC').all();
  const subscriptions = db
    .prepare(
      `SELECT s.*, sp.code as plan_code, sp.name as plan_name, u.display_name as seller_name
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC LIMIT 100`
    )
    .all();
  const promotions = db
    .prepare(
      `SELECT pr.*, s.name as shop_name, p.title as product_title, u.display_name as seller_name
       FROM promotions pr
       JOIN shops s ON s.id = pr.shop_id
       JOIN users u ON u.id = pr.user_id
       LEFT JOIN products p ON p.id = pr.product_id
       ORDER BY pr.created_at DESC`
    )
    .all();
  const promotionTransactions = db
    .prepare('SELECT * FROM promotion_transactions ORDER BY created_at DESC LIMIT 100')
    .all();

  res.json({ plans, subscriptions, promotions, promotionTransactions });
});

adminRouter.patch('/plans/:id', requireAdmin, (req, res) => {
  const monthlyPrice = Number(req.body?.monthlyPrice ?? 0);
  const annualPrice = Number(req.body?.annualPrice ?? 0);
  const maxProducts = Math.max(1, Number(req.body?.maxProducts ?? 10));
  const aiDailyLimit = Math.max(0, Number(req.body?.aiDailyLimit ?? 15));
  const featuredSlots = Math.max(0, Number(req.body?.featuredSlots ?? 0));
  const promotionalDiscountPct = Math.min(90, Math.max(0, Number(req.body?.promotionalDiscountPct ?? 0)));

  db.prepare(
    `UPDATE subscription_plans
     SET monthly_price = ?, annual_price = ?, max_products = ?, ai_daily_limit = ?, featured_slots = ?, promotional_discount_pct = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(monthlyPrice, annualPrice, maxProducts, aiDailyLimit, featuredSlots, promotionalDiscountPct, req.params.id);

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'plan.updated',
    'subscription_plan',
    req.params.id,
    { monthlyPrice, annualPrice, maxProducts, aiDailyLimit },
    req.ip || ''
  );
  res.json({ updated: true });
});

adminRouter.patch('/promotions/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid promotion status.' });
  }
  const promo = db.prepare('SELECT * FROM promotions WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!promo) return res.status(404).json({ error: 'Promotion not found.' });

  db.transaction(() => {
    db.prepare('UPDATE promotions SET status = ? WHERE id = ?').run(status, promo.id);
    if (status === 'active') {
      db.prepare("UPDATE promotion_transactions SET status = 'recorded' WHERE promotion_id = ?").run(promo.id);
      if (promo.product_id) {
        if (promo.promo_type === 'sponsored_placement') {
          db.prepare('UPDATE products SET is_sponsored = 1 WHERE id = ?').run(promo.product_id);
        } else {
          db.prepare('UPDATE products SET is_featured = 1 WHERE id = ?').run(promo.product_id);
        }
      }
    }
  })();

  recordAdminAudit(req.adminSession!.adminIdentifier, 'promotion.updated', 'promotion', req.params.id, { status }, req.ip || '');
  res.json({ updated: true });
});

// ============================================================================
// AI GOVERNANCE, USAGE & ERROR MONITORING
// ============================================================================

adminRouter.get('/ai', requireAdmin, (_req, res) => {
  const features = db.prepare('SELECT * FROM ai_feature_settings ORDER BY id ASC').all();
  const usageLogs = db
    .prepare(
      `SELECT au.*, u.display_name as user_name
       FROM ai_usage au
       LEFT JOIN users u ON u.id = au.user_id
       ORDER BY au.created_at DESC LIMIT 100`
    )
    .all();
  const summary = db
    .prepare(
      `SELECT
         COUNT(*) as total_calls,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_calls,
         SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) as denied_calls,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls,
         COALESCE(AVG(latency_ms), 0) as avg_latency_ms
       FROM ai_usage`
    )
    .get();
  res.json({ features, usageLogs, summary });
});

adminRouter.patch('/ai/features/:featureKey', requireAdmin, (req, res) => {
  const isEnabled = req.body?.isEnabled ? 1 : 0;
  const modelName = sanitizeText(
    req.body?.modelName || process.env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct',
    64
  );
  const dailyLimitPerUser = Math.max(0, Number(req.body?.dailyLimitPerUser ?? 30));

  db.prepare(
    `UPDATE ai_feature_settings
     SET is_enabled = ?, model_name = ?, daily_limit_per_user = ?, updated_by = ?, updated_at = datetime('now')
     WHERE feature_key = ?`
  ).run(isEnabled, modelName, dailyLimitPerUser, req.adminSession!.adminIdentifier, req.params.featureKey);

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'ai.feature_updated',
    'ai_feature',
    req.params.featureKey,
    { isEnabled: Boolean(isEnabled), modelName, dailyLimitPerUser },
    req.ip || ''
  );
  res.json({ updated: true });
});

// ============================================================================
// COUNTRIES, SUPPORT, SETTINGS, NOTIFICATIONS, ROLES, AUDIT LOGS
// ============================================================================

adminRouter.get('/countries', requireAdmin, (_req, res) => {
  const countries = db.prepare('SELECT * FROM countries ORDER BY name ASC').all();
  const currencies = db.prepare('SELECT * FROM currencies ORDER BY code ASC').all();
  res.json({ countries, currencies });
});

adminRouter.patch('/countries/:code', requireAdmin, (req, res) => {
  const isEnabled = req.body?.isEnabled ? 1 : 0;
  const shippingNotes = sanitizeText(req.body?.shippingNotes || '', 300);
  db.prepare('UPDATE countries SET is_enabled = ?, shipping_notes = ? WHERE code = ?').run(
    isEnabled,
    shippingNotes,
    req.params.code.toUpperCase()
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'country.updated', 'country', req.params.code, { isEnabled }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.get('/support', requireAdmin, (_req, res) => {
  const tickets = db
    .prepare(
      `SELECT t.*, u.display_name, u.telegram_username
       FROM support_tickets t JOIN users u ON u.id = t.user_id
       ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC`
    )
    .all();
  res.json({ tickets });
});

adminRouter.patch('/support/:id', requireAdmin, async (req, res) => {
  const status = String(req.body?.status || 'resolved');
  const adminResponse = sanitizeText(req.body?.adminResponse || '', 1500);
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

  db.prepare(
    `UPDATE support_tickets SET status = ?, admin_response = ?, responded_by = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, adminResponse, req.adminSession!.adminIdentifier, ticket.id);

  await notifyUserAndTelegram(
    String(ticket.user_id),
    'support',
    `Support Ticket Updated: ${String(ticket.subject)}`,
    adminResponse || `Ticket status changed to ${status}.`
  );

  recordAdminAudit(req.adminSession!.adminIdentifier, 'support.updated', 'support_ticket', req.params.id, { status }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.post('/notifications/broadcast', requireAdmin, (req, res) => {
  const title = sanitizeText(req.body?.title || '', 120);
  const body = sanitizeText(req.body?.body || '', 600);
  if (!title || !body) return res.status(400).json({ error: 'Title and body required.' });

  db.prepare(
    `INSERT INTO notifications (id, user_id, scope, type, title, body) VALUES (?, NULL, 'global', 'announcement', ?, ?)`
  ).run(newId('notif'), title, body);

  db.prepare(
    `INSERT INTO platform_settings (key, value, value_type, updated_by, updated_at)
     VALUES ('marketplace_announcement', ?, 'string', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(`${title} — ${body}`, req.adminSession!.adminIdentifier);

  recordAdminAudit(req.adminSession!.adminIdentifier, 'notification.broadcast', 'global', 'announcement', { title }, req.ip || '');
  res.status(201).json({ broadcast: true });
});

adminRouter.get('/settings', requireAdmin, (_req, res) => {
  const settings = db.prepare('SELECT * FROM platform_settings ORDER BY key ASC').all();
  const roles = db.prepare('SELECT * FROM admin_roles').all();
  const permissions = db.prepare('SELECT * FROM admin_permissions').all();
  res.json({ settings, roles, permissions });
});

adminRouter.patch('/settings/:key', requireAdmin, (req, res) => {
  const value = sanitizeText(String(req.body?.value ?? ''), 500);
  db.prepare(
    `UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`
  ).run(value, req.adminSession!.adminIdentifier, req.params.key);
  recordAdminAudit(req.adminSession!.adminIdentifier, 'setting.updated', 'setting', req.params.key, { value }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.get('/audit-logs', requireAdmin, (_req, res) => {
  const logs = db
    .prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 150')
    .all();
  res.json({ logs });
});
