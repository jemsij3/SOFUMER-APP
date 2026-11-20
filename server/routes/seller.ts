import { Router } from 'express';
import { db, newId, slugify } from '../db.ts';
import {
  checkProhibitedKeywords,
  requireAuth,
  requireSeller,
  sanitizeText,
} from '../security.ts';
import { notifyUserAndTelegram } from '../telegram.ts';

export const sellerRouter = Router();

sellerRouter.post('/register', requireAuth, (req, res) => {
  const regSetting = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'seller_registration_enabled'")
    .get() as { value: string } | undefined;
  if (regSetting?.value === 'false') {
    return res.status(403).json({ error: 'Seller registration is currently paused by administrators.' });
  }

  const user = req.authUser!;
  const existing = db
    .prepare('SELECT id FROM seller_profiles WHERE user_id = ?')
    .get(user.id);
  if (existing) {
    return res.status(409).json({ error: 'You already have a registered seller profile.' });
  }

  const sellerType = req.body?.sellerType === 'business' ? 'business' : 'individual';
  const legalName = sanitizeText(req.body?.legalName || user.display_name, 100);
  const shopName = sanitizeText(req.body?.shopName || '', 80);
  const countryCode = sanitizeText(req.body?.countryCode || user.country_code || 'US', 4).toUpperCase();
  const description = sanitizeText(req.body?.description || '', 1000);
  const contactEmail = sanitizeText(req.body?.contactEmail || '', 120);
  const contactPhone = sanitizeText(req.body?.contactPhone || '', 40);
  const contactTelegram = sanitizeText(req.body?.contactTelegram || user.telegram_username || '', 64);
  const businessRegistrationNo = sanitizeText(req.body?.businessRegistrationNo || '', 80);
  const logoUrl = sanitizeText(req.body?.logoUrl || '', 300);
  const bannerUrl = sanitizeText(req.body?.bannerUrl || '', 300);
  const defaultCurrency = sanitizeText(req.body?.defaultCurrency || 'USD', 6).toUpperCase();

  if (!legalName || !shopName) {
    return res.status(400).json({ error: 'Seller name and shop name are required.' });
  }

  const sellerId = newId('sel');
  const shopId = newId('shop');
  const baseSlug = slugify(shopName);
  const slugConflict = db.prepare('SELECT id FROM shops WHERE slug = ?').get(baseSlug);
  const shopSlug = slugConflict ? `${baseSlug}-${shopId.slice(-5)}` : baseSlug;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO seller_profiles (id, user_id, seller_type, legal_name, business_registration_no, country_code, contact_email, contact_phone, contact_telegram)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sellerId,
      user.id,
      sellerType,
      legalName,
      businessRegistrationNo,
      countryCode,
      contactEmail,
      contactPhone,
      contactTelegram
    );

    db.prepare(
      `INSERT INTO shops (id, seller_id, user_id, slug, name, description, country_code, logo_url, banner_url, default_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      shopId,
      sellerId,
      user.id,
      shopSlug,
      shopName,
      description,
      countryCode,
      logoUrl,
      bannerUrl,
      defaultCurrency
    );

    db.prepare(
      `INSERT OR IGNORE INTO user_roles (id, user_id, role, granted_by) VALUES (?, ?, 'seller', 'seller_registration')`
    ).run(newId('role'), user.id);

    // Assign default FREE subscription plan
    db.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status)
       VALUES (?, ?, ?, 'plan_free', 'monthly', 0, 'USD', 'active')`
    ).run(newId('sub'), sellerId, user.id);
  });

  tx();

  const sellerProfile = db.prepare('SELECT * FROM seller_profiles WHERE id = ?').get(sellerId);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);

  res.status(201).json({ sellerProfile, shop });
});

sellerRouter.get('/dashboard', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const sellerProfile = db
    .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .get(userId) as Record<string, unknown>;
  const shop = db
    .prepare('SELECT * FROM shops WHERE seller_id = ?')
    .get(sellerProfile.id) as Record<string, unknown>;

  const subscription = db
    .prepare(
      `SELECT s.*, sp.code as plan_code, sp.name as plan_name, sp.max_products, sp.ai_daily_limit,
              sp.featured_slots, sp.promotional_discount_pct, sp.analytics_level
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.seller_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(sellerProfile.id);

  const stats = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE shop_id = ?) as total_products,
         (SELECT COUNT(*) FROM products WHERE shop_id = ? AND status = 'published') as published_products,
         (SELECT COUNT(*) FROM products WHERE shop_id = ? AND status = 'draft') as draft_products,
         (SELECT COALESCE(SUM(view_count), 0) FROM products WHERE shop_id = ?) as total_views,
         (SELECT COALESCE(SUM(favorite_count), 0) FROM products WHERE shop_id = ?) as total_favorites,
         (SELECT COUNT(*) FROM inquiries WHERE shop_id = ?) as total_inquiries,
         (SELECT COUNT(*) FROM orders WHERE shop_id = ?) as total_orders,
         (SELECT COUNT(*) FROM orders WHERE shop_id = ? AND status IN ('Pending Confirmation', 'Confirmed', 'Processing', 'Shipped')) as active_orders`
    )
    .get(shop.id, shop.id, shop.id, shop.id, shop.id, shop.id, shop.id, shop.id);

  const promotions = db
    .prepare(
      `SELECT pr.*, p.title as product_title
       FROM promotions pr
       LEFT JOIN products p ON p.id = pr.product_id
       WHERE pr.shop_id = ?
       ORDER BY pr.created_at DESC`
    )
    .all(shop.id);

  const verifications = db
    .prepare('SELECT * FROM shop_verifications WHERE shop_id = ? ORDER BY created_at DESC')
    .all(shop.id);

  res.json({ sellerProfile, shop, subscription, stats, promotions, verifications });
});

sellerRouter.patch('/shop', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(userId) as Record<string, unknown>;
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });

  const name = sanitizeText(req.body?.name ?? shop.name, 80);
  const description = sanitizeText(req.body?.description ?? shop.description, 1200);
  const logoUrl = sanitizeText(req.body?.logoUrl ?? shop.logo_url, 300);
  const bannerUrl = sanitizeText(req.body?.bannerUrl ?? shop.banner_url, 300);
  const returnPolicy = sanitizeText(req.body?.returnPolicy ?? shop.return_policy, 600);
  const shippingPolicy = sanitizeText(req.body?.shippingPolicy ?? shop.shipping_policy, 600);
  const defaultCurrency = sanitizeText(req.body?.defaultCurrency ?? shop.default_currency, 6).toUpperCase();
  const countryCode = sanitizeText(req.body?.countryCode ?? shop.country_code, 4).toUpperCase();

  db.prepare(
    `UPDATE shops
     SET name = ?, description = ?, logo_url = ?, banner_url = ?, return_policy = ?, shipping_policy = ?, default_currency = ?, country_code = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(name, description, logoUrl, bannerUrl, returnPolicy, shippingPolicy, defaultCurrency, countryCode, shop.id, userId);

  const updated = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
  res.json({ shop: updated });
});

sellerRouter.post('/verification', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const seller = db.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').get(userId) as Record<string, unknown>;
  const shop = db.prepare('SELECT * FROM shops WHERE seller_id = ?').get(seller.id) as Record<string, unknown>;

  const documentType = sanitizeText(req.body?.documentType || '', 60);
  const documentReference = sanitizeText(req.body?.documentReference || '', 200);
  const notes = sanitizeText(req.body?.notes || '', 500);

  if (!documentType || !documentReference) {
    return res.status(400).json({ error: 'Document type and reference are required.' });
  }

  const verId = newId('ver');
  db.prepare(
    `INSERT INTO shop_verifications (id, shop_id, seller_id, document_type, document_reference, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(verId, shop.id, seller.id, documentType, documentReference, notes);

  db.prepare("UPDATE shops SET verification_status = 'pending' WHERE id = ?").run(shop.id);
  db.prepare("UPDATE seller_profiles SET verification_status = 'pending' WHERE id = ?").run(seller.id);

  res.status(201).json({ verificationId: verId, status: 'pending' });
});

sellerRouter.get('/products', requireSeller, (req, res) => {
  const products = db
    .prepare(
      `SELECT p.*, c.name as category_name,
              (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) as primary_image,
              COALESCE(inv.stock_quantity, 1) as stock_quantity,
              COALESCE(inv.availability_status, 'in_stock') as availability_status
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_inventory inv ON inv.product_id = p.id
       WHERE p.seller_user_id = ?
       ORDER BY p.updated_at DESC`
    )
    .all(req.authUser!.id);
  res.json({ products });
});

sellerRouter.post('/products', requireSeller, (req, res) => {
  const subSetting = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'product_submissions_enabled'")
    .get() as { value: string } | undefined;
  if (subSetting?.value === 'false') {
    return res.status(403).json({ error: 'New product submissions are temporarily paused by administrators.' });
  }

  const userId = req.authUser!.id;
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(userId) as Record<string, unknown>;
  if (!shop || shop.status !== 'active') {
    return res.status(403).json({ error: 'Active shop required to publish products.' });
  }

  // Enforce plan listing limits
  const sub = db
    .prepare(
      `SELECT sp.max_products FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(userId) as { max_products: number } | undefined;
  const maxProducts = sub?.max_products ?? 10;
  const currentCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM products WHERE shop_id = ? AND status != 'archived'").get(shop.id) as {
      cnt: number;
    }
  ).cnt;

  if (currentCount >= maxProducts) {
    return res.status(403).json({
      error: `Listing limit reached (${currentCount}/${maxProducts}). Upgrade your seller plan to publish more listings.`,
    });
  }

  const listingType = String(req.body?.listingType || 'physical');
  if (!['physical', 'digital', 'service'].includes(listingType)) {
    return res.status(400).json({ error: 'Invalid listing type.' });
  }

  const title = sanitizeText(req.body?.title || '', 140);
  const description = sanitizeText(req.body?.description || '', 4000);
  const categoryId = sanitizeText(req.body?.categoryId || '', 64);
  const subcategoryId = sanitizeText(req.body?.subcategoryId || '', 64) || null;
  const price = Number(req.body?.price ?? 0);
  const currency = sanitizeText(req.body?.currency || String(shop.default_currency || 'USD'), 6).toUpperCase();

  if (!title || !description || !categoryId || Number.isNaN(price) || price < 0) {
    return res.status(400).json({ error: 'Title, description, category, and valid price are required.' });
  }

  const catExists = db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
  if (!catExists) {
    return res.status(400).json({ error: 'Selected category does not exist.' });
  }

  // Prohibited keyword moderation check
  const flaggedWords = checkProhibitedKeywords(`${title} ${description}`);
  const autoApprove = (
    db.prepare("SELECT value FROM platform_settings WHERE key = 'auto_approve_products'").get() as
      | { value: string }
      | undefined
  )?.value !== 'false';

  let requestedStatus = req.body?.status === 'draft' ? 'draft' : 'published';
  let moderationNotes = '';
  if (requestedStatus === 'published') {
    if (flaggedWords.length > 0) {
      requestedStatus = 'pending_review';
      moderationNotes = `Flagged for manual moderation review (matched policy terms: ${flaggedWords.join(', ')}).`;
    } else if (!autoApprove) {
      requestedStatus = 'pending_review';
      moderationNotes = 'Queued for standard administrator approval.';
    }
  }

  const productId = newId('prod');
  const slug = `${slugify(title)}-${productId.slice(-5)}`;
  const condition =
    listingType === 'physical' && ['new', 'like_new', 'used', 'refurbished'].includes(String(req.body?.condition))
      ? String(req.body.condition)
      : listingType === 'physical'
      ? 'new'
      : 'not_applicable';

  const stockQuantity = Math.max(0, Math.floor(Number(req.body?.stockQuantity ?? 1)));
  const unlimitedDigital = listingType === 'digital' ? 1 : 0;
  const availabilityStatus =
    unlimitedDigital || stockQuantity > 3 ? 'in_stock' : stockQuantity > 0 ? 'low_stock' : 'out_of_stock';

  const images: string[] = Array.isArray(req.body?.images)
    ? req.body.images.map((u: unknown) => sanitizeText(u, 300)).filter(Boolean).slice(0, 6)
    : [];

  const faqsJson = Array.isArray(req.body?.faqs) ? JSON.stringify(req.body.faqs.slice(0, 8)) : '[]';

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO products (
        id, shop_id, seller_user_id, category_id, subcategory_id, listing_type,
        title, slug, description, price, currency, condition, country_code, location_text,
        shipping_info, international_shipping, file_format, digital_delivery_method, license_info,
        pricing_model, service_mode, delivery_timeframe, return_policy, keywords, faqs_json,
        status, moderation_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      productId,
      shop.id,
      userId,
      categoryId,
      subcategoryId,
      listingType,
      title,
      slug,
      description,
      price,
      currency,
      condition,
      sanitizeText(req.body?.countryCode || String(shop.country_code), 4).toUpperCase(),
      sanitizeText(req.body?.locationText || '', 120),
      sanitizeText(req.body?.shippingInfo || '', 500),
      req.body?.internationalShipping ? 1 : 0,
      sanitizeText(req.body?.fileFormat || '', 80),
      sanitizeText(req.body?.digitalDeliveryMethod || '', 200),
      sanitizeText(req.body?.licenseInfo || '', 300),
      sanitizeText(req.body?.pricingModel || 'fixed', 40),
      ['remote', 'onsite', 'hybrid'].includes(String(req.body?.serviceMode))
        ? String(req.body.serviceMode)
        : listingType === 'service'
        ? 'remote'
        : 'not_applicable',
      sanitizeText(req.body?.deliveryTimeframe || '', 120),
      sanitizeText(req.body?.returnPolicy || String(shop.return_policy || ''), 500),
      sanitizeText(req.body?.keywords || '', 300),
      faqsJson,
      requestedStatus,
      moderationNotes
    );

    db.prepare(
      `INSERT INTO product_inventory (id, product_id, stock_quantity, unlimited_digital, availability_status)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId('inv'), productId, stockQuantity, unlimitedDigital, availabilityStatus);

    images.forEach((url, idx) => {
      db.prepare(
        `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(newId('img'), productId, url, title, idx, idx === 0 ? 1 : 0);
    });
  });

  tx();

  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  res.status(201).json({ product: created, moderationNotes });
});

sellerRouter.patch('/products/:id', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const existing = db
    .prepare('SELECT * FROM products WHERE id = ? AND seller_user_id = ?')
    .get(req.params.id, userId) as Record<string, unknown> | undefined;

  if (!existing) {
    return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  }

  const title = sanitizeText(req.body?.title ?? existing.title, 140);
  const description = sanitizeText(req.body?.description ?? existing.description, 4000);
  const price = req.body?.price !== undefined ? Number(req.body.price) : Number(existing.price);
  const currency = sanitizeText(req.body?.currency ?? existing.currency, 6).toUpperCase();
  const nextStatusInput = req.body?.status ? String(req.body.status) : String(existing.status);

  let finalStatus = String(existing.status);
  if (['draft', 'published', 'archived'].includes(nextStatusInput)) {
    finalStatus = nextStatusInput;
    if (finalStatus === 'published') {
      const flagged = checkProhibitedKeywords(`${title} ${description}`);
      if (flagged.length > 0) {
        finalStatus = 'pending_review';
      }
    }
  }

  db.prepare(
    `UPDATE products
     SET title = ?, description = ?, price = ?, currency = ?,
         shipping_info = ?, international_shipping = ?, return_policy = ?,
         delivery_timeframe = ?, status = ?, updated_at = datetime('now')
     WHERE id = ? AND seller_user_id = ?`
  ).run(
    title,
    description,
    price,
    currency,
    sanitizeText(req.body?.shippingInfo ?? existing.shipping_info, 500),
    req.body?.internationalShipping !== undefined
      ? req.body.internationalShipping
        ? 1
        : 0
      : existing.international_shipping,
    sanitizeText(req.body?.returnPolicy ?? existing.return_policy, 500),
    sanitizeText(req.body?.deliveryTimeframe ?? existing.delivery_timeframe, 120),
    finalStatus,
    existing.id,
    userId
  );

  if (req.body?.stockQuantity !== undefined) {
    const qty = Math.max(0, Math.floor(Number(req.body.stockQuantity)));
    const avail = qty > 3 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';
    db.prepare(
      `UPDATE product_inventory SET stock_quantity = ?, availability_status = ?, updated_at = datetime('now') WHERE product_id = ?`
    ).run(qty, avail, existing.id);
  }

  if (Array.isArray(req.body?.images)) {
    const imgs = req.body.images.map((u: unknown) => sanitizeText(u, 300)).filter(Boolean).slice(0, 6);
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(existing.id);
    imgs.forEach((url: string, idx: number) => {
      db.prepare(
        `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(newId('img'), existing.id, url, title, idx, idx === 0 ? 1 : 0);
    });
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  res.json({ product: updated });
});

sellerRouter.delete('/products/:id', requireSeller, (req, res) => {
  const result = db
    .prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  }
  res.json({ deleted: true });
});

sellerRouter.post('/subscriptions', requireSeller, async (req, res) => {
  const userId = req.authUser!.id;
  const planCode = String(req.body?.planCode || '').toUpperCase();
  const billingCycle = req.body?.billingCycle === 'annual' ? 'annual' : 'monthly';

  const plan = db
    .prepare('SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1')
    .get(planCode) as Record<string, unknown> | undefined;
  if (!plan) {
    return res.status(404).json({ error: 'Subscription plan not found.' });
  }

  const seller = db
    .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .get(userId) as Record<string, unknown>;

  const price =
    billingCycle === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);

  const subId = newId('sub');
  const endsAt =
    billingCycle === 'annual'
      ? new Date(Date.now() + 365 * 86400_000).toISOString()
      : new Date(Date.now() + 30 * 86400_000).toISOString();

  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active'").run(
      seller.id
    );
    db.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(
      subId,
      seller.id,
      userId,
      plan.id,
      billingCycle,
      price,
      plan.currency,
      `SUB-${subId.slice(-6).toUpperCase()}`,
      endsAt
    );
  })();

  await notifyUserAndTelegram(
    userId,
    'subscription',
    `SOFUMER Plan Updated: ${String(plan.name)}`,
    `Your seller account is now on the ${String(plan.name)} plan (${billingCycle}).`
  );

  res.status(201).json({ subscriptionId: subId, planCode, billingCycle, amountRecorded: price });
});

sellerRouter.post('/promotions', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(userId) as Record<string, unknown>;
  const promoType = String(req.body?.promoType || 'featured_product');
  const productId = sanitizeText(req.body?.productId || '', 64) || null;
  const durationDays = Math.min(30, Math.max(1, Number(req.body?.durationDays || 7)));
  const title = sanitizeText(req.body?.title || '', 120);

  if (!['featured_product', 'sponsored_placement', 'banner_ad', 'shop_spotlight'].includes(promoType) || !title) {
    return res.status(400).json({ error: 'Valid promotion type and title are required.' });
  }

  if (productId) {
    const owned = db
      .prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
      .get(productId, userId);
    if (!owned) {
      return res.status(403).json({ error: 'You can only promote your own listings.' });
    }
  }

  // Calculate price from admin-configured platform_settings
  const settingKey =
    promoType === 'sponsored_placement'
      ? 'sponsored_placement_price_7d'
      : promoType === 'banner_ad'
      ? 'banner_ad_price_7d'
      : 'featured_product_price_7d';

  const basePriceRow = db
    .prepare('SELECT value FROM platform_settings WHERE key = ?')
    .get(settingKey) as { value: string } | undefined;
  const base7dPrice = Number(basePriceRow?.value || 15);

  const planDiscountRow = db
    .prepare(
      `SELECT sp.promotional_discount_pct FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(userId) as { promotional_discount_pct: number } | undefined;

  const discountPct = planDiscountRow?.promotional_discount_pct || 0;
  const computedPrice = Number(
    ((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2)
  );

  const promoId = newId('promo');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO promotions (id, shop_id, product_id, user_id, promo_type, title, duration_days, price_amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending')`
    ).run(promoId, shop.id, productId, userId, promoType, title, durationDays, computedPrice);

    db.prepare(
      `INSERT INTO promotion_transactions (id, promotion_id, user_id, amount, currency, status, reference)
       VALUES (?, ?, ?, ?, 'USD', 'pending', ?)`
    ).run(newId('ptx'), promoId, userId, computedPrice, `PROMO-${promoId.slice(-6).toUpperCase()}`);
  })();

  res.status(201).json({ promotionId: promoId, priceAmount: computedPrice, status: 'pending' });
});
