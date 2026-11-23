import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { Router } from 'express';
import { db, getDigitalDir, newId, resolveConfinedDigitalPath, slugify } from '../db.ts';
import {
  PAID_ORDER_STATUSES,
  checkProhibitedKeywords,
  computeStarsFromUsd,
  getActiveSubscriptionLocal,
  getStarsPerUsdLocal,
  isSafeUrlOrEmpty,
  recordAdminAudit,
  requireAuth,
  requireSeller,
  sanitizeSafeUrl,
  sanitizeText,
} from '../security.ts';
import { createTelegramInvoiceLink, notifyUserAndTelegram } from '../telegram.ts';
import {
  type SubmittedMediaInput,
  type VerifiedMediaRecord,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_PRODUCT_PHOTOS,
  destroyExclusiveShopCloudinaryAssetsLocal,
  destroyUnreferencedCloudinaryAssetsLocal,
  generateCloudinarySignature,
  getCloudinaryConfigState,
  getMediaLimitsFromLocalDb,
  syncProductImagesFromMediaLocal,
  validateSignRequestPayload,
  verifyUploadedCloudinaryAsset,
} from '../cloudinary.ts';

export const sellerRouter = Router();

export async function executeLocalShopSoftDelete(
  shop: Record<string, unknown>,
  actorIdentifier: string,
  reason = ''
): Promise<
  | { ok: true; shopId: string; archivedProductsCount: number; deletedProductsCount: number }
  | { ok: false; status: number; error: string }
> {
  if (String(shop.status || '') === 'closed') {
    return { ok: false, status: 409, error: 'Shop is already closed.' };
  }

  const shopId = String(shop.id);
  const sellerId = String(shop.seller_id);
  const sellerUserId = String(shop.user_id);
  const oldLogoUrl = String(shop.logo_url || '');
  const oldBannerUrl = String(shop.banner_url || '');
  const cleanReason = sanitizeText(reason || '', 300);
  const nextSlug = `${String(shop.slug || 'shop').slice(0, 60)}__del_${shopId.slice(-6)}`;

  let archivedProductsCount = 0;
  let deletedProductsCount = 0;
  const mediaToDestroy: Array<Record<string, unknown>> = [];
  const digitalFilesToUnlink: string[] = [];

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE shops
       SET status = 'closed',
           is_featured = 0,
           verification_status = CASE WHEN verification_status = 'pending' THEN 'rejected' ELSE verification_status END,
           logo_url = '',
           banner_url = '',
           slug = ?,
           deleted_at = datetime('now'),
           deleted_by = ?,
           deletion_reason = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextSlug, actorIdentifier, cleanReason, shopId);

    db.prepare(
      `UPDATE shop_verifications
       SET status = 'rejected', review_notes = 'Closed upon shop deletion', reviewed_at = datetime('now')
       WHERE shop_id = ? AND status = 'pending'`
    ).run(shopId);

    const shopProducts = db.prepare('SELECT id FROM products WHERE shop_id = ?').all(shopId) as Array<{ id: string }>;

    for (const prod of shopProducts) {
      const productId = prod.id;
      const hasOrderItem = db.prepare('SELECT id FROM order_items WHERE product_id = ? LIMIT 1').get(productId);
      const hasReview = db.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').get(productId);

      if (hasOrderItem || hasReview) {
        db.prepare('DELETE FROM product_favorites WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').run(productId);
        db.prepare(
          "UPDATE products SET status = 'archived', is_featured = 0, is_sponsored = 0, updated_at = datetime('now') WHERE id = ?"
        ).run(productId);
        archivedProductsCount++;
      } else {
        const prodMedia = db
          .prepare('SELECT public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?')
          .all(productId) as Array<Record<string, unknown>>;
        mediaToDestroy.push(...prodMedia);

        const digitalAsset = db
          .prepare('SELECT storage_provider, storage_key FROM product_digital_assets WHERE product_id = ?')
          .get(productId) as { storage_provider: string; storage_key: string } | undefined;
        if (digitalAsset?.storage_provider === 'local' && digitalAsset.storage_key) {
          digitalFilesToUnlink.push(digitalAsset.storage_key);
        }

        db.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').run(productId);
        db.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM inquiries WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_favorites WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_media WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM product_inventory WHERE product_id = ?').run(productId);
        db.prepare('DELETE FROM products WHERE id = ?').run(productId);
        deletedProductsCount++;
      }
    }

    db.prepare(
      `UPDATE telegram_stars_payments
       SET status = 'cancelled', updated_at = datetime('now')
       WHERE target_type = 'promotion'
         AND status = 'pending'
         AND target_id IN (SELECT id FROM promotions WHERE shop_id = ? AND status = 'pending')`
    ).run(shopId);

    db.prepare(
      `UPDATE promotions
       SET status = CASE WHEN status = 'pending' THEN 'rejected' ELSE 'paused' END
       WHERE shop_id = ? AND status IN ('pending', 'active')`
    ).run(shopId);

    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM shops WHERE seller_id = ? AND status != 'closed'")
      .get(sellerId) as { cnt: number };

    if ((remaining?.cnt ?? 0) === 0) {
      db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status IN ('active', 'pending_payment')").run(
        sellerId
      );
      db.prepare(
        "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ? AND target_type = 'subscription' AND status = 'pending'"
      ).run(sellerUserId);
      db.prepare(
        `UPDATE seller_profiles
         SET verification_status = CASE WHEN verification_status = 'pending' THEN 'unverified' ELSE verification_status END,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(sellerId);
    }
  });

  tx();

  for (const key of digitalFilesToUnlink) {
    const filePath = resolveConfinedDigitalPath(key);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Non-fatal local cleanup error
      }
    }
  }
  if (mediaToDestroy.length > 0) {
    await destroyUnreferencedCloudinaryAssetsLocal(mediaToDestroy);
  }
  await destroyExclusiveShopCloudinaryAssetsLocal([oldLogoUrl, oldBannerUrl]);

  return {
    ok: true,
    shopId,
    archivedProductsCount,
    deletedProductsCount,
  };
}

async function resolveSubmittedProductMediaLocal(options: {
  sellerUserId: string;
  productId?: string;
  productTitle: string;
  rawMedia: unknown[];
}): Promise<
  | { ok: true; records: VerifiedMediaRecord[] }
  | { ok: false; status: number; error: string }
> {
  const { sellerUserId, productId, productTitle, rawMedia } = options;
  const limits = getMediaLimitsFromLocalDb();

  const items = rawMedia as SubmittedMediaInput[];
  const imageItems = items.filter((m) => (m?.mediaType || m?.resourceType || 'image') === 'image');
  const videoItems = items.filter((m) => (m?.mediaType || m?.resourceType) === 'video');

  if (imageItems.length > MAX_PRODUCT_PHOTOS) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product. You submitted ${imageItems.length}.`,
    };
  }
  if (videoItems.length > limits.maxVideos) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${limits.maxVideos} short video(s) allowed per product.`,
    };
  }

  const existingById = new Map<string, Record<string, unknown>>();
  const existingByPublicId = new Map<string, Record<string, unknown>>();
  if (productId) {
    const existingRows = db
      .prepare('SELECT * FROM product_media WHERE product_id = ? AND seller_user_id = ?')
      .all(productId, sellerUserId) as Array<Record<string, unknown>>;
    for (const row of existingRows) {
      existingById.set(String(row.id), row);
      if (row.public_id) existingByPublicId.set(String(row.public_id), row);
    }
  }

  const seenPublicIds = new Set<string>();
  const resolvedImages: VerifiedMediaRecord[] = [];
  const resolvedVideos: VerifiedMediaRecord[] = [];

  for (const item of [...imageItems, ...videoItems]) {
    if (!item || typeof item !== 'object') {
      return { ok: false, status: 400, error: 'Invalid media item payload.' };
    }
    const existingRow =
      (item.id && existingById.get(String(item.id))) ||
      (item.publicId && existingByPublicId.get(String(item.publicId))) ||
      undefined;

    if (existingRow) {
      const publicId = String(existingRow.public_id || '');
      if (publicId) {
        if (seenPublicIds.has(publicId)) continue;
        seenPublicIds.add(publicId);
      }
      const mType = existingRow.media_type === 'video' ? 'video' : 'image';
      const rec: VerifiedMediaRecord = {
        id: String(existingRow.id),
        storageProvider: existingRow.storage_provider === 'legacy_url' ? 'legacy_url' : 'cloudinary',
        mediaType: mType,
        resourceType: mType,
        publicId,
        secureUrl: String(existingRow.secure_url),
        format: String(existingRow.format || ''),
        bytes: Number(existingRow.bytes || 0),
        width: Number(existingRow.width || 0),
        height: Number(existingRow.height || 0),
        duration:
          existingRow.duration !== null && existingRow.duration !== undefined
            ? Number(existingRow.duration)
            : null,
        sortOrder: 0,
        isPrimary: mType === 'image' && item.isPrimary ? 1 : 0,
        altText: sanitizeText(item.altText ?? existingRow.alt_text ?? productTitle, 160),
      };
      if (mType === 'image') resolvedImages.push(rec);
      else resolvedVideos.push(rec);
      continue;
    }

    const verified = await verifyUploadedCloudinaryAsset({
      sellerUserId,
      scope: 'product',
      input: item,
      limits,
    });
    if (verified.ok === false) {
      return verified;
    }
    if (seenPublicIds.has(verified.media.publicId)) continue;
    seenPublicIds.add(verified.media.publicId);
    verified.media.altText = sanitizeText(verified.media.altText || productTitle, 160);
    if (verified.media.mediaType === 'image') resolvedImages.push(verified.media);
    else resolvedVideos.push(verified.media);
  }

  if (resolvedImages.length > MAX_PRODUCT_PHOTOS) {
    return { ok: false, status: 400, error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` };
  }
  if (resolvedVideos.length > limits.maxVideos) {
    return { ok: false, status: 400, error: `Maximum ${limits.maxVideos} short video(s) allowed per product.` };
  }

  if (resolvedImages.length > 0) {
    let primaryAssigned = false;
    for (let i = 0; i < resolvedImages.length; i++) {
      resolvedImages[i].sortOrder = i;
      if (resolvedImages[i].isPrimary === 1 && !primaryAssigned) primaryAssigned = true;
      else resolvedImages[i].isPrimary = 0;
    }
    if (!primaryAssigned) resolvedImages[0].isPrimary = 1;
  }
  for (let i = 0; i < resolvedVideos.length; i++) {
    resolvedVideos[i].sortOrder = i;
    resolvedVideos[i].isPrimary = 0;
  }

  return { ok: true, records: [...resolvedImages, ...resolvedVideos] };
}

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

sellerRouter.get('/media/config', requireSeller, (_req, res) => {
  const config = getCloudinaryConfigState();
  const limits = getMediaLimitsFromLocalDb();
  res.json({
    configured: config.configured,
    presetRequired: false,
    maxPhotos: limits.maxPhotos,
    maxVideos: limits.maxVideos,
    maxVideoDurationSec: limits.maxVideoDurationSec,
    maxImageBytes: limits.maxImageBytes,
    maxVideoBytes: limits.maxVideoBytes,
    allowedImageFormats: [...ALLOWED_IMAGE_EXTENSIONS],
    allowedVideoFormats: [...ALLOWED_VIDEO_EXTENSIONS],
  });
});

sellerRouter.post('/media/sign', requireSeller, (req, res) => {
  const config = getCloudinaryConfigState();
  if (!config.configured) {
    return res.status(503).json({ error: 'Cloudinary media credentials are not configured on the server.' });
  }
  const limits = getMediaLimitsFromLocalDb();
  const validated = validateSignRequestPayload(req.body || {}, limits);
  if (validated.ok === false) {
    return res.status(400).json({ error: validated.error });
  }

  const userId = req.authUser!.id;
  const productId = sanitizeText(req.body?.productId || '', 64);
  const replaceMediaId = sanitizeText(req.body?.replaceMediaId || '', 64);

  if (productId) {
    const product = db
      .prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
      .get(productId, userId);
    if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });

    if (replaceMediaId) {
      const target = db
        .prepare('SELECT id, media_type FROM product_media WHERE id = ? AND product_id = ? AND seller_user_id = ?')
        .get(replaceMediaId, productId, userId) as { id: string; media_type: string } | undefined;
      if (!target) return res.status(404).json({ error: 'Media item to replace was not found on this listing.' });
      if (target.media_type !== validated.mediaType) {
        return res.status(400).json({ error: 'Replacement file must match the existing media type.' });
      }
    } else if (validated.mediaType === 'image') {
      const cnt = (
        db.prepare("SELECT COUNT(*) as cnt FROM product_media WHERE product_id = ? AND media_type = 'image'").get(productId) as {
          cnt: number;
        }
      ).cnt;
      if (cnt >= limits.maxPhotos) {
        return res
          .status(400)
          .json({ error: `Maximum ${limits.maxPhotos} photos allowed per product. Remove or replace an existing photo first.` });
      }
    } else {
      const cnt = (
        db.prepare("SELECT COUNT(*) as cnt FROM product_media WHERE product_id = ? AND media_type = 'video'").get(productId) as {
          cnt: number;
        }
      ).cnt;
      if (cnt >= limits.maxVideos) {
        return res.status(400).json({ error: `Maximum ${limits.maxVideos} short video(s) allowed per product.` });
      }
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = validated.scope === 'shop' ? `sofumer/shops/${userId}` : `sofumer/products/${userId}`;
  const publicId = `${validated.mediaType === 'video' ? 'vid' : 'img'}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const signature = generateCloudinarySignature({ folder, public_id: publicId, timestamp }, config.apiSecret);

  res.json({
    cloudName: config.cloudName,
    apiKey: config.apiKey,
    timestamp,
    signature,
    folder,
    publicId,
    expectedFullPublicId: `${folder}/${publicId}`,
    resourceType: validated.resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${validated.resourceType}/upload`,
    maxFileBytes: validated.mediaType === 'video' ? limits.maxVideoBytes : limits.maxImageBytes,
    maxVideoDurationSec: limits.maxVideoDurationSec,
    maxPhotos: limits.maxPhotos,
    maxVideos: limits.maxVideos,
  });
});

sellerRouter.post('/media/verify', requireSeller, async (req, res) => {
  const limits = getMediaLimitsFromLocalDb();
  const result = await verifyUploadedCloudinaryAsset({
    sellerUserId: req.authUser!.id,
    scope: req.body?.scope === 'shop' ? 'shop' : 'product',
    input: (req.body || {}) as SubmittedMediaInput,
    limits,
  });
  if (result.ok === false) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ verifiedMedia: result.media });
});

sellerRouter.post('/register', requireAuth, (req, res) => {
  const regSetting = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'seller_registration_enabled'")
    .get() as { value: string } | undefined;
  if (regSetting?.value === 'false') {
    return res.status(403).json({ error: 'Seller registration is currently paused by administrators.' });
  }

  const user = req.authUser!;
  const existingSeller = db
    .prepare('SELECT id, status FROM seller_profiles WHERE user_id = ?')
    .get(user.id) as { id: string; status: string } | undefined;
  if (existingSeller) {
    if (existingSeller.status === 'suspended') {
      return res.status(403).json({ error: 'Seller account is suspended.' });
    }
    const activeShop = db
      .prepare("SELECT id FROM shops WHERE seller_id = ? AND status != 'closed' LIMIT 1")
      .get(existingSeller.id);
    if (activeShop) {
      return res.status(409).json({ error: 'You already have a registered seller profile and shop.' });
    }
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

  const sellerId = existingSeller ? existingSeller.id : newId('sel');
  const shopId = newId('shop');
  const baseSlug = slugify(shopName);
  const slugConflict = db.prepare('SELECT id FROM shops WHERE slug = ?').get(baseSlug);
  const shopSlug = slugConflict ? `${baseSlug}-${shopId.slice(-5)}` : baseSlug;

  const tx = db.transaction(() => {
    if (existingSeller) {
      db.prepare(
        `UPDATE seller_profiles
         SET seller_type = ?, legal_name = ?, business_registration_no = ?, country_code = ?,
             contact_email = ?, contact_phone = ?, contact_telegram = ?, verification_status = 'unverified',
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        sellerType,
        legalName,
        businessRegistrationNo,
        countryCode,
        contactEmail,
        contactPhone,
        contactTelegram,
        sellerId
      );
    } else {
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
    }

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
    .prepare("SELECT * FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
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
  const shop = db
    .prepare("SELECT * FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(userId) as Record<string, unknown>;
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

sellerRouter.delete('/shop', requireSeller, async (req, res) => {
  const user = req.authUser!;
  const shop = db
    .prepare("SELECT * FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(user.id) as Record<string, unknown> | undefined;
  if (!shop) return res.status(404).json({ error: 'Active shop not found.' });

  const confirmShopName = sanitizeText(req.body?.confirmShopName ?? '', 100);
  const explicitConfirm = req.body?.confirm === true;
  const reason = sanitizeText(req.body?.reason ?? '', 300);

  if (confirmShopName) {
    if (confirmShopName.toLowerCase() !== String(shop.name || '').trim().toLowerCase()) {
      return res.status(400).json({ error: `Confirmation failed. Type "${String(shop.name)}" to delete your shop.` });
    }
  } else if (!explicitConfirm) {
    return res.status(400).json({ error: `Type "${String(shop.name)}" to confirm shop deletion.` });
  }

  const actorIdentifier = user.telegram_username
    ? `@${user.telegram_username}`
    : user.display_name || user.id;
  const result = await executeLocalShopSoftDelete(shop, actorIdentifier, reason);
  if (result.ok === false) {
    return res.status(result.status).json({ error: result.error });
  }

  recordAdminAudit(
    actorIdentifier,
    'shop.deleted_by_owner',
    'shop',
    result.shopId,
    {
      shopName: shop.name,
      reason,
      archivedProductsCount: result.archivedProductsCount,
      deletedProductsCount: result.deletedProductsCount,
    },
    req.ip || '',
    true
  );

  res.json({
    deleted: true,
    shopId: result.shopId,
    archivedProductsCount: result.archivedProductsCount,
    deletedProductsCount: result.deletedProductsCount,
  });
});

sellerRouter.post('/verification', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const seller = db.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').get(userId) as Record<string, unknown>;
  const shop = db
    .prepare("SELECT * FROM shops WHERE seller_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(seller.id) as Record<string, unknown>;

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
  const activeShop = db
    .prepare("SELECT id FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(req.authUser!.id) as { id: string } | undefined;
  if (!activeShop) return res.json({ products: [] });

  const products = db
    .prepare(
      `SELECT p.*, c.name as category_name,
              COALESCE(
                (SELECT secure_url FROM product_media pm WHERE pm.product_id = p.id AND pm.media_type = 'image' ORDER BY pm.is_primary DESC, pm.sort_order ASC LIMIT 1),
                (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1)
              ) as primary_image,
              (SELECT COUNT(*) FROM product_media pm WHERE pm.product_id = p.id AND pm.media_type = 'image') as media_image_count,
              (SELECT COUNT(*) FROM product_media pm WHERE pm.product_id = p.id AND pm.media_type = 'video') as media_video_count,
              COALESCE(inv.stock_quantity, 1) as stock_quantity,
              COALESCE(inv.availability_status, 'in_stock') as availability_status,
              EXISTS(SELECT 1 FROM product_digital_assets da WHERE da.product_id = p.id) as has_digital_package
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_inventory inv ON inv.product_id = p.id
       WHERE p.seller_user_id = ? AND p.shop_id = ?
       ORDER BY p.updated_at DESC`
    )
    .all(req.authUser!.id, activeShop.id);
  res.json({ products });
});

sellerRouter.post('/products', requireSeller, async (req, res) => {
  const subSetting = db
    .prepare("SELECT value FROM platform_settings WHERE key = 'product_submissions_enabled'")
    .get() as { value: string } | undefined;
  if (subSetting?.value === 'false') {
    return res.status(403).json({ error: 'New product submissions are temporarily paused by administrators.' });
  }

  const userId = req.authUser!.id;
  const shop = db
    .prepare("SELECT * FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(userId) as Record<string, unknown>;
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

  let verifiedMediaRecords: VerifiedMediaRecord[] = [];
  let legacyImages: string[] = [];

  if (Array.isArray(req.body?.media)) {
    const mediaRes = await resolveSubmittedProductMediaLocal({
      sellerUserId: userId,
      productTitle: title,
      rawMedia: req.body.media,
    });
    if (mediaRes.ok === false) {
      return res.status(mediaRes.status).json({ error: mediaRes.error });
    }
    verifiedMediaRecords = mediaRes.records;
  } else if (Array.isArray(req.body?.images)) {
    if (req.body.images.length > MAX_PRODUCT_PHOTOS) {
      return res.status(400).json({ error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` });
    }
    const rawImages = req.body.images;
    for (const u of rawImages) {
      if (!isSafeUrlOrEmpty(u, 500)) {
        return res.status(400).json({ error: 'Product image URLs must use http(s) or a valid relative path.' });
      }
    }
    legacyImages = rawImages.map((u: unknown) => sanitizeSafeUrl(u, 500)).filter(Boolean);
  }

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

    if (verifiedMediaRecords.length > 0) {
      for (const rec of verifiedMediaRecords) {
        db.prepare(
          `INSERT INTO product_media (
             id, product_id, seller_user_id, storage_provider, media_type, resource_type,
             public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId('med'),
          productId,
          userId,
          rec.storageProvider,
          rec.mediaType,
          rec.resourceType,
          rec.publicId,
          rec.secureUrl,
          rec.format,
          rec.bytes,
          rec.width,
          rec.height,
          rec.duration,
          rec.sortOrder,
          rec.isPrimary,
          rec.altText || title
        );
      }
      syncProductImagesFromMediaLocal(productId, title);
    } else {
      legacyImages.forEach((url, idx) => {
        db.prepare(
          `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(newId('img'), productId, url, title, idx, idx === 0 ? 1 : 0);
      });
    }
  });

  tx();

  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const savedMedia = db
    .prepare(
      `SELECT * FROM product_media WHERE product_id = ?
       ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
    )
    .all(productId);
  res.status(201).json({ product: created, media: savedMedia, moderationNotes });
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

sellerRouter.delete('/products/:id/digital-asset', requireSeller, (req, res) => {
  const product = db
    .prepare('SELECT id, listing_type FROM products WHERE id = ? AND seller_user_id = ?')
    .get(req.params.id, req.authUser!.id) as { id: string; listing_type: string } | undefined;
  if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });
  if (product.listing_type !== 'digital') {
    return res.status(400).json({ error: 'Protected digital delivery assets are only supported for digital listings.' });
  }

  const existingAsset = db
    .prepare('SELECT id, storage_provider, storage_key FROM product_digital_assets WHERE product_id = ?')
    .get(product.id) as { id: string; storage_provider: string; storage_key: string } | undefined;
  if (!existingAsset) {
    return res.status(404).json({ error: 'No digital delivery package is configured for this product.' });
  }

  const placeholders = PAID_ORDER_STATUSES.map(() => '?').join(', ');
  const paidOrder = db
    .prepare(
      `SELECT o.id FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.product_id = ? AND o.status IN (${placeholders})
       LIMIT 1`
    )
    .get(product.id, ...PAID_ORDER_STATUSES);
  if (paidOrder) {
    return res.status(409).json({
      error: 'Cannot delete the digital delivery package after confirmed/paid orders exist for this listing.',
    });
  }

  if (existingAsset.storage_provider === 'local' && existingAsset.storage_key) {
    const filePath = resolveConfinedDigitalPath(existingAsset.storage_key);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Non-fatal local cleanup
      }
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').run(product.id);
    db.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').run(product.id);
  })();

  res.json({ deleted: true });
});

sellerRouter.get('/products/:id', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const product = db
    .prepare(
      `SELECT p.*, COALESCE(inv.stock_quantity, 1) as stock_quantity
       FROM products p LEFT JOIN product_inventory inv ON inv.product_id = p.id
       WHERE p.id = ? AND p.seller_user_id = ?`
    )
    .get(req.params.id, userId) as Record<string, unknown> | undefined;
  if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });

  const legacyImgs = db
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC')
    .all(product.id) as Array<Record<string, unknown>>;

  let media = db
    .prepare(
      `SELECT * FROM product_media WHERE product_id = ?
       ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
    )
    .all(product.id) as Array<Record<string, unknown>>;

  if (media.length === 0 && legacyImgs.length > 0) {
    legacyImgs.slice(0, MAX_PRODUCT_PHOTOS).forEach((leg, idx) => {
      db.prepare(
        `INSERT INTO product_media (
           id, product_id, seller_user_id, storage_provider, media_type, resource_type,
           public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
         ) VALUES (?, ?, ?, 'legacy_url', 'image', 'image', '', ?, '', 0, 0, 0, NULL, ?, ?, ?)`
      ).run(
        newId('med'),
        product.id,
        userId,
        String(leg.url),
        idx,
        Number(leg.is_primary || (idx === 0 ? 1 : 0)),
        sanitizeText(String(leg.alt_text || product.title || ''), 160)
      );
    });
    media = db
      .prepare(
        `SELECT * FROM product_media WHERE product_id = ?
         ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
      )
      .all(product.id) as Array<Record<string, unknown>>;
  }

  res.json({
    product,
    media,
    images: legacyImgs,
    videos: media.filter((m) => m.media_type === 'video'),
  });
});

sellerRouter.patch('/products/:id/media/reorder', requireSeller, (req, res) => {
  const userId = req.authUser!.id;
  const productId = req.params.id;
  const product = db
    .prepare('SELECT id, title FROM products WHERE id = ? AND seller_user_id = ?')
    .get(productId, userId) as { id: string; title: string } | undefined;
  if (!product) return res.status(404).json({ error: 'Listing not found or unauthorized.' });

  const rows = db
    .prepare('SELECT * FROM product_media WHERE product_id = ? AND seller_user_id = ? ORDER BY sort_order ASC')
    .all(productId, userId) as Array<Record<string, unknown>>;

  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map((id: unknown) => String(id)) : [];
  const primaryMediaId = sanitizeText(req.body?.primaryMediaId || '', 64);
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  db.transaction(() => {
    let imgIdx = 0;
    let vidIdx = 0;
    for (const id of orderedIds) {
      const row = byId.get(id);
      if (!row) continue;
      if (row.media_type === 'image') {
        db.prepare("UPDATE product_media SET sort_order = ?, updated_at = datetime('now') WHERE id = ?").run(imgIdx++, id);
      } else {
        db.prepare("UPDATE product_media SET sort_order = ?, updated_at = datetime('now') WHERE id = ?").run(vidIdx++, id);
      }
    }
    if (primaryMediaId) {
      const target = byId.get(primaryMediaId);
      if (target && target.media_type === 'image') {
        db.prepare(
          "UPDATE product_media SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE product_id = ? AND media_type = 'image'"
        ).run(primaryMediaId, productId);
      }
    }
    syncProductImagesFromMediaLocal(productId, product.title);
  })();

  const updatedMedia = db
    .prepare(
      `SELECT * FROM product_media WHERE product_id = ?
       ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
    )
    .all(productId);
  res.json({ media: updatedMedia });
});

sellerRouter.patch('/products/:id', requireSeller, async (req, res) => {
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

  let categoryId = String(existing.category_id);
  let subcategoryId = existing.subcategory_id ? String(existing.subcategory_id) : null;
  if (req.body?.categoryId !== undefined) {
    const nextCat = sanitizeText(req.body.categoryId, 64);
    if (!db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(nextCat)) {
      return res.status(400).json({ error: 'Selected category does not exist.' });
    }
    categoryId = nextCat;
    subcategoryId = req.body.subcategoryId ? sanitizeText(req.body.subcategoryId, 64) : null;
    if (
      subcategoryId &&
      !db.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ? AND is_active = 1').get(subcategoryId, categoryId)
    ) {
      return res.status(400).json({ error: 'Selected subcategory does not belong to this category.' });
    }
  }

  const nextStatusInput = req.body?.status ? String(req.body.status) : String(existing.status);
  let finalStatus = String(existing.status);
  if (['draft', 'published', 'archived'].includes(nextStatusInput)) {
    finalStatus = nextStatusInput;
    if (finalStatus === 'published') {
      const flagged = checkProhibitedKeywords(`${title} ${description}`);
      if (flagged.length > 0) finalStatus = 'pending_review';
    }
  }

  let verifiedMediaRecords: VerifiedMediaRecord[] | null = null;
  if (Array.isArray(req.body?.media)) {
    const mediaRes = await resolveSubmittedProductMediaLocal({
      sellerUserId: userId,
      productId: String(existing.id),
      productTitle: title,
      rawMedia: req.body.media,
    });
    if (mediaRes.ok === false) {
      return res.status(mediaRes.status).json({ error: mediaRes.error });
    }
    verifiedMediaRecords = mediaRes.records;
  } else if (Array.isArray(req.body?.images)) {
    if (req.body.images.length > MAX_PRODUCT_PHOTOS) {
      return res.status(400).json({ error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` });
    }
  }

  let removedCloudinaryAssets: Array<Record<string, unknown>> = [];

  db.transaction(() => {
    db.prepare(
      `UPDATE products
       SET category_id = ?, subcategory_id = ?, title = ?, description = ?, price = ?, currency = ?,
           shipping_info = ?, international_shipping = ?, return_policy = ?,
           delivery_timeframe = ?, keywords = ?, status = ?, updated_at = datetime('now')
       WHERE id = ? AND seller_user_id = ?`
    ).run(
      categoryId,
      subcategoryId,
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
      sanitizeText(req.body?.keywords ?? existing.keywords, 300),
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

    if (verifiedMediaRecords !== null) {
      const prevRows = db
        .prepare('SELECT id, public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?')
        .all(existing.id) as Array<Record<string, unknown>>;
      const nextPublicIds = new Set(verifiedMediaRecords.map((m) => m.publicId).filter(Boolean));
      removedCloudinaryAssets = prevRows.filter(
        (oldRow) => oldRow.public_id && !nextPublicIds.has(String(oldRow.public_id))
      );

      db.prepare('DELETE FROM product_media WHERE product_id = ?').run(existing.id);
      for (const rec of verifiedMediaRecords) {
        db.prepare(
          `INSERT INTO product_media (
             id, product_id, seller_user_id, storage_provider, media_type, resource_type,
             public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          rec.id || newId('med'),
          existing.id,
          userId,
          rec.storageProvider,
          rec.mediaType,
          rec.resourceType,
          rec.publicId,
          rec.secureUrl,
          rec.format,
          rec.bytes,
          rec.width,
          rec.height,
          rec.duration,
          rec.sortOrder,
          rec.isPrimary,
          rec.altText || title
        );
      }
      syncProductImagesFromMediaLocal(String(existing.id), title);
    } else if (Array.isArray(req.body?.images)) {
      const rawImgs = req.body.images;
      const imgs = rawImgs.map((u: unknown) => sanitizeSafeUrl(u, 500)).filter(Boolean);
      db.prepare('DELETE FROM product_images WHERE product_id = ?').run(existing.id);
      imgs.forEach((url: string, idx: number) => {
        db.prepare(
          `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(newId('img'), existing.id, url, title, idx, idx === 0 ? 1 : 0);
      });
    }
  })();

  if (removedCloudinaryAssets.length > 0) {
    await destroyUnreferencedCloudinaryAssetsLocal(removedCloudinaryAssets);
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  const updatedMedia = db
    .prepare(
      `SELECT * FROM product_media WHERE product_id = ?
       ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
    )
    .all(existing.id);
  res.json({ product: updated, media: updatedMedia });
});

sellerRouter.delete('/products/:id', requireSeller, async (req, res) => {
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

  const mediaToDestroy = db
    .prepare('SELECT public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?')
    .all(productId) as Array<Record<string, unknown>>;

  db.transaction(() => {
    db.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').run(productId);
    db.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM inquiries WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_favorites WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_media WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_inventory WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?').run(productId, userId);
  })();

  await destroyUnreferencedCloudinaryAssetsLocal(mediaToDestroy);

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
  const shop = db
    .prepare("SELECT * FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(userId) as Record<string, unknown>;
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
  const shop = db
    .prepare("SELECT * FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(user.id) as Record<string, unknown>;
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

sellerRouter.delete('/promotions/:id', requireSeller, (req, res) => {
  const promoId = req.params.id;
  const promo = db
    .prepare('SELECT * FROM promotions WHERE id = ? AND user_id = ?')
    .get(promoId, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!promo) return res.status(404).json({ error: 'Promotion not found or unauthorized.' });
  if (promo.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending promotions can be cancelled and removed.' });
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE target_type = 'promotion' AND target_id = ? AND status = 'pending'"
    ).run(promoId);
    db.prepare('DELETE FROM promotion_transactions WHERE promotion_id = ?').run(promoId);
    db.prepare('DELETE FROM promotions WHERE id = ? AND user_id = ?').run(promoId, req.authUser!.id);
  })();
  res.json({ deleted: true, promotionId: promoId });
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
