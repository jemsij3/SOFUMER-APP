import {
  type Env,
  ADMIN_EXCLUSIVE_MODE_ERROR,
  escapeSqlLike,
  json,
  methodNotAllowed,
  newId,
  parseJsonBody,
  requireEdgeUser,
  sanitizeText,
} from './helpers.ts';

const PRODUCT_SELECT = `
  SELECT p.*,
         c.name as category_name, c.slug as category_slug,
         sc.name as subcategory_name,
         s.name as shop_name, s.slug as shop_slug, s.logo_url as shop_logo,
         s.country_code as shop_country, s.verification_status as shop_verification_status,
         u.display_name as seller_name,
         co.name as country_name,
         COALESCE(
           (SELECT secure_url FROM product_media pm WHERE pm.product_id = p.id AND pm.media_type = 'image' ORDER BY pm.is_primary DESC, pm.sort_order ASC LIMIT 1),
           (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1)
         ) as primary_image,
         (SELECT COUNT(*) FROM product_media pm WHERE pm.product_id = p.id AND pm.media_type = 'video') as video_count,
         COALESCE(inv.stock_quantity, 1) as stock_quantity,
         COALESCE(inv.unlimited_digital, 0) as unlimited_digital,
         COALESCE(inv.availability_status, 'in_stock') as availability_status,
         EXISTS(SELECT 1 FROM product_digital_assets pda WHERE pda.product_id = p.id) as has_digital_package
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN shops s ON s.id = p.shop_id
  JOIN users u ON u.id = p.seller_user_id
  JOIN countries co ON co.code = p.country_code
  LEFT JOIN product_inventory inv ON inv.product_id = p.id
`;

export async function handleMarketplaceRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/marketplace/')) return null;
  if (!env.DB) return json({ error: 'Database binding (DB) is not configured.' }, 503);

  const auth = await requireEdgeUser(request, env);
  if ('error' in auth) return auth.error;
  const authUser = auth.user;

  const sub = url.pathname.slice('/api/marketplace'.length);

  if (sub === '/bootstrap') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const [categories, subcategories, countries, currencies, plans, announcementRow, regEnabled] =
      await Promise.all([
        env.DB.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC').all(),
        env.DB.prepare('SELECT * FROM subcategories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC').all(),
        env.DB.prepare('SELECT * FROM countries WHERE is_enabled = 1 ORDER BY name ASC').all(),
        env.DB.prepare('SELECT * FROM currencies WHERE is_active = 1 ORDER BY code ASC').all(),
        env.DB.prepare(
          `SELECT sp.*,
                  COALESCE(sps.stars_monthly, CASE sp.code WHEN 'PRO' THEN 1450 WHEN 'BUSINESS' THEN 4450 ELSE 0 END) as stars_monthly,
                  COALESCE(sps.stars_annual, CASE sp.code WHEN 'PRO' THEN 14500 WHEN 'BUSINESS' THEN 44500 ELSE 0 END) as stars_annual
           FROM subscription_plans sp
           LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
           WHERE sp.is_active = 1
           ORDER BY sp.monthly_price ASC`
        ).all(),
        env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'marketplace_announcement'").first<{ value: string }>(),
        env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'seller_registration_enabled'").first<{ value: string }>(),
      ]);
    return json({
      categories: categories.results,
      subcategories: subcategories.results,
      countries: countries.results,
      currencies: currencies.results,
      plans: plans.results,
      announcement: announcementRow?.value || '',
      sellerRegistrationEnabled: regEnabled?.value !== 'false',
    });
  }

  if (authUser.isAdmin) {
    return json(
      {
        error: ADMIN_EXCLUSIVE_MODE_ERROR,
        code: 'ADMIN_MODE_EXCLUSIVE',
      },
      403
    );
  }

  if (sub === '/home') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);

    const [featuredProducts, trendingProducts, newArrivals, featuredShops, activePromotions, totalRow] =
      await Promise.all([
        env.DB.prepare(
          `${PRODUCT_SELECT}
           WHERE p.status = 'published' AND s.status = 'active' AND (p.is_featured = 1 OR p.is_sponsored = 1)
           ORDER BY p.is_sponsored DESC, p.updated_at DESC LIMIT 8`
        ).all(),
        env.DB.prepare(
          `${PRODUCT_SELECT}
           WHERE p.status = 'published' AND s.status = 'active'
           ORDER BY (p.view_count + p.favorite_count * 3 + p.inquiry_count * 5) DESC, p.created_at DESC LIMIT 8`
        ).all(),
        env.DB.prepare(
          `${PRODUCT_SELECT}
           WHERE p.status = 'published' AND s.status = 'active'
           ORDER BY p.created_at DESC LIMIT 8`
        ).all(),
        env.DB.prepare(
          `SELECT s.*, co.name as country_name,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as product_count
           FROM shops s JOIN countries co ON co.code = s.country_code
           WHERE s.status = 'active'
           ORDER BY s.is_featured DESC, s.verification_status = 'verified' DESC, product_count DESC LIMIT 6`
        ).all(),
        env.DB.prepare(
          `SELECT pr.*, s.name as shop_name, s.slug as shop_slug, p.title as product_title
           FROM promotions pr JOIN shops s ON s.id = pr.shop_id
           LEFT JOIN products p ON p.id = pr.product_id
           WHERE pr.status = 'active' AND s.status = 'active' ORDER BY pr.created_at DESC LIMIT 5`
        ).all(),
        env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.status = 'published' AND s.status = 'active'"
        ).first<{ cnt: number }>(),
      ]);

    let recentlyViewed: unknown[] = [];
    if (authUser) {
      const rv = await env.DB.prepare(
        `${PRODUCT_SELECT}
         JOIN recently_viewed rv ON rv.product_id = p.id
         WHERE rv.user_id = ? AND p.status = 'published' AND s.status = 'active'
         ORDER BY rv.viewed_at DESC LIMIT 6`
      )
        .bind(authUser.id)
        .all();
      recentlyViewed = rv.results;
    }

    return json({
      featuredProducts: featuredProducts.results,
      trendingProducts: trendingProducts.results,
      newArrivals: newArrivals.results,
      featuredShops: featuredShops.results,
      activePromotions: activePromotions.results,
      recentlyViewed,
      totalPublished: totalRow?.cnt || 0,
    });
  }

  if (sub === '/explore') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const q = sanitizeText(url.searchParams.get('q') || '', 120);
    const qEscaped = q ? escapeSqlLike(q) : '';
    const mode = String(url.searchParams.get('mode') || 'products');
    const categoryId = sanitizeText(url.searchParams.get('categoryId') || '', 64);
    const subcategoryId = sanitizeText(url.searchParams.get('subcategoryId') || '', 64);
    const country = sanitizeText(url.searchParams.get('country') || '', 8);
    const listingType = sanitizeText(url.searchParams.get('listingType') || '', 24);
    const condition = sanitizeText(url.searchParams.get('condition') || '', 24);
    const minPriceRaw = url.searchParams.get('minPrice');
    const maxPriceRaw = url.searchParams.get('maxPrice');
    const minPrice = minPriceRaw !== null && minPriceRaw !== '' ? Number(minPriceRaw) : null;
    const maxPrice = maxPriceRaw !== null && maxPriceRaw !== '' ? Number(maxPriceRaw) : null;
    const sort = String(url.searchParams.get('sort') || 'newest');

    if (mode === 'shops') {
      const conditions: string[] = ["s.status = 'active'"];
      const params: unknown[] = [];
      if (qEscaped) {
        conditions.push("(s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')");
        params.push(`%${qEscaped}%`, `%${qEscaped}%`);
      }
      if (country) {
        conditions.push('s.country_code = ?');
        params.push(country);
      }
      const shops = await env.DB.prepare(
        `SELECT s.*, co.name as country_name,
                (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as product_count
         FROM shops s JOIN countries co ON co.code = s.country_code
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.is_featured DESC, s.created_at DESC LIMIT 60`
      )
        .bind(...params)
        .all();
      return json({ mode: 'shops', items: shops.results });
    }

    const conditions: string[] = ["p.status = 'published'", "s.status = 'active'"];
    const params: unknown[] = [];
    if (mode === 'services') {
      conditions.push("p.listing_type = 'service'");
    } else if (listingType && ['physical', 'digital', 'service'].includes(listingType)) {
      conditions.push('p.listing_type = ?');
      params.push(listingType);
    }
    if (qEscaped) {
      conditions.push(
        "(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.keywords LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')"
      );
      params.push(`%${qEscaped}%`, `%${qEscaped}%`, `%${qEscaped}%`, `%${qEscaped}%`);
    }
    if (categoryId) {
      conditions.push('p.category_id = ?');
      params.push(categoryId);
    }
    if (subcategoryId) {
      conditions.push('p.subcategory_id = ?');
      params.push(subcategoryId);
    }
    if (country) {
      conditions.push('p.country_code = ?');
      params.push(country);
    }
    if (condition && ['new', 'like_new', 'used', 'refurbished'].includes(condition)) {
      conditions.push('p.condition = ?');
      params.push(condition);
    }
    if (minPrice !== null && Number.isFinite(minPrice) && minPrice >= 0) {
      conditions.push('p.price >= ?');
      params.push(minPrice);
    }
    if (maxPrice !== null && Number.isFinite(maxPrice) && maxPrice >= 0) {
      conditions.push('p.price <= ?');
      params.push(maxPrice);
    }

    let orderBy = 'p.is_sponsored DESC, p.created_at DESC';
    if (sort === 'price_asc') orderBy = 'p.price ASC, p.created_at DESC';
    else if (sort === 'price_desc') orderBy = 'p.price DESC, p.created_at DESC';
    else if (sort === 'popular') orderBy = '(p.view_count + p.favorite_count * 3 + p.inquiry_count * 5) DESC';

    const products = await env.DB.prepare(
      `${PRODUCT_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT 80`
    )
      .bind(...params)
      .all();

    return json({ mode, items: products.results });
  }

  if (sub.startsWith('/products/')) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const id = decodeURIComponent(sub.slice('/products/'.length));
    const product = await env.DB.prepare(
      `${PRODUCT_SELECT} WHERE p.id = ? AND ((p.status = 'published' AND s.status = 'active') OR (p.seller_user_id = ? AND s.status != 'closed'))`
    )
      .bind(id, authUser.id)
      .first<Record<string, unknown>>();

    if (!product) return json({ error: 'Listing not found or unavailable.' }, 404);

    if (product.status === 'published') {
      await env.DB.prepare('UPDATE products SET view_count = view_count + 1 WHERE id = ?')
        .bind(product.id)
        .run();
      await env.DB.prepare(
        `INSERT INTO recently_viewed (id, user_id, product_id, viewed_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, product_id) DO UPDATE SET viewed_at = datetime('now')`
      )
        .bind(newId('rv'), authUser.id, product.id)
        .run();
    }

    const [images, mediaRows, variants, reviews, shop] = await Promise.all([
      env.DB.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC')
        .bind(product.id)
        .all(),
      env.DB.prepare(
        `SELECT * FROM product_media WHERE product_id = ?
         ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
      )
        .bind(product.id)
        .all<Record<string, unknown>>(),
      env.DB.prepare('SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1')
        .bind(product.id)
        .all(),
      env.DB.prepare(
        `SELECT r.*, u.display_name as reviewer_name, u.avatar_url as reviewer_avatar
         FROM reviews r JOIN users u ON u.id = r.reviewer_user_id
         WHERE r.product_id = ? AND r.status = 'published' ORDER BY r.created_at DESC`
      )
        .bind(product.id)
        .all(),
      env.DB.prepare(
        `SELECT s.*, co.name as country_name FROM shops s JOIN countries co ON co.code = s.country_code WHERE s.id = ?`
      )
        .bind(product.shop_id)
        .first(),
    ]);

    const normalizedMedia =
      mediaRows.results.length > 0
        ? mediaRows.results
        : (images.results as Array<Record<string, unknown>>).map((img, idx) => ({
            id: img.id,
            product_id: img.product_id,
            storage_provider: 'legacy_url',
            media_type: 'image',
            resource_type: 'image',
            public_id: '',
            secure_url: img.url,
            format: '',
            bytes: 0,
            width: 0,
            height: 0,
            duration: null,
            sort_order: idx,
            is_primary: img.is_primary ?? (idx === 0 ? 1 : 0),
            alt_text: img.alt_text || '',
          }));

    return json({
      product,
      images: images.results,
      media: normalizedMedia,
      videos: normalizedMedia.filter((m) => m.media_type === 'video'),
      variants: variants.results,
      reviews: reviews.results,
      shop,
    });
  }

  if (sub.startsWith('/shops/')) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const slug = decodeURIComponent(sub.slice('/shops/'.length));
    const shop = await env.DB.prepare(
      `SELECT s.*, co.name as country_name, u.display_name as owner_name
       FROM shops s JOIN countries co ON co.code = s.country_code JOIN users u ON u.id = s.user_id
       WHERE s.slug = ? AND s.status = 'active'`
    )
      .bind(slug)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

    const [products, reviews] = await Promise.all([
      env.DB.prepare(
        `${PRODUCT_SELECT} WHERE p.shop_id = ? AND p.status = 'published' ORDER BY p.is_featured DESC, p.created_at DESC`
      )
        .bind(shop.id)
        .all(),
      env.DB.prepare(
        `SELECT r.*, u.display_name as reviewer_name, p.title as product_title
         FROM reviews r JOIN users u ON u.id = r.reviewer_user_id JOIN products p ON p.id = r.product_id
         WHERE r.shop_id = ? AND r.status = 'published' ORDER BY r.created_at DESC`
      )
        .bind(shop.id)
        .all(),
    ]);

    return json({ shop, products: products.results, reviews: reviews.results });
  }

  if (sub === '/favorites') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const items = await env.DB.prepare(
      `${PRODUCT_SELECT} JOIN product_favorites f ON f.product_id = p.id
       WHERE f.user_id = ? AND p.status = 'published' AND s.status = 'active' ORDER BY f.created_at DESC`
    )
      .bind(auth.user.id)
      .all();
    return json({ items: items.results });
  }

  if (sub.startsWith('/favorites/')) {
    const productId = decodeURIComponent(sub.slice('/favorites/'.length));
    if (request.method === 'DELETE') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const existing = await env.DB.prepare(
        'SELECT id FROM product_favorites WHERE user_id = ? AND product_id = ?'
      )
        .bind(auth.user.id, productId)
        .first<{ id: string }>();
      if (existing) {
        await env.DB.prepare('DELETE FROM product_favorites WHERE id = ?').bind(existing.id).run();
        await env.DB.prepare('UPDATE products SET favorite_count = MAX(0, favorite_count - 1) WHERE id = ?')
          .bind(productId)
          .run();
      }
      return json({ favorited: false, removed: true });
    }
    if (request.method !== 'POST') return methodNotAllowed(['POST', 'DELETE']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const prod = await env.DB.prepare(
      "SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ? AND p.status = 'published' AND s.status = 'active'"
    )
      .bind(productId)
      .first();
    if (!prod) return json({ error: 'Listing not found.' }, 404);

    const existing = await env.DB.prepare(
      'SELECT id FROM product_favorites WHERE user_id = ? AND product_id = ?'
    )
      .bind(auth.user.id, productId)
      .first<{ id: string }>();

    if (existing) {
      await env.DB.prepare('DELETE FROM product_favorites WHERE id = ?').bind(existing.id).run();
      await env.DB.prepare('UPDATE products SET favorite_count = MAX(0, favorite_count - 1) WHERE id = ?')
        .bind(productId)
        .run();
      return json({ favorited: false });
    } else {
      await env.DB.prepare('INSERT INTO product_favorites (id, user_id, product_id) VALUES (?, ?, ?)')
        .bind(newId('fav'), auth.user.id, productId)
        .run();
      await env.DB.prepare('UPDATE products SET favorite_count = favorite_count + 1 WHERE id = ?')
        .bind(productId)
        .run();
      return json({ favorited: true });
    }
  }

  if (sub === '/recently-viewed') {
    if (request.method === 'DELETE') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const res = await env.DB.prepare('DELETE FROM recently_viewed WHERE user_id = ?')
        .bind(auth.user.id)
        .run();
      return json({ cleared: true, deletedCount: res.meta?.changes ?? 0 });
    }
    if (request.method !== 'GET') return methodNotAllowed(['GET', 'DELETE']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const items = await env.DB.prepare(
      `${PRODUCT_SELECT} JOIN recently_viewed rv ON rv.product_id = p.id
       WHERE rv.user_id = ? AND p.status = 'published' AND s.status = 'active' ORDER BY rv.viewed_at DESC LIMIT 24`
    )
      .bind(auth.user.id)
      .all();
    return json({ items: items.results });
  }

  if (sub.startsWith('/recently-viewed/')) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const productId = decodeURIComponent(sub.slice('/recently-viewed/'.length));
    await env.DB.prepare('DELETE FROM recently_viewed WHERE user_id = ? AND product_id = ?')
      .bind(auth.user.id, productId)
      .run();
    return json({ removed: true });
  }

  if (sub === '/reports') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const targetType = String(body.data.targetType || '');
    const targetId = sanitizeText(body.data.targetId || '', 64);
    const reason = sanitizeText(body.data.reason || '', 120);
    const details = sanitizeText(body.data.details || '', 1000);

    if (!['product', 'shop', 'user', 'message', 'review'].includes(targetType) || !targetId || !reason) {
      return json({ error: 'Valid target type, target ID, and reason are required.' }, 400);
    }

    const reportId = newId('rep');
    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(reportId, auth.user.id, targetType, targetId, reason, details)
      .run();

    if (targetType === 'message') {
      await env.DB.prepare("UPDATE conversations SET status = 'flagged' WHERE id = ?")
        .bind(targetId)
        .run();
    }

    return json({ reportId, status: 'open' }, 201);
  }

  return json({ error: 'Marketplace API endpoint not found.' }, 404);
}
