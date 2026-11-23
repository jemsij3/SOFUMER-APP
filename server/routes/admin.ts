import { Router } from 'express';
import { db, newId, slugify } from '../db.ts';
import { invokeCloudflareWorkersAi, logAiUsage } from '../ai.ts';
import {
  ADMIN_PERMISSION_CATALOG,
  DEFAULT_CF_AI_MODEL,
  OWNER_ONLY_PERMISSIONS,
  VALID_CF_MODELS,
  VALID_PERMISSION_KEYS,
  checkProhibitedKeywords,
  hasAdminPermission,
  isTelegramIdAdmin,
  recordAdminAudit,
  requireAdmin,
  requireAdminPermission,
  sanitizeText,
} from '../security.ts';
import { notifyUserAndTelegram } from '../telegram.ts';

export const adminRouter = Router();

function validateAndNormalizeSettingLocal(
  key: string,
  rawValue: unknown
): { ok: true; value: string } | { ok: false; error: string; status?: number } {
  const row = db
    .prepare('SELECT key, value_type FROM platform_settings WHERE key = ?')
    .get(key) as { key: string; value_type: string } | undefined;
  if (!row) {
    return { ok: false, error: `Setting "${key}" not found.`, status: 404 };
  }

  if (
    row.value_type === 'boolean' ||
    key === 'seller_registration_enabled' ||
    key === 'product_submissions_enabled' ||
    key === 'auto_approve_products'
  ) {
    if (typeof rawValue === 'boolean') {
      return { ok: true, value: rawValue ? 'true' : 'false' };
    }
    const str = String(rawValue ?? '').trim().toLowerCase();
    if (str !== 'true' && str !== 'false') {
      return { ok: false, error: `Setting "${key}" must be "true" or "false".`, status: 400 };
    }
    return { ok: true, value: str };
  }

  if (
    row.value_type === 'number' ||
    key === 'stars_per_usd' ||
    key === 'featured_product_price_7d' ||
    key === 'sponsored_placement_price_7d' ||
    key === 'banner_ad_price_7d'
  ) {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Setting "${key}" must be a valid finite number.`, status: 400 };
    }
    if (key === 'stars_per_usd') {
      if (!Number.isInteger(num) || num < 1 || num > 10000) {
        return { ok: false, error: 'stars_per_usd must be a whole number between 1 and 10,000.', status: 400 };
      }
      return { ok: true, value: String(num) };
    }
    if (key.endsWith('_price_7d')) {
      if (num < 1 || num > 10000) {
        return { ok: false, error: `${key} must be between 1 and 10,000 USD.`, status: 400 };
      }
      return { ok: true, value: String(Number(num.toFixed(2))) };
    }
    if (num < 0) {
      return { ok: false, error: `${key} must be a non-negative number.`, status: 400 };
    }
    return { ok: true, value: String(num) };
  }

  if (key === 'prohibited_keywords') {
    const cleaned = Array.from(
      new Set(
        String(rawValue ?? '')
          .split(',')
          .map((item) => sanitizeText(item, 60).toLowerCase())
          .filter(Boolean)
      )
    )
      .join(', ')
      .slice(0, 500);
    return { ok: true, value: cleaned };
  }

  return { ok: true, value: sanitizeText(String(rawValue ?? ''), 500) };
}

function getEnvOwnerTelegramIds(): string[] {
  return [process.env.ADMIN_TELEGRAM_IDS, process.env.ADMIN_TELEGRAM_ID]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
}

function roleHasOwnerOnlyPermissionsLocal(roleId: string): boolean {
  const rows = db
    .prepare('SELECT permission_key FROM admin_permissions WHERE role_id = ?')
    .all(roleId) as Array<{ permission_key: string }>;
  return rows.some((p) => OWNER_ONLY_PERMISSIONS.has(p.permission_key));
}

// ============================================================================
// ADMIN AUTHENTICATION (TELEGRAM JWT + ADMIN_TELEGRAM_IDS + DB RBAC)
// ============================================================================

adminRouter.get('/auth/me', requireAdmin, (req, res) => {
  res.json({
    authenticated: true,
    admin: req.adminSession,
    permissionCatalog: ADMIN_PERMISSION_CATALOG,
  });
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

adminRouter.get('/overview', requireAdminPermission('overview.view'), (_req, res) => {
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
         (SELECT COALESCE(SUM(stars_amount), 0) FROM telegram_stars_payments WHERE status = 'paid') as stars_revenue_xtr,
         (SELECT COUNT(*) FROM telegram_stars_payments WHERE status = 'pending') as pending_stars_payments,
         (SELECT COUNT(*) FROM ai_usage WHERE date(created_at) = date('now')) as ai_calls_today,
         (SELECT COUNT(*) FROM ai_usage WHERE status = 'error' AND date(created_at) = date('now')) as ai_errors_today`
    )
    .get();

  res.json({ overview: counts });
});

adminRouter.get('/analytics', requireAdminPermission('analytics.view'), (_req, res) => {
  const productsByStatus = db
    .prepare('SELECT status, COUNT(*) as cnt FROM products GROUP BY status ORDER BY cnt DESC')
    .all();
  const productsByType = db
    .prepare('SELECT listing_type, COUNT(*) as cnt FROM products GROUP BY listing_type ORDER BY cnt DESC')
    .all();
  const ordersByStatus = db
    .prepare('SELECT status, COUNT(*) as cnt, COALESCE(SUM(agreed_total), 0) as volume_usd FROM orders GROUP BY status ORDER BY cnt DESC')
    .all();
  const topCategories = db
    .prepare(
      `SELECT c.id, c.name, COUNT(p.id) as product_count, COALESCE(SUM(p.view_count), 0) as total_views
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id, c.name ORDER BY product_count DESC, total_views DESC LIMIT 10`
    )
    .all();
  const aiByFeature = db
    .prepare(
      `SELECT feature_key,
              COUNT(*) as total_calls,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_calls,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls,
              COALESCE(AVG(latency_ms), 0) as avg_latency_ms
       FROM ai_usage GROUP BY feature_key ORDER BY total_calls DESC`
    )
    .all();
  const engagementTotals = db
    .prepare(
      `SELECT COALESCE(SUM(view_count), 0) as total_views,
              COALESCE(SUM(favorite_count), 0) as total_favorites,
              COALESCE(SUM(inquiry_count), 0) as total_inquiries,
              (SELECT COUNT(*) FROM conversations) as total_conversations,
              (SELECT COUNT(*) FROM reviews WHERE status = 'published') as published_reviews
       FROM products`
    )
    .get();
  const verificationBreakdown = db
    .prepare('SELECT verification_status, COUNT(*) as cnt FROM shops GROUP BY verification_status')
    .all();

  res.json({
    productsByStatus,
    productsByType,
    ordersByStatus,
    topCategories,
    aiByFeature,
    engagementTotals,
    verificationBreakdown,
  });
});

// ============================================================================
// USERS & INDIVIDUAL AI ACCESS
// ============================================================================

adminRouter.get('/users', requireAdminPermission('users.manage'), (_req, res) => {
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

adminRouter.patch('/users/:id/status', requireAdminPermission('users.manage'), (req, res) => {
  const status = String(req.body?.status || '');
  const reason = sanitizeText(req.body?.reason || '', 300);
  if (!['active', 'restricted', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid user status.' });
  }
  const upd = db
    .prepare("UPDATE users SET status = ?, restriction_reason = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, reason, req.params.id);
  if (upd.changes === 0) return res.status(404).json({ error: 'User not found.' });
  recordAdminAudit(req.adminSession!.adminIdentifier, 'user.status_updated', 'user', req.params.id, { status, reason }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.patch('/users/:id/ai-access', requireAdminPermission('users.manage'), (req, res) => {
  const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!userExists) return res.status(404).json({ error: 'User not found.' });

  const aiEnabled = req.body?.aiEnabled ? 1 : 0;
  const customDailyLimit =
    req.body?.customDailyLimit !== undefined && req.body?.customDailyLimit !== '' && req.body?.customDailyLimit !== null
      ? Number(req.body.customDailyLimit)
      : null;
  if (customDailyLimit !== null && (!Number.isFinite(customDailyLimit) || customDailyLimit < 0)) {
    return res.status(400).json({ error: 'customDailyLimit must be a non-negative number.' });
  }
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

adminRouter.get('/sellers', requireAdminPermission(['sellers.manage', 'sellers.suspend', 'shops.manage']), (_req, res) => {
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

adminRouter.patch('/sellers/:id/status', requireAdminPermission(['sellers.manage', 'sellers.suspend', 'shops.manage']), async (req, res) => {
  const status = String(req.body?.status || '');
  const verificationStatus = req.body?.verificationStatus ? String(req.body.verificationStatus) : null;
  const isFeatured = req.body?.isFeatured;

  if ((verificationStatus || typeof isFeatured === 'boolean') && !hasAdminPermission(req.adminSession!, ['sellers.manage', 'shops.manage'])) {
    return res.status(403).json({ error: 'Insufficient administrative permissions to change shop verification or featured status.' });
  }

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
// PRODUCTS MODERATION & AI POLICY SCAN
// ============================================================================

adminRouter.get('/products', requireAdminPermission(['moderation.manage', 'catalog.manage']), (_req, res) => {
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

adminRouter.patch('/products/:id/moderate', requireAdminPermission('moderation.manage'), async (req, res) => {
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
  if (typeof req.body?.isSponsored === 'boolean') {
    db.prepare('UPDATE products SET is_sponsored = ? WHERE id = ?').run(req.body.isSponsored ? 1 : 0, product.id);
  }

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

adminRouter.post('/moderation/products/:id/ai-scan', requireAdminPermission('moderation.manage'), async (req, res) => {
  const product = db
    .prepare(
      `SELECT p.*, c.name as category_name, s.name as shop_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ?`
    )
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  const textBlob = `${String(product.title || '')} ${String(product.description || '')} ${String(product.keywords || '')}`;
  const keywordMatches = checkProhibitedKeywords(textBlob);

  const settingRow = db
    .prepare("SELECT model_name FROM ai_feature_settings WHERE feature_key = 'platform_support'")
    .get() as { model_name: string } | undefined;
  const candidateModel = settingRow?.model_name || process.env.CLOUDFLARE_AI_MODEL || DEFAULT_CF_AI_MODEL;
  const modelName = VALID_CF_MODELS.has(candidateModel) ? candidateModel : DEFAULT_CF_AI_MODEL;

  let riskLevel: 'low' | 'medium' | 'high' = keywordMatches.length > 0 ? 'high' : 'low';
  let rationale = keywordMatches.length
    ? `Matched prohibited keywords: ${keywordMatches.join(', ')}.`
    : 'No prohibited marketplace keywords detected.';
  let recommendedStatus: 'published' | 'pending_review' | 'rejected' = keywordMatches.length > 0 ? 'rejected' : 'published';
  let aiEvaluated = false;

  try {
    const start = Date.now();
    const rawText = await invokeCloudflareWorkersAi(
      modelName,
      [
        {
          role: 'system',
          content:
            'You are SOFUMER Trust & Safety AI Moderator. Evaluate marketplace listings for prohibited/illegal goods, fraud, counterfeit indicators, or policy violations. Respond ONLY with valid JSON: {"riskLevel": "low"|"medium"|"high", "recommendedStatus": "published"|"pending_review"|"rejected", "rationale": string}.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: product.title,
            description: product.description,
            listingType: product.listing_type,
            category: product.category_name,
            price: product.price,
            currency: product.currency,
            keywordMatches,
          }),
        },
      ],
      true
    );
    const matchJson = rawText.match(/\{[\s\S]*\}/);
    if (matchJson) {
      const parsed = JSON.parse(matchJson[0]) as {
        riskLevel?: string;
        recommendedStatus?: string;
        rationale?: string;
      };
      if (parsed.riskLevel === 'low' || parsed.riskLevel === 'medium' || parsed.riskLevel === 'high') {
        riskLevel = keywordMatches.length > 0 ? 'high' : parsed.riskLevel;
      }
      if (
        parsed.recommendedStatus === 'published' ||
        parsed.recommendedStatus === 'pending_review' ||
        parsed.recommendedStatus === 'rejected'
      ) {
        recommendedStatus = keywordMatches.length > 0 ? 'rejected' : parsed.recommendedStatus;
      }
      if (parsed.rationale) {
        rationale = sanitizeText(parsed.rationale, 400);
      }
      aiEvaluated = true;
    }
    logAiUsage(req.adminSession!.userId, 'platform_support', modelName, `admin_scan:${req.params.id}`, 'success', Date.now() - start, Math.ceil(rawText.length / 4));
  } catch {
    // Fall back to deterministic keyword check if REST credentials are absent in local dev
  }

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'product.ai_moderation_scan',
    'product',
    req.params.id,
    { riskLevel, recommendedStatus, keywordMatches, aiEvaluated, modelName },
    req.ip || ''
  );

  res.json({
    productId: req.params.id,
    riskLevel,
    recommendedStatus,
    keywordMatches,
    rationale,
    aiEvaluated,
    model: modelName,
  });
});

// ============================================================================
// CATEGORIES & SUBCATEGORIES
// ============================================================================

adminRouter.get('/categories', requireAdminPermission(['catalog.manage', 'moderation.manage']), (_req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
  const subcategories = db.prepare('SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC').all();
  res.json({ categories, subcategories });
});

adminRouter.post('/categories', requireAdminPermission('catalog.manage'), (req, res) => {
  const name = sanitizeText(req.body?.name || '', 80);
  const description = sanitizeText(req.body?.description || '', 240);
  const sortOrder = Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 99;
  if (!name) return res.status(400).json({ error: 'Category name required.' });

  const id = newId('cat');
  const slug = `${slugify(name)}-${id.slice(-4)}`;
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

adminRouter.patch('/categories/:id', requireAdminPermission('catalog.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return res.status(404).json({ error: 'Category not found.' });

  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 80) : String(existing.name);
  const description =
    req.body?.description !== undefined ? sanitizeText(req.body.description, 240) : String(existing.description || '');
  const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : Number(existing.is_active ?? 1);
  if (!name) return res.status(400).json({ error: 'Category name cannot be empty.' });

  db.prepare('UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?').run(
    name,
    description,
    isActive,
    req.params.id
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'category.updated', 'category', req.params.id, { name, isActive: Boolean(isActive) }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.post('/subcategories', requireAdminPermission('catalog.manage'), (req, res) => {
  const categoryId = sanitizeText(req.body?.categoryId || '', 64);
  const name = sanitizeText(req.body?.name || '', 80);
  if (!categoryId || !name) return res.status(400).json({ error: 'Category ID and name required.' });

  const parentCat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!parentCat) return res.status(404).json({ error: 'Parent category not found.' });

  const id = newId('sub');
  const slug = `${slugify(name)}-${id.slice(-4)}`;
  db.prepare('INSERT INTO subcategories (id, category_id, slug, name) VALUES (?, ?, ?, ?)').run(
    id,
    categoryId,
    slug,
    name
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'subcategory.created', 'subcategory', id, { categoryId, name }, req.ip || '');
  res.status(201).json({ id, categoryId, slug, name });
});

adminRouter.patch('/subcategories/:id', requireAdminPermission('catalog.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return res.status(404).json({ error: 'Subcategory not found.' });

  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 80) : String(existing.name);
  const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : Number(existing.is_active ?? 1);
  if (!name) return res.status(400).json({ error: 'Subcategory name cannot be empty.' });

  db.prepare('UPDATE subcategories SET name = ?, is_active = ? WHERE id = ?').run(name, isActive, req.params.id);
  recordAdminAudit(req.adminSession!.adminIdentifier, 'subcategory.updated', 'subcategory', req.params.id, { name, isActive: Boolean(isActive) }, req.ip || '');
  res.json({ updated: true });
});

// ============================================================================
// ORDERS, REPORTS, REVIEWS, SUPPORT, MESSAGES INVESTIGATION
// ============================================================================

adminRouter.get('/orders', requireAdminPermission('orders.manage'), (_req, res) => {
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

adminRouter.get('/reports', requireAdminPermission(['reports.manage', 'messages.moderate']), (_req, res) => {
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

adminRouter.get('/conversations/:id/messages', requireAdminPermission(['reports.manage', 'messages.moderate']), (req, res) => {
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

adminRouter.patch('/reports/:id', requireAdminPermission('reports.manage'), (req, res) => {
  const status = String(req.body?.status || 'resolved');
  const resolutionNotes = sanitizeText(req.body?.resolutionNotes || '', 500);
  if (!['open', 'investigating', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid report status.' });
  }
  const repUpd = db
    .prepare(
      `UPDATE reports SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`
    )
    .run(status, resolutionNotes, req.adminSession!.adminIdentifier, req.params.id);
  if (repUpd.changes === 0) return res.status(404).json({ error: 'Report not found.' });
  recordAdminAudit(req.adminSession!.adminIdentifier, 'report.updated', 'report', req.params.id, { status, resolutionNotes }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.get('/reviews', requireAdminPermission('reviews.manage'), (_req, res) => {
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

adminRouter.patch('/reviews/:id', requireAdminPermission('reviews.manage'), (req, res) => {
  const status = String(req.body?.status || 'published');
  if (!['published', 'hidden', 'removed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid review status.' });
  }
  const review = db
    .prepare('SELECT id, product_id, shop_id FROM reviews WHERE id = ?')
    .get(req.params.id) as { id: string; product_id: string; shop_id: string } | undefined;
  if (!review) return res.status(404).json({ error: 'Review not found.' });

  db.transaction(() => {
    db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, review.id);

    const prodAgg = db
      .prepare("SELECT COALESCE(AVG(rating), 0) as avg_r, COUNT(*) as cnt FROM reviews WHERE product_id = ? AND status = 'published'")
      .get(review.product_id) as { avg_r: number; cnt: number };
    db.prepare('UPDATE products SET rating_avg = ?, review_count = ? WHERE id = ?').run(
      Number((prodAgg.avg_r || 0).toFixed(2)),
      prodAgg.cnt,
      review.product_id
    );

    const shopAgg = db
      .prepare("SELECT COALESCE(AVG(rating), 0) as avg_r, COUNT(*) as cnt FROM reviews WHERE shop_id = ? AND status = 'published'")
      .get(review.shop_id) as { avg_r: number; cnt: number };
    db.prepare('UPDATE shops SET rating_avg = ?, review_count = ? WHERE id = ?').run(
      Number((shopAgg.avg_r || 0).toFixed(2)),
      shopAgg.cnt,
      review.shop_id
    );
  })();

  recordAdminAudit(req.adminSession!.adminIdentifier, 'review.moderated', 'review', req.params.id, { status }, req.ip || '');
  res.json({ updated: true });
});

// ============================================================================
// MONETIZATION: SUBSCRIPTIONS, PROMOTIONS, REVENUE
// ============================================================================

adminRouter.get('/monetization', requireAdminPermission('monetization.manage'), (_req, res) => {
  const plans = db
    .prepare(
      `SELECT sp.*, COALESCE(sps.stars_monthly, 0) as stars_monthly, COALESCE(sps.stars_annual, 0) as stars_annual
       FROM subscription_plans sp
       LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
       ORDER BY sp.monthly_price ASC`
    )
    .all();
  const subscriptions = db
    .prepare(
      `SELECT s.*, sp.code as plan_code, sp.name as plan_name, u.display_name as seller_name, sh.name as shop_name
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN shops sh ON sh.seller_id = s.seller_id
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
  const starsPayments = db
    .prepare(
      `SELECT x.*, u.display_name as payer_name, u.telegram_username as payer_username
       FROM telegram_stars_payments x
       LEFT JOIN users u ON u.id = x.user_id
       ORDER BY x.created_at DESC LIMIT 100`
    )
    .all();

  res.json({ plans, subscriptions, promotions, promotionTransactions, starsPayments });
});

adminRouter.patch('/plans/:id', requireAdminPermission('monetization.manage'), (req, res) => {
  const monthlyPrice = Number(req.body?.monthlyPrice ?? 0);
  const annualPrice = Number(req.body?.annualPrice ?? 0);
  const maxProductsRaw = Number(req.body?.maxProducts ?? 10);
  const aiDailyLimitRaw = Number(req.body?.aiDailyLimit ?? 15);
  const featuredSlotsRaw = Number(req.body?.featuredSlots ?? 0);
  const promotionalDiscountPctRaw = Number(req.body?.promotionalDiscountPct ?? 0);

  if (
    !Number.isFinite(monthlyPrice) || monthlyPrice < 0 ||
    !Number.isFinite(annualPrice) || annualPrice < 0 ||
    !Number.isFinite(maxProductsRaw) || maxProductsRaw < 1 ||
    !Number.isFinite(aiDailyLimitRaw) || aiDailyLimitRaw < 0 ||
    !Number.isFinite(featuredSlotsRaw) || featuredSlotsRaw < 0 ||
    !Number.isFinite(promotionalDiscountPctRaw)
  ) {
    return res.status(400).json({ error: 'All plan pricing and limit fields must be valid non-negative numbers.' });
  }

  const maxProducts = Math.max(1, Math.floor(maxProductsRaw));
  const aiDailyLimit = Math.max(0, Math.floor(aiDailyLimitRaw));
  const featuredSlots = Math.max(0, Math.floor(featuredSlotsRaw));
  const promotionalDiscountPct = Math.min(90, Math.max(0, promotionalDiscountPctRaw));

  const upd = db
    .prepare(
      `UPDATE subscription_plans
       SET monthly_price = ?, annual_price = ?, max_products = ?, ai_daily_limit = ?, featured_slots = ?, promotional_discount_pct = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(monthlyPrice, annualPrice, maxProducts, aiDailyLimit, featuredSlots, promotionalDiscountPct, req.params.id);
  if (upd.changes === 0) return res.status(404).json({ error: 'Subscription plan not found.' });

  if (req.body?.starsMonthly !== undefined || req.body?.starsAnnual !== undefined) {
    const starsMonthly = Math.max(0, Math.floor(Number(req.body?.starsMonthly ?? Math.round(monthlyPrice * 50))));
    const starsAnnual = Math.max(0, Math.floor(Number(req.body?.starsAnnual ?? Math.round(annualPrice * 50))));
    db.prepare(
      `INSERT INTO subscription_plan_stars (plan_id, stars_monthly, stars_annual, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(plan_id) DO UPDATE SET
         stars_monthly = excluded.stars_monthly,
         stars_annual = excluded.stars_annual,
         updated_at = datetime('now')`
    ).run(req.params.id, starsMonthly, starsAnnual);
  }

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

adminRouter.patch('/promotions/:id', requireAdminPermission('monetization.manage'), (req, res) => {
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

adminRouter.get('/ai', requireAdminPermission('ai.manage'), (_req, res) => {
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
  res.json({
    features,
    usageLogs,
    summary,
    availableModels: Array.from(VALID_CF_MODELS),
    defaultModel: DEFAULT_CF_AI_MODEL,
  });
});

adminRouter.patch('/ai/features/:featureKey', requireAdminPermission('ai.manage'), (req, res) => {
  const isEnabled = req.body?.isEnabled ? 1 : 0;
  const fallbackModel = VALID_CF_MODELS.has(process.env.CLOUDFLARE_AI_MODEL || '')
    ? String(process.env.CLOUDFLARE_AI_MODEL)
    : DEFAULT_CF_AI_MODEL;
  const modelName = sanitizeText(req.body?.modelName || fallbackModel, 64);
  if (!VALID_CF_MODELS.has(modelName)) {
    return res.status(400).json({
      error: `Unsupported or deprecated Cloudflare Workers AI model "${modelName}". Choose one of: ${Array.from(VALID_CF_MODELS).join(', ')}`,
    });
  }
  const dailyLimitRaw = Number(req.body?.dailyLimitPerUser ?? 30);
  if (!Number.isFinite(dailyLimitRaw) || dailyLimitRaw < 0 || dailyLimitRaw > 10000) {
    return res.status(400).json({ error: 'dailyLimitPerUser must be a valid number between 0 and 10,000.' });
  }
  const dailyLimitPerUser = Math.max(0, Math.floor(dailyLimitRaw));

  const upd = db
    .prepare(
      `UPDATE ai_feature_settings
       SET is_enabled = ?, model_name = ?, daily_limit_per_user = ?, updated_by = ?, updated_at = datetime('now')
       WHERE feature_key = ?`
    )
    .run(isEnabled, modelName, dailyLimitPerUser, req.adminSession!.adminIdentifier, req.params.featureKey);
  if (upd.changes === 0) return res.status(404).json({ error: 'AI feature setting not found.' });

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

adminRouter.get('/countries', requireAdminPermission('countries.manage'), (_req, res) => {
  const countries = db.prepare('SELECT * FROM countries ORDER BY name ASC').all();
  const currencies = db.prepare('SELECT * FROM currencies ORDER BY code ASC').all();
  res.json({ countries, currencies });
});

adminRouter.patch('/countries/:code', requireAdminPermission('countries.manage'), (req, res) => {
  const code = req.params.code.toUpperCase();
  const existing = db.prepare('SELECT * FROM countries WHERE code = ?').get(code) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return res.status(404).json({ error: 'Country not found.' });

  const isEnabled = req.body?.isEnabled !== undefined ? (req.body.isEnabled ? 1 : 0) : Number(existing.is_enabled ?? 1);
  const shippingNotes =
    req.body?.shippingNotes !== undefined ? sanitizeText(req.body.shippingNotes, 300) : String(existing.shipping_notes || '');
  const verificationNotes =
    req.body?.verificationNotes !== undefined
      ? sanitizeText(req.body.verificationNotes, 300)
      : String(existing.verification_notes || '');

  db.prepare('UPDATE countries SET is_enabled = ?, shipping_notes = ?, verification_notes = ? WHERE code = ?').run(
    isEnabled,
    shippingNotes,
    verificationNotes,
    code
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'country.updated', 'country', code, { isEnabled: Boolean(isEnabled) }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.get('/support', requireAdminPermission('support.manage'), (_req, res) => {
  const tickets = db
    .prepare(
      `SELECT t.*, u.display_name, u.telegram_username
       FROM support_tickets t JOIN users u ON u.id = t.user_id
       ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC`
    )
    .all();
  res.json({ tickets });
});

adminRouter.patch('/support/:id', requireAdminPermission('support.manage'), async (req, res) => {
  const status = String(req.body?.status || 'resolved');
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid support ticket status.' });
  }
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

adminRouter.get('/notifications', requireAdminPermission('notifications.manage'), (_req, res) => {
  const notifications = db
    .prepare(
      `SELECT n.*, u.display_name as recipient_name
       FROM notifications n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.scope = 'global' OR n.type = 'announcement'
       ORDER BY n.created_at DESC LIMIT 80`
    )
    .all();
  res.json({ notifications });
});

adminRouter.post('/notifications/broadcast', requireAdminPermission('notifications.manage'), (req, res) => {
  const title = sanitizeText(req.body?.title || '', 120);
  const body = sanitizeText(req.body?.body || '', 600);
  if (!title || !body) return res.status(400).json({ error: 'Title and body required.' });

  const id = newId('notif');
  db.prepare(
    `INSERT INTO notifications (id, user_id, scope, type, title, body) VALUES (?, NULL, 'global', 'announcement', ?, ?)`
  ).run(id, title, body);

  db.prepare(
    `INSERT INTO platform_settings (key, value, value_type, updated_by, updated_at)
     VALUES ('marketplace_announcement', ?, 'string', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(`${title} — ${body}`, req.adminSession!.adminIdentifier);

  recordAdminAudit(req.adminSession!.adminIdentifier, 'notification.broadcast', 'global', id, { title }, req.ip || '');
  res.status(201).json({ broadcast: true, id });
});

adminRouter.get('/settings', requireAdminPermission(['settings.manage', 'rbac.manage']), (_req, res) => {
  const settings = db.prepare('SELECT * FROM platform_settings ORDER BY key ASC').all();
  const roles = db.prepare('SELECT * FROM admin_roles ORDER BY created_at ASC').all();
  const permissions = db.prepare('SELECT * FROM admin_permissions').all();
  const roleAssignments = db
    .prepare(
      `SELECT ara.*, ar.code as role_code, ar.name as role_name, u.display_name, u.telegram_username
       FROM admin_role_assignments ara
       JOIN admin_roles ar ON ar.id = ara.role_id
       LEFT JOIN users u ON u.telegram_id = ara.telegram_id
       ORDER BY ara.created_at DESC`
    )
    .all();
  res.json({
    settings,
    roles,
    permissions,
    roleAssignments,
    permissionCatalog: ADMIN_PERMISSION_CATALOG,
    envOwnerTelegramIds: getEnvOwnerTelegramIds(),
  });
});

adminRouter.patch('/settings', requireAdminPermission('settings.manage'), (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? (req.body.updates as Array<{ key?: string; value?: unknown }>) : [];
  if (!updates.length) return res.status(400).json({ error: 'Provide an updates array of { key, value }.' });

  const validated: Array<{ key: string; value: string }> = [];
  for (const item of updates) {
    const key = sanitizeText(item.key || '', 80);
    if (!key) return res.status(400).json({ error: 'Each update item requires a setting key.' });
    const result = validateAndNormalizeSettingLocal(key, item.value);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    validated.push({ key, value: result.value });
  }

  db.transaction(() => {
    const stmt = db.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`);
    for (const item of validated) {
      stmt.run(item.value, req.adminSession!.adminIdentifier, item.key);
    }
  })();

  recordAdminAudit(
    req.adminSession!.adminIdentifier,
    'settings.batch_updated',
    'setting',
    'batch',
    { keys: validated.map((v) => v.key), values: Object.fromEntries(validated.map((v) => [v.key, v.value])) },
    req.ip || ''
  );
  res.json({ updated: true, count: validated.length });
});

adminRouter.patch('/settings/:key', requireAdminPermission('settings.manage'), (req, res) => {
  const result = validateAndNormalizeSettingLocal(req.params.key, req.body?.value);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

  db.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`).run(
    result.value,
    req.adminSession!.adminIdentifier,
    req.params.key
  );
  recordAdminAudit(req.adminSession!.adminIdentifier, 'setting.updated', 'setting', req.params.key, { value: result.value }, req.ip || '');
  res.json({ updated: true, key: req.params.key, value: result.value });
});

// ============================================================================
// DATABASE-BACKED ADMINISTRATIVE RBAC
// ============================================================================

adminRouter.get('/roles', requireAdminPermission('rbac.manage'), (_req, res) => {
  const roles = db.prepare('SELECT * FROM admin_roles ORDER BY created_at ASC').all();
  const permissions = db.prepare('SELECT * FROM admin_permissions').all();
  const roleAssignments = db
    .prepare(
      `SELECT ara.*, ar.code as role_code, ar.name as role_name, u.display_name, u.telegram_username
       FROM admin_role_assignments ara
       JOIN admin_roles ar ON ar.id = ara.role_id
       LEFT JOIN users u ON u.telegram_id = ara.telegram_id
       ORDER BY ara.created_at DESC`
    )
    .all();
  res.json({
    roles,
    permissions,
    roleAssignments,
    permissionCatalog: ADMIN_PERMISSION_CATALOG,
    envOwnerTelegramIds: getEnvOwnerTelegramIds(),
  });
});

adminRouter.post('/roles', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const code = sanitizeText(req.body?.code || '', 24)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
  const name = sanitizeText(req.body?.name || '', 80);
  const description = sanitizeText(req.body?.description || '', 240);
  const permissions = Array.isArray(req.body?.permissions)
    ? Array.from(new Set((req.body.permissions as unknown[]).map((p) => String(p).trim()).filter(Boolean)))
    : [];

  if (!code || code.length < 2 || !name) {
    return res.status(400).json({ error: 'Valid role code (min 2 chars) and name are required.' });
  }
  for (const perm of permissions) {
    if (!VALID_PERMISSION_KEYS.has(perm)) {
      return res.status(400).json({ error: `Unknown permission key "${perm}".` });
    }
    if (!admin.isOwner && OWNER_ONLY_PERMISSIONS.has(perm)) {
      return res.status(403).json({ error: `Only a Platform Owner can grant "${perm}".` });
    }
  }

  const existingCode = db.prepare('SELECT id FROM admin_roles WHERE code = ?').get(code);
  if (existingCode) return res.status(409).json({ error: `Role code "${code}" already exists.` });

  const roleId = newId('role');
  db.transaction(() => {
    db.prepare('INSERT INTO admin_roles (id, code, name, description) VALUES (?, ?, ?, ?)').run(roleId, code, name, description);
    const insPerm = db.prepare('INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES (?, ?, ?)');
    for (const perm of permissions) {
      insPerm.run(newId('perm'), roleId, perm);
    }
  })();

  recordAdminAudit(admin.adminIdentifier, 'rbac.role_created', 'admin_role', roleId, { code, name, permissions }, req.ip || '');
  res.status(201).json({ id: roleId, code, name, description, permissions });
});

adminRouter.put('/roles/:id/permissions', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const roleId = req.params.id;
  const role = db.prepare('SELECT * FROM admin_roles WHERE id = ?').get(roleId) as { id: string; code: string } | undefined;
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (role.id === 'role_owner' || role.code === 'OWNER') {
    return res.status(403).json({ error: 'Platform Owner (*) permissions are immutable.' });
  }

  const nextPerms = Array.isArray(req.body?.permissions)
    ? Array.from(new Set((req.body.permissions as unknown[]).map((p) => String(p).trim()).filter(Boolean)))
    : [];

  for (const perm of nextPerms) {
    if (!VALID_PERMISSION_KEYS.has(perm)) {
      return res.status(400).json({ error: `Unknown permission key "${perm}".` });
    }
  }

  const currentRows = db.prepare('SELECT permission_key FROM admin_permissions WHERE role_id = ?').all(roleId) as Array<{
    permission_key: string;
  }>;
  const currentSet = new Set(currentRows.map((r) => r.permission_key));

  if (!admin.isOwner) {
    for (const perm of nextPerms) {
      if (OWNER_ONLY_PERMISSIONS.has(perm) && !currentSet.has(perm)) {
        return res.status(403).json({ error: `Only a Platform Owner can grant "${perm}".` });
      }
    }
    for (const perm of currentSet) {
      if (OWNER_ONLY_PERMISSIONS.has(perm) && !nextPerms.includes(perm)) {
        return res.status(403).json({ error: `Only a Platform Owner can revoke "${perm}".` });
      }
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM admin_permissions WHERE role_id = ?').run(roleId);
    const ins = db.prepare('INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES (?, ?, ?)');
    for (const perm of nextPerms) {
      ins.run(newId('perm'), roleId, perm);
    }
  })();

  recordAdminAudit(
    admin.adminIdentifier,
    'rbac.permissions_updated',
    'admin_role',
    roleId,
    { roleCode: role.code, permissions: nextPerms },
    req.ip || ''
  );
  res.json({ updated: true, roleId, permissions: nextPerms });
});

adminRouter.patch('/roles/:id', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const role = db.prepare('SELECT * FROM admin_roles WHERE id = ?').get(req.params.id) as
    | { id: string; code: string; name: string; description: string }
    | undefined;
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if ((role.id === 'role_owner' || role.code === 'OWNER') && !admin.isOwner) {
    return res.status(403).json({ error: 'Only a Platform Owner can edit the OWNER role.' });
  }
  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 80) : role.name;
  const description = req.body?.description !== undefined ? sanitizeText(req.body.description, 240) : role.description;
  if (!name) return res.status(400).json({ error: 'Role name cannot be empty.' });
  db.prepare('UPDATE admin_roles SET name = ?, description = ? WHERE id = ?').run(name, description, req.params.id);
  recordAdminAudit(admin.adminIdentifier, 'rbac.role_updated', 'admin_role', req.params.id, { name }, req.ip || '');
  res.json({ updated: true });
});

adminRouter.delete('/roles/:id', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  if (['role_owner', 'role_mod', 'role_ops'].includes(req.params.id)) {
    return res.status(403).json({ error: 'Built-in system roles cannot be deleted.' });
  }
  const role = db.prepare('SELECT * FROM admin_roles WHERE id = ?').get(req.params.id) as { id: string; code: string } | undefined;
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (!admin.isOwner && roleHasOwnerOnlyPermissionsLocal(req.params.id)) {
    return res.status(403).json({ error: 'Only a Platform Owner can delete a role holding owner-level permissions.' });
  }
  const assigned = db.prepare('SELECT COUNT(*) as cnt FROM admin_role_assignments WHERE role_id = ?').get(req.params.id) as {
    cnt: number;
  };
  if (assigned.cnt > 0) {
    return res.status(409).json({ error: 'Revoke or reassign administrators holding this role before deleting it.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM admin_permissions WHERE role_id = ?').run(req.params.id);
    db.prepare('DELETE FROM admin_roles WHERE id = ?').run(req.params.id);
  })();
  recordAdminAudit(admin.adminIdentifier, 'rbac.role_deleted', 'admin_role', req.params.id, { code: role.code }, req.ip || '');
  res.json({ deleted: true });
});

adminRouter.post('/role-assignments', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const telegramId = String(req.body?.telegramId || '').trim();
  const roleId = sanitizeText(req.body?.roleId || '', 64);
  const displayLabel = sanitizeText(req.body?.displayLabel || '', 80);

  if (!/^\d{3,20}$/.test(telegramId)) {
    return res.status(400).json({ error: 'Telegram ID must be a numeric Telegram user ID (3–20 digits).' });
  }
  if (isTelegramIdAdmin(telegramId)) {
    return res.status(409).json({ error: 'This Telegram ID is already a permanent Owner configured in ADMIN_TELEGRAM_IDS.' });
  }
  const role = db.prepare('SELECT * FROM admin_roles WHERE id = ?').get(roleId) as { id: string; code: string } | undefined;
  if (!role) return res.status(404).json({ error: 'Target admin role not found.' });

  if (!admin.isOwner && (role.code === 'OWNER' || role.id === 'role_owner' || roleHasOwnerOnlyPermissionsLocal(roleId))) {
    return res.status(403).json({ error: 'Only a Platform Owner can assign OWNER or owner-privileged roles.' });
  }
  if (!admin.isOwner && telegramId === admin.telegramId) {
    return res.status(403).json({ error: 'You cannot modify your own administrative role assignment.' });
  }

  const existingAssign = db.prepare('SELECT id FROM admin_role_assignments WHERE telegram_id = ?').get(telegramId);
  if (existingAssign) {
    return res.status(409).json({ error: 'An assignment already exists for this Telegram ID. Update the existing assignment instead.' });
  }

  const id = newId('assign');
  db.prepare(
    `INSERT INTO admin_role_assignments (id, telegram_id, role_id, display_label, is_active, assigned_by)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(id, telegramId, roleId, displayLabel, admin.adminIdentifier);

  recordAdminAudit(
    admin.adminIdentifier,
    'rbac.assignment_created',
    'admin_role_assignment',
    id,
    { telegramId, roleCode: role.code, displayLabel },
    req.ip || ''
  );
  res.status(201).json({ id, telegramId, roleId, displayLabel, isActive: true });
});

adminRouter.patch('/role-assignments/:id', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const existing = db
    .prepare(
      `SELECT ara.*, ar.code as role_code
       FROM admin_role_assignments ara JOIN admin_roles ar ON ar.id = ara.role_id
       WHERE ara.id = ?`
    )
    .get(req.params.id) as
    | { id: string; telegram_id: string; role_id: string; role_code: string; display_label: string; is_active: number }
    | undefined;
  if (!existing) return res.status(404).json({ error: 'Role assignment not found.' });

  if (!admin.isOwner && existing.telegram_id === admin.telegramId) {
    return res.status(403).json({ error: 'You cannot modify or revoke your own administrative assignment.' });
  }
  if (
    !admin.isOwner &&
    (existing.role_code === 'OWNER' || existing.role_id === 'role_owner' || roleHasOwnerOnlyPermissionsLocal(existing.role_id))
  ) {
    return res.status(403).json({ error: 'Only a Platform Owner can manage OWNER-level assignments.' });
  }

  const nextRoleId = req.body?.roleId !== undefined ? sanitizeText(req.body.roleId, 64) : existing.role_id;
  const nextIsActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active;
  const nextLabel = req.body?.displayLabel !== undefined ? sanitizeText(req.body.displayLabel, 80) : existing.display_label;

  const targetRole = db.prepare('SELECT id, code FROM admin_roles WHERE id = ?').get(nextRoleId) as
    | { id: string; code: string }
    | undefined;
  if (!targetRole) return res.status(404).json({ error: 'Target admin role not found.' });
  if (
    !admin.isOwner &&
    (targetRole.code === 'OWNER' || targetRole.id === 'role_owner' || roleHasOwnerOnlyPermissionsLocal(nextRoleId))
  ) {
    return res.status(403).json({ error: 'Only a Platform Owner can assign OWNER-level roles.' });
  }

  db.prepare(
    `UPDATE admin_role_assignments
     SET role_id = ?, is_active = ?, display_label = ?, assigned_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextRoleId, nextIsActive, nextLabel, admin.adminIdentifier, req.params.id);

  recordAdminAudit(
    admin.adminIdentifier,
    'rbac.assignment_updated',
    'admin_role_assignment',
    req.params.id,
    { telegramId: existing.telegram_id, roleCode: targetRole.code, isActive: Boolean(nextIsActive) },
    req.ip || ''
  );
  res.json({ updated: true });
});

adminRouter.delete('/role-assignments/:id', requireAdminPermission('rbac.manage'), (req, res) => {
  const admin = req.adminSession!;
  const existing = db
    .prepare(
      `SELECT ara.*, ar.code as role_code
       FROM admin_role_assignments ara JOIN admin_roles ar ON ar.id = ara.role_id
       WHERE ara.id = ?`
    )
    .get(req.params.id) as { id: string; telegram_id: string; role_id: string; role_code: string } | undefined;
  if (!existing) return res.status(404).json({ error: 'Role assignment not found.' });

  if (!admin.isOwner && existing.telegram_id === admin.telegramId) {
    return res.status(403).json({ error: 'You cannot modify or revoke your own administrative assignment.' });
  }
  if (
    !admin.isOwner &&
    (existing.role_code === 'OWNER' || existing.role_id === 'role_owner' || roleHasOwnerOnlyPermissionsLocal(existing.role_id))
  ) {
    return res.status(403).json({ error: 'Only a Platform Owner can revoke OWNER-level assignments.' });
  }

  db.prepare('DELETE FROM admin_role_assignments WHERE id = ?').run(req.params.id);
  recordAdminAudit(
    admin.adminIdentifier,
    'rbac.assignment_revoked',
    'admin_role_assignment',
    req.params.id,
    { telegramId: existing.telegram_id, roleCode: existing.role_code },
    req.ip || ''
  );
  res.json({ deleted: true });
});

adminRouter.get('/audit-logs', requireAdminPermission('audit.view'), (_req, res) => {
  const logs = db
    .prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 150')
    .all();
  res.json({ logs });
});
