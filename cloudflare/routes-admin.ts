import {
  type D1Database,
  type Env,
  ADMIN_PERMISSION_CATALOG,
  DEFAULT_CF_AI_MODEL,
  OWNER_ONLY_PERMISSIONS,
  VALID_CF_MODELS,
  VALID_PERMISSION_KEYS,
  checkProhibitedKeywordsEdge,
  ensureTelegramMenuButtonEdge,
  getTelegramBotLaunchDiagnosticsEdge,
  hasEdgeAdminPermission,
  isAuditActionProtected,
  isTelegramIdAdmin,
  json,
  methodNotAllowed,
  newId,
  notifyUserAndTelegramEdge,
  parseJsonBody,
  recordEdgeAdminAudit,
  requireEdgeAdmin,
  resolveSafeMiniAppUrlEdge,
  sanitizeText,
  slugify,
} from './helpers.ts';
import { destroyUnreferencedCloudinaryAssets, getCloudinaryPublicDiagnostics } from './cloudinary.ts';
import { executeEdgeShopSoftDelete } from './routes-seller.ts';
import {
  coerceAiString,
  normalizeAiJsonObject,
  resolveActiveCfAiModel,
  runWorkersAiWithJsonFallback,
  sanitizeAiErrorForUser,
} from './ai-normalizer.ts';

async function parseOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await request.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function validateAndNormalizeSetting(
  db: D1Database,
  key: string,
  rawValue: unknown
): Promise<{ ok: true; value: string } | { ok: false; error: string; status?: number }> {
  const row = await db
    .prepare('SELECT key, value_type FROM platform_settings WHERE key = ?')
    .bind(key)
    .first<{ key: string; value_type: string }>();
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
    if (key === 'max_product_videos') {
      if (!Number.isInteger(num) || num < 1 || num > 5) {
        return { ok: false, error: 'max_product_videos must be a whole number between 1 and 5.', status: 400 };
      }
      return { ok: true, value: String(num) };
    }
    if (key === 'max_product_image_mb') {
      if (num < 1 || num > 20) {
        return { ok: false, error: 'max_product_image_mb must be between 1 and 20 MB.', status: 400 };
      }
      return { ok: true, value: String(Number(num.toFixed(1))) };
    }
    if (key === 'max_product_video_mb') {
      if (num < 5 || num > 100) {
        return { ok: false, error: 'max_product_video_mb must be between 5 and 100 MB.', status: 400 };
      }
      return { ok: true, value: String(Number(num.toFixed(1))) };
    }
    if (key === 'audit_retention_days') {
      if (!Number.isInteger(num) || num < 7 || num > 3650) {
        return { ok: false, error: 'audit_retention_days must be a whole number between 7 and 3,650 days.', status: 400 };
      }
      return { ok: true, value: String(num) };
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

function getEnvOwnerTelegramIds(env: Env): string[] {
  return [env.ADMIN_TELEGRAM_IDS, env.ADMIN_TELEGRAM_ID]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(',')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
}

async function roleHasOwnerOnlyPermissionsEdge(db: D1Database, roleId: string): Promise<boolean> {
  const perms = await db
    .prepare('SELECT permission_key FROM admin_permissions WHERE role_id = ?')
    .bind(roleId)
    .all<{ permission_key: string }>();
  return perms.results.some((p) => OWNER_ONLY_PERMISSIONS.has(p.permission_key));
}

export async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin/')) return null;
  if (!env.DB) return json({ error: 'Database binding (DB) is not configured.' }, 503);

  try {
    return await handleAdminRoutesInner(request, { ...env, DB: env.DB }, url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('SOFUMER Admin Worker route error:', msg);
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return json({ error: 'Operation blocked by related database records.' }, 409);
    }
    if (/UNIQUE constraint failed/i.test(msg)) {
      return json({ error: 'Duplicate record conflict.' }, 409);
    }
    if (/CHECK constraint failed|NOT NULL constraint failed/i.test(msg)) {
      return json({ error: 'Submitted values violate database validation constraints.' }, 400);
    }
    return json({ error: 'Internal server error.' }, 500);
  }
}

async function handleAdminRoutesInner(
  request: Request,
  env: Env & { DB: D1Database },
  url: URL
): Promise<Response> {
  const sub = url.pathname.slice('/api/admin'.length);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (sub === '/auth/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env);
    if ('error' in auth) return auth.error;
    return json({
      authenticated: true,
      admin: auth.admin,
      permissionCatalog: ADMIN_PERMISSION_CATALOG,
    });
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

  if (sub === '/overview') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'overview.view');
    if ('error' in auth) return auth.error;
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) as total_users,
         (SELECT COUNT(*) FROM seller_profiles) as total_sellers,
         (SELECT COUNT(*) FROM shops WHERE status != 'closed') as total_shops,
         (SELECT COUNT(*) FROM shops WHERE status = 'active') as active_shops,
         (SELECT COUNT(*) FROM shops WHERE status = 'closed') as closed_shops,
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

  if (sub === '/analytics') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'analytics.view');
    if ('error' in auth) return auth.error;

    const [
      productsByStatus,
      productsByType,
      ordersByStatus,
      topCategories,
      aiByFeature,
      engagementTotals,
      verificationBreakdown,
    ] = await Promise.all([
      env.DB.prepare('SELECT status, COUNT(*) as cnt FROM products GROUP BY status ORDER BY cnt DESC').all(),
      env.DB.prepare('SELECT listing_type, COUNT(*) as cnt FROM products GROUP BY listing_type ORDER BY cnt DESC').all(),
      env.DB.prepare('SELECT status, COUNT(*) as cnt, COALESCE(SUM(agreed_total), 0) as volume_usd FROM orders GROUP BY status ORDER BY cnt DESC').all(),
      env.DB.prepare(
        `SELECT c.id, c.name, COUNT(p.id) as product_count, COALESCE(SUM(p.view_count), 0) as total_views
         FROM categories c LEFT JOIN products p ON p.category_id = c.id
         GROUP BY c.id, c.name ORDER BY product_count DESC, total_views DESC LIMIT 10`
      ).all(),
      env.DB.prepare(
        `SELECT feature_key,
                COUNT(*) as total_calls,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls,
                COALESCE(AVG(latency_ms), 0) as avg_latency_ms
         FROM ai_usage GROUP BY feature_key ORDER BY total_calls DESC`
      ).all(),
      env.DB.prepare(
        `SELECT COALESCE(SUM(view_count), 0) as total_views,
                COALESCE(SUM(favorite_count), 0) as total_favorites,
                COALESCE(SUM(inquiry_count), 0) as total_inquiries,
                (SELECT COUNT(*) FROM conversations) as total_conversations,
                (SELECT COUNT(*) FROM reviews WHERE status = 'published') as published_reviews
         FROM products`
      ).first(),
      env.DB.prepare("SELECT verification_status, COUNT(*) as cnt FROM shops WHERE status != 'closed' GROUP BY verification_status").all(),
    ]);

    return json({
      productsByStatus: productsByStatus.results,
      productsByType: productsByType.results,
      ordersByStatus: ordersByStatus.results,
      topCategories: topCategories.results,
      aiByFeature: aiByFeature.results,
      engagementTotals,
      verificationBreakdown: verificationBreakdown.results,
    });
  }

  if (sub === '/users') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'users.manage');
    if ('error' in auth) return auth.error;
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
    const auth = await requireEdgeAdmin(request, env, 'users.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

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
    const auth = await requireEdgeAdmin(request, env, 'users.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    const userId = decodeURIComponent(sub.slice('/users/'.length, -'/ai-access'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const aiEnabled = body.data.aiEnabled ? 1 : 0;
    const customDailyLimit =
      body.data.customDailyLimit !== undefined && body.data.customDailyLimit !== '' && body.data.customDailyLimit !== null
        ? Number(body.data.customDailyLimit)
        : null;
    if (customDailyLimit !== null && (!Number.isFinite(customDailyLimit) || customDailyLimit < 0)) {
      return json({ error: 'customDailyLimit must be a non-negative number.' }, 400);
    }
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
    const auth = await requireEdgeAdmin(request, env, ['sellers.manage', 'sellers.suspend', 'shops.manage']);
    if ('error' in auth) return auth.error;
    const sellers = await env.DB.prepare(
      `SELECT sp.*, u.display_name, u.telegram_username, s.id as shop_id, s.name as shop_name,
              s.slug as shop_slug, s.status as shop_status, s.is_featured, s.verification_status as shop_verification_status
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
       LEFT JOIN shops s ON s.id = (
         SELECT s2.id FROM shops s2 WHERE s2.seller_id = sp.id AND s2.status != 'closed' ORDER BY s2.created_at DESC LIMIT 1
       )
       ORDER BY sp.created_at DESC`
    ).all();
    return json({ sellers: sellers.results });
  }

  if (sub.startsWith('/sellers/') && sub.endsWith('/status')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, ['sellers.manage', 'sellers.suspend', 'shops.manage']);
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

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

    if ((verificationStatus || typeof isFeatured === 'boolean') && !hasEdgeAdminPermission(admin, ['sellers.manage', 'shops.manage'])) {
      return json({ error: 'Insufficient administrative permissions to change shop verification or featured status.' }, 403);
    }

    if (['active', 'suspended'].includes(status)) {
      await env.DB.prepare("UPDATE seller_profiles SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status, seller.id)
        .run();
      await env.DB.prepare("UPDATE shops SET status = ?, updated_at = datetime('now') WHERE seller_id = ? AND status != 'closed'")
        .bind(status, seller.id)
        .run();
    }
    if (verificationStatus && ['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) {
      await env.DB.prepare('UPDATE seller_profiles SET verification_status = ? WHERE id = ?')
        .bind(verificationStatus, seller.id)
        .run();
      await env.DB.prepare("UPDATE shops SET verification_status = ? WHERE seller_id = ? AND status != 'closed'")
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
      await env.DB.prepare("UPDATE shops SET is_featured = ? WHERE seller_id = ? AND status != 'closed'")
        .bind(isFeatured ? 1 : 0, seller.id)
        .run();
    }
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'seller.updated', 'seller', sellerId, { status, verificationStatus, isFeatured }, ip);
    return json({ updated: true });
  }

  if (sub === '/shops') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, ['shops.manage', 'sellers.manage', 'sellers.suspend']);
    if ('error' in auth) return auth.error;
    const statusFilter = String(url.searchParams.get('status') || 'all').toLowerCase();
    const q = sanitizeText(url.searchParams.get('q') || '', 120).toLowerCase();

    const where: string[] = [];
    const params: unknown[] = [];
    if (['active', 'suspended', 'closed'].includes(statusFilter)) {
      where.push('s.status = ?');
      params.push(statusFilter);
    }
    if (q) {
      where.push('(LOWER(s.name) LIKE ? OR LOWER(s.slug) LIKE ? OR LOWER(u.display_name) LIKE ? OR LOWER(u.telegram_username) LIKE ?)');
      const pat = `%${q}%`;
      params.push(pat, pat, pat, pat);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const shops = await env.DB.prepare(
      `SELECT s.*, u.display_name as owner_name, u.telegram_username as owner_telegram_username,
              u.telegram_id as owner_telegram_id, sp.seller_type, sp.legal_name,
              (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status != 'archived') as product_count,
              (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) as order_count
       FROM shops s
       JOIN users u ON u.id = s.user_id
       JOIN seller_profiles sp ON sp.id = s.seller_id
       ${whereClause}
       ORDER BY CASE WHEN s.status = 'active' THEN 0 WHEN s.status = 'suspended' THEN 1 ELSE 2 END, s.created_at DESC`
    )
      .bind(...params)
      .all();
    return json({ shops: shops.results });
  }

  if (sub.startsWith('/shops/')) {
    const shopId = decodeURIComponent(sub.slice('/shops/'.length));

    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, ['shops.manage', 'sellers.manage', 'sellers.suspend']);
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const shop = await env.DB.prepare('SELECT * FROM shops WHERE id = ?')
        .bind(shopId)
        .first<Record<string, unknown>>();
      if (!shop) return json({ error: 'Shop not found.' }, 404);
      if (String(shop.status) === 'closed') {
        return json({ error: 'Closed or deleted shops cannot be modified.' }, 409);
      }

      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const status = body.data.status ? String(body.data.status) : null;
      const verificationStatus = body.data.verificationStatus ? String(body.data.verificationStatus) : null;
      const isFeatured = body.data.isFeatured;
      const nextName = body.data.name !== undefined ? sanitizeText(body.data.name, 80) : null;
      const nextDesc = body.data.description !== undefined ? sanitizeText(body.data.description, 600) : null;

      if (
        (verificationStatus || typeof isFeatured === 'boolean' || nextName !== null || nextDesc !== null) &&
        !hasEdgeAdminPermission(admin, ['shops.manage', 'sellers.manage'])
      ) {
        return json({ error: 'Insufficient administrative permissions to edit shop details or verification status.' }, 403);
      }
      if (nextName !== null && nextName.length < 2) {
        return json({ error: 'Shop name must be at least 2 characters.' }, 400);
      }

      if (status && ['active', 'suspended'].includes(status)) {
        await env.DB.prepare("UPDATE shops SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(status, shopId)
          .run();
      }
      if (verificationStatus && ['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) {
        await env.DB.prepare("UPDATE shops SET verification_status = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(verificationStatus, shopId)
          .run();
        await env.DB.prepare('UPDATE seller_profiles SET verification_status = ? WHERE id = ?')
          .bind(verificationStatus, shop.seller_id)
          .run();
        await notifyUserAndTelegramEdge(
          env,
          String(shop.user_id),
          'verification',
          `Shop Verification: ${verificationStatus.toUpperCase()}`,
          `Verification status for "${nextName || String(shop.name)}" is now ${verificationStatus}.`,
          url.origin
        );
      }
      if (typeof isFeatured === 'boolean') {
        await env.DB.prepare("UPDATE shops SET is_featured = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(isFeatured ? 1 : 0, shopId)
          .run();
      }
      if (nextName !== null || nextDesc !== null) {
        await env.DB.prepare(
          "UPDATE shops SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(nextName !== null ? nextName : String(shop.name), nextDesc !== null ? nextDesc : String(shop.description || ''), shopId)
          .run();
      }

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'shop.updated',
        'shop',
        shopId,
        { status, verificationStatus, isFeatured, name: nextName },
        ip
      );
      return json({ updated: true });
    }

    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, ['shops.manage', 'sellers.manage']);
      if ('error' in auth) return auth.error;
      const admin = auth.admin;

      const shop = await env.DB.prepare('SELECT * FROM shops WHERE id = ?')
        .bind(shopId)
        .first<Record<string, unknown>>();
      if (!shop) return json({ error: 'Shop not found.' }, 404);
      if (String(shop.status) === 'closed') {
        return json({ error: 'Shop has already been deleted/closed.' }, 409);
      }

      const bodyData = await parseOptionalJsonBody(request);
      const confirmFlag = bodyData.confirm === true;
      const confirmName = sanitizeText(bodyData.confirmShopName || '', 120);
      const reason = sanitizeText(bodyData.reason || '', 300);

      if (!confirmFlag && confirmName !== String(shop.name)) {
        return json({ error: 'Explicit shop deletion confirmation is required.' }, 400);
      }

      const result = await executeEdgeShopSoftDelete(env.DB, env, shop, admin.adminIdentifier, reason);
      if (result.ok === false) {
        return json({ error: result.error }, result.status);
      }

      await notifyUserAndTelegramEdge(
        env,
        String(shop.user_id),
        'moderation',
        `Shop Removed: ${String(shop.name)}`,
        reason
          ? `Your shop "${String(shop.name)}" was closed by SOFUMER Administration. Reason: ${reason}`
          : `Your shop "${String(shop.name)}" was closed by SOFUMER Administration. Historical orders remain accessible in your account.`,
        url.origin
      );

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'shop.deleted',
        'shop',
        shopId,
        {
          shopName: shop.name,
          ownerUserId: shop.user_id,
          reason,
          archivedProductsCount: result.archivedProductsCount,
          deletedProductsCount: result.deletedProductsCount,
        },
        ip,
        true
      );

      return json({
        deleted: true,
        shopId: result.shopId,
        archivedProductsCount: result.archivedProductsCount,
        deletedProductsCount: result.deletedProductsCount,
      });
    }

    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/products') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, ['moderation.manage', 'catalog.manage']);
    if ('error' in auth) return auth.error;
    const products = await env.DB.prepare(
      `SELECT p.*, s.name as shop_name, c.name as category_name, u.display_name as seller_name
       FROM products p JOIN shops s ON s.id = p.shop_id JOIN categories c ON c.id = p.category_id JOIN users u ON u.id = p.seller_user_id
       ORDER BY CASE WHEN p.status = 'pending_review' THEN 0 ELSE 1 END, p.created_at DESC`
    ).all();
    return json({ products: products.results });
  }

  if (sub.startsWith('/products/') && !sub.endsWith('/moderate')) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeAdmin(request, env, 'moderation.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const prodId = decodeURIComponent(sub.slice('/products/'.length));
    const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?')
      .bind(prodId)
      .first<Record<string, unknown>>();
    if (!product) return json({ error: 'Product not found.' }, 404);

    const bodyData = await parseOptionalJsonBody(request);
    const reason = sanitizeText(bodyData.reason || '', 300);

    const [hasOrder, hasReview] = await Promise.all([
      env.DB.prepare('SELECT id FROM order_items WHERE product_id = ? LIMIT 1').bind(prodId).first(),
      env.DB.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').bind(prodId).first(),
    ]);

    let mode: 'archived' | 'deleted' = 'deleted';
    if (hasOrder || hasReview) {
      mode = 'archived';
      await env.DB.batch([
        env.DB.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(prodId),
        env.DB.prepare(
          "UPDATE products SET status = 'archived', is_featured = 0, is_sponsored = 0, moderation_notes = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(reason || String(product.moderation_notes || ''), prodId),
      ]);
    } else {
      const [mediaRows, digitalAsset] = await Promise.all([
        env.DB.prepare('SELECT public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?')
          .bind(prodId)
          .all<Record<string, unknown>>(),
        env.DB.prepare('SELECT storage_provider, storage_key FROM product_digital_assets WHERE product_id = ?')
          .bind(prodId)
          .first<{ storage_provider: string; storage_key: string }>(),
      ]);

      if (digitalAsset?.storage_provider === 'r2' && digitalAsset.storage_key && env.MEDIA_BUCKET?.delete) {
        await env.MEDIA_BUCKET.delete(digitalAsset.storage_key).catch(() => {});
      }

      await env.DB.batch([
        env.DB.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').bind(prodId),
        env.DB.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM inquiries WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_inventory WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_variants WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_images WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM product_media WHERE product_id = ?').bind(prodId),
        env.DB.prepare('DELETE FROM products WHERE id = ?').bind(prodId),
      ]);

      await destroyUnreferencedCloudinaryAssets(env.DB, env, mediaRows.results);
    }

    await notifyUserAndTelegramEdge(
      env,
      String(product.seller_user_id),
      'moderation',
      `Listing ${mode === 'archived' ? 'Archived' : 'Removed'}: ${String(product.title)}`,
      reason || `Your listing "${String(product.title)}" was ${mode} by an administrator.`,
      url.origin
    );
    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'product.deleted',
      'product',
      prodId,
      { title: product.title, mode, reason },
      ip,
      true
    );
    return json({ deleted: true, mode, productId: prodId });
  }

  if (sub.startsWith('/products/') && sub.endsWith('/moderate')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'moderation.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

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

  if (sub.startsWith('/moderation/products/') && sub.endsWith('/ai-scan')) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'moderation.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    const prodId = decodeURIComponent(sub.slice('/moderation/products/'.length, -'/ai-scan'.length));
    const product = await env.DB.prepare(
      `SELECT p.*, c.name as category_name, s.name as shop_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ?`
    )
      .bind(prodId)
      .first<Record<string, unknown>>();
    if (!product) return json({ error: 'Product not found.' }, 404);

    const textBlob = `${String(product.title || '')} ${String(product.description || '')} ${String(product.keywords || '')}`;
    const keywordMatches = await checkProhibitedKeywordsEdge(env, textBlob);

    const settingRow = await env.DB.prepare(
      "SELECT model_name FROM ai_feature_settings WHERE feature_key = 'platform_support'"
    ).first<{ model_name: string }>();
    const modelName = resolveActiveCfAiModel(settingRow?.model_name, env.CLOUDFLARE_AI_MODEL, DEFAULT_CF_AI_MODEL);

    let riskLevel: 'low' | 'medium' | 'high' = keywordMatches.length > 0 ? 'high' : 'low';
    let rationale = keywordMatches.length
      ? `Matched prohibited keywords: ${keywordMatches.join(', ')}.`
      : 'No prohibited marketplace keywords detected.';
    let recommendedStatus: 'published' | 'pending_review' | 'rejected' = keywordMatches.length > 0 ? 'rejected' : 'published';
    let aiEvaluated = false;

    if (env.AI) {
      const start = Date.now();
      try {
        const rawOut = await runWorkersAiWithJsonFallback(
          env.AI,
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
                description: String(product.description || '').slice(0, 800),
                listingType: product.listing_type,
                category: product.category_name,
                price: product.price,
                currency: product.currency,
                keywordMatches,
              }),
            },
          ],
          true,
          400,
          0.1
        );
        const { data: parsed, estimatedTokens } = await normalizeAiJsonObject(rawOut);
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
        const rationaleText = coerceAiString(parsed.rationale);
        if (rationaleText) {
          rationale = sanitizeText(rationaleText, 400);
        }
        aiEvaluated = true;

        await env.DB.prepare(
          `INSERT INTO ai_usage (id, user_id, feature_key, model_name, prompt_summary, tokens_estimated, status, latency_ms)
           VALUES (?, ?, 'platform_support', ?, ?, ?, 'success', ?)`
        )
          .bind(newId('ai'), admin.userId, modelName, `admin_scan:${prodId}`, estimatedTokens, Date.now() - start)
          .run();
      } catch (err) {
        const { internalMessage } = sanitizeAiErrorForUser(err);
        await env.DB.prepare(
          `INSERT INTO ai_usage (id, user_id, feature_key, model_name, prompt_summary, tokens_estimated, status, error_message, latency_ms)
           VALUES (?, ?, 'platform_support', ?, ?, 0, 'error', ?, ?)`
        )
          .bind(newId('ai'), admin.userId, modelName, `admin_scan:${prodId}`, internalMessage.slice(0, 400), Date.now() - start)
          .run()
          .catch(() => {});
        // Fall back to deterministic keyword scan when AI model binding fails
      }
    }

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'product.ai_moderation_scan',
      'product',
      prodId,
      { riskLevel, recommendedStatus, keywordMatches, aiEvaluated, modelName },
      ip
    );

    return json({
      productId: prodId,
      riskLevel,
      recommendedStatus,
      keywordMatches,
      rationale,
      aiEvaluated,
      model: modelName,
    });
  }

  if (sub === '/categories') {
    if (request.method === 'GET') {
      const auth = await requireEdgeAdmin(request, env, ['catalog.manage', 'moderation.manage']);
      if ('error' in auth) return auth.error;
      const [categories, subcategories] = await Promise.all([
        env.DB.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all(),
        env.DB.prepare('SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC').all(),
      ]);
      return json({ categories: categories.results, subcategories: subcategories.results });
    }
    if (request.method === 'POST') {
      const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
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

  if (sub.startsWith('/categories/')) {
    const catId = decodeURIComponent(sub.slice('/categories/'.length));
    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;

      const existing = await env.DB.prepare('SELECT * FROM categories WHERE id = ?')
        .bind(catId)
        .first<Record<string, unknown>>();
      if (!existing) return json({ error: 'Category not found.' }, 404);

      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const name = body.data.name !== undefined ? sanitizeText(body.data.name, 80) : String(existing.name);
      const description =
        body.data.description !== undefined ? sanitizeText(body.data.description, 240) : String(existing.description || '');
      const isActive = body.data.isActive !== undefined ? (body.data.isActive ? 1 : 0) : Number(existing.is_active ?? 1);
      if (!name) return json({ error: 'Category name cannot be empty.' }, 400);

      await env.DB.prepare('UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?')
        .bind(name, description, isActive, catId)
        .run();

      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'category.updated', 'category', catId, { name, isActive: Boolean(isActive) }, ip);
      return json({ updated: true });
    }
    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const existing = await env.DB.prepare('SELECT id, name FROM categories WHERE id = ?')
        .bind(catId)
        .first<{ id: string; name: string }>();
      if (!existing) return json({ error: 'Category not found.' }, 404);

      const [subCnt, prodCnt] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as cnt FROM subcategories WHERE category_id = ?').bind(catId).first<{ cnt: number }>(),
        env.DB.prepare('SELECT COUNT(*) as cnt FROM products WHERE category_id = ?').bind(catId).first<{ cnt: number }>(),
      ]);
      if ((subCnt?.cnt ?? 0) > 0 || (prodCnt?.cnt ?? 0) > 0) {
        return json(
          { error: 'Category is referenced by existing subcategories or listings and cannot be deleted. Deactivate it instead.' },
          409
        );
      }

      await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(catId).run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'category.deleted', 'category', catId, { name: existing.name }, ip);
      return json({ deleted: true, id: catId });
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/subcategories') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
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
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'subcategory.created', 'subcategory', id, { categoryId, name }, ip);
    return json({ id, name }, 201);
  }

  if (sub.startsWith('/subcategories/')) {
    const subId = decodeURIComponent(sub.slice('/subcategories/'.length));
    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const existing = await env.DB.prepare('SELECT * FROM subcategories WHERE id = ?')
        .bind(subId)
        .first<Record<string, unknown>>();
      if (!existing) return json({ error: 'Subcategory not found.' }, 404);
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const name = body.data.name !== undefined ? sanitizeText(body.data.name, 80) : String(existing.name);
      const isActive = body.data.isActive !== undefined ? (body.data.isActive ? 1 : 0) : Number(existing.is_active ?? 1);
      if (!name) return json({ error: 'Subcategory name cannot be empty.' }, 400);
      await env.DB.prepare('UPDATE subcategories SET name = ?, is_active = ? WHERE id = ?')
        .bind(name, isActive, subId)
        .run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'subcategory.updated', 'subcategory', subId, { name, isActive: Boolean(isActive) }, ip);
      return json({ updated: true });
    }
    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'catalog.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const existing = await env.DB.prepare('SELECT id, name FROM subcategories WHERE id = ?')
        .bind(subId)
        .first<{ id: string; name: string }>();
      if (!existing) return json({ error: 'Subcategory not found.' }, 404);
      const prodCnt = await env.DB.prepare('SELECT COUNT(*) as cnt FROM products WHERE subcategory_id = ?')
        .bind(subId)
        .first<{ cnt: number }>();
      if ((prodCnt?.cnt ?? 0) > 0) {
        return json({ error: 'Subcategory is referenced by existing listings and cannot be deleted.' }, 409);
      }
      await env.DB.prepare('DELETE FROM subcategories WHERE id = ?').bind(subId).run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'subcategory.deleted', 'subcategory', subId, { name: existing.name }, ip);
      return json({ deleted: true, id: subId });
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/orders') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'orders.manage');
    if ('error' in auth) return auth.error;
    const orders = await env.DB.prepare(
      `SELECT o.*, s.name as shop_name, bu.display_name as buyer_name, su.display_name as seller_name
       FROM orders o JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id JOIN users su ON su.id = o.seller_user_id
       ORDER BY o.created_at DESC LIMIT 120`
    ).all();
    return json({ orders: orders.results });
  }

  if (sub.startsWith('/orders/')) {
    const orderId = decodeURIComponent(sub.slice('/orders/'.length));
    const auth = await requireEdgeAdmin(request, env, 'orders.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    if (request.method === 'GET') {
      const order = await env.DB.prepare(
        `SELECT o.*, s.name as shop_name, bu.display_name as buyer_name, su.display_name as seller_name
         FROM orders o JOIN shops s ON s.id = o.shop_id
         JOIN users bu ON bu.id = o.buyer_user_id JOIN users su ON su.id = o.seller_user_id
         WHERE o.id = ?`
      )
        .bind(orderId)
        .first<Record<string, unknown>>();
      if (!order) return json({ error: 'Order not found.' }, 404);
      const [items, history] = await Promise.all([
        env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all(),
        env.DB.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC')
          .bind(orderId)
          .all(),
      ]);
      return json({ order, items: items.results, history: history.results });
    }

    if (request.method === 'PATCH') {
      const VALID_ORDER_STATUSES = [
        'Inquiry',
        'Pending Confirmation',
        'Confirmed',
        'Processing',
        'Shipped',
        'Delivered',
        'Completed',
        'Cancelled',
        'Disputed',
      ];
      const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?')
        .bind(orderId)
        .first<Record<string, unknown>>();
      if (!order) return json({ error: 'Order not found.' }, 404);

      const body = await parseJsonBody<{ status?: string; note?: string }>(request);
      if (!body.ok) return body.error;
      const status = String(body.data.status || '');
      if (!VALID_ORDER_STATUSES.includes(status)) {
        return json({ error: 'Invalid order status.' }, 400);
      }
      const note = sanitizeText(body.data.note || '', 300);

      await env.DB.batch([
        env.DB.prepare(
          `UPDATE orders
           SET status = ?,
               buyer_confirmed_at = CASE WHEN ? = 'Confirmed' THEN COALESCE(buyer_confirmed_at, datetime('now')) ELSE buyer_confirmed_at END,
               completed_at = CASE WHEN ? = 'Completed' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(status, status, status, orderId),
        env.DB.prepare(
          `INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by_user_id, changed_by_role, note)
           VALUES (?, ?, ?, ?, ?, 'admin', ?)`
        ).bind(
          newId('osh'),
          orderId,
          String(order.status || ''),
          status,
          admin.userId,
          note || `Status updated to ${status} by administrator`
        ),
      ]);

      await Promise.all([
        notifyUserAndTelegramEdge(
          env,
          String(order.buyer_user_id),
          'order',
          `Order ${String(order.order_number)}: ${status}`,
          note || `An administrator updated your order status to ${status}.`,
          url.origin
        ),
        notifyUserAndTelegramEdge(
          env,
          String(order.seller_user_id),
          'order',
          `Order ${String(order.order_number)}: ${status}`,
          note || `An administrator updated order status to ${status}.`,
          url.origin
        ),
      ]);

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'order.status_updated',
        'order',
        orderId,
        { orderNumber: order.order_number, previousStatus: order.status, status, note },
        ip,
        true
      );
      return json({ updated: true, status });
    }

    return methodNotAllowed(['GET', 'PATCH']);
  }

  if (sub === '/reports') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, ['reports.manage', 'messages.moderate']);
    if ('error' in auth) return auth.error;
    const [reports, flaggedConversations] = await Promise.all([
      env.DB.prepare(
        `SELECT r.*, u.display_name as reporter_name FROM reports r
         JOIN users u ON u.id = r.reporter_user_id
         ORDER BY CASE WHEN r.status = 'open' THEN 0 WHEN r.status = 'investigating' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 100`
      ).all(),
      env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
         FROM conversations c
         WHERE c.status IN ('flagged', 'closed')
         ORDER BY CASE WHEN c.status = 'flagged' THEN 0 ELSE 1 END, c.last_message_at DESC LIMIT 60`
      ).all(),
    ]);
    return json({ reports: reports.results, flaggedConversations: flaggedConversations.results });
  }

  if (sub.startsWith('/reports/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'reports.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
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
    const auth = await requireEdgeAdmin(request, env, ['reports.manage', 'messages.moderate']);
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const convId = decodeURIComponent(sub.slice('/conversations/'.length, -'/messages'.length));
    const conv = await env.DB.prepare('SELECT id, subject, status FROM conversations WHERE id = ?')
      .bind(convId)
      .first<Record<string, unknown>>();
    if (!conv) return json({ error: 'Conversation not found.' }, 404);
    const messages = await env.DB.prepare(
      `SELECT m.*, u.display_name as sender_name FROM messages m
       JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? ORDER BY m.created_at ASC`
    )
      .bind(convId)
      .all();
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'conversation.investigated', 'conversation', convId, {}, ip);
    return json({ conversation: conv, messages: messages.results });
  }

  if (sub.startsWith('/conversations/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, ['reports.manage', 'messages.moderate']);
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const convId = decodeURIComponent(sub.slice('/conversations/'.length));
    const body = await parseJsonBody<{ status?: string }>(request);
    if (!body.ok) return body.error;
    const status = String(body.data.status || '');
    if (!['active', 'flagged', 'closed', 'archived'].includes(status)) {
      return json({ error: 'Invalid conversation status.' }, 400);
    }
    const upd = await env.DB.prepare('UPDATE conversations SET status = ? WHERE id = ?')
      .bind(status, convId)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) return json({ error: 'Conversation not found.' }, 404);
    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'conversation.status_updated',
      'conversation',
      convId,
      { status },
      ip
    );
    return json({ updated: true, status });
  }

  if (sub.startsWith('/messages/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'messages.moderate');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const msgId = decodeURIComponent(sub.slice('/messages/'.length));
    const body = await parseJsonBody<{ isDeleted?: boolean }>(request);
    if (!body.ok) return body.error;
    const existing = await env.DB.prepare('SELECT id, conversation_id, body, is_deleted FROM messages WHERE id = ?')
      .bind(msgId)
      .first<{ id: string; conversation_id: string; body: string; is_deleted: number }>();
    if (!existing) return json({ error: 'Message not found.' }, 404);

    const isDeleted = body.data.isDeleted !== undefined ? Boolean(body.data.isDeleted) : !existing.is_deleted;
    await env.DB.prepare('UPDATE messages SET is_deleted = ? WHERE id = ?').bind(isDeleted ? 1 : 0, msgId).run();

    const latestMsg = await env.DB.prepare(
      'SELECT body, is_deleted FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(existing.conversation_id)
      .first<{ body: string; is_deleted: number }>();
    if (latestMsg) {
      const preview = latestMsg.is_deleted ? '[Removed by moderation]' : sanitizeText(latestMsg.body || '', 120);
      await env.DB.prepare('UPDATE conversations SET last_message_preview = ? WHERE id = ?')
        .bind(preview, existing.conversation_id)
        .run();
    }

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'message.moderated',
      'message',
      msgId,
      { conversationId: existing.conversation_id, isDeleted },
      ip
    );
    return json({ updated: true, isDeleted });
  }

  if (sub === '/reviews') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'reviews.manage');
    if ('error' in auth) return auth.error;
    const reviews = await env.DB.prepare(
      `SELECT r.*, p.title as product_title, u.display_name as reviewer_name, s.name as shop_name
       FROM reviews r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.reviewer_user_id
       JOIN shops s ON s.id = r.shop_id
       ORDER BY r.created_at DESC LIMIT 100`
    ).all();
    return json({ reviews: reviews.results });
  }

  if (sub.startsWith('/reviews/')) {
    const revId = decodeURIComponent(sub.slice('/reviews/'.length));
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'reviews.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const review = await env.DB.prepare('SELECT id, product_id, shop_id FROM reviews WHERE id = ?')
        .bind(revId)
        .first<{ id: string; product_id: string; shop_id: string }>();
      if (!review) return json({ error: 'Review not found.' }, 404);

      let status = 'removed';
      if (request.method === 'PATCH') {
        const body = await parseJsonBody(request);
        if (!body.ok) return body.error;
        status = String(body.data.status || 'published');
        if (!['published', 'hidden', 'removed'].includes(status)) {
          return json({ error: 'Invalid review status.' }, 400);
        }
      }

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

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        request.method === 'DELETE' ? 'review.removed' : 'review.moderated',
        'review',
        revId,
        { status },
        ip
      );
      return request.method === 'DELETE' ? json({ deleted: true, id: revId }) : json({ updated: true });
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/monetization') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'monetization.manage');
    if ('error' in auth) return auth.error;
    const [plans, subscriptions, promotions, promotionTransactions, starsPayments, revenueSummary] = await Promise.all([
      env.DB.prepare(
        `SELECT sp.*, COALESCE(sps.stars_monthly, 0) as stars_monthly, COALESCE(sps.stars_annual, 0) as stars_annual
         FROM subscription_plans sp LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
         ORDER BY sp.monthly_price ASC`
      ).all(),
      env.DB.prepare(
        `SELECT s.*, sp.code as plan_code, sp.name as plan_name, u.display_name as seller_name, sh.name as shop_name
         FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
         JOIN users u ON u.id = s.user_id LEFT JOIN shops sh ON sh.seller_id = s.seller_id
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
      env.DB.prepare(
        `SELECT
           (SELECT COALESCE(SUM(stars_amount), 0) FROM telegram_stars_payments WHERE status = 'paid') as stars_revenue_xtr,
           (SELECT COUNT(*) FROM telegram_stars_payments WHERE status = 'pending') as pending_stars_payments,
           (SELECT COALESCE(SUM(amount_recorded), 0) FROM subscriptions WHERE status = 'active') as subscription_revenue_usd,
           (SELECT COALESCE(SUM(amount), 0) FROM promotion_transactions WHERE status = 'recorded') as promotion_revenue_usd`
      ).first(),
    ]);
    return json({
      plans: plans.results,
      subscriptions: subscriptions.results,
      promotions: promotions.results,
      promotionTransactions: promotionTransactions.results,
      starsPayments: starsPayments.results,
      revenueSummary,
    });
  }

  if (sub.startsWith('/plans/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'monetization.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
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

  if (sub.startsWith('/subscriptions/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'monetization.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const subId = decodeURIComponent(sub.slice('/subscriptions/'.length));
    const subRow = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?')
      .bind(subId)
      .first<Record<string, unknown>>();
    if (!subRow) return json({ error: 'Subscription not found.' }, 404);

    const body = await parseJsonBody<{ status?: string }>(request);
    if (!body.ok) return body.error;
    const nextStatus = String(body.data.status || '');
    if (!['cancelled', 'expired'].includes(nextStatus)) {
      return json({ error: 'Administrators can only transition subscriptions to cancelled or expired.' }, 400);
    }

    await env.DB.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').bind(nextStatus, subId).run();
    await notifyUserAndTelegramEdge(
      env,
      String(subRow.user_id),
      'subscription',
      `Subscription ${nextStatus.toUpperCase()}`,
      `Your seller subscription status was updated to ${nextStatus} by SOFUMER Administration.`,
      url.origin
    );
    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'subscription.updated',
      'subscription',
      subId,
      { previousStatus: subRow.status, status: nextStatus },
      ip,
      true
    );
    return json({ updated: true, status: nextStatus });
  }

  if (sub.startsWith('/stars-payments/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'monetization.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const payId = decodeURIComponent(sub.slice('/stars-payments/'.length));
    const payment = await env.DB.prepare('SELECT * FROM telegram_stars_payments WHERE id = ?')
      .bind(payId)
      .first<Record<string, unknown>>();
    if (!payment) return json({ error: 'Stars payment record not found.' }, 404);
    if (String(payment.status) !== 'pending') {
      return json({ error: 'Only pending Stars invoices can be expired or cancelled.' }, 409);
    }

    const body = await parseJsonBody<{ status?: string }>(request);
    if (!body.ok) return body.error;
    const nextStatus = String(body.data.status || 'expired');
    if (!['expired', 'cancelled'].includes(nextStatus)) {
      return json({ error: 'Pending Stars invoices may only be marked expired or cancelled.' }, 400);
    }

    await env.DB.prepare("UPDATE telegram_stars_payments SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(nextStatus, payId)
      .run();
    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'stars_payment.updated',
      'telegram_stars_payment',
      payId,
      { status: nextStatus, starsAmount: payment.stars_amount },
      ip,
      true
    );
    return json({ updated: true, status: nextStatus });
  }

  if (sub.startsWith('/promotions/')) {
    const promoId = decodeURIComponent(sub.slice('/promotions/'.length));
    const auth = await requireEdgeAdmin(request, env, 'monetization.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    const promo = await env.DB.prepare('SELECT * FROM promotions WHERE id = ?')
      .bind(promoId)
      .first<Record<string, unknown>>();
    if (!promo) return json({ error: 'Promotion not found.' }, 404);

    if (request.method === 'PATCH') {
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const status = String(body.data.status || '');
      if (!['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) {
        return json({ error: 'Invalid promotion status.' }, 400);
      }

      if (status === 'active') {
        const durationDays = Math.max(1, Math.min(365, Number(promo.duration_days || 7) || 7));
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE promotions
             SET status = 'active',
                 starts_at = COALESCE(starts_at, datetime('now')),
                 ends_at = COALESCE(ends_at, datetime('now', '+' || ? || ' days'))
             WHERE id = ?`
          ).bind(durationDays, promo.id),
          env.DB.prepare("UPDATE promotion_transactions SET status = 'recorded' WHERE promotion_id = ?").bind(promo.id),
        ]);
        if (promo.product_id) {
          if (promo.promo_type === 'sponsored_placement') {
            await env.DB.prepare('UPDATE products SET is_sponsored = 1 WHERE id = ?').bind(promo.product_id).run();
          } else {
            await env.DB.prepare('UPDATE products SET is_featured = 1 WHERE id = ?').bind(promo.product_id).run();
          }
        }
      } else {
        await env.DB.prepare('UPDATE promotions SET status = ? WHERE id = ?').bind(status, promo.id).run();
        if (promo.product_id && ['paused', 'completed', 'rejected'].includes(status)) {
          const col = promo.promo_type === 'sponsored_placement' ? 'is_sponsored' : 'is_featured';
          const otherActive = await env.DB.prepare(
            "SELECT id FROM promotions WHERE product_id = ? AND promo_type = ? AND status = 'active' AND id != ? LIMIT 1"
          )
            .bind(promo.product_id, promo.promo_type, promo.id)
            .first();
          if (!otherActive) {
            await env.DB.prepare(`UPDATE products SET ${col} = 0 WHERE id = ?`).bind(promo.product_id).run();
          }
        }
      }

      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'promotion.updated', 'promotion', promoId, { status }, ip);
      return json({ updated: true });
    }

    if (request.method === 'DELETE') {
      if (String(promo.status) === 'active') {
        return json({ error: 'Pause or complete an active promotion before deleting it.' }, 409);
      }
      const paidStars = await env.DB.prepare(
        "SELECT id FROM telegram_stars_payments WHERE target_type = 'promotion' AND target_id = ? AND status = 'paid' LIMIT 1"
      )
        .bind(promoId)
        .first();
      if (paidStars) {
        return json({ error: 'Paid Telegram Stars promotions cannot be permanently deleted; mark them completed or rejected instead.' }, 409);
      }

      await env.DB.batch([
        env.DB.prepare(
          "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE target_type = 'promotion' AND target_id = ? AND status = 'pending'"
        ).bind(promoId),
        env.DB.prepare('DELETE FROM promotion_transactions WHERE promotion_id = ?').bind(promoId),
        env.DB.prepare('DELETE FROM promotions WHERE id = ?').bind(promoId),
      ]);
      if (promo.product_id) {
        const col = promo.promo_type === 'sponsored_placement' ? 'is_sponsored' : 'is_featured';
        const otherActive = await env.DB.prepare(
          "SELECT id FROM promotions WHERE product_id = ? AND promo_type = ? AND status = 'active' LIMIT 1"
        )
          .bind(promo.product_id, promo.promo_type)
          .first();
        if (!otherActive) {
          await env.DB.prepare(`UPDATE products SET ${col} = 0 WHERE id = ?`).bind(promo.product_id).run();
        }
      }
      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'promotion.deleted',
        'promotion',
        promoId,
        { title: promo.title, previousStatus: promo.status },
        ip,
        true
      );
      return json({ deleted: true, id: promoId });
    }

    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/ai') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'ai.manage');
    if ('error' in auth) return auth.error;
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
    return json({
      features: features.results,
      usageLogs: usageLogs.results,
      summary,
      availableModels: Array.from(VALID_CF_MODELS),
      defaultModel: DEFAULT_CF_AI_MODEL,
    });
  }

  if (sub.startsWith('/ai/features/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'ai.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const featureKey = decodeURIComponent(sub.slice('/ai/features/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const isEnabled = body.data.isEnabled ? 1 : 0;
    const modelName = sanitizeText(
      body.data.modelName || (VALID_CF_MODELS.has(env.CLOUDFLARE_AI_MODEL || '') ? env.CLOUDFLARE_AI_MODEL : DEFAULT_CF_AI_MODEL),
      64
    );
    if (!VALID_CF_MODELS.has(modelName)) {
      return json(
        {
          error: `Unsupported or deprecated Cloudflare Workers AI model "${modelName}". Choose one of: ${Array.from(VALID_CF_MODELS).join(', ')}`,
        },
        400
      );
    }
    const dailyLimitRaw = Number(body.data.dailyLimitPerUser ?? 30);
    if (!Number.isFinite(dailyLimitRaw) || dailyLimitRaw < 0 || dailyLimitRaw > 10000) {
      return json({ error: 'dailyLimitPerUser must be a valid number between 0 and 10,000.' }, 400);
    }
    const dailyLimitPerUser = Math.max(0, Math.floor(dailyLimitRaw));

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
    const auth = await requireEdgeAdmin(request, env, 'countries.manage');
    if ('error' in auth) return auth.error;
    const [countries, currencies] = await Promise.all([
      env.DB.prepare('SELECT * FROM countries ORDER BY name ASC').all(),
      env.DB.prepare('SELECT * FROM currencies ORDER BY code ASC').all(),
    ]);
    return json({ countries: countries.results, currencies: currencies.results });
  }

  if (sub.startsWith('/countries/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'countries.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const code = decodeURIComponent(sub.slice('/countries/'.length)).toUpperCase();
    const existing = await env.DB.prepare('SELECT * FROM countries WHERE code = ?').bind(code).first<Record<string, unknown>>();
    if (!existing) return json({ error: 'Country not found.' }, 404);

    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const isEnabled = body.data.isEnabled !== undefined ? (body.data.isEnabled ? 1 : 0) : Number(existing.is_enabled ?? 1);
    const shippingNotes =
      body.data.shippingNotes !== undefined ? sanitizeText(body.data.shippingNotes, 300) : String(existing.shipping_notes || '');
    const verificationNotes =
      body.data.verificationNotes !== undefined
        ? sanitizeText(body.data.verificationNotes, 300)
        : String(existing.verification_notes || '');

    await env.DB.prepare('UPDATE countries SET is_enabled = ?, shipping_notes = ?, verification_notes = ? WHERE code = ?')
      .bind(isEnabled, shippingNotes, verificationNotes, code)
      .run();
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'country.updated', 'country', code, { isEnabled: Boolean(isEnabled) }, ip);
    return json({ updated: true });
  }

  if (sub === '/support') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'support.manage');
    if ('error' in auth) return auth.error;
    const tickets = await env.DB.prepare(
      `SELECT t.*, u.display_name, u.telegram_username FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC`
    ).all();
    return json({ tickets: tickets.results });
  }

  if (sub.startsWith('/support/')) {
    const ticketId = decodeURIComponent(sub.slice('/support/'.length));
    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, 'support.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
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
    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'support.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const ticket = await env.DB.prepare('SELECT id, subject, status FROM support_tickets WHERE id = ?')
        .bind(ticketId)
        .first<{ id: string; subject: string; status: string }>();
      if (!ticket) return json({ error: 'Ticket not found.' }, 404);
      if (!['resolved', 'closed'].includes(ticket.status)) {
        return json({ error: 'Only resolved or closed support tickets can be deleted.' }, 409);
      }
      await env.DB.prepare('DELETE FROM support_tickets WHERE id = ?').bind(ticketId).run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'support.deleted', 'support_ticket', ticketId, { subject: ticket.subject }, ip);
      return json({ deleted: true, id: ticketId });
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/notifications') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'notifications.manage');
    if ('error' in auth) return auth.error;
    const notifications = await env.DB.prepare(
      `SELECT n.*, u.display_name as recipient_name
       FROM notifications n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.scope = 'global' OR n.type = 'announcement'
       ORDER BY n.created_at DESC LIMIT 80`
    ).all();
    return json({ notifications: notifications.results });
  }

  if (sub === '/notifications/broadcast') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'notifications.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const title = sanitizeText(body.data.title || '', 120);
    const msgBody = sanitizeText(body.data.body || '', 600);
    if (!title || !msgBody) return json({ error: 'Title and body required.' }, 400);

    const id = newId('notif');
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, scope, type, title, body) VALUES (?, NULL, 'global', 'announcement', ?, ?)`
    )
      .bind(id, title, msgBody)
      .run();

    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value, value_type, updated_by, updated_at)
       VALUES ('marketplace_announcement', ?, 'string', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
    )
      .bind(`${title} — ${msgBody}`, admin.adminIdentifier)
      .run();

    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'notification.broadcast', 'global', id, { title }, ip);
    return json({ broadcast: true, id }, 201);
  }

  if (sub.startsWith('/notifications/')) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeAdmin(request, env, 'notifications.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const notifId = decodeURIComponent(sub.slice('/notifications/'.length));
    const notif = await env.DB.prepare('SELECT id, title, body, scope FROM notifications WHERE id = ?')
      .bind(notifId)
      .first<{ id: string; title: string; body: string; scope: string }>();
    if (!notif) return json({ error: 'Notification not found.' }, 404);

    await env.DB.prepare('DELETE FROM notifications WHERE id = ?').bind(notifId).run();

    const bannerRow = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'marketplace_announcement'").first<{
      value: string;
    }>();
    if (bannerRow && bannerRow.value === `${notif.title} — ${notif.body}`) {
      await env.DB.prepare(
        "UPDATE platform_settings SET value = '', updated_by = ?, updated_at = datetime('now') WHERE key = 'marketplace_announcement'"
      )
        .bind(admin.adminIdentifier)
        .run();
    }

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'notification.deleted',
      notif.scope || 'global',
      notifId,
      { title: notif.title },
      ip,
      true
    );
    return json({ deleted: true, id: notifId });
  }

  if (sub === '/settings') {
    if (request.method === 'GET') {
      const auth = await requireEdgeAdmin(request, env, ['settings.manage', 'rbac.manage']);
      if ('error' in auth) return auth.error;
      const [settings, roles, permissions, roleAssignments] = await Promise.all([
        env.DB.prepare('SELECT * FROM platform_settings ORDER BY key ASC').all(),
        env.DB.prepare('SELECT * FROM admin_roles ORDER BY created_at ASC').all(),
        env.DB.prepare('SELECT * FROM admin_permissions').all(),
        env.DB.prepare(
          `SELECT ara.*, ar.code as role_code, ar.name as role_name, u.display_name, u.telegram_username
           FROM admin_role_assignments ara
           JOIN admin_roles ar ON ar.id = ara.role_id
           LEFT JOIN users u ON u.telegram_id = ara.telegram_id
           ORDER BY ara.created_at DESC`
        ).all(),
      ]);
      return json({
        settings: settings.results,
        roles: roles.results,
        permissions: permissions.results,
        roleAssignments: roleAssignments.results,
        permissionCatalog: ADMIN_PERMISSION_CATALOG,
        envOwnerTelegramIds: getEnvOwnerTelegramIds(env),
        cloudinaryStatus: getCloudinaryPublicDiagnostics(env),
      });
    }

    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, 'settings.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const body = await parseJsonBody<{ updates?: Array<{ key?: string; value?: unknown }> }>(request);
      if (!body.ok) return body.error;
      const updates = Array.isArray(body.data.updates) ? body.data.updates : [];
      if (!updates.length) return json({ error: 'Provide an updates array of { key, value }.' }, 400);

      const validated: Array<{ key: string; value: string }> = [];
      for (const item of updates) {
        const key = sanitizeText(item.key || '', 80);
        if (!key) return json({ error: 'Each update item requires a setting key.' }, 400);
        const res = await validateAndNormalizeSetting(env.DB, key, item.value);
        if (!res.ok) return json({ error: res.error }, res.status || 400);
        validated.push({ key, value: res.value });
      }

      await env.DB.batch(
        validated.map((item) =>
          env.DB!.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`).bind(
            item.value,
            admin.adminIdentifier,
            item.key
          )
        )
      );

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'settings.batch_updated',
        'setting',
        'batch',
        { keys: validated.map((v) => v.key), values: Object.fromEntries(validated.map((v) => [v.key, v.value])) },
        ip
      );
      return json({ updated: true, count: validated.length });
    }

    return methodNotAllowed(['GET', 'PATCH']);
  }

  if (sub.startsWith('/settings/')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeAdmin(request, env, 'settings.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const key = decodeURIComponent(sub.slice('/settings/'.length));
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const validated = await validateAndNormalizeSetting(env.DB, key, body.data.value);
    if (!validated.ok) return json({ error: validated.error }, validated.status || 400);

    await env.DB.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`)
      .bind(validated.value, admin.adminIdentifier, key)
      .run();
    await recordEdgeAdminAudit(env, admin.adminIdentifier, 'setting.updated', 'setting', key, { value: validated.value }, ip);
    return json({ updated: true, key, value: validated.value });
  }

  // ==========================================================================
  // DATABASE-BACKED ADMINISTRATIVE RBAC
  // ==========================================================================
  if (sub === '/roles') {
    if (request.method === 'GET') {
      const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
      if ('error' in auth) return auth.error;
      const [roles, permissions, roleAssignments] = await Promise.all([
        env.DB.prepare('SELECT * FROM admin_roles ORDER BY created_at ASC').all(),
        env.DB.prepare('SELECT * FROM admin_permissions').all(),
        env.DB.prepare(
          `SELECT ara.*, ar.code as role_code, ar.name as role_name, u.display_name, u.telegram_username
           FROM admin_role_assignments ara
           JOIN admin_roles ar ON ar.id = ara.role_id
           LEFT JOIN users u ON u.telegram_id = ara.telegram_id
           ORDER BY ara.created_at DESC`
        ).all(),
      ]);
      return json({
        roles: roles.results,
        permissions: permissions.results,
        roleAssignments: roleAssignments.results,
        permissionCatalog: ADMIN_PERMISSION_CATALOG,
        envOwnerTelegramIds: getEnvOwnerTelegramIds(env),
      });
    }

    if (request.method === 'POST') {
      const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const body = await parseJsonBody<{
        code?: string;
        name?: string;
        description?: string;
        permissions?: string[];
      }>(request);
      if (!body.ok) return body.error;

      const code = sanitizeText(body.data.code || '', 24)
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_');
      const name = sanitizeText(body.data.name || '', 80);
      const description = sanitizeText(body.data.description || '', 240);
      const permissions = Array.isArray(body.data.permissions)
        ? Array.from(new Set(body.data.permissions.map((p) => String(p).trim()).filter(Boolean)))
        : [];

      if (!code || code.length < 2 || !name) {
        return json({ error: 'Valid role code (min 2 chars) and name are required.' }, 400);
      }
      for (const perm of permissions) {
        if (!VALID_PERMISSION_KEYS.has(perm)) {
          return json({ error: `Unknown permission key "${perm}".` }, 400);
        }
        if (!admin.isOwner && OWNER_ONLY_PERMISSIONS.has(perm)) {
          return json({ error: `Only a Platform Owner can grant "${perm}".` }, 403);
        }
      }

      const existingCode = await env.DB.prepare('SELECT id FROM admin_roles WHERE code = ?').bind(code).first();
      if (existingCode) return json({ error: `Role code "${code}" already exists.` }, 409);

      const roleId = newId('role');
      await env.DB.prepare('INSERT INTO admin_roles (id, code, name, description) VALUES (?, ?, ?, ?)')
        .bind(roleId, code, name, description)
        .run();

      if (permissions.length) {
        await env.DB.batch(
          permissions.map((perm) =>
            env.DB!.prepare('INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES (?, ?, ?)').bind(
              newId('perm'),
              roleId,
              perm
            )
          )
        );
      }

      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'rbac.role_created', 'admin_role', roleId, { code, name, permissions }, ip);
      return json({ id: roleId, code, name, description, permissions }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  if (sub.startsWith('/roles/') && sub.endsWith('/permissions')) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const roleId = decodeURIComponent(sub.slice('/roles/'.length, -'/permissions'.length));
    const role = await env.DB.prepare('SELECT * FROM admin_roles WHERE id = ?')
      .bind(roleId)
      .first<{ id: string; code: string }>();
    if (!role) return json({ error: 'Role not found.' }, 404);
    if (role.id === 'role_owner' || role.code === 'OWNER') {
      return json({ error: 'Platform Owner (*) permissions are immutable.' }, 403);
    }

    const body = await parseJsonBody<{ permissions?: string[] }>(request);
    if (!body.ok) return body.error;
    const nextPerms = Array.isArray(body.data.permissions)
      ? Array.from(new Set(body.data.permissions.map((p) => String(p).trim()).filter(Boolean)))
      : [];

    for (const perm of nextPerms) {
      if (!VALID_PERMISSION_KEYS.has(perm)) {
        return json({ error: `Unknown permission key "${perm}".` }, 400);
      }
    }

    const currentRows = await env.DB.prepare('SELECT permission_key FROM admin_permissions WHERE role_id = ?')
      .bind(roleId)
      .all<{ permission_key: string }>();
    const currentSet = new Set<string>(currentRows.results.map((r: { permission_key: string }) => r.permission_key));

    if (!admin.isOwner) {
      for (const perm of nextPerms) {
        if (OWNER_ONLY_PERMISSIONS.has(perm) && !currentSet.has(perm)) {
          return json({ error: `Only a Platform Owner can grant "${perm}".` }, 403);
        }
      }
      for (const perm of currentSet) {
        if (OWNER_ONLY_PERMISSIONS.has(perm) && !nextPerms.includes(perm)) {
          return json({ error: `Only a Platform Owner can revoke "${perm}".` }, 403);
        }
      }
    }

    await env.DB.prepare('DELETE FROM admin_permissions WHERE role_id = ?').bind(roleId).run();
    if (nextPerms.length > 0) {
      await env.DB.batch(
        nextPerms.map((perm) =>
          env.DB!.prepare('INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES (?, ?, ?)').bind(
            newId('perm'),
            roleId,
            perm
          )
        )
      );
    }

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'rbac.permissions_updated',
      'admin_role',
      roleId,
      { roleCode: role.code, permissions: nextPerms },
      ip
    );
    return json({ updated: true, roleId, permissions: nextPerms });
  }

  if (sub.startsWith('/roles/')) {
    const roleId = decodeURIComponent(sub.slice('/roles/'.length));
    if (request.method === 'PATCH') {
      const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const role = await env.DB.prepare('SELECT * FROM admin_roles WHERE id = ?')
        .bind(roleId)
        .first<{ id: string; code: string; name: string; description: string }>();
      if (!role) return json({ error: 'Role not found.' }, 404);
      if ((role.id === 'role_owner' || role.code === 'OWNER') && !admin.isOwner) {
        return json({ error: 'Only a Platform Owner can edit the OWNER role.' }, 403);
      }
      const body = await parseJsonBody<{ name?: string; description?: string }>(request);
      if (!body.ok) return body.error;
      const name = body.data.name !== undefined ? sanitizeText(body.data.name, 80) : role.name;
      const description = body.data.description !== undefined ? sanitizeText(body.data.description, 240) : role.description;
      if (!name) return json({ error: 'Role name cannot be empty.' }, 400);
      await env.DB.prepare('UPDATE admin_roles SET name = ?, description = ? WHERE id = ?')
        .bind(name, description, roleId)
        .run();
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'rbac.role_updated', 'admin_role', roleId, { name }, ip);
      return json({ updated: true });
    }

    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      if (['role_owner', 'role_mod', 'role_ops'].includes(roleId)) {
        return json({ error: 'Built-in system roles cannot be deleted.' }, 403);
      }
      const role = await env.DB.prepare('SELECT * FROM admin_roles WHERE id = ?')
        .bind(roleId)
        .first<{ id: string; code: string }>();
      if (!role) return json({ error: 'Role not found.' }, 404);
      if (!admin.isOwner && (await roleHasOwnerOnlyPermissionsEdge(env.DB, roleId))) {
        return json({ error: 'Only a Platform Owner can delete a role holding owner-level permissions.' }, 403);
      }
      const assigned = await env.DB.prepare('SELECT COUNT(*) as cnt FROM admin_role_assignments WHERE role_id = ?')
        .bind(roleId)
        .first<{ cnt: number }>();
      if ((assigned?.cnt ?? 0) > 0) {
        return json({ error: 'Revoke or reassign administrators holding this role before deleting it.' }, 409);
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_permissions WHERE role_id = ?').bind(roleId),
        env.DB.prepare('DELETE FROM admin_roles WHERE id = ?').bind(roleId),
      ]);
      await recordEdgeAdminAudit(env, admin.adminIdentifier, 'rbac.role_deleted', 'admin_role', roleId, { code: role.code }, ip);
      return json({ deleted: true });
    }

    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/role-assignments') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    const body = await parseJsonBody<{ telegramId?: string; roleId?: string; displayLabel?: string }>(request);
    if (!body.ok) return body.error;
    const telegramId = String(body.data.telegramId || '').trim();
    const roleId = sanitizeText(body.data.roleId || '', 64);
    const displayLabel = sanitizeText(body.data.displayLabel || '', 80);

    if (!/^\d{3,20}$/.test(telegramId)) {
      return json({ error: 'Telegram ID must be a numeric Telegram user ID (3–20 digits).' }, 400);
    }
    if (isTelegramIdAdmin(telegramId, [env.ADMIN_TELEGRAM_IDS, env.ADMIN_TELEGRAM_ID].filter(Boolean).join(','))) {
      return json({ error: 'This Telegram ID is already a permanent Owner configured in ADMIN_TELEGRAM_IDS.' }, 409);
    }
    const role = await env.DB.prepare('SELECT * FROM admin_roles WHERE id = ?')
      .bind(roleId)
      .first<{ id: string; code: string }>();
    if (!role) return json({ error: 'Target admin role not found.' }, 404);

    if (!admin.isOwner && (role.code === 'OWNER' || role.id === 'role_owner' || (await roleHasOwnerOnlyPermissionsEdge(env.DB, roleId)))) {
      return json({ error: 'Only a Platform Owner can assign OWNER or owner-privileged roles.' }, 403);
    }
    if (!admin.isOwner && telegramId === admin.telegramId) {
      return json({ error: 'You cannot modify your own administrative role assignment.' }, 403);
    }

    const existingAssign = await env.DB.prepare('SELECT id FROM admin_role_assignments WHERE telegram_id = ?')
      .bind(telegramId)
      .first();
    if (existingAssign) {
      return json({ error: 'An assignment already exists for this Telegram ID. Update the existing assignment instead.' }, 409);
    }

    const id = newId('assign');
    await env.DB.prepare(
      `INSERT INTO admin_role_assignments (id, telegram_id, role_id, display_label, is_active, assigned_by)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
      .bind(id, telegramId, roleId, displayLabel, admin.adminIdentifier)
      .run();

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'rbac.assignment_created',
      'admin_role_assignment',
      id,
      { telegramId, roleCode: role.code, displayLabel },
      ip
    );
    return json({ id, telegramId, roleId, displayLabel, isActive: true }, 201);
  }

  if (sub.startsWith('/role-assignments/')) {
    const assignId = decodeURIComponent(sub.slice('/role-assignments/'.length));
    const auth = await requireEdgeAdmin(request, env, 'rbac.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;

    const existing = await env.DB.prepare(
      `SELECT ara.*, ar.code as role_code
       FROM admin_role_assignments ara JOIN admin_roles ar ON ar.id = ara.role_id
       WHERE ara.id = ?`
    )
      .bind(assignId)
      .first<{ id: string; telegram_id: string; role_id: string; role_code: string; display_label: string; is_active: number }>();
    if (!existing) return json({ error: 'Role assignment not found.' }, 404);

    if (!admin.isOwner && existing.telegram_id === admin.telegramId) {
      return json({ error: 'You cannot modify or revoke your own administrative assignment.' }, 403);
    }
    if (
      !admin.isOwner &&
      (existing.role_code === 'OWNER' || existing.role_id === 'role_owner' || (await roleHasOwnerOnlyPermissionsEdge(env.DB, existing.role_id)))
    ) {
      return json({ error: 'Only a Platform Owner can manage OWNER-level assignments.' }, 403);
    }

    if (request.method === 'PATCH') {
      const body = await parseJsonBody<{ roleId?: string; isActive?: boolean; displayLabel?: string }>(request);
      if (!body.ok) return body.error;
      const nextRoleId = body.data.roleId !== undefined ? sanitizeText(body.data.roleId, 64) : existing.role_id;
      const nextIsActive = body.data.isActive !== undefined ? (body.data.isActive ? 1 : 0) : existing.is_active;
      const nextLabel =
        body.data.displayLabel !== undefined ? sanitizeText(body.data.displayLabel, 80) : existing.display_label;

      const targetRole = await env.DB.prepare('SELECT id, code FROM admin_roles WHERE id = ?')
        .bind(nextRoleId)
        .first<{ id: string; code: string }>();
      if (!targetRole) return json({ error: 'Target admin role not found.' }, 404);
      if (
        !admin.isOwner &&
        (targetRole.code === 'OWNER' || targetRole.id === 'role_owner' || (await roleHasOwnerOnlyPermissionsEdge(env.DB, nextRoleId)))
      ) {
        return json({ error: 'Only a Platform Owner can assign OWNER-level roles.' }, 403);
      }

      await env.DB.prepare(
        `UPDATE admin_role_assignments
         SET role_id = ?, is_active = ?, display_label = ?, assigned_by = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(nextRoleId, nextIsActive, nextLabel, admin.adminIdentifier, assignId)
        .run();

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'rbac.assignment_updated',
        'admin_role_assignment',
        assignId,
        { telegramId: existing.telegram_id, roleCode: targetRole.code, isActive: Boolean(nextIsActive) },
        ip
      );
      return json({ updated: true });
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM admin_role_assignments WHERE id = ?').bind(assignId).run();
      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'rbac.assignment_revoked',
        'admin_role_assignment',
        assignId,
        { telegramId: existing.telegram_id, roleCode: existing.role_code },
        ip
      );
      return json({ deleted: true });
    }

    return methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (sub === '/audit-logs') {
    if (request.method === 'GET') {
      const auth = await requireEdgeAdmin(request, env, 'audit.view');
      if ('error' in auth) return auth.error;
      const scope = String(url.searchParams.get('scope') || 'active').toLowerCase();
      const q = sanitizeText(url.searchParams.get('q') || '', 120).toLowerCase();

      const where: string[] = [];
      const params: unknown[] = [];
      if (scope === 'archived') {
        where.push('a.is_archived = 1');
      } else if (scope === 'active') {
        where.push('a.is_archived = 0');
      }
      if (q) {
        where.push(
          '(LOWER(a.admin_identifier) LIKE ? OR LOWER(a.action) LIKE ? OR LOWER(a.target_type) LIKE ? OR LOWER(a.target_id) LIKE ? OR LOWER(a.details_json) LIKE ?)'
        );
        const pat = `%${q}%`;
        params.push(pat, pat, pat, pat, pat);
      }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const [logs, summaryRow, retRow] = await Promise.all([
        env.DB.prepare(
          `SELECT a.*, COALESCE(NULLIF(a.archived_by, ''), arch.archived_by, '') as archive_actor,
                  COALESCE(arch.reason, '') as archive_reason
           FROM admin_audit_logs a
           LEFT JOIN admin_audit_log_archives arch ON arch.log_id = a.id
           ${whereClause}
           ORDER BY a.created_at DESC LIMIT 200`
        )
          .bind(...params)
          .all<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT
             SUM(CASE WHEN is_archived = 0 THEN 1 ELSE 0 END) as active_count,
             SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived_count,
             SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END) as protected_count
           FROM admin_audit_logs`
        ).first<{ active_count: number; archived_count: number; protected_count: number }>(),
        env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'audit_retention_days'").first<{ value: string }>(),
      ]);

      const retentionDays = Math.min(3650, Math.max(7, Math.floor(Number(retRow?.value || 90)) || 90));
      return json({
        logs: logs.results.map((r) => ({
          ...r,
          is_protected: Number(r.is_protected || 0) === 1 || isAuditActionProtected(String(r.action || '')) ? 1 : 0,
        })),
        retentionDays,
        summary: {
          activeCount: Number(summaryRow?.active_count || 0),
          archivedCount: Number(summaryRow?.archived_count || 0),
          protectedCount: Number(summaryRow?.protected_count || 0),
        },
      });
    }

    if (request.method === 'DELETE') {
      const auth = await requireEdgeAdmin(request, env, 'audit.manage');
      if ('error' in auth) return auth.error;
      const admin = auth.admin;
      const bodyData = await parseOptionalJsonBody(request);
      const ids = Array.isArray(bodyData.ids)
        ? bodyData.ids.map((id) => sanitizeText(String(id || ''), 80)).filter(Boolean)
        : [];
      const scope = String(bodyData.scope || 'eligible').toLowerCase();

      const retRow = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'audit_retention_days'").first<{
        value: string;
      }>();
      const defaultRetention = Math.min(3650, Math.max(7, Math.floor(Number(retRow?.value || 90)) || 90));
      const olderThanDaysRaw = Number(bodyData.olderThanDays ?? defaultRetention);
      const olderThanDays = Number.isFinite(olderThanDaysRaw)
        ? Math.min(3650, Math.max(7, Math.floor(olderThanDaysRaw)))
        : defaultRetention;

      let candidates: Array<{ id: string; admin_identifier: string; action: string; is_protected: number }> = [];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        const res = await env.DB.prepare(
          `SELECT id, admin_identifier, action, is_protected FROM admin_audit_logs WHERE id IN (${placeholders})`
        )
          .bind(...ids)
          .all<{ id: string; admin_identifier: string; action: string; is_protected: number }>();
        candidates = res.results;
      } else if (scope === 'archived') {
        const res = await env.DB.prepare(
          'SELECT id, admin_identifier, action, is_protected FROM admin_audit_logs WHERE is_archived = 1'
        ).all<{ id: string; admin_identifier: string; action: string; is_protected: number }>();
        candidates = res.results;
      } else {
        const res = await env.DB.prepare(
          `SELECT id, admin_identifier, action, is_protected
           FROM admin_audit_logs
           WHERE datetime(created_at) <= datetime('now', '-' || ? || ' days')`
        )
          .bind(olderThanDays)
          .all<{ id: string; admin_identifier: string; action: string; is_protected: number }>();
        candidates = res.results;
      }

      const deletableIds: string[] = [];
      let skippedProtectedCount = 0;

      for (const row of candidates) {
        const act = String(row.action || '');
        const isProtectedRow = Number(row.is_protected || 0) === 1 || isAuditActionProtected(act);
        const isSelfSensitive =
          String(row.admin_identifier || '') === admin.adminIdentifier &&
          (act.startsWith('audit.') || act.startsWith('rbac.') || isProtectedRow);
        if (isProtectedRow || isSelfSensitive) {
          skippedProtectedCount++;
          continue;
        }
        deletableIds.push(row.id);
      }

      for (let i = 0; i < deletableIds.length; i += 40) {
        const chunk = deletableIds.slice(i, i + 40);
        const ph = chunk.map(() => '?').join(', ');
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM admin_audit_log_archives WHERE log_id IN (${ph})`).bind(...chunk),
          env.DB.prepare(`DELETE FROM admin_audit_logs WHERE id IN (${ph})`).bind(...chunk),
        ]);
      }

      await recordEdgeAdminAudit(
        env,
        admin.adminIdentifier,
        'audit.logs_deleted',
        'audit_logs',
        ids.length ? 'selected' : scope,
        {
          deletedCount: deletableIds.length,
          skippedProtectedCount,
          mode: ids.length ? 'ids' : scope,
          olderThanDays,
        },
        ip,
        true
      );

      return json({
        deletedCount: deletableIds.length,
        skippedProtectedCount,
      });
    }

    return methodNotAllowed(['GET', 'DELETE']);
  }

  if (sub === '/audit-logs/archive') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'audit.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const bodyData = await parseOptionalJsonBody(request);
    const ids = Array.isArray(bodyData.ids)
      ? bodyData.ids.map((id) => sanitizeText(String(id || ''), 80)).filter(Boolean)
      : [];
    const reason = sanitizeText(bodyData.reason || 'Archived per audit retention policy', 300);

    const retRow = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'audit_retention_days'").first<{
      value: string;
    }>();
    const defaultRetention = Math.min(3650, Math.max(7, Math.floor(Number(retRow?.value || 90)) || 90));
    const olderThanDaysRaw = Number(bodyData.olderThanDays ?? defaultRetention);
    const olderThanDays = Number.isFinite(olderThanDaysRaw)
      ? Math.min(3650, Math.max(7, Math.floor(olderThanDaysRaw)))
      : defaultRetention;

    let targetIds: string[] = [];
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(', ');
      const rows = await env.DB.prepare(
        `SELECT id FROM admin_audit_logs WHERE is_archived = 0 AND id IN (${ph})`
      )
        .bind(...ids)
        .all<{ id: string }>();
      targetIds = rows.results.map((r) => r.id);
    } else {
      const rows = await env.DB.prepare(
        `SELECT id FROM admin_audit_logs WHERE is_archived = 0 AND datetime(created_at) <= datetime('now', '-' || ? || ' days')`
      )
        .bind(olderThanDays)
        .all<{ id: string }>();
      targetIds = rows.results.map((r) => r.id);
    }

    for (let i = 0; i < targetIds.length; i += 40) {
      const chunk = targetIds.slice(i, i + 40);
      const ph = chunk.map(() => '?').join(', ');
      await env.DB.prepare(
        `UPDATE admin_audit_logs
         SET is_archived = 1, archived_at = datetime('now'), archived_by = ?
         WHERE id IN (${ph})`
      )
        .bind(admin.adminIdentifier, ...chunk)
        .run();
      await env.DB.batch(
        chunk.map((logId) =>
          env.DB!.prepare(
            `INSERT OR REPLACE INTO admin_audit_log_archives (log_id, archived_by, reason, archived_at)
             VALUES (?, ?, ?, datetime('now'))`
          ).bind(logId, admin.adminIdentifier, reason)
        )
      );
    }

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'audit.logs_archived',
      'audit_logs',
      ids.length ? 'selected' : 'retention',
      {
        archivedCount: targetIds.length,
        mode: ids.length ? 'ids' : 'older_than_days',
        olderThanDays,
        reason,
      },
      ip,
      true
    );

    return json({ archivedCount: targetIds.length, olderThanDays });
  }

  if (sub.startsWith('/audit-logs/')) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeAdmin(request, env, 'audit.manage');
    if ('error' in auth) return auth.error;
    const admin = auth.admin;
    const logId = decodeURIComponent(sub.slice('/audit-logs/'.length));
    const row = await env.DB.prepare('SELECT id, admin_identifier, action, is_protected FROM admin_audit_logs WHERE id = ?')
      .bind(logId)
      .first<{ id: string; admin_identifier: string; action: string; is_protected: number }>();
    if (!row) return json({ error: 'Audit log entry not found.' }, 404);

    const act = String(row.action || '');
    const isProtectedRow = Number(row.is_protected || 0) === 1 || isAuditActionProtected(act);
    const isSelfSensitive =
      String(row.admin_identifier || '') === admin.adminIdentifier &&
      (act.startsWith('audit.') || act.startsWith('rbac.') || isProtectedRow);
    if (isProtectedRow || isSelfSensitive) {
      return json({ error: 'Protected audit and critical security logs cannot be deleted.' }, 403);
    }

    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_audit_log_archives WHERE log_id = ?').bind(logId),
      env.DB.prepare('DELETE FROM admin_audit_logs WHERE id = ?').bind(logId),
    ]);

    await recordEdgeAdminAudit(
      env,
      admin.adminIdentifier,
      'audit.logs_deleted',
      'audit_log',
      logId,
      { deletedCount: 1, deletedAction: act, mode: 'single' },
      ip,
      true
    );
    return json({ deleted: true, deletedCount: 1, id: logId });
  }

  if (sub === '/telegram/diagnostics') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeAdmin(request, env, 'settings.manage');
    if ('error' in auth) return auth.error;
    const diagnostics = await getTelegramBotLaunchDiagnosticsEdge(env, url.origin);
    return json(diagnostics);
  }

  if (sub === '/telegram/configure-launch') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeAdmin(request, env, 'settings.manage');
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody<{ miniAppUrl?: string; menuText?: string }>(request);
    if (!body.ok) return body.error;
    const targetUrl =
      (typeof body.data.miniAppUrl === 'string' && body.data.miniAppUrl.trim().startsWith('https://')
        ? body.data.miniAppUrl.trim()
        : '') || resolveSafeMiniAppUrlEdge(env, url.origin);
    const result = await ensureTelegramMenuButtonEdge(env, targetUrl, true);
    if (!result.ok) {
      return json({ error: result.error || 'Failed to update Telegram chat Menu Button.' }, 502);
    }
    const diagnostics = await getTelegramBotLaunchDiagnosticsEdge(env, url.origin);
    return json({ configured: true, targetUrl, diagnostics });
  }

  return json({ error: 'Admin API endpoint not found.' }, 404);
}
