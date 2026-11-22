import {
  type Env,
  VALID_CF_MODELS,
  json,
  methodNotAllowed,
  newId,
  notifyUserAndTelegramEdge,
  parseJsonBody,
  recordEdgeAdminAudit,
  requireEdgeAdmin,
  sanitizeText,
  slugify,
} from './helpers.ts';

export async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin/')) return null;
  if (!env.DB) return json({ error: 'Database binding (DB) is not configured.' }, 503);

  const sub = url.pathname.slice('/api/admin'.length);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (sub === '/auth/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env);
    if ('error' in auth) return auth.error;
    return json({ authenticated: true, admin: auth.admin });
  }

  if (sub === '/auth/logout') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env);
    if ('error' in auth) return auth.error;
    await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?")
      .bind(auth.admin.sessionId)
      .run();
    return json(
      { loggedOut: true },
      200,
      { 'Set-Cookie': 'sofumer_session=; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=0' }
    );
  }

  const auth = await requireEdgeAdmin(request, env);
  if ('error' in auth) return auth.error;
  const admin = auth.admin;

  if (sub === '/overview') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const counts = await env.DB.prepare(
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
    ).first();
    return json({ overview: counts });
  }

  if (sub === '/users') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const users = await env.DB.prepare(
      `SELECT u.*, COALESCE(ap.ai_enabled, 1) as ai_enabled, ap.custom_daily_limit,
              (SELECT GROUP_CONCAT(role) FROM user_roles ur WHERE ur.user_id = u.id) as roles
       FROM users u LEFT JOIN ai_permissions ap ON ap.user_id = u.id
       ORDER BY u.created_at DESC`
    ).all();
    return json({ users: users.results });
  }

  if (sub.startsWith('/users/') && sub.endsWith('/status')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const userId = decodeURIComponent(sub.slice('/users/'.length, -'/status'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const status = String(body.data.status || '');
    const reason = sanitizeText(body.data.reason || '', 300);
    if (!['active', 'restricted', 'suspended'].includes(status)) {
      return json({ error: 'Invalid user status.' }, 400);
    }
    const upd = await env.DB.prepare("UPDATE users SET status = ?, restriction_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(status, reason, userId)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) return json({ error: 'User not found.' }, 404);
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'user.status_updated', 'user', userId, { status, reason }, ip);
    return json({ updated: true });
  }

  if (sub.startsWith('/users/') && sub.endsWith('/ai-access')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const userId = decodeURIComponent(sub.slice('/users/'.length, -'/ai-access'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const aiEnabled = body.data.aiEnabled ? 1 : 0;
    const customDailyLimit =
      body.data.customDailyLimit !== undefined && body.data.customDailyLimit !== ''
        ? Number(body.data.customDailyLimit)
        : null;
    const reason = sanitizeText(body.data.reason || '', 300);

    const userExists = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!userExists) return json({ error: 'User not found.' }, 404);

    await env.DB.prepare(
      `INSERT INTO ai_permissions (user_id, ai_enabled, custom_daily_limit, reason, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         ai_enabled = excluded.ai_enabled,
         custom_daily_limit = excluded.custom_daily_limit,
         reason = excluded.reason,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`
    )
      .bind(userId, aiEnabled, customDailyLimit, reason, admin.adminIdentifier)
      .run();

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'user.ai_access_updated', 'user', userId, { aiEnabled: Boolean(aiEnabled), customDailyLimit, reason }, ip);
    return json({ updated: true });
  }

  if (sub === '/sellers') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const sellers = await env.DB.prepare(
      `SELECT sp.*, u.display_name, u.telegram_username, s.id as shop_id, s.name as shop_name,
              s.slug as shop_slug, s.status as shop_status, s.is_featured, s.verification_status as shop_verification_status
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
       LEFT JOIN shops s ON s.seller_id = sp.id ORDER BY sp.created_at DESC`
    ).all();
    return json({ sellers: sellers.results });
  }

  if (sub.startsWith('/sellers/') && sub.endsWith('/status')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const sellerId = decodeURIComponent(sub.slice('/sellers/'.length, -'/status'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const seller = await env.DB.prepare('SELECT * FROM seller_profiles WHERE id = ?')
      .bind(sellerId)
      .first<Record<string, unknown>>();
    if (!seller) return json({ error: 'Seller not found.' }, 404);

    const status = String(body.data.status || '');
    const verificationStatus = body.data.verificationStatus ? String(body.data.verificationStatus) : null;
    const isFeatured = body.data.isFeatured;

    if (['active', 'suspended'].includes(status)) {
      await env.DB.prepare("UPDATE seller_profiles SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status, seller.id)
        .run();
      await env.DB.prepare("UPDATE shops SET status = ?, updated_at = datetime('now') WHERE seller_id = ?")
        .bind(status, seller.id)
        .run();
    }
    if (verificationStatus && ['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) {
      await env.DB.prepare('UPDATE seller_profiles SET verification_status = ? WHERE id = ?')
        .bind(verificationStatus, seller.id)
        .run();
      await env.DB.prepare('UPDATE shops SET verification_status = ? WHERE seller_id = ?')
        .bind(verificationStatus, seller.id)
        .run();
      await notifyUserAndTelegramEdge(
        env,
        String(seller.user_id),
        'verification',
        `Shop Verification: ${verificationStatus.toUpperCase()}`,
        `Your SOFUMER shop verification status is now ${verificationStatus}.`,
        url.origin
      );
    }
    if (typeof isFeatured === 'boolean') {
      await env.DB.prepare('UPDATE shops SET is_featured = ? WHERE seller_id = ?')
        .bind(isFeatured ? 1 : 0, seller.id)
        .run();
    }
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'seller.updated', 'seller', sellerId, { status, verificationStatus, isFeatured }, ip);
    return json({ updated: true });
  }

  if (sub === '/products') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const products = await env.DB.prepare(
      `SELECT p.*, s.name as shop_name, c.name as category_name, u.display_name as seller_name
       FROM products p JOIN shops s ON s.id = p.shop_id JOIN categories c ON c.id = p.category_id JOIN users u ON u.id = p.seller_user_id
       ORDER BY CASE WHEN p.status = 'pending_review' THEN 0 ELSE 1 END, p.created_at DESC`
    ).all();
    return json({ products: products.results });
  }

  if (sub.startsWith('/products/') && sub.endsWith('/moderate')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const prodId = decodeURIComponent(sub.slice('/products/'.length, -'/moderate'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?')
      .bind(prodId)
      .first<Record<string, unknown>>();
    if (!product) return json({ error: 'Product not found.' }, 404);

    const status = String(body.data.status || '');
    const notes = sanitizeText(body.data.notes || '', 400);
    const isFeatured = body.data.isFeatured;
    const isSponsored = body.data.isSponsored;

    if (['published', 'rejected', 'pending_review', 'archived'].includes(status)) {
      await env.DB.prepare("UPDATE products SET status = ?, moderation_notes = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status, notes, product.id)
        .run();
      await notifyUserAndTelegramEdge(
        env,
        String(product.seller_user_id),
        'moderation',
        `Listing ${status.toUpperCase()}: ${String(product.title)}`,
        notes || `Listing status updated to ${status}.`,
        url.origin
      );
    }
    if (typeof isFeatured === 'boolean') {
      await env.DB.prepare('UPDATE products SET is_featured = ? WHERE id = ?').bind(isFeatured ? 1 : 0, product.id).run();
    }
    if (typeof isSponsored === 'boolean') {
      await env.DB.prepare('UPDATE products SET is_sponsored = ? WHERE id = ?').bind(isSponsored ? 1 : 0, product.id).run();
    }
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'product.moderated', 'product', prodId, { status, notes, isFeatured, isSponsored }, ip);
    return json({ updated: true });
  }

  if (sub === '/categories') {
    if (request.method === 'GET') {
      const [categories, subcategories] = await Promise.all([
        env.DB.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all(),
        env.DB.prepare('SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC').all(),
      ]);
      return json({ categories: categories.results, subcategories: subcategories.results });
    }
    if (request.method === 'POST') {
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const name = sanitizeText(body.data.name || '', 80);
      const description = sanitizeText(body.data.description || '', 240);
      if (!name) return json({ error: 'Category name is required.' }, 400);
      const id = newId('cat');
      await env.DB.prepare(`INSERT INTO categories (id, slug, name, description, sort_order) VALUES (?, ?, ?, ?, 99)`)
        .bind(id, `${slugify(name)}-${id.slice(-4)}`, name, description)
        .run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'category.created', 'category', id, { name }, ip);
      return json({ id, name }, 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  if (sub === '/subcategories') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const categoryId = sanitizeText(body.data.categoryId || '', 64);
    const name = sanitizeText(body.data.name || '', 80);
    if (!categoryId || !name) return json({ error: 'Parent category and name required.' }, 400);
    const parentCat = await env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(categoryId).first();
    if (!parentCat) return json({ error: 'Parent category not found.' }, 404);
    const id = newId('sub');
    await env.DB.prepare(`INSERT INTO subcategories (id, category_id, slug, name, sort_order) VALUES (?, ?, ?, ?, 50)`)
      .bind(id, categoryId, `${slugify(name)}-${id.slice(-4)}`, name)
      .run();
    return json({ id, name }, 201);
  }

  if (sub === '/orders') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const orders = await env.DB.prepare(
      `SELECT o.*, s.name as shop_name, bu.display_name as buyer_name, su.display_name as seller_name
       FROM orders o JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id JOIN users su ON su.id = o.seller_user_id
       ORDER BY o.created_at DESC LIMIT 120`
    ).all();
    return json({ orders: orders.results });
  }

  if (sub === '/reports') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [reports, flaggedConversations] = await Promise.all([
      env.DB.prepare(
        `SELECT r.*, u.display_name as reporter_name FROM reports r
         JOIN users u ON u.id = r.reporter_user_id ORDER BY r.created_at DESC LIMIT 100`
      ).all(),
      env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
         FROM conversations c WHERE c.status = 'flagged' ORDER BY c.last_message_at DESC`
      ).all(),
    ]);
    return json({ reports: reports.results, flaggedConversations: flaggedConversations.results });
  }

  if (sub.startsWith('/reports/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const repId = decodeURIComponent(sub.slice('/reports/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const status = String(body.data.status || 'resolved');
    if (!['open', 'investigating', 'resolved', 'dismissed'].includes(status)) {
      return json({ error: 'Invalid report status.' }, 400);
    }
    const notes = sanitizeText(body.data.resolutionNotes || '', 500);
    const isResolved = status === 'resolved' || status === 'dismissed';
    const repUpd = await env.DB.prepare(
      `UPDATE reports
       SET status = ?,
           resolution_notes = ?,
           reviewed_by = ?,
           resolved_by = CASE WHEN ? = 1 THEN ? ELSE resolved_by END,
           resolved_at = CASE WHEN ? = 1 THEN datetime('now') ELSE resolved_at END,
           updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(status, notes, admin.adminIdentifier, isResolved ? 1 : 0, admin.adminIdentifier, isResolved ? 1 : 0, repId)
      .run();
    if ((repUpd.meta?.changes ?? 0) === 0) return json({ error: 'Report not found.' }, 404);
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'report.resolved', 'report', repId, { status, notes }, ip);
    return json({ updated: true });
  }

  if (sub.startsWith('/conversations/') && sub.endsWith('/messages')) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const convId = decodeURIComponent(sub.slice('/conversations/'.length, -'/messages'.length));
    const messages = await env.DB.prepare(
      `SELECT m.*, u.display_name as sender_name FROM messages m
       JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? ORDER BY m.created_at ASC`
    )
      .bind(convId)
      .all();
    return json({ messages: messages.results });
  }

  if (sub === '/reviews') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const reviews = await env.DB.prepare(
      `SELECT r.*, p.title as product_title, u.display_name as reviewer_name
       FROM reviews r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.reviewer_user_id
       ORDER BY r.created_at DESC LIMIT 100`
    ).all();
    return json({ reviews: reviews.results });
  }

  if (sub.startsWith('/reviews/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const revId = decodeURIComponent(sub.slice('/reviews/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const status = String(body.data.status || 'published');
    if (!['published', 'hidden', 'removed'].includes(status)) {
      return json({ error: 'Invalid review status.' }, 400);
    }
    const review = await env.DB.prepare('SELECT id, product_id, shop_id FROM reviews WHERE id = ?')
      .bind(revId)
      .first<{ id: string; product_id: string; shop_id: string }>();
    if (!review) return json({ error: 'Review not found.' }, 404);

    await env.DB.prepare('UPDATE reviews SET status = ? WHERE id = ?').bind(status, revId).run();

    const [prodAgg, shopAgg] = await Promise.all([
      env.DB.prepare("SELECT COALESCE(AVG(rating), 0) as avg_r, COUNT(*) as cnt FROM reviews WHERE product_id = ? AND status = 'published'")
        .bind(review.product_id)
        .first<{ avg_r: number; cnt: number }>(),
      env.DB.prepare("SELECT COALESCE(AVG(rating), 0) as avg_r, COUNT(*) as cnt FROM reviews WHERE shop_id = ? AND status = 'published'")
        .bind(review.shop_id)
        .first<{ avg_r: number; cnt: number }>(),
    ]);
    await env.DB.batch([
      env.DB.prepare('UPDATE products SET rating_avg = ?, review_count = ? WHERE id = ?').bind(
        Number((prodAgg?.avg_r || 0).toFixed(2)),
        prodAgg?.cnt || 0,
        review.product_id
      ),
      env.DB.prepare('UPDATE shops SET rating_avg = ?, review_count = ? WHERE id = ?').bind(
        Number((shopAgg?.avg_r || 0).toFixed(2)),
        shopAgg?.cnt || 0,
        review.shop_id
      ),
    ]);

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'review.moderated', 'review', revId, { status }, ip);
    return json({ updated: true });
  }

  if (sub === '/monetization') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [plans, subscriptions, promotions, promotionTransactions, starsPayments] = await Promise.all([
      env.DB.prepare(
        `SELECT sp.*, COALESCE(sps.stars_monthly, 0) as stars_monthly, COALESCE(sps.stars_annual, 0) as stars_annual
         FROM subscription_plans sp LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
         ORDER BY sp.monthly_price ASC`
      ).all(),
      env.DB.prepare(
        `SELECT s.*, sp.name as plan_name, u.display_name as seller_name, sh.name as shop_name
         FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
         JOIN users u ON u.id = s.user_id JOIN shops sh ON sh.seller_id = s.seller_id
         ORDER BY s.created_at DESC LIMIT 100`
      ).all(),
      env.DB.prepare(
        `SELECT pr.*, s.name as shop_name, p.title as product_title, u.display_name as seller_name
         FROM promotions pr JOIN shops s ON s.id = pr.shop_id JOIN users u ON u.id = pr.user_id
         LEFT JOIN products p ON p.id = pr.product_id ORDER BY pr.created_at DESC`
      ).all(),
      env.DB.prepare('SELECT * FROM promotion_transactions ORDER BY created_at DESC LIMIT 100').all(),
      env.DB.prepare(
        `SELECT x.*, u.display_name as payer_name, u.telegram_username as payer_username
         FROM telegram_stars_payments x LEFT JOIN users u ON u.id = x.user_id
         ORDER BY x.created_at DESC LIMIT 100`
      ).all(),
    ]);
    return json({
      plans: plans.results,
      subscriptions: subscriptions.results,
      promotions: promotions.results,
      promotionTransactions: promotionTransactions.results,
      starsPayments: starsPayments.results,
    });
  }

  if (sub.startsWith('/plans/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const planId = decodeURIComponent(sub.slice('/plans/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const monthlyPrice = Number(body.data.monthlyPrice ?? 0);
    const annualPrice = Number(body.data.annualPrice ?? 0);
    const maxProductsRaw = Number(body.data.maxProducts ?? 10);
    const aiDailyLimitRaw = Number(body.data.aiDailyLimit ?? 15);
    const featuredSlotsRaw = Number(body.data.featuredSlots ?? 0);
    const promotionalDiscountPctRaw = Number(body.data.promotionalDiscountPct ?? 0);

    if (
      !Number.isFinite(monthlyPrice) || monthlyPrice < 0 ||
      !Number.isFinite(annualPrice) || annualPrice < 0 ||
      !Number.isFinite(maxProductsRaw) || maxProductsRaw < 1 ||
      !Number.isFinite(aiDailyLimitRaw) || aiDailyLimitRaw < 0 ||
      !Number.isFinite(featuredSlotsRaw) || featuredSlotsRaw < 0 ||
      !Number.isFinite(promotionalDiscountPctRaw)
    ) {
      return json({ error: 'All plan pricing and limit fields must be valid non-negative numbers.' }, 400);
    }

    const maxProducts = Math.max(1, Math.floor(maxProductsRaw));
    const aiDailyLimit = Math.max(0, Math.floor(aiDailyLimitRaw));
    const featuredSlots = Math.max(0, Math.floor(featuredSlotsRaw));
    const promotionalDiscountPct = Math.min(90, Math.max(0, promotionalDiscountPctRaw));

    const planUpd = await env.DB.prepare(
      `UPDATE subscription_plans
       SET monthly_price = ?, annual_price = ?, max_products = ?, ai_daily_limit = ?, featured_slots = ?, promotional_discount_pct = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(monthlyPrice, annualPrice, maxProducts, aiDailyLimit, featuredSlots, promotionalDiscountPct, planId)
      .run();
    if ((planUpd.meta?.changes ?? 0) === 0) return json({ error: 'Subscription plan not found.' }, 404);

    if (body.data.starsMonthly !== undefined || body.data.starsAnnual !== undefined) {
      const starsMonthly = Math.max(0, Math.floor(Number(body.data.starsMonthly ?? Math.round(monthlyPrice * 50))));
      const starsAnnual = Math.max(0, Math.floor(Number(body.data.starsAnnual ?? Math.round(annualPrice * 50))));
      await env.DB.prepare(
        `INSERT INTO subscription_plan_stars (plan_id, stars_monthly, stars_annual, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(plan_id) DO UPDATE SET
           stars_monthly = excluded.stars_monthly,
           stars_annual = excluded.stars_annual,
           updated_at = datetime('now')`
      )
        .bind(planId, starsMonthly, starsAnnual)
        .run();
    }

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'plan.updated', 'subscription_plan', planId, { monthlyPrice, annualPrice, maxProducts, aiDailyLimit }, ip);
    return json({ updated: true });
  }

  if (sub.startsWith('/promotions/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const promoId = decodeURIComponent(sub.slice('/promotions/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const status = String(body.data.status || '');
    if (!['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) {
      return json({ error: 'Invalid promotion status.' }, 400);
    }
    const promo = await env.DB.prepare('SELECT * FROM promotions WHERE id = ?')
      .bind(promoId)
      .first<Record<string, unknown>>();
    if (!promo) return json({ error: 'Promotion not found.' }, 404);

    await env.DB.prepare('UPDATE promotions SET status = ? WHERE id = ?').bind(status, promo.id).run();
    if (status === 'active') {
      await env.DB.prepare("UPDATE promotion_transactions SET status = 'recorded' WHERE promotion_id = ?").bind(promo.id).run();
      if (promo.product_id) {
        if (promo.promo_type === 'sponsored_placement') {
          await env.DB.prepare('UPDATE products SET is_sponsored = 1 WHERE id = ?').bind(promo.product_id).run();
        } else {
          await env.DB.prepare('UPDATE products SET is_featured = 1 WHERE id = ?').bind(promo.product_id).run();
        }
      }
    }
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'promotion.updated', 'promotion', promoId, { status }, ip);
    return json({ updated: true });
  }

  if (sub === '/ai') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [features, usageLogs, summary] = await Promise.all([
      env.DB.prepare('SELECT * FROM ai_feature_settings ORDER BY id ASC').all(),
      env.DB.prepare(
        `SELECT au.*, u.display_name as user_name FROM ai_usage au
         LEFT JOIN users u ON u.id = au.user_id ORDER BY au.created_at DESC LIMIT 100`
      ).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as total_calls,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_calls,
                SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) as denied_calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls,
                COALESCE(AVG(latency_ms), 0) as avg_latency_ms
         FROM ai_usage`
      ).first(),
    ]);
    return json({ features: features.results, usageLogs: usageLogs.results, summary });
  }

  if (sub.startsWith('/ai/features/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const featureKey = decodeURIComponent(sub.slice('/ai/features/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const isEnabled = body.data.isEnabled ? 1 : 0;
    const modelName = sanitizeText(
      body.data.modelName || env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct',
      64
    );
    if (!VALID_CF_MODELS.has(modelName)) {
      return json({ error: `Unsupported Cloudflare Workers AI model "${modelName}".` }, 400);
    }
    const dailyLimitPerUser = Math.max(0, Math.floor(Number(body.data.dailyLimitPerUser ?? 30)));

    const aiUpd = await env.DB.prepare(
      `UPDATE ai_feature_settings
       SET is_enabled = ?, model_name = ?, daily_limit_per_user = ?, updated_by = ?, updated_at = datetime('now')
       WHERE feature_key = ?`
    )
      .bind(isEnabled, modelName, dailyLimitPerUser, admin.adminIdentifier, featureKey)
      .run();
    if ((aiUpd.meta?.changes ?? 0) === 0) return json({ error: 'AI feature setting not found.' }, 404);

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'ai.feature_updated', 'ai_feature', featureKey, { isEnabled: Boolean(isEnabled), modelName, dailyLimitPerUser }, ip);
    return json({ updated: true });
  }

  if (sub === '/countries') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [countries, currencies] = await Promise.all([
      env.DB.prepare('SELECT * FROM countries ORDER BY name ASC').all(),
      env.DB.prepare('SELECT * FROM currencies ORDER BY code ASC').all(),
    ]);
    return json({ countries: countries.results, currencies: currencies.results });
  }

  if (sub.startsWith('/countries/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const code = decodeURIComponent(sub.slice('/countries/'.length)).toUpperCase();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const isEnabled = body.data.isEnabled ? 1 : 0;
    const shippingNotes = sanitizeText(body.data.shippingNotes || '', 300);
    const countryUpd = await env.DB.prepare('UPDATE countries SET is_enabled = ?, shipping_notes = ? WHERE code = ?')
      .bind(isEnabled, shippingNotes, code)
      .run();
    if ((countryUpd.meta?.changes ?? 0) === 0) return json({ error: 'Country not found.' }, 404);
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'country.updated', 'country', code, { isEnabled }, ip);
    return json({ updated: true });
  }

  if (sub === '/support') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const tickets = await env.DB.prepare(
      `SELECT t.*, u.display_name, u.telegram_username FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC`
    ).all();
    return json({ tickets: tickets.results });
  }

  if (sub.startsWith('/support/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const ticketId = decodeURIComponent(sub.slice('/support/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const ticket = await env.DB.prepare('SELECT * FROM support_tickets WHERE id = ?')
      .bind(ticketId)
      .first<Record<string, unknown>>();
    if (!ticket) return json({ error: 'Ticket not found.' }, 404);
    const status = String(body.data.status || 'resolved');
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return json({ error: 'Invalid support ticket status.' }, 400);
    }
    const adminResponse = sanitizeText(body.data.adminResponse || '', 1500);

    await env.DB.prepare(
      `UPDATE support_tickets SET status = ?, admin_response = ?, responded_by = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(status, adminResponse, admin.adminIdentifier, ticket.id)
      .run();

    await notifyUserAndTelegramEdge(
      env,
      String(ticket.user_id),
      'support',
      `Support Ticket Updated: ${String(ticket.subject)}`,
      adminResponse || `Ticket status changed to ${status}.`,
      url.origin
    );
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'support.updated', 'support_ticket', ticketId, { status }, ip);
    return json({ updated: true });
  }

  if (sub === '/notifications/broadcast') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const title = sanitizeText(body.data.title || '', 120);
    const msgBody = sanitizeText(body.data.body || '', 600);
    if (!title || !msgBody) return json({ error: 'Title and body required.' }, 400);

    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, scope, type, title, body) VALUES (?, NULL, 'global', 'announcement', ?, ?)`
    )
      .bind(newId('notif'), title, msgBody)
      .run();

    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value, value_type, updated_by, updated_at)
       VALUES ('marketplace_announcement', ?, 'string', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
    )
      .bind(`${title} — ${msgBody}`, admin.adminIdentifier)
      .run();

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'notification.broadcast', 'global', 'announcement', { title }, ip);
    return json({ broadcast: true }, 201);
  }

  if (sub === '/settings') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [settings, roles, permissions] = await Promise.all([
      env.DB.prepare('SELECT * FROM platform_settings ORDER BY key ASC').all(),
      env.DB.prepare('SELECT * FROM admin_roles').all(),
      env.DB.prepare('SELECT * FROM admin_permissions').all(),
    ]);
    return json({ settings: settings.results, roles: roles.results, permissions: permissions.results });
  }

  if (sub.startsWith('/settings/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const key = decodeURIComponent(sub.slice('/settings/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const value = sanitizeText(String(body.data.value ?? ''), 500);
    const stUpd = await env.DB.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`)
      .bind(value, admin.adminIdentifier, key)
      .run();
    if ((stUpd.meta?.changes ?? 0) === 0) return json({ error: 'Setting not found.' }, 404);
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'setting.updated', 'setting', key, { value }, ip);
    return json({ updated: true });
  }

  if (sub === '/audit-logs') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const logs = await env.DB.prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 150').all();
    return json({ logs: logs.results });
  }

  return json({ error: 'Admin API endpoint not found.' }, 404);
}
