import { Router } from 'express';
import { db, newId } from '../db.ts';
import { escapeSqlLike, requireAuth, sanitizeText } from '../security.ts';

export const marketplaceRouter = Router();
marketplaceRouter.use(requireAuth);

const PRODUCT_SELECT = `
  SELECT p.*,
         c.name as category_name, c.slug as category_slug,
         sc.name as subcategory_name,
         s.name as shop_name, s.slug as shop_slug, s.logo_url as shop_logo,
         s.country_code as shop_country, s.verification_status as shop_verification_status,
         u.display_name as seller_name,
         co.name as country_name,
         (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) as primary_image,
         COALESCE(inv.stock_quantity, 1) as stock_quantity,
         COALESCE(inv.unlimited_digital, 0) as unlimited_digital,
         COALESCE(inv.availability_status, 'in_stock') as availability_status,
         EXISTS(SELECT 1 FROM product_digital_assets da WHERE da.product_id = p.id) as has_digital_package
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN shops s ON s.id = p.shop_id
  JOIN users u ON u.id = p.seller_user_id
  JOIN countries co ON co.code = p.country_code
  LEFT JOIN product_inventory inv ON inv.product_id = p.id
`;

marketplaceRouter.get('/bootstrap', (_req, res) => {
  const categories = db
    .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC')
    .all();
  const subcategories = db
    .prepare('SELECT * FROM subcategories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC')
    .all();
  const countries = db
    .prepare('SELECT * FROM countries WHERE is_enabled = 1 ORDER BY name ASC')
    .all();
  const currencies = db
    .prepare('SELECT * FROM currencies WHERE is_active = 1 ORDER BY code ASC')
    .all();
  const plans = db
    .prepare(
      `SELECT sp.*, COALESCE(sps.stars_monthly, 0) as stars_monthly, COALESCE(sps.stars_annual, 0) as stars_annual
       FROM subscription_plans sp
       LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
       WHERE sp.is_active = 1
       ORDER BY sp.monthly_price ASC`
    )
    .all();
  const announcementRow = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'marketplace_announcement'")
    .get() as { value: string } | undefined;
  const regEnabled = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'seller_registration_enabled'")
    .get() as { value: string } | undefined;

  res.json({
    categories,
    subcategories,
    countries,
    currencies,
    plans,
    announcement: announcementRow?.value || '',
    sellerRegistrationEnabled: regEnabled?.value !== 'false',
  });
});

marketplaceRouter.get('/home', (req, res) => {
  const featuredProducts = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.status = 'published' AND s.status = 'active' AND (p.is_featured = 1 OR p.is_sponsored = 1)
       ORDER BY p.is_sponsored DESC, p.updated_at DESC
       LIMIT 8`
    )
    .all();

  const trendingProducts = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.status = 'published' AND s.status = 'active'
       ORDER BY (p.view_count + p.favorite_count * 3 + p.inquiry_count * 5) DESC, p.created_at DESC
       LIMIT 8`
    )
    .all();

  const newArrivals = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.status = 'published' AND s.status = 'active'
       ORDER BY p.created_at DESC
       LIMIT 8`
    )
    .all();

  const featuredShops = db
    .prepare(
      `SELECT s.*, co.name as country_name,
              (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as product_count
       FROM shops s
       JOIN countries co ON co.code = s.country_code
       WHERE s.status = 'active'
       ORDER BY s.is_featured DESC, s.verification_status = 'verified' DESC, product_count DESC
       LIMIT 6`
    )
    .all();

  const activePromotions = db
    .prepare(
      `SELECT pr.*, s.name as shop_name, s.slug as shop_slug, p.title as product_title
       FROM promotions pr
       JOIN shops s ON s.id = pr.shop_id
       LEFT JOIN products p ON p.id = pr.product_id
       WHERE pr.status = 'active'
       ORDER BY pr.created_at DESC
       LIMIT 5`
    )
    .all();

  let recentlyViewed: unknown[] = [];
  if (req.authUser) {
    recentlyViewed = db
      .prepare(
        `${PRODUCT_SELECT}
         JOIN recently_viewed rv ON rv.product_id = p.id
         WHERE rv.user_id = ? AND p.status = 'published' AND s.status = 'active'
         ORDER BY rv.viewed_at DESC
         LIMIT 6`
      )
      .all(req.authUser.id);
  }

  const totalPublished = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.status = 'published' AND s.status = 'active'"
      )
      .get() as { cnt: number }
  ).cnt;

  res.json({
    featuredProducts,
    trendingProducts,
    newArrivals,
    featuredShops,
    activePromotions,
    recentlyViewed,
    totalPublished,
  });
});

marketplaceRouter.get('/explore', (req, res) => {
  const q = sanitizeText(req.query.q || '', 120);
  const mode = String(req.query.mode || 'products');
  const categoryId = sanitizeText(req.query.categoryId || '', 64);
  const subcategoryId = sanitizeText(req.query.subcategoryId || '', 64);
  const country = sanitizeText(req.query.country || '', 8);
  const listingType = sanitizeText(req.query.listingType || '', 24);
  const condition = sanitizeText(req.query.condition || '', 24);
  const minPrice = req.query.minPrice !== undefined && req.query.minPrice !== '' ? Number(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice !== undefined && req.query.maxPrice !== '' ? Number(req.query.maxPrice) : null;
  const sort = String(req.query.sort || 'newest');

  if (mode === 'shops') {
    const conditions: string[] = ["s.status = 'active'"];
    const params: unknown[] = [];
    if (q) {
      const escapedQ = escapeSqlLike(q);
      conditions.push("(s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')");
      params.push(`%${escapedQ}%`, `%${escapedQ}%`);
    }
    if (country) {
      conditions.push('s.country_code = ?');
      params.push(country);
    }
    const shops = db
      .prepare(
        `SELECT s.*, co.name as country_name,
                (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as product_count
         FROM shops s
         JOIN countries co ON co.code = s.country_code
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.is_featured DESC, s.created_at DESC
         LIMIT 60`
      )
      .all(...params);
    return res.json({ mode: 'shops', items: shops });
  }

  const conditions: string[] = ["p.status = 'published'", "s.status = 'active'"];
  const params: unknown[] = [];

  if (mode === 'services') {
    conditions.push("p.listing_type = 'service'");
  } else if (listingType && ['physical', 'digital', 'service'].includes(listingType)) {
    conditions.push('p.listing_type = ?');
    params.push(listingType);
  }

  if (q) {
    const escapedQ = escapeSqlLike(q);
    conditions.push(
      "(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.keywords LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')"
    );
    params.push(`%${escapedQ}%`, `%${escapedQ}%`, `%${escapedQ}%`, `%${escapedQ}%`);
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
  if (minPrice !== null) {
    if (!Number.isFinite(minPrice) || minPrice < 0) {
      return res.status(400).json({ error: 'minPrice must be a valid non-negative number.' });
    }
    conditions.push('p.price >= ?');
    params.push(minPrice);
  }
  if (maxPrice !== null) {
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      return res.status(400).json({ error: 'maxPrice must be a valid non-negative number.' });
    }
    conditions.push('p.price <= ?');
    params.push(maxPrice);
  }

  let orderBy = 'p.is_sponsored DESC, p.created_at DESC';
  if (sort === 'price_asc') orderBy = 'p.price ASC, p.created_at DESC';
  else if (sort === 'price_desc') orderBy = 'p.price DESC, p.created_at DESC';
  else if (sort === 'popular') orderBy = '(p.view_count + p.favorite_count * 3 + p.inquiry_count * 5) DESC';

  const products = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 80`
    )
    .all(...params);

  res.json({ mode, items: products });
});

marketplaceRouter.get('/products/:id', (req, res) => {
  const product = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.id = ? AND ((p.status = 'published' AND s.status = 'active') OR p.seller_user_id = ?)`
    )
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;

  if (!product) {
    return res.status(404).json({ error: 'Listing not found or unavailable.' });
  }

  if (product.status === 'published') {
    db.prepare('UPDATE products SET view_count = view_count + 1 WHERE id = ?').run(product.id);
    db.prepare(
      `INSERT INTO recently_viewed (id, user_id, product_id, viewed_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, product_id) DO UPDATE SET viewed_at = datetime('now')`
    ).run(newId('rv'), req.authUser!.id, product.id);
  }

  const images = db
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC')
    .all(product.id);

  const variants = db
    .prepare('SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1')
    .all(product.id);

  const reviews = db
    .prepare(
      `SELECT r.*, u.display_name as reviewer_name, u.avatar_url as reviewer_avatar
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       WHERE r.product_id = ? AND r.status = 'published'
       ORDER BY r.created_at DESC`
    )
    .all(product.id);

  const shop = db
    .prepare(
      `SELECT s.*, co.name as country_name
       FROM shops s
       JOIN countries co ON co.code = s.country_code
       WHERE s.id = ?`
    )
    .get(product.shop_id);

  res.json({ product, images, variants, reviews, shop });
});

marketplaceRouter.get('/shops/:slug', (req, res) => {
  const shop = db
    .prepare(
      `SELECT s.*, co.name as country_name, u.display_name as owner_name
       FROM shops s
       JOIN countries co ON co.code = s.country_code
       JOIN users u ON u.id = s.user_id
       WHERE s.slug = ? AND s.status = 'active'`
    )
    .get(req.params.slug) as Record<string, unknown> | undefined;

  if (!shop) {
    return res.status(404).json({ error: 'Shop not found.' });
  }

  const products = db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.shop_id = ? AND p.status = 'published'
       ORDER BY p.is_featured DESC, p.created_at DESC`
    )
    .all(shop.id);

  const reviews = db
    .prepare(
      `SELECT r.*, u.display_name as reviewer_name, p.title as product_title
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       JOIN products p ON p.id = r.product_id
       WHERE r.shop_id = ? AND r.status = 'published'
       ORDER BY r.created_at DESC`
    )
    .all(shop.id);

  res.json({ shop, products, reviews });
});

marketplaceRouter.post('/favorites/:productId', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const productId = req.params.productId;
  const prod = db
    .prepare(
      `SELECT p.id FROM products p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ? AND p.status = 'published' AND s.status = 'active'`
    )
    .get(productId);
  if (!prod) {
    return res.status(404).json({ error: 'Listing not found.' });
  }

  const existing = db
    .prepare('SELECT id FROM product_favorites WHERE user_id = ? AND product_id = ?')
    .get(userId, productId) as { id: string } | undefined;

  if (existing) {
    db.prepare('DELETE FROM product_favorites WHERE id = ?').run(existing.id);
    db.prepare('UPDATE products SET favorite_count = MAX(0, favorite_count - 1) WHERE id = ?').run(productId);
    return res.json({ favorited: false });
  } else {
    db.prepare('INSERT INTO product_favorites (id, user_id, product_id) VALUES (?, ?, ?)').run(
      newId('fav'),
      userId,
      productId
    );
    db.prepare('UPDATE products SET favorite_count = favorite_count + 1 WHERE id = ?').run(productId);
    return res.json({ favorited: true });
  }
});

marketplaceRouter.get('/favorites', requireAuth, (req, res) => {
  const items = db
    .prepare(
      `${PRODUCT_SELECT}
       JOIN product_favorites f ON f.product_id = p.id
       WHERE f.user_id = ? AND p.status = 'published' AND s.status = 'active'
       ORDER BY f.created_at DESC`
    )
    .all(req.authUser!.id);
  res.json({ items });
});

marketplaceRouter.get('/recently-viewed', requireAuth, (req, res) => {
  const items = db
    .prepare(
      `${PRODUCT_SELECT}
       JOIN recently_viewed rv ON rv.product_id = p.id
       WHERE rv.user_id = ? AND p.status = 'published' AND s.status = 'active'
       ORDER BY rv.viewed_at DESC
       LIMIT 24`
    )
    .all(req.authUser!.id);
  res.json({ items });
});

marketplaceRouter.post('/reports', requireAuth, (req, res) => {
  const targetType = String(req.body?.targetType || '');
  const targetId = sanitizeText(req.body?.targetId || '', 64);
  const reason = sanitizeText(req.body?.reason || '', 120);
  const details = sanitizeText(req.body?.details || '', 1000);

  if (!['product', 'shop', 'user', 'message', 'review'].includes(targetType) || !targetId || !reason) {
    return res.status(400).json({ error: 'Valid target type, target ID, and reason are required.' });
  }

  const reportId = newId('rep');
  db.prepare(
    `INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(reportId, req.authUser!.id, targetType, targetId, reason, details);

  if (targetType === 'message') {
    db.prepare("UPDATE conversations SET status = 'flagged' WHERE id = ?").run(targetId);
  }

  res.status(201).json({ reportId, status: 'open' });
});
