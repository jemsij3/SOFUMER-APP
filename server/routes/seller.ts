import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { Router } from 'express';
import { db, getDigitalDir, newId, slugify } from '../db.ts';
import {
  checkProhibitedKeywords,
  computeStarsFromUsd,
  getActiveSubscriptionLocal,
  getStarsPerUsdLocal,
  isSafeUrlOrEmpty,
  requireAuth,
  requireSeller,
  sanitizeSafeUrl,
  sanitizeText,
} from '../security.ts';
import { createTelegramInvoiceLink, notifyUserAndTelegram } from '../telegram.ts';

export const sellerRouter = Router();

const digitalStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const productDir = path.join(getDigitalDir(), String(req.params.id || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_'));
    fs.mkdirSync(productDir, { recursive: true });
    cb(null, productDir);
  },
  filename: (_req, file, cb) => {
    const base = slugify(path.basename(file.originalname || 'package', path.extname(file.originalname || '')));
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${base}${ext}`);
  },
});

const uploadDigital = multer({
  storage: digitalStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

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
  if (!isSafeUrlOrEmpty(req.body?.logoUrl, 300) || !isSafeUrlOrEmpty(req.body?.bannerUrl, 300)) {
    return res.status(400).json({ error: 'Logo and banner URLs must use http(s) or a valid relative path.' });
  }
  const logoUrl = sanitizeSafeUrl(req.body?.logoUrl || '', 300);
  const bannerUrl = sanitizeSafeUrl(req.body?.bannerUrl || '', 300);
  const defaultCurrency = sanitizeText(req.body?.defaultCurrency || 'USD', 6).toUpperCase();

  if (!legalName || !shopName) {
    return res.status(400).json({ error: 'Seller name and shop name are required.' });
  }

  const validCountry = db
    .prepare('SELECT code, default_currency FROM countries WHERE code = ?')
    .get(countryCode) as { code: string; default_currency: string } | undefined;
  const validCurrency = db
    .prepare('SELECT code FROM currencies WHERE code = ?')
    .get(defaultCurrency) as { code: string } | undefined;
  if (!validCountry) {
    return res.status(400).json({ error: `Unsupported country code "${countryCode}".` });
  }
  const resolvedCurrency = validCurrency?.code || validCountry.default_currency || 'USD';

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
      resolvedCurrency
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

  const subscription = getActiveSubscriptionLocal({ sellerId: String(sellerProfile.id) }) || null;

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

  const starsPayments = db
    .prepare(
      `SELECT id, target_type, target_id, plan_code, billing_cycle, stars_amount, currency, status, invoice_url, telegram_payment_charge_id, paid_at, expires_at, created_at
       FROM telegram_stars_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`
    )
    .all(userId);

  res.json({ sellerProfile, shop, subscription, stats, promotions, verifications, starsPayments });
});

sellerRouter.patch('/shop', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(userId) as Record<string, unknown>;
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });

  if (
    (req.body?.logoUrl !== undefined && !isSafeUrlOrEmpty(req.body.logoUrl, 300)) ||
    (req.body?.bannerUrl !== undefined && !isSafeUrlOrEmpty(req.body.bannerUrl, 300))
  ) {
    return res.status(400).json({ error: 'Logo and banner URLs must use http(s) or a valid relative path.' });
  }

  const name = sanitizeText(req.body?.name ?? shop.name, 80);
  const description = sanitizeText(req.body?.description ?? shop.description, 1200);
  const logoUrl = req.body?.logoUrl !== undefined ? sanitizeSafeUrl(req.body.logoUrl, 300) : String(shop.logo_url || '');
  const bannerUrl = req.body?.bannerUrl !== undefined ? sanitizeSafeUrl(req.body.bannerUrl, 300) : String(shop.banner_url || '');
  const returnPolicy = sanitizeText(req.body?.returnPolicy ?? shop.return_policy, 600);
  const shippingPolicy = sanitizeText(req.body?.shippingPolicy ?? shop.shipping_policy, 600);
  const defaultCurrency = sanitizeText(req.body?.defaultCurrency ?? shop.default_currency, 6).toUpperCase();
  const countryCode = sanitizeText(req.body?.countryCode ?? shop.country_code, 4).toUpperCase();

  const validCountry = db.prepare('SELECT code FROM countries WHERE code = ?').get(countryCode);
  const validCurrency = db.prepare('SELECT code FROM currencies WHERE code = ?').get(defaultCurrency);
  if (!validCountry) return res.status(400).json({ error: `Unsupported country code "${countryCode}".` });
  if (!validCurrency) return res.status(400).json({ error: `Unsupported currency code "${defaultCurrency}".` });

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
              COALESCE(inv.availability_status, 'in_stock') as availability_status,
              EXISTS(SELECT 1 FROM product_digital_assets da WHERE da.product_id = p.id) as has_digital_package
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

  const activeSub = getActiveSubscriptionLocal({ userId });
  const maxProducts = activeSub ? Number(activeSub.max_products) : 10;
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
  const productCountry = sanitizeText(req.body?.countryCode || String(shop.country_code || 'US'), 4).toUpperCase();

  if (!title || !description || !categoryId || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Title, description, category, and valid price are required.' });
  }

  const catExists = db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
  if (!catExists) {
    return res.status(400).json({ error: 'Selected category does not exist.' });
  }
  if (subcategoryId) {
    const subcatExists = db
      .prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ? AND is_active = 1')
      .get(subcategoryId, categoryId);
    if (!subcatExists) {
      return res.status(400).json({ error: 'Selected subcategory does not belong to this category.' });
    }
  }
  if (!db.prepare('SELECT code FROM currencies WHERE code = ?').get(currency)) {
    return res.status(400).json({ error: `Unsupported currency code "${currency}".` });
  }
  if (!db.prepare('SELECT code FROM countries WHERE code = ?').get(productCountry)) {
    return res.status(400).json({ error: `Unsupported country code "${productCountry}".` });
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

  const rawImages = Array.isArray(req.body?.images) ? req.body.images.slice(0, 6) : [];
  for (const u of rawImages) {
    if (!isSafeUrlOrEmpty(u, 300)) {
      return res.status(400).json({ error: 'Product image URLs must use http(s) or a valid relative path.' });
    }
  }
  const images: string[] = rawImages.map((u: unknown) => sanitizeSafeUrl(u, 300)).filter(Boolean);

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

sellerRouter.get('/products/:id/digital-asset', requireSeller, (req, res) => {
  const product = db
    .prepare('SELECT id, listing_type FROM products WHERE id = ? AND seller_user_id = ?')
    .get(req.params.id, req.authUser!.id) as { id: string; listing_type: string } | undefined;
  if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  if (product.listing_type !== 'digital') {
    return res.status(400).json({ error: 'Protected digital delivery assets are only supported for digital listings.' });
  }
  const asset = db
    .prepare(
      `SELECT id, product_id, file_name, content_type, file_size, storage_provider,
              delivery_instructions, license_key_template, download_limit, download_count, created_at, updated_at
       FROM product_digital_assets WHERE product_id = ?`
    )
    .get(product.id);
  res.json({ asset: asset || null, r2Configured: true });
});

sellerRouter.post('/products/:id/digital-asset', requireSeller, (req, res) => {
  const product = db
    .prepare('SELECT id, listing_type FROM products WHERE id = ? AND seller_user_id = ?')
    .get(req.params.id, req.authUser!.id) as { id: string; listing_type: string } | undefined;
  if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  if (product.listing_type !== 'digital') {
    return res.status(400).json({ error: 'Protected digital delivery assets are only supported for digital listings.' });
  }

  const handleSave = () => {
    const uploadedFile = req.file;
    const deliveryInstructions = sanitizeText(req.body?.deliveryInstructions || '', 2000);
    const licenseKeyTemplate = sanitizeText(req.body?.licenseKeyTemplate || '', 300);
    const downloadLimit = Math.min(100, Math.max(1, Math.floor(Number(req.body?.downloadLimit ?? 5))));

    let fileName = sanitizeText(req.body?.fileName || '', 140);
    let mimeType = 'text/plain;charset=UTF-8';
    let fileSizeBytes = 0;
    let storageProvider: 'local' | 'inline_note' = 'inline_note';
    let storageKey = '';

    if (uploadedFile) {
      fileName = sanitizeText(uploadedFile.originalname || 'package.bin', 140) || 'package.bin';
      mimeType = sanitizeText(uploadedFile.mimetype || 'application/octet-stream', 100);
      fileSizeBytes = uploadedFile.size;
      storageProvider = 'local';
      storageKey = path.relative(getDigitalDir(), uploadedFile.path).replace(/\\/g, '/');
    } else if (!deliveryInstructions && !licenseKeyTemplate) {
      return res.status(400).json({
        error: 'Provide delivery instructions, a license key template, or upload a digital package.',
      });
    }

    if (!fileName) fileName = 'digital-delivery-receipt.txt';
    const assetId = newId('dga');
    db.prepare(
      `INSERT INTO product_digital_assets (
         id, product_id, seller_user_id, file_name, content_type, file_size,
         storage_provider, storage_key, delivery_instructions, license_key_template, download_limit, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(product_id) DO UPDATE SET
         file_name = excluded.file_name,
         content_type = excluded.content_type,
         file_size = excluded.file_size,
         storage_provider = excluded.storage_provider,
         storage_key = excluded.storage_key,
         delivery_instructions = excluded.delivery_instructions,
         license_key_template = excluded.license_key_template,
         download_limit = excluded.download_limit,
         updated_at = datetime('now')`
    ).run(
      assetId,
      product.id,
      req.authUser!.id,
      fileName,
      mimeType,
      fileSizeBytes,
      storageProvider,
      storageKey,
      deliveryInstructions,
      licenseKeyTemplate,
      downloadLimit
    );

    const saved = db
      .prepare(
        `SELECT id, product_id, file_name, content_type, file_size, storage_provider,
                delivery_instructions, license_key_template, download_limit, download_count, created_at, updated_at
         FROM product_digital_assets WHERE product_id = ?`
      )
      .get(product.id);
    return res.status(201).json({ asset: saved });
  };

  if (req.is('multipart/form-data')) {
    return uploadDigital.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Digital upload failed.' });
      }
      return handleSave();
    });
  }
  return handleSave();
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
  if (!title || !description || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Valid title, description, and non-negative price are required.' });
  }
  const currency = sanitizeText(req.body?.currency ?? existing.currency, 6).toUpperCase();
  if (!db.prepare('SELECT code FROM currencies WHERE code = ?').get(currency)) {
    return res.status(400).json({ error: `Unsupported currency code "${currency}".` });
  }
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
      `INSERT INTO product_inventory (id, product_id, stock_quantity, unlimited_digital, availability_status, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(product_id) DO UPDATE SET
         stock_quantity = excluded.stock_quantity,
         availability_status = excluded.availability_status,
         updated_at = datetime('now')`
    ).run(newId('inv'), existing.id, qty, existing.listing_type === 'digital' ? 1 : 0, avail);
  }

  if (Array.isArray(req.body?.images)) {
    const rawImgs = req.body.images.slice(0, 6);
    for (const u of rawImgs) {
      if (!isSafeUrlOrEmpty(u, 300)) {
        return res.status(400).json({ error: 'Product image URLs must use http(s) or a valid relative path.' });
      }
    }
    const imgs = rawImgs.map((u: unknown) => sanitizeSafeUrl(u, 300)).filter(Boolean);
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
  const productId = req.params.id;
  const userId = req.authUser!.id;
  const existing = db
    .prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
    .get(productId, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  }

  const hasOrderItem = db.prepare('SELECT id FROM order_items WHERE product_id = ? LIMIT 1').get(productId);
  const hasReview = db.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').get(productId);

  if (hasOrderItem || hasReview) {
    db.transaction(() => {
      db.prepare('DELETE FROM product_favorites WHERE product_id = ?').run(productId);
      db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').run(productId);
      db.prepare("UPDATE products SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND seller_user_id = ?").run(productId, userId);
    })();
    return res.json({ deleted: true, archived: true });
  }

  db.transaction(() => {
    db.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').run(productId);
    db.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM inquiries WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_favorites WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_inventory WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?').run(productId, userId);
  })();

  res.json({ deleted: true, archived: false });
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

  if (planCode !== 'FREE') {
    return res.status(402).json({
      error: 'Paid seller plans require Telegram Stars (XTR) payment.',
      requiresStarsPayment: true,
      invoiceEndpoint: '/api/seller/subscriptions/invoice',
      planCode,
      billingCycle,
    });
  }

  const seller = db
    .prepare('SELECT * FROM seller_profiles WHERE user_id = ?')
    .get(userId) as Record<string, unknown>;

  const subId = newId('sub');
  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active'").run(
      seller.id
    );
    db.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)`
    ).run(subId, seller.id, userId, plan.id, billingCycle, plan.currency, `SUB-${subId.slice(-6).toUpperCase()}`);
  })();

  await notifyUserAndTelegram(
    userId,
    'subscription',
    `SOFUMER Plan Updated: ${String(plan.name)}`,
    `Your seller account is now on the ${String(plan.name)} plan.`
  );

  res.status(201).json({ subscriptionId: subId, planCode, billingCycle, amountRecorded: 0 });
});

sellerRouter.post('/subscriptions/invoice', requireSeller, async (req, res) => {
  const user = req.authUser!;
  const planCode = String(req.body?.planCode || '').toUpperCase();
  const billingCycle = req.body?.billingCycle === 'annual' ? 'annual' : 'monthly';
  if (!planCode || planCode === 'FREE') {
    return res.status(400).json({ error: 'Select a paid seller plan (PRO or BUSINESS) for Telegram Stars checkout.' });
  }

  const plan = db
    .prepare(
      `SELECT sp.*, sps.stars_monthly, sps.stars_annual
       FROM subscription_plans sp
       LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
       WHERE sp.code = ? AND sp.is_active = 1`
    )
    .get(planCode) as Record<string, unknown> | undefined;
  if (!plan) return res.status(404).json({ error: 'Subscription plan not found.' });

  const seller = db.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').get(user.id) as Record<string, unknown>;
  const usdPrice = billingCycle === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
  const starsPerUsd = getStarsPerUsdLocal();
  const configuredStars = billingCycle === 'annual' ? Number(plan.stars_annual || 0) : Number(plan.stars_monthly || 0);
  const starsAmount = configuredStars > 0 ? configuredStars : computeStarsFromUsd(usdPrice, starsPerUsd);
  if (starsAmount < 1) {
    return res.status(400).json({ error: 'Unable to determine valid Telegram Stars pricing for this plan.' });
  }

  const subId = newId('sub');
  const paymentId = newId('xtr');
  const payloadToken = `sfm_sub_${paymentId}_${crypto.randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending_payment', ?)`
    ).run(subId, seller.id, user.id, plan.id, billingCycle, usdPrice, payloadToken);

    db.prepare(
      `INSERT INTO telegram_stars_payments (
         id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle,
         title, description, usd_equivalent, stars_amount, currency, payload_token, status, expires_at
       ) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, ?, ?, ?, 'XTR', ?, 'pending', ?)`
    ).run(
      paymentId,
      user.id,
      user.telegram_id,
      subId,
      planCode,
      billingCycle,
      `SOFUMER ${String(plan.name)} (${billingCycle})`,
      `Activate ${String(plan.name)} seller tier (${billingCycle}) on SOFUMER Marketplace.`,
      usdPrice,
      starsAmount,
      payloadToken,
      expiresAt
    );
  })();

  const invoiceRes = await createTelegramInvoiceLink({
    title: `SOFUMER ${String(plan.name)} (${billingCycle})`,
    description: `Activate ${String(plan.name)} seller tier (${billingCycle}) on SOFUMER Marketplace.`,
    payload: payloadToken,
    starsAmount,
  });

  if (invoiceRes.ok === false) {
    db.transaction(() => {
      db.prepare("UPDATE telegram_stars_payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(paymentId);
      db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(subId);
    })();
    return res.status(502).json({ error: invoiceRes.error, paymentId });
  }

  db.prepare("UPDATE telegram_stars_payments SET invoice_url = ?, updated_at = datetime('now') WHERE id = ?").run(
    invoiceRes.invoiceUrl,
    paymentId
  );

  res.status(201).json({
    paymentId,
    subscriptionId: subId,
    invoiceUrl: invoiceRes.invoiceUrl,
    starsAmount,
    currency: 'XTR',
    planCode,
    billingCycle,
    expiresAt,
  });
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
  const activeSub = getActiveSubscriptionLocal({ userId });
  const discountPct = activeSub ? Number(activeSub.promotional_discount_pct || 0) : 0;
  const computedPrice = Number(((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2));
  const starsAmount = computeStarsFromUsd(computedPrice, getStarsPerUsdLocal());

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

  res.status(201).json({ promotionId: promoId, priceAmount: computedPrice, starsAmount, currency: 'XTR', status: 'pending' });
});

sellerRouter.post('/promotions/invoice', requireSeller, async (req, res) => {
  const user = req.authUser!;
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(user.id) as Record<string, unknown>;
  const promoType = String(req.body?.promoType || 'featured_product');
  const productId = sanitizeText(req.body?.productId || '', 64) || null;
  const durationDays = Math.min(30, Math.max(1, Math.floor(Number(req.body?.durationDays || 7))));
  const title = sanitizeText(req.body?.title || '', 120);

  if (!['featured_product', 'sponsored_placement', 'banner_ad', 'shop_spotlight'].includes(promoType) || !title) {
    return res.status(400).json({ error: 'Valid promotion type and title are required.' });
  }
  if (productId) {
    const owned = db.prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?').get(productId, user.id);
    if (!owned) return res.status(403).json({ error: 'You can only promote your own listings.' });
  }

  const settingKey =
    promoType === 'sponsored_placement'
      ? 'sponsored_placement_price_7d'
      : promoType === 'banner_ad'
      ? 'banner_ad_price_7d'
      : 'featured_product_price_7d';

  const basePriceRow = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(settingKey) as
    | { value: string }
    | undefined;
  const base7dPrice = Number(basePriceRow?.value || 15);
  const activeSub = getActiveSubscriptionLocal({ userId: user.id });
  const discountPct = activeSub ? Number(activeSub.promotional_discount_pct || 0) : 0;
  const computedPrice = Number(((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2));
  const starsAmount = Math.max(1, computeStarsFromUsd(computedPrice, getStarsPerUsdLocal()));

  const promoId = newId('promo');
  const paymentId = newId('xtr');
  const payloadToken = `sfm_prm_${paymentId}_${crypto.randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO promotions (id, shop_id, product_id, user_id, promo_type, title, duration_days, price_amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending')`
    ).run(promoId, shop.id, productId, user.id, promoType, title, durationDays, computedPrice);

    db.prepare(
      `INSERT INTO promotion_transactions (id, promotion_id, user_id, amount, currency, status, reference)
       VALUES (?, ?, ?, ?, 'USD', 'pending', ?)`
    ).run(newId('ptx'), promoId, user.id, computedPrice, payloadToken);

    db.prepare(
      `INSERT INTO telegram_stars_payments (
         id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle,
         title, description, usd_equivalent, stars_amount, currency, payload_token, status, expires_at
       ) VALUES (?, ?, ?, 'promotion', ?, ?, 'one_time', ?, ?, ?, ?, 'XTR', ?, 'pending', ?)`
    ).run(
      paymentId,
      user.id,
      user.telegram_id,
      promoId,
      promoType,
      `Promote: ${title.slice(0, 22)}`,
      `${durationDays}-day ${promoType.replace('_', ' ')} campaign on SOFUMER Marketplace.`,
      computedPrice,
      starsAmount,
      payloadToken,
      expiresAt
    );
  })();

  const invoiceRes = await createTelegramInvoiceLink({
    title: `Promote: ${title.slice(0, 22)}`,
    description: `${durationDays}-day ${promoType.replace('_', ' ')} campaign on SOFUMER Marketplace.`,
    payload: payloadToken,
    starsAmount,
  });

  if (invoiceRes.ok === false) {
    db.transaction(() => {
      db.prepare("UPDATE telegram_stars_payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(paymentId);
      db.prepare("UPDATE promotions SET status = 'rejected' WHERE id = ?").run(promoId);
    })();
    return res.status(502).json({ error: invoiceRes.error, paymentId });
  }

  db.prepare("UPDATE telegram_stars_payments SET invoice_url = ?, updated_at = datetime('now') WHERE id = ?").run(
    invoiceRes.invoiceUrl,
    paymentId
  );

  res.status(201).json({
    paymentId,
    promotionId: promoId,
    invoiceUrl: invoiceRes.invoiceUrl,
    starsAmount,
    priceAmount: computedPrice,
    currency: 'XTR',
    expiresAt,
  });
});

sellerRouter.get('/payments', requireSeller, (req, res) => {
  const payments = db
    .prepare(
      `SELECT id, target_type, target_id, plan_code, billing_cycle, stars_amount, currency,
              invoice_url, telegram_payment_charge_id, status, paid_at, expires_at, created_at
       FROM telegram_stars_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
    )
    .all(req.authUser!.id);
  res.json({ payments });
});

sellerRouter.post('/payments/:id/cancel', requireSeller, (req, res) => {
  const payment = db
    .prepare('SELECT * FROM telegram_stars_payments WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!payment) return res.status(404).json({ error: 'Payment invoice not found.' });
  if (payment.status !== 'pending') {
    return res.json({ cancelled: false, status: payment.status });
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(payment.id);
    if (payment.target_type === 'subscription') {
      db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'").run(
        payment.target_id
      );
    } else if (payment.target_type === 'promotion') {
      db.prepare("UPDATE promotions SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(
        payment.target_id
      );
    }
  })();
  res.json({ cancelled: true, status: 'cancelled' });
});
