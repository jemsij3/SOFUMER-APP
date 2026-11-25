import {
  type D1Database,
  type Env,
  PAID_ORDER_STATUSES,
  checkEdgeRateLimit,
  checkProhibitedKeywordsEdge,
  computeStarsFromUsd,
  createTelegramInvoiceLinkEdge,
  getActiveSubscriptionEdge,
  getStarsPerUsdEdge,
  isSafeUrlOrEmpty,
  json,
  methodNotAllowed,
  newId,
  notifyUserAndTelegramEdge,
  parseJsonBody,
  recordEdgeAdminAudit,
  requireEdgeNonAdminUser,
  requireEdgeSeller,
  sanitizeSafeUrl,
  sanitizeText,
  slugify,
} from './helpers.ts';
import {
  type SubmittedMediaInput,
  type VerifiedMediaRecord,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_PRODUCT_PHOTOS,
  destroyExclusiveShopCloudinaryAssets,
  destroyUnreferencedCloudinaryAssets,
  generateCloudinarySignature,
  getCloudinaryConfigState,
  getMediaLimitsFromDb,
  syncProductImagesFromMedia,
  validateSignRequestPayload,
  verifyUploadedCloudinaryAsset,
} from './cloudinary.ts';

export async function executeEdgeShopSoftDelete(
  db: D1Database,
  env: Env,
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

  await db
    .prepare(
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
    )
    .bind(nextSlug, actorIdentifier, cleanReason, shopId)
    .run();

  await db
    .prepare(
      `UPDATE shop_verifications
       SET status = 'rejected', review_notes = 'Closed upon shop deletion', reviewed_at = datetime('now')
       WHERE shop_id = ? AND status = 'pending'`
    )
    .bind(shopId)
    .run();

  const shopProducts = await db
    .prepare('SELECT id FROM products WHERE shop_id = ?')
    .bind(shopId)
    .all<{ id: string }>();

  let archivedProductsCount = 0;
  let deletedProductsCount = 0;
  const mediaToDestroy: Array<Record<string, unknown>> = [];

  for (const prod of shopProducts.results) {
    const productId = prod.id;
    const [hasOrderItem, hasReview] = await Promise.all([
      db.prepare('SELECT id FROM order_items WHERE product_id = ? LIMIT 1').bind(productId).first(),
      db.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').bind(productId).first(),
    ]);

    if (hasOrderItem || hasReview) {
      await db.batch([
        db.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(productId),
        db
          .prepare(
            "UPDATE products SET status = 'archived', is_featured = 0, is_sponsored = 0, updated_at = datetime('now') WHERE id = ?"
          )
          .bind(productId),
      ]);
      archivedProductsCount++;
    } else {
      const [prodMedia, digitalAsset] = await Promise.all([
        db
          .prepare('SELECT public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?')
          .bind(productId)
          .all<Record<string, unknown>>(),
        db
          .prepare('SELECT storage_provider, storage_key FROM product_digital_assets WHERE product_id = ?')
          .bind(productId)
          .first<{ storage_provider: string; storage_key: string }>(),
      ]);

      mediaToDestroy.push(...prodMedia.results);
      if (digitalAsset?.storage_provider === 'r2' && digitalAsset.storage_key && env.MEDIA_BUCKET?.delete) {
        try {
          await env.MEDIA_BUCKET.delete(digitalAsset.storage_key);
        } catch {
          // Non-fatal R2 cleanup failure
        }
      }

      await db.batch([
        db.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').bind(productId),
        db.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM inquiries WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_variants WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_media WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM product_inventory WHERE product_id = ?').bind(productId),
        db.prepare('DELETE FROM products WHERE id = ?').bind(productId),
      ]);
      deletedProductsCount++;
    }
  }

  await db
    .prepare(
      `UPDATE telegram_stars_payments
       SET status = 'cancelled', updated_at = datetime('now')
       WHERE target_type = 'promotion'
         AND status = 'pending'
         AND target_id IN (SELECT id FROM promotions WHERE shop_id = ? AND status = 'pending')`
    )
    .bind(shopId)
    .run();

  await db
    .prepare(
      `UPDATE promotions
       SET status = CASE WHEN status = 'pending' THEN 'rejected' ELSE 'paused' END
       WHERE shop_id = ? AND status IN ('pending', 'active')`
    )
    .bind(shopId)
    .run();

  const remainingShop = await db
    .prepare("SELECT COUNT(*) as cnt FROM shops WHERE seller_id = ? AND status != 'closed'")
    .bind(sellerId)
    .first<{ cnt: number }>();

  if ((remainingShop?.cnt ?? 0) === 0) {
    await db
      .prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status IN ('active', 'pending_payment')")
      .bind(sellerId)
      .run();
    await db
      .prepare(
        "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ? AND target_type = 'subscription' AND status = 'pending'"
      )
      .bind(sellerUserId)
      .run();
    await db
      .prepare(
        `UPDATE seller_profiles
         SET verification_status = CASE WHEN verification_status = 'pending' THEN 'unverified' ELSE verification_status END,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(sellerId)
      .run();
  }

  if (mediaToDestroy.length > 0) {
    await destroyUnreferencedCloudinaryAssets(db, env, mediaToDestroy);
  }
  await destroyExclusiveShopCloudinaryAssets(db, env, [oldLogoUrl, oldBannerUrl]);

  return {
    ok: true,
    shopId,
    archivedProductsCount,
    deletedProductsCount,
  };
}

async function resolveSubmittedProductMedia(options: {
  env: Env;
  sellerUserId: string;
  productId?: string;
  productTitle: string;
  rawMedia: unknown[];
}): Promise<
  | { ok: true; records: VerifiedMediaRecord[] }
  | { ok: false; status: number; error: string }
> {
  const { env, sellerUserId, productId, productTitle, rawMedia } = options;
  const limits = await getMediaLimitsFromDb(env.DB!);

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
    const existingRows = await env.DB!
      .prepare('SELECT * FROM product_media WHERE product_id = ? AND seller_user_id = ?')
      .bind(productId, sellerUserId)
      .all<Record<string, unknown>>();
    for (const row of existingRows.results) {
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
        duration: existingRow.duration !== null && existingRow.duration !== undefined ? Number(existingRow.duration) : null,
        sortOrder: 0,
        isPrimary: mType === 'image' && item.isPrimary ? 1 : 0,
        altText: sanitizeText(item.altText ?? existingRow.alt_text ?? productTitle, 160),
      };
      if (mType === 'image') resolvedImages.push(rec);
      else resolvedVideos.push(rec);
      continue;
    }

    const verified = await verifyUploadedCloudinaryAsset({
      env,
      sellerUserId,
      scope: 'product',
      input: item,
      limits,
    });
    if (verified.ok === false) {
      return verified;
    }
    if (seenPublicIds.has(verified.media.publicId)) {
      continue;
    }
    seenPublicIds.add(verified.media.publicId);
    verified.media.altText = sanitizeText(verified.media.altText || productTitle, 160);
    if (verified.media.mediaType === 'image') resolvedImages.push(verified.media);
    else resolvedVideos.push(verified.media);
  }

  // Re-check resolved actual Cloudinary media types (prevents spoofed mediaType)
  if (resolvedImages.length > MAX_PRODUCT_PHOTOS) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.`,
    };
  }
  if (resolvedVideos.length > limits.maxVideos) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${limits.maxVideos} short video(s) allowed per product.`,
    };
  }

  if (resolvedImages.length > 0) {
    let primaryAssigned = false;
    for (let i = 0; i < resolvedImages.length; i++) {
      resolvedImages[i].sortOrder = i;
      if (resolvedImages[i].isPrimary === 1 && !primaryAssigned) {
        primaryAssigned = true;
      } else {
        resolvedImages[i].isPrimary = 0;
      }
    }
    if (!primaryAssigned) {
      resolvedImages[0].isPrimary = 1;
    }
  }

  for (let i = 0; i < resolvedVideos.length; i++) {
    resolvedVideos[i].sortOrder = i;
    resolvedVideos[i].isPrimary = 0;
  }

  return { ok: true, records: [...resolvedImages, ...resolvedVideos] };
}

export async function handleSellerRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/seller/')) return null;
  if (!env.DB) return json({ error: 'Database binding (DB) is not configured.' }, 503);

  if (['POST', 'PATCH', 'DELETE'].includes(request.method)) {
    const rl = await checkEdgeRateLimit(request, env, 'seller_mut', 120, 60);
    if (rl) return rl;
  }

  const sub = url.pathname.slice('/api/seller'.length);

  if (sub === '/media/config') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const isShopOnboarding = url.searchParams.get('scope') === 'shop';
    const auth = isShopOnboarding
      ? await requireEdgeNonAdminUser(request, env)
      : await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const config = getCloudinaryConfigState(env);
    const limits = await getMediaLimitsFromDb(env.DB);
    return json({
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
  }

  if (sub === '/media/sign') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeNonAdminUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    if (body.data.scope !== 'shop') {
      const sellerAuth = await requireEdgeSeller(request, env);
      if ('error' in sellerAuth) return sellerAuth.error;
    }

    const config = getCloudinaryConfigState(env);
    if (!config.configured) {
      return json(
        { error: 'Cloudinary media credentials are not configured on the Worker.' },
        503
      );
    }

    const limits = await getMediaLimitsFromDb(env.DB);
    const validated = validateSignRequestPayload(body.data, limits);
    if (validated.ok === false) {
      return json({ error: validated.error }, 400);
    }

    const productId = sanitizeText(body.data.productId || '', 64);
    const replaceMediaId = sanitizeText(body.data.replaceMediaId || '', 64);
    if (productId && validated.scope !== 'shop') {
      const product = await env.DB.prepare(
        'SELECT id FROM products WHERE id = ? AND seller_user_id = ?'
      )
        .bind(productId, auth.user.id)
        .first<{ id: string }>();
      if (!product) {
        return json({ error: 'Listing not found or unauthorized.' }, 404);
      }

      if (replaceMediaId) {
        const target = await env.DB.prepare(
          'SELECT id, media_type FROM product_media WHERE id = ? AND product_id = ? AND seller_user_id = ?'
        )
          .bind(replaceMediaId, productId, auth.user.id)
          .first<{ id: string; media_type: string }>();
        if (!target) {
          return json({ error: 'Media item to replace was not found on this listing.' }, 404);
        }
        if (target.media_type !== validated.mediaType) {
          return json({ error: 'Replacement file must match the existing media type.' }, 400);
        }
      } else if (validated.mediaType === 'image') {
        const imgCountRow = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM product_media WHERE product_id = ? AND media_type = 'image'"
        )
          .bind(productId)
          .first<{ cnt: number }>();
        if ((imgCountRow?.cnt ?? 0) >= limits.maxPhotos) {
          return json(
            { error: `Maximum ${limits.maxPhotos} photos allowed per product. Remove or replace an existing photo first.` },
            400
          );
        }
      } else {
        const vidCountRow = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM product_media WHERE product_id = ? AND media_type = 'video'"
        )
          .bind(productId)
          .first<{ cnt: number }>();
        if ((vidCountRow?.cnt ?? 0) >= limits.maxVideos) {
          return json(
            { error: `Maximum ${limits.maxVideos} short video(s) allowed per product.` },
            400
          );
        }
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder =
      validated.scope === 'shop'
        ? `sofumer/shops/${auth.user.id}`
        : `sofumer/products/${auth.user.id}`;
    const publicId = `${validated.mediaType === 'video' ? 'vid' : 'img'}_${crypto
      .randomUUID()
      .replace(/-/g, '')
      .slice(0, 16)}`;

    const signature = await generateCloudinarySignature(
      {
        folder,
        public_id: publicId,
        timestamp,
      },
      config.apiSecret
    );

    return json({
      cloudName: config.cloudName,
      apiKey: config.apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      expectedFullPublicId: `${folder}/${publicId}`,
      resourceType: validated.resourceType,
      uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(
        config.cloudName
      )}/${validated.resourceType}/upload`,
      maxFileBytes:
        validated.mediaType === 'video' ? limits.maxVideoBytes : limits.maxImageBytes,
      maxVideoDurationSec: limits.maxVideoDurationSec,
      maxPhotos: limits.maxPhotos,
      maxVideos: limits.maxVideos,
    });
  }

  if (sub === '/media/verify') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeNonAdminUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const scope = body.data.scope === 'shop' ? 'shop' : 'product';
    if (scope !== 'shop') {
      const sellerAuth = await requireEdgeSeller(request, env);
      if ('error' in sellerAuth) return sellerAuth.error;
    }

    const limits = await getMediaLimitsFromDb(env.DB);
    const result = await verifyUploadedCloudinaryAsset({
      env,
      sellerUserId: auth.user.id,
      scope,
      input: body.data as SubmittedMediaInput,
      limits,
    });

    if (result.ok === false) {
      return json({ error: result.error }, result.status);
    }

    return json({ verifiedMedia: result.media });
  }

  if (sub === '/register') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeNonAdminUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const regSetting = await env.DB.prepare(
      "SELECT value FROM platform_settings WHERE key = 'seller_registration_enabled'"
    ).first<{ value: string }>();
    if (regSetting?.value === 'false') {
      return json({ error: 'Seller registration is currently paused by administrators.' }, 403);
    }

    const user = auth.user;
    const existingSeller = await env.DB.prepare('SELECT id, status FROM seller_profiles WHERE user_id = ?')
      .bind(user.id)
      .first<{ id: string; status: string }>();
    if (existingSeller) {
      if (existingSeller.status === 'suspended') {
        return json({ error: 'Seller account is suspended.' }, 403);
      }
      const existingActiveShop = await env.DB.prepare(
        "SELECT id FROM shops WHERE seller_id = ? AND status != 'closed' LIMIT 1"
      )
        .bind(existingSeller.id)
        .first();
      if (existingActiveShop) {
        return json({ error: 'You already have a registered seller profile and shop.' }, 409);
      }
    }

    const sellerType = body.data.sellerType === 'business' ? 'business' : 'individual';
    const legalName = sanitizeText(body.data.legalName || user.display_name, 100);
    const shopName = sanitizeText(body.data.shopName || '', 80);
    const countryCode = sanitizeText(body.data.countryCode || user.country_code || 'US', 4).toUpperCase();
    const description = sanitizeText(body.data.description || '', 1000);
    const contactEmail = sanitizeText(body.data.contactEmail || '', 120);
    const contactPhone = sanitizeText(body.data.contactPhone || '', 40);
    const contactTelegram = sanitizeText(body.data.contactTelegram || user.telegram_username || '', 64);
    const businessRegistrationNo = sanitizeText(body.data.businessRegistrationNo || '', 80);
    if (!isSafeUrlOrEmpty(body.data.logoUrl, 300) || !isSafeUrlOrEmpty(body.data.bannerUrl, 300)) {
      return json({ error: 'Logo and banner URLs must use http(s) or a valid relative path.' }, 400);
    }
    const logoUrl = sanitizeSafeUrl(body.data.logoUrl || '', 300);
    const bannerUrl = sanitizeSafeUrl(body.data.bannerUrl || '', 300);
    const defaultCurrency = sanitizeText(body.data.defaultCurrency || 'USD', 6).toUpperCase();

    if (!legalName || !shopName) {
      return json({ error: 'Seller name and shop name are required.' }, 400);
    }

    const [validCountry, validCurrency] = await Promise.all([
      env.DB.prepare('SELECT code, default_currency FROM countries WHERE code = ?')
        .bind(countryCode)
        .first<{ code: string; default_currency: string }>(),
      env.DB.prepare('SELECT code FROM currencies WHERE code = ?').bind(defaultCurrency).first<{ code: string }>(),
    ]);
    if (!validCountry) {
      return json({ error: `Unsupported country code "${countryCode}".` }, 400);
    }
    const resolvedCurrency = validCurrency?.code || validCountry.default_currency || 'USD';

    const sellerId = existingSeller ? existingSeller.id : newId('sel');
    const shopId = newId('shop');
    const baseSlug = slugify(shopName);
    const slugConflict = await env.DB.prepare('SELECT id FROM shops WHERE slug = ?').bind(baseSlug).first();
    const shopSlug = slugConflict ? `${baseSlug}-${shopId.slice(-5)}` : baseSlug;

    if (existingSeller) {
      await env.DB.prepare(
        `UPDATE seller_profiles
         SET seller_type = ?, legal_name = ?, business_registration_no = ?, country_code = ?,
             contact_email = ?, contact_phone = ?, contact_telegram = ?, verification_status = 'unverified',
             updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(sellerType, legalName, businessRegistrationNo, countryCode, contactEmail, contactPhone, contactTelegram, sellerId)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO seller_profiles (id, user_id, seller_type, legal_name, business_registration_no, country_code, contact_email, contact_phone, contact_telegram)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(sellerId, user.id, sellerType, legalName, businessRegistrationNo, countryCode, contactEmail, contactPhone, contactTelegram)
        .run();
    }

    await env.DB.prepare(
      `INSERT INTO shops (id, seller_id, user_id, slug, name, description, country_code, logo_url, banner_url, default_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(shopId, sellerId, user.id, shopSlug, shopName, description, countryCode, logoUrl, bannerUrl, resolvedCurrency)
      .run();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_roles (id, user_id, role, granted_by) VALUES (?, ?, 'seller', 'seller_registration')`
    )
      .bind(newId('role'), user.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status)
       VALUES (?, ?, ?, 'plan_free', 'monthly', 0, 'USD', 'active')`
    )
      .bind(newId('sub'), sellerId, user.id)
      .run();

    const [sellerProfile, shop] = await Promise.all([
      env.DB.prepare('SELECT * FROM seller_profiles WHERE id = ?').bind(sellerId).first(),
      env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shopId).first(),
    ]);

    return json({ sellerProfile, shop }, 201);
  }

  if (sub === '/dashboard') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const sellerProfile = auth.seller;
    const shop = auth.shop;

    const [subscription, stats, promotions, verifications, starsPayments] = await Promise.all([
      getActiveSubscriptionEdge(env.DB, { sellerId: String(sellerProfile.id) }),
      env.DB.prepare(
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
        .bind(shop.id, shop.id, shop.id, shop.id, shop.id, shop.id, shop.id, shop.id)
        .first(),
      env.DB.prepare(
        `SELECT pr.*, p.title as product_title FROM promotions pr
         LEFT JOIN products p ON p.id = pr.product_id
         WHERE pr.shop_id = ? ORDER BY pr.created_at DESC`
      )
        .bind(shop.id)
        .all(),
      env.DB.prepare('SELECT * FROM shop_verifications WHERE shop_id = ? ORDER BY created_at DESC')
        .bind(shop.id)
        .all(),
      env.DB.prepare(
        `SELECT id, target_type, target_id, plan_code, billing_cycle, stars_amount, currency, status, invoice_url, telegram_payment_charge_id, paid_at, expires_at, created_at
         FROM telegram_stars_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`
      )
        .bind(auth.user.id)
        .all(),
    ]);

    return json({
      sellerProfile,
      shop,
      subscription,
      stats,
      promotions: promotions.results,
      verifications: verifications.results,
      starsPayments: starsPayments.results,
    });
  }

  if (sub === '/shop') {
    if (request.method === 'DELETE') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;
      const shop = auth.shop;

      const rawText = await request.text();
      let bodyData: Record<string, unknown> = {};
      if (rawText.trim()) {
        try {
          bodyData = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          return json({ error: 'Invalid JSON request body.' }, 400);
        }
      }

      const confirmShopName = sanitizeText(bodyData.confirmShopName ?? '', 100);
      const explicitConfirm = bodyData.confirm === true;
      const reason = sanitizeText(bodyData.reason ?? '', 300);

      if (confirmShopName) {
        if (confirmShopName.toLowerCase() !== String(shop.name || '').trim().toLowerCase()) {
          return json({ error: `Confirmation failed. Type "${String(shop.name)}" to delete your shop.` }, 400);
        }
      } else if (!explicitConfirm) {
        return json({ error: `Type "${String(shop.name)}" to confirm shop deletion.` }, 400);
      }

      const actorIdentifier = auth.user.telegram_username
        ? `@${auth.user.telegram_username}`
        : auth.user.display_name || auth.user.id;
      const result = await executeEdgeShopSoftDelete(env.DB, env, shop, actorIdentifier, reason);
      if (result.ok === false) {
        return json({ error: result.error }, result.status);
      }

      await recordEdgeAdminAudit(
        env,
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
        request.headers.get('CF-Connecting-IP') || '',
        true
      );

      return json({
        deleted: true,
        shopId: result.shopId,
        archivedProductsCount: result.archivedProductsCount,
        deletedProductsCount: result.deletedProductsCount,
      });
    }

    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH', 'DELETE']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const shop = auth.shop;

    if (
      (body.data.logoUrl !== undefined && !isSafeUrlOrEmpty(body.data.logoUrl, 300)) ||
      (body.data.bannerUrl !== undefined && !isSafeUrlOrEmpty(body.data.bannerUrl, 300))
    ) {
      return json({ error: 'Logo and banner URLs must use http(s) or a valid relative path.' }, 400);
    }

    const name = sanitizeText(body.data.name ?? shop.name, 80);
    const description = sanitizeText(body.data.description ?? shop.description, 1200);
    const logoUrl = body.data.logoUrl !== undefined ? sanitizeSafeUrl(body.data.logoUrl, 300) : String(shop.logo_url || '');
    const bannerUrl = body.data.bannerUrl !== undefined ? sanitizeSafeUrl(body.data.bannerUrl, 300) : String(shop.banner_url || '');
    const returnPolicy = sanitizeText(body.data.returnPolicy ?? shop.return_policy, 600);
    const shippingPolicy = sanitizeText(body.data.shippingPolicy ?? shop.shipping_policy, 600);
    const defaultCurrency = sanitizeText(body.data.defaultCurrency ?? shop.default_currency, 6).toUpperCase();
    const countryCode = sanitizeText(body.data.countryCode ?? shop.country_code, 4).toUpperCase();

    const [validCountry, validCurrency] = await Promise.all([
      env.DB.prepare('SELECT code FROM countries WHERE code = ?').bind(countryCode).first(),
      env.DB.prepare('SELECT code FROM currencies WHERE code = ?').bind(defaultCurrency).first(),
    ]);
    if (!validCountry) return json({ error: `Unsupported country code "${countryCode}".` }, 400);
    if (!validCurrency) return json({ error: `Unsupported currency code "${defaultCurrency}".` }, 400);

    await env.DB.prepare(
      `UPDATE shops
       SET name = ?, description = ?, logo_url = ?, banner_url = ?, return_policy = ?, shipping_policy = ?, default_currency = ?, country_code = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(name, description, logoUrl, bannerUrl, returnPolicy, shippingPolicy, defaultCurrency, countryCode, shop.id, auth.user.id)
      .run();

    const updated = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(shop.id).first();
    return json({ shop: updated });
  }

  if (sub === '/verification') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const shop = auth.shop;

    const documentType = sanitizeText(body.data.documentType || '', 60);
    const documentReference = sanitizeText(body.data.documentReference || '', 200);
    const notes = sanitizeText(body.data.notes || '', 500);
    if (!documentType || !documentReference) {
      return json({ error: 'Document type and reference are required.' }, 400);
    }

    const verId = newId('ver');
    await env.DB.prepare(
      `INSERT INTO shop_verifications (id, shop_id, seller_id, document_type, document_reference, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(verId, shop.id, auth.seller.id, documentType, documentReference, notes)
      .run();

    await env.DB.prepare("UPDATE shops SET verification_status = 'pending' WHERE id = ?").bind(shop.id).run();
    await env.DB.prepare("UPDATE seller_profiles SET verification_status = 'pending' WHERE id = ?").bind(auth.seller.id).run();

    return json({ verificationId: verId, status: 'pending' }, 201);
  }

  if (sub === '/products') {
    if (request.method === 'GET') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;
      const products = await env.DB.prepare(
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
         FROM products p JOIN categories c ON c.id = p.category_id
         LEFT JOIN product_inventory inv ON inv.product_id = p.id
         WHERE p.seller_user_id = ? AND p.shop_id = ? ORDER BY p.updated_at DESC`
      )
        .bind(auth.user.id, auth.shop.id)
        .all();
      return json({ products: products.results });
    }

    if (request.method === 'POST') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const subSetting = await env.DB.prepare(
        "SELECT value FROM platform_settings WHERE key = 'product_submissions_enabled'"
      ).first<{ value: string }>();
      if (subSetting?.value === 'false') {
        return json({ error: 'New product submissions are temporarily paused by administrators.' }, 403);
      }

      const userId = auth.user.id;
      const shop = auth.shop;
      if (!shop || shop.status !== 'active') {
        return json({ error: 'Active shop required to publish products.' }, 403);
      }

      const activeSub = await getActiveSubscriptionEdge(env.DB, { userId });
      const maxProducts = activeSub ? Number(activeSub.max_products) : 10;
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM products WHERE shop_id = ? AND status != 'archived'"
      )
        .bind(shop.id)
        .first<{ cnt: number }>();
      const currentCount = countRow?.cnt || 0;
      if (currentCount >= maxProducts) {
        return json(
          { error: `Listing limit reached (${currentCount}/${maxProducts}). Upgrade your seller plan to publish more listings.` },
          403
        );
      }

      const listingType = String(body.data.listingType || 'physical');
      if (!['physical', 'digital', 'service'].includes(listingType)) {
        return json({ error: 'Invalid listing type.' }, 400);
      }

      const title = sanitizeText(body.data.title || '', 140);
      const description = sanitizeText(body.data.description || '', 4000);
      const categoryId = sanitizeText(body.data.categoryId || '', 64);
      const subcategoryId = sanitizeText(body.data.subcategoryId || '', 64) || null;
      const price = Number(body.data.price ?? 0);
      const currency = sanitizeText(body.data.currency || String(shop.default_currency || 'USD'), 6).toUpperCase();

      if (!title || !description || !categoryId || !Number.isFinite(price) || price < 0) {
        return json({ error: 'Title, description, category, and valid price are required.' }, 400);
      }

      const productCountry = sanitizeText(body.data.countryCode || String(shop.country_code || 'US'), 4).toUpperCase();
      const [catExists, subcatExists, validCurrency, validCountry] = await Promise.all([
        env.DB.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').bind(categoryId).first(),
        subcategoryId
          ? env.DB.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ? AND is_active = 1')
              .bind(subcategoryId, categoryId)
              .first()
          : Promise.resolve(true),
        env.DB.prepare('SELECT code FROM currencies WHERE code = ?').bind(currency).first(),
        env.DB.prepare('SELECT code FROM countries WHERE code = ?').bind(productCountry).first(),
      ]);
      if (!catExists) return json({ error: 'Selected category does not exist.' }, 400);
      if (subcategoryId && !subcatExists) return json({ error: 'Selected subcategory does not belong to this category.' }, 400);
      if (!validCurrency) return json({ error: `Unsupported currency code "${currency}".` }, 400);
      if (!validCountry) return json({ error: `Unsupported country code "${productCountry}".` }, 400);

      const flaggedWords = await checkProhibitedKeywordsEdge(env, `${title} ${description}`);
      const autoApproveRow = await env.DB.prepare(
        "SELECT value FROM platform_settings WHERE key = 'auto_approve_products'"
      ).first<{ value: string }>();
      const autoApprove = autoApproveRow?.value !== 'false';

      let requestedStatus = body.data.status === 'draft' ? 'draft' : 'published';
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
        listingType === 'physical' && ['new', 'like_new', 'used', 'refurbished'].includes(String(body.data.condition))
          ? String(body.data.condition)
          : listingType === 'physical'
          ? 'new'
          : 'not_applicable';

      const stockQuantity = Math.max(0, Math.floor(Number(body.data.stockQuantity ?? 1)));
      const unlimitedDigital = listingType === 'digital' ? 1 : 0;
      const availabilityStatus =
        unlimitedDigital || stockQuantity > 3 ? 'in_stock' : stockQuantity > 0 ? 'low_stock' : 'out_of_stock';

      let verifiedMediaRecords: VerifiedMediaRecord[] = [];
      let legacyImages: string[] = [];

      if (Array.isArray(body.data.media)) {
        const mediaRes = await resolveSubmittedProductMedia({
          env,
          sellerUserId: userId,
          productTitle: title,
          rawMedia: body.data.media,
        });
        if (mediaRes.ok === false) {
          return json({ error: mediaRes.error }, mediaRes.status);
        }
        verifiedMediaRecords = mediaRes.records;
      } else if (Array.isArray(body.data.images)) {
        if (body.data.images.length > MAX_PRODUCT_PHOTOS) {
          return json(
            { error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` },
            400
          );
        }
        const rawImages = body.data.images;
        for (const u of rawImages) {
          if (!isSafeUrlOrEmpty(u, 500)) {
            return json({ error: 'Product image URLs must use http(s) or a valid relative path.' }, 400);
          }
        }
        legacyImages = rawImages.map((u: unknown) => sanitizeSafeUrl(u, 500)).filter(Boolean);
      }

      const faqsJson = Array.isArray(body.data.faqs) ? JSON.stringify(body.data.faqs.slice(0, 8)) : '[]';

      await env.DB.prepare(
        `INSERT INTO products (
          id, shop_id, seller_user_id, category_id, subcategory_id, listing_type,
          title, slug, description, price, currency, condition, country_code, location_text,
          shipping_info, international_shipping, file_format, digital_delivery_method, license_info,
          pricing_model, service_mode, delivery_timeframe, return_policy, keywords, faqs_json,
          status, moderation_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
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
          productCountry,
          sanitizeText(body.data.locationText || '', 120),
          sanitizeText(body.data.shippingInfo || '', 500),
          body.data.internationalShipping ? 1 : 0,
          sanitizeText(body.data.fileFormat || '', 80),
          sanitizeText(body.data.digitalDeliveryMethod || '', 200),
          sanitizeText(body.data.licenseInfo || '', 300),
          sanitizeText(body.data.pricingModel || 'fixed', 40),
          ['remote', 'onsite', 'hybrid'].includes(String(body.data.serviceMode))
            ? String(body.data.serviceMode)
            : listingType === 'service'
            ? 'remote'
            : 'not_applicable',
          sanitizeText(body.data.deliveryTimeframe || '', 120),
          sanitizeText(body.data.returnPolicy || String(shop.return_policy || ''), 500),
          sanitizeText(body.data.keywords || '', 300),
          faqsJson,
          requestedStatus,
          moderationNotes
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO product_inventory (id, product_id, stock_quantity, unlimited_digital, availability_status)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(newId('inv'), productId, stockQuantity, unlimitedDigital, availabilityStatus)
        .run();

      if (verifiedMediaRecords.length > 0) {
        for (const rec of verifiedMediaRecords) {
          await env.DB.prepare(
            `INSERT INTO product_media (
               id, product_id, seller_user_id, storage_provider, media_type, resource_type,
               public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
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
            )
            .run();
        }
        await syncProductImagesFromMedia(env.DB, productId, title);
      } else {
        for (let idx = 0; idx < legacyImages.length; idx++) {
          await env.DB.prepare(
            `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
            .bind(newId('img'), productId, legacyImages[idx], title, idx, idx === 0 ? 1 : 0)
            .run();
        }
      }

      const [created, savedMedia] = await Promise.all([
        env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first(),
        env.DB.prepare(
          `SELECT * FROM product_media WHERE product_id = ?
           ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
        )
          .bind(productId)
          .all(),
      ]);
      return json({ product: created, media: savedMedia.results, moderationNotes }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  if (sub.startsWith('/products/') && sub.endsWith('/digital-asset')) {
    const productId = decodeURIComponent(sub.slice('/products/'.length, -'/digital-asset'.length));
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;

    const product = await env.DB.prepare('SELECT id, listing_type, seller_user_id FROM products WHERE id = ? AND seller_user_id = ?')
      .bind(productId, auth.user.id)
      .first<{ id: string; listing_type: string; seller_user_id: string }>();
    if (!product) return json({ error: 'Listing not found or unauthorized.' }, 404);
    if (product.listing_type !== 'digital') {
      return json({ error: 'Protected digital delivery assets are only supported for digital listings.' }, 400);
    }

    if (request.method === 'GET') {
      const asset = await env.DB.prepare(
        `SELECT id, product_id, file_name, content_type, file_size, storage_provider,
                delivery_instructions, license_key_template, download_limit, download_count, created_at, updated_at
         FROM product_digital_assets WHERE product_id = ?`
      )
        .bind(productId)
        .first();
      return json({ asset: asset || null, r2Configured: Boolean(env.MEDIA_BUCKET) });
    }

    if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      let fileName = '';
      let mimeType = 'text/plain;charset=UTF-8';
      let fileSizeBytes = 0;
      let storageProvider: 'r2' | 'inline_note' = 'inline_note';
      let storageKey = '';
      let deliveryInstructions = '';
      let licenseKeyTemplate = '';
      let downloadLimit = 5;

      if (contentType.includes('multipart/form-data')) {
        const form = await request.formData();
        deliveryInstructions = sanitizeText(String(form.get('deliveryInstructions') || ''), 2000);
        licenseKeyTemplate = sanitizeText(String(form.get('licenseKeyTemplate') || ''), 300);
        downloadLimit = Math.min(100, Math.max(1, Math.floor(Number(form.get('downloadLimit') || 5))));
        const maybeFile = form.get('file');
        if (maybeFile && typeof maybeFile === 'object' && 'arrayBuffer' in maybeFile && (maybeFile as File).size > 0) {
          const uploadedFile = maybeFile as File;
          if (!env.MEDIA_BUCKET) {
            return json(
              {
                error:
                  'Binary file storage (R2) is not attached yet. Provide delivery instructions / license template instead, or bind MEDIA_BUCKET in wrangler.jsonc.',
              },
              503
            );
          }
          if (uploadedFile.size > 50 * 1024 * 1024) {
            return json({ error: 'Digital asset file exceeds maximum 50MB size limit.' }, 400);
          }
          fileName = sanitizeText(uploadedFile.name || 'package.bin', 140) || 'package.bin';
          mimeType = sanitizeText(uploadedFile.type || 'application/octet-stream', 100);
          fileSizeBytes = uploadedFile.size;
          storageProvider = 'r2';
          storageKey = `digital/${productId}/${crypto.randomUUID()}-${slugify(fileName)}`;
          await env.MEDIA_BUCKET.put(storageKey, await uploadedFile.arrayBuffer(), {
            httpMetadata: { contentType: mimeType },
          });
        } else {
          fileName = sanitizeText(String(form.get('fileName') || ''), 140);
        }
      } else {
        const body = await parseJsonBody(request);
        if (!body.ok) return body.error;
        fileName = sanitizeText(body.data.fileName || '', 140);
        deliveryInstructions = sanitizeText(body.data.deliveryInstructions || '', 2000);
        licenseKeyTemplate = sanitizeText(body.data.licenseKeyTemplate || '', 300);
        downloadLimit = Math.min(100, Math.max(1, Math.floor(Number(body.data.downloadLimit ?? 5))));
      }

      if (storageProvider === 'inline_note' && !deliveryInstructions && !licenseKeyTemplate) {
        return json(
          { error: 'Provide delivery instructions, a license key template, or upload a digital package.' },
          400
        );
      }

      if (!fileName) fileName = 'digital-delivery-receipt.txt';
      const assetId = newId('dga');
      await env.DB.prepare(
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
      )
        .bind(
          assetId,
          productId,
          auth.user.id,
          fileName,
          mimeType,
          fileSizeBytes,
          storageProvider,
          storageKey,
          deliveryInstructions,
          licenseKeyTemplate,
          downloadLimit
        )
        .run();

      const saved = await env.DB.prepare(
        `SELECT id, product_id, file_name, content_type, file_size, storage_provider,
                delivery_instructions, license_key_template, download_limit, download_count, created_at, updated_at
         FROM product_digital_assets WHERE product_id = ?`
      )
        .bind(productId)
        .first();
      return json({ asset: saved }, 201);
    }

    if (request.method === 'DELETE') {
      const existingAsset = await env.DB.prepare(
        'SELECT id, storage_provider, storage_key FROM product_digital_assets WHERE product_id = ?'
      )
        .bind(productId)
        .first<{ id: string; storage_provider: string; storage_key: string }>();
      if (!existingAsset) {
        return json({ error: 'No digital delivery package is configured for this product.' }, 404);
      }

      const paidStatusesSql = PAID_ORDER_STATUSES.map(() => '?').join(', ');
      const paidOrder = await env.DB.prepare(
        `SELECT o.id FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         WHERE oi.product_id = ? AND o.status IN (${paidStatusesSql})
         LIMIT 1`
      )
        .bind(productId, ...PAID_ORDER_STATUSES)
        .first();
      if (paidOrder) {
        return json(
          { error: 'Cannot delete the digital delivery package after confirmed/paid orders exist for this listing.' },
          409
        );
      }

      if (existingAsset.storage_provider === 'r2' && existingAsset.storage_key && env.MEDIA_BUCKET?.delete) {
        try {
          await env.MEDIA_BUCKET.delete(existingAsset.storage_key);
        } catch {
          // Non-fatal R2 cleanup failure
        }
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').bind(productId),
      ]);
      return json({ deleted: true });
    }

    return methodNotAllowed(['GET', 'POST', 'DELETE']);
  }

  if (sub.startsWith('/products/') && sub.endsWith('/media/reorder')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const productId = decodeURIComponent(sub.slice('/products/'.length, -'/media/reorder'.length));
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const product = await env.DB.prepare(
      'SELECT id, title FROM products WHERE id = ? AND seller_user_id = ?'
    )
      .bind(productId, auth.user.id)
      .first<{ id: string; title: string }>();
    if (!product) return json({ error: 'Listing not found or unauthorized.' }, 404);

    const rows = await env.DB.prepare(
      'SELECT * FROM product_media WHERE product_id = ? AND seller_user_id = ? ORDER BY sort_order ASC'
    )
      .bind(productId, auth.user.id)
      .all<Record<string, unknown>>();

    const orderedIds = Array.isArray(body.data.orderedIds)
      ? body.data.orderedIds.map((id: unknown) => String(id))
      : [];
    const primaryMediaId = sanitizeText(body.data.primaryMediaId || '', 64);

    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows.results) byId.set(String(r.id), r);

    const images = rows.results.filter((r) => r.media_type === 'image');
    const videos = rows.results.filter((r) => r.media_type === 'video');

    if (orderedIds.length > 0) {
      let imgIdx = 0;
      let vidIdx = 0;
      for (const id of orderedIds) {
        const row = byId.get(id);
        if (!row) continue;
        if (row.media_type === 'image') {
          await env.DB.prepare("UPDATE product_media SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(imgIdx++, id)
            .run();
        } else {
          await env.DB.prepare("UPDATE product_media SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(vidIdx++, id)
            .run();
        }
      }
    }

    if (primaryMediaId) {
      const target = byId.get(primaryMediaId);
      if (!target || target.media_type !== 'image') {
        return json({ error: 'Primary media must be an existing photo on this listing.' }, 400);
      }
      await env.DB.prepare(
        "UPDATE product_media SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE product_id = ? AND media_type = 'image'"
      )
        .bind(primaryMediaId, productId)
        .run();
    } else if (images.length > 0) {
      const hasPrimary = images.some((i) => Number(i.is_primary) === 1);
      if (!hasPrimary) {
        await env.DB.prepare('UPDATE product_media SET is_primary = 1 WHERE id = ?')
          .bind(images[0].id)
          .run();
      }
    }

    await syncProductImagesFromMedia(env.DB, productId, product.title);

    const updatedMedia = await env.DB.prepare(
      `SELECT * FROM product_media WHERE product_id = ?
       ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
    )
      .bind(productId)
      .all();
    return json({ media: updatedMedia.results, videoCount: videos.length });
  }

  if (sub.startsWith('/products/') && sub.endsWith('/media')) {
    const productId = decodeURIComponent(sub.slice('/products/'.length, -'/media'.length));
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;

    const product = await env.DB.prepare(
      'SELECT id, title FROM products WHERE id = ? AND seller_user_id = ?'
    )
      .bind(productId, auth.user.id)
      .first<{ id: string; title: string }>();
    if (!product) return json({ error: 'Listing not found or unauthorized.' }, 404);

    if (request.method === 'GET') {
      const media = await env.DB.prepare(
        `SELECT * FROM product_media WHERE product_id = ?
         ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
      )
        .bind(productId)
        .all();
      return json({ media: media.results });
    }

    if (request.method === 'POST') {
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const limits = await getMediaLimitsFromDb(env.DB);
      const replaceMediaId = sanitizeText(body.data.replaceMediaId || '', 64);

      const verified = await verifyUploadedCloudinaryAsset({
        env,
        sellerUserId: auth.user.id,
        scope: 'product',
        input: body.data as SubmittedMediaInput,
        limits,
      });
      if (verified.ok === false) {
        return json({ error: verified.error }, verified.status);
      }

      if (replaceMediaId) {
        const replacedAsset = await env.DB.prepare(
          'SELECT * FROM product_media WHERE id = ? AND product_id = ? AND seller_user_id = ?'
        )
          .bind(replaceMediaId, productId, auth.user.id)
          .first<Record<string, unknown>>();
        if (!replacedAsset) {
          await destroyUnreferencedCloudinaryAssets(env.DB, env, [
            {
              public_id: verified.media.publicId,
              resource_type: verified.media.resourceType,
              storage_provider: 'cloudinary',
            },
          ]);
          return json({ error: 'Media item to replace was not found on this listing.' }, 404);
        }
        if (replacedAsset.media_type !== verified.media.mediaType) {
          await destroyUnreferencedCloudinaryAssets(env.DB, env, [
            {
              public_id: verified.media.publicId,
              resource_type: verified.media.resourceType,
              storage_provider: 'cloudinary',
            },
          ]);
          return json({ error: 'Replacement file must match the existing media type.' }, 400);
        }

        await env.DB.prepare(
          `UPDATE product_media
           SET storage_provider = 'cloudinary', public_id = ?, secure_url = ?, format = ?,
               bytes = ?, width = ?, height = ?, duration = ?, updated_at = datetime('now')
           WHERE id = ? AND product_id = ?`
        )
          .bind(
            verified.media.publicId,
            verified.media.secureUrl,
            verified.media.format,
            verified.media.bytes,
            verified.media.width,
            verified.media.height,
            verified.media.duration,
            replaceMediaId,
            productId
          )
          .run();

        await syncProductImagesFromMedia(env.DB, productId, product.title);
        await destroyUnreferencedCloudinaryAssets(env.DB, env, [replacedAsset]);

        const updatedMedia = await env.DB.prepare(
          `SELECT * FROM product_media WHERE product_id = ?
           ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
        )
          .bind(productId)
          .all();
        return json({ media: updatedMedia.results }, 200);
      }

      const existingRows = await env.DB.prepare(
        'SELECT media_type, sort_order, is_primary FROM product_media WHERE product_id = ?'
      )
        .bind(productId)
        .all<{ media_type: string; sort_order: number; is_primary: number }>();

      const imgCount = existingRows.results.filter((r) => r.media_type === 'image').length;
      const vidCount = existingRows.results.filter((r) => r.media_type === 'video').length;

      if (verified.media.mediaType === 'image' && imgCount >= MAX_PRODUCT_PHOTOS) {
        await destroyUnreferencedCloudinaryAssets(env.DB, env, [
          {
            public_id: verified.media.publicId,
            resource_type: verified.media.resourceType,
            storage_provider: 'cloudinary',
          },
        ]);
        return json({ error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` }, 400);
      }
      if (verified.media.mediaType === 'video' && vidCount >= limits.maxVideos) {
        await destroyUnreferencedCloudinaryAssets(env.DB, env, [
          {
            public_id: verified.media.publicId,
            resource_type: verified.media.resourceType,
            storage_provider: 'cloudinary',
          },
        ]);
        return json({ error: `Maximum ${limits.maxVideos} short video(s) allowed per product.` }, 400);
      }

      const nextSort = verified.media.mediaType === 'image' ? imgCount : vidCount;
      const makePrimary =
        verified.media.mediaType === 'image' && (imgCount === 0 || Boolean(body.data.isPrimary))
          ? 1
          : 0;

      if (makePrimary === 1) {
        await env.DB.prepare(
          "UPDATE product_media SET is_primary = 0 WHERE product_id = ? AND media_type = 'image'"
        )
          .bind(productId)
          .run();
      }

      const medId = newId('med');
      await env.DB.prepare(
        `INSERT INTO product_media (
           id, product_id, seller_user_id, storage_provider, media_type, resource_type,
           public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
         ) VALUES (?, ?, ?, 'cloudinary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          medId,
          productId,
          auth.user.id,
          verified.media.mediaType,
          verified.media.resourceType,
          verified.media.publicId,
          verified.media.secureUrl,
          verified.media.format,
          verified.media.bytes,
          verified.media.width,
          verified.media.height,
          verified.media.duration,
          nextSort,
          makePrimary,
          verified.media.altText || product.title
        )
        .run();

      await syncProductImagesFromMedia(env.DB, productId, product.title);

      const updatedMedia = await env.DB.prepare(
        `SELECT * FROM product_media WHERE product_id = ?
         ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
      )
        .bind(productId)
        .all();
      return json({ media: updatedMedia.results }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  if (sub.startsWith('/products/') && sub.includes('/media/')) {
    const rest = sub.slice('/products/'.length);
    const medIdx = rest.indexOf('/media/');
    if (medIdx > 0) {
      const productId = decodeURIComponent(rest.slice(0, medIdx));
      const mediaId = decodeURIComponent(rest.slice(medIdx + '/media/'.length));
      if (!mediaId || mediaId.includes('/')) {
        return json({ error: 'Seller media endpoint not found.' }, 404);
      }
      if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;

      const product = await env.DB.prepare(
        'SELECT id, title FROM products WHERE id = ? AND seller_user_id = ?'
      )
        .bind(productId, auth.user.id)
        .first<{ id: string; title: string }>();
      if (!product) return json({ error: 'Listing not found or unauthorized.' }, 404);

      const target = await env.DB.prepare(
        'SELECT * FROM product_media WHERE id = ? AND product_id = ? AND seller_user_id = ?'
      )
        .bind(mediaId, productId, auth.user.id)
        .first<Record<string, unknown>>();
      if (!target) return json({ error: 'Media item not found.' }, 404);

      await env.DB.prepare('DELETE FROM product_media WHERE id = ? AND product_id = ?')
        .bind(mediaId, productId)
        .run();

      const remainingSameType = await env.DB.prepare(
        'SELECT id, is_primary FROM product_media WHERE product_id = ? AND media_type = ? ORDER BY sort_order ASC'
      )
        .bind(productId, target.media_type)
        .all<{ id: string; is_primary: number }>();

      const needsNewPrimary =
        target.media_type === 'image' &&
        remainingSameType.results.length > 0 &&
        !remainingSameType.results.some((r) => Number(r.is_primary) === 1);

      for (let i = 0; i < remainingSameType.results.length; i++) {
        const row = remainingSameType.results[i];
        await env.DB.prepare('UPDATE product_media SET sort_order = ?, is_primary = ? WHERE id = ?')
          .bind(i, needsNewPrimary && i === 0 ? 1 : row.is_primary, row.id)
          .run();
      }

      await syncProductImagesFromMedia(env.DB, productId, product.title);
      await destroyUnreferencedCloudinaryAssets(env.DB, env, [target]);

      const updatedMedia = await env.DB.prepare(
        `SELECT * FROM product_media WHERE product_id = ?
         ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
      )
        .bind(productId)
        .all();
      return json({ deleted: true, media: updatedMedia.results });
    }
  }

  if (sub.startsWith('/products/')) {
    const productId = decodeURIComponent(sub.slice('/products/'.length));
    if (request.method === 'GET') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;

      const product = await env.DB.prepare(
        `SELECT p.*, COALESCE(inv.stock_quantity, 1) as stock_quantity
         FROM products p LEFT JOIN product_inventory inv ON inv.product_id = p.id
         WHERE p.id = ? AND p.seller_user_id = ?`
      )
        .bind(productId, auth.user.id)
        .first<Record<string, unknown>>();
      if (!product) return json({ error: 'Listing not found or unauthorized.' }, 404);

      const [mediaRows, legacyImgRows] = await Promise.all([
        env.DB.prepare(
          `SELECT * FROM product_media WHERE product_id = ?
           ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
        )
          .bind(productId)
          .all<Record<string, unknown>>(),
        env.DB.prepare(
          'SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC'
        )
          .bind(productId)
          .all<Record<string, unknown>>(),
      ]);

      let media = mediaRows.results;
      if (media.length === 0 && legacyImgRows.results.length > 0) {
        for (let idx = 0; idx < Math.min(MAX_PRODUCT_PHOTOS, legacyImgRows.results.length); idx++) {
          const leg = legacyImgRows.results[idx];
          await env.DB.prepare(
            `INSERT INTO product_media (
               id, product_id, seller_user_id, storage_provider, media_type, resource_type,
               public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
             ) VALUES (?, ?, ?, 'legacy_url', 'image', 'image', '', ?, '', 0, 0, 0, NULL, ?, ?, ?)`
          )
            .bind(
              newId('med'),
              productId,
              auth.user.id,
              String(leg.url),
              idx,
              Number(leg.is_primary || (idx === 0 ? 1 : 0)),
              sanitizeText(leg.alt_text || String(product.title || ''), 160)
            )
            .run();
        }
        const reloaded = await env.DB.prepare(
          `SELECT * FROM product_media WHERE product_id = ?
           ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
        )
          .bind(productId)
          .all<Record<string, unknown>>();
        media = reloaded.results;
      }

      return json({
        product,
        media,
        images: legacyImgRows.results,
        videos: media.filter((m) => m.media_type === 'video'),
      });
    }

    if (request.method === 'PATCH') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const existing = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND seller_user_id = ?')
        .bind(productId, auth.user.id)
        .first<Record<string, unknown>>();
      if (!existing) return json({ error: 'Listing not found or unauthorized.' }, 404);

      const title = sanitizeText(body.data.title ?? existing.title, 140);
      const description = sanitizeText(body.data.description ?? existing.description, 4000);
      const price = body.data.price !== undefined ? Number(body.data.price) : Number(existing.price);
      if (!title || !description || !Number.isFinite(price) || price < 0) {
        return json({ error: 'Valid title, description, and non-negative price are required.' }, 400);
      }
      const currency = sanitizeText(body.data.currency ?? existing.currency, 6).toUpperCase();
      const validCurrency = await env.DB.prepare('SELECT code FROM currencies WHERE code = ?').bind(currency).first();
      if (!validCurrency) return json({ error: `Unsupported currency code "${currency}".` }, 400);

      let categoryId = String(existing.category_id);
      let subcategoryId = existing.subcategory_id ? String(existing.subcategory_id) : null;
      if (body.data.categoryId !== undefined) {
        const nextCat = sanitizeText(body.data.categoryId, 64);
        const catExists = await env.DB.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1')
          .bind(nextCat)
          .first();
        if (!catExists) return json({ error: 'Selected category does not exist.' }, 400);
        categoryId = nextCat;
        subcategoryId = body.data.subcategoryId ? sanitizeText(body.data.subcategoryId, 64) : null;
        if (subcategoryId) {
          const subExists = await env.DB.prepare(
            'SELECT id FROM subcategories WHERE id = ? AND category_id = ? AND is_active = 1'
          )
            .bind(subcategoryId, categoryId)
            .first();
          if (!subExists) {
            return json({ error: 'Selected subcategory does not belong to this category.' }, 400);
          }
        }
      }

      const nextStatusInput = body.data.status ? String(body.data.status) : String(existing.status);

      let finalStatus = String(existing.status);
      if (['draft', 'published', 'archived'].includes(nextStatusInput)) {
        finalStatus = nextStatusInput;
        if (finalStatus === 'published') {
          const flagged = await checkProhibitedKeywordsEdge(env, `${title} ${description}`);
          if (flagged.length > 0) finalStatus = 'pending_review';
        }
      }

      let verifiedMediaRecords: VerifiedMediaRecord[] | null = null;
      if (Array.isArray(body.data.media)) {
        const mediaRes = await resolveSubmittedProductMedia({
          env,
          sellerUserId: auth.user.id,
          productId: String(existing.id),
          productTitle: title,
          rawMedia: body.data.media,
        });
        if (mediaRes.ok === false) {
          return json({ error: mediaRes.error }, mediaRes.status);
        }
        verifiedMediaRecords = mediaRes.records;
      } else if (Array.isArray(body.data.images)) {
        if (body.data.images.length > MAX_PRODUCT_PHOTOS) {
          return json(
            { error: `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product.` },
            400
          );
        }
      }

      const condition =
        existing.listing_type === 'physical' &&
        body.data.condition &&
        ['new', 'like_new', 'used', 'refurbished'].includes(String(body.data.condition))
          ? String(body.data.condition)
          : String(existing.condition);

      const serviceMode =
        existing.listing_type === 'service' &&
        body.data.serviceMode &&
        ['remote', 'onsite', 'hybrid'].includes(String(body.data.serviceMode))
          ? String(body.data.serviceMode)
          : String(existing.service_mode);

      const faqsJson = Array.isArray(body.data.faqs)
        ? JSON.stringify(body.data.faqs.slice(0, 8))
        : String(existing.faqs_json || '[]');

      await env.DB.prepare(
        `UPDATE products
         SET category_id = ?, subcategory_id = ?, title = ?, description = ?, price = ?, currency = ?,
             condition = ?, location_text = ?, shipping_info = ?, international_shipping = ?,
             file_format = ?, digital_delivery_method = ?, license_info = ?, pricing_model = ?,
             service_mode = ?, delivery_timeframe = ?, return_policy = ?, keywords = ?, faqs_json = ?,
             status = ?, updated_at = datetime('now')
         WHERE id = ? AND seller_user_id = ?`
      )
        .bind(
          categoryId,
          subcategoryId,
          title,
          description,
          price,
          currency,
          condition,
          sanitizeText(body.data.locationText ?? existing.location_text, 120),
          sanitizeText(body.data.shippingInfo ?? existing.shipping_info, 500),
          body.data.internationalShipping !== undefined
            ? body.data.internationalShipping
              ? 1
              : 0
            : existing.international_shipping,
          sanitizeText(body.data.fileFormat ?? existing.file_format, 80),
          sanitizeText(body.data.digitalDeliveryMethod ?? existing.digital_delivery_method, 200),
          sanitizeText(body.data.licenseInfo ?? existing.license_info, 300),
          sanitizeText(body.data.pricingModel ?? existing.pricing_model, 40),
          serviceMode,
          sanitizeText(body.data.deliveryTimeframe ?? existing.delivery_timeframe, 120),
          sanitizeText(body.data.returnPolicy ?? existing.return_policy, 500),
          sanitizeText(body.data.keywords ?? existing.keywords, 300),
          faqsJson,
          finalStatus,
          existing.id,
          auth.user.id
        )
        .run();

      if (body.data.stockQuantity !== undefined) {
        const qty = Math.max(0, Math.floor(Number(body.data.stockQuantity)));
        const avail = qty > 3 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';
        await env.DB.prepare(
          `INSERT INTO product_inventory (id, product_id, stock_quantity, unlimited_digital, availability_status, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(product_id) DO UPDATE SET
             stock_quantity = excluded.stock_quantity,
             availability_status = excluded.availability_status,
             updated_at = datetime('now')`
        )
          .bind(newId('inv'), existing.id, qty, existing.listing_type === 'digital' ? 1 : 0, avail)
          .run();
      }

      if (verifiedMediaRecords !== null) {
        const previousRows = await env.DB.prepare(
          'SELECT id, public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?'
        )
          .bind(existing.id)
          .all<Record<string, unknown>>();
        const nextPublicIds = new Set(
          verifiedMediaRecords.map((m) => m.publicId).filter(Boolean)
        );
        const removedCloudinaryAssets = previousRows.results.filter(
          (oldRow) => oldRow.public_id && !nextPublicIds.has(String(oldRow.public_id))
        );

        await env.DB.prepare('DELETE FROM product_media WHERE product_id = ?')
          .bind(existing.id)
          .run();

        for (const rec of verifiedMediaRecords) {
          await env.DB.prepare(
            `INSERT INTO product_media (
               id, product_id, seller_user_id, storage_provider, media_type, resource_type,
               public_id, secure_url, format, bytes, width, height, duration, sort_order, is_primary, alt_text
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              rec.id || newId('med'),
              existing.id,
              auth.user.id,
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
            )
            .run();
        }
        await syncProductImagesFromMedia(env.DB, String(existing.id), title);
        await destroyUnreferencedCloudinaryAssets(env.DB, env, removedCloudinaryAssets);
      } else if (Array.isArray(body.data.images)) {
        const rawImgs = body.data.images;
        for (const u of rawImgs) {
          if (!isSafeUrlOrEmpty(u, 500)) {
            return json({ error: 'Product image URLs must use http(s) or a valid relative path.' }, 400);
          }
        }
        const imgs = rawImgs.map((u: unknown) => sanitizeSafeUrl(u, 500)).filter(Boolean);
        await env.DB.prepare('DELETE FROM product_images WHERE product_id = ?').bind(existing.id).run();
        for (let idx = 0; idx < imgs.length; idx++) {
          await env.DB.prepare(
            `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
            .bind(newId('img'), existing.id, imgs[idx], title, idx, idx === 0 ? 1 : 0)
            .run();
        }
      }

      const [updated, updatedMedia] = await Promise.all([
        env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(existing.id).first(),
        env.DB.prepare(
          `SELECT * FROM product_media WHERE product_id = ?
           ORDER BY CASE WHEN media_type = 'image' THEN 0 ELSE 1 END, is_primary DESC, sort_order ASC`
        )
          .bind(existing.id)
          .all(),
      ]);
      return json({ product: updated, media: updatedMedia.results });
    }

    if (request.method === 'DELETE') {
      const auth = await requireEdgeSeller(request, env);
      if ('error' in auth) return auth.error;

      const existing = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
        .bind(productId, auth.user.id)
        .first<{ id: string }>();
      if (!existing) {
        return json({ error: 'Listing not found or unauthorized.' }, 404);
      }

      const [hasOrderItem, hasReview] = await Promise.all([
        env.DB.prepare('SELECT id FROM order_items WHERE product_id = ? LIMIT 1').bind(productId).first(),
        env.DB.prepare('SELECT id FROM reviews WHERE product_id = ? LIMIT 1').bind(productId).first(),
      ]);

      if (hasOrderItem || hasReview) {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(productId),
          env.DB.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(productId),
          env.DB.prepare("UPDATE products SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND seller_user_id = ?").bind(productId, auth.user.id),
        ]);
        return json({ deleted: true, archived: true });
      }

      const mediaToDestroy = await env.DB.prepare(
        'SELECT public_id, resource_type, storage_provider FROM product_media WHERE product_id = ?'
      )
        .bind(productId)
        .all<Record<string, unknown>>();

      await env.DB.batch([
        env.DB.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').bind(productId),
        env.DB.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM inquiries WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_variants WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_media WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_images WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_inventory WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?').bind(productId, auth.user.id),
      ]);

      await destroyUnreferencedCloudinaryAssets(env.DB, env, mediaToDestroy.results);

      return json({ deleted: true, archived: false });
    }

    return methodNotAllowed(['GET', 'PATCH', 'DELETE']);
  }

  if (sub === '/subscriptions') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const planCode = String(body.data.planCode || '').toUpperCase();
    const billingCycle = body.data.billingCycle === 'annual' ? 'annual' : 'monthly';
    const plan = await env.DB.prepare('SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1')
      .bind(planCode)
      .first<Record<string, unknown>>();
    if (!plan) return json({ error: 'Subscription plan not found.' }, 404);

    if (planCode !== 'FREE') {
      return json(
        {
          error: 'Paid seller plans require Telegram Stars (XTR) payment.',
          requiresStarsPayment: true,
          invoiceEndpoint: '/api/seller/subscriptions/invoice',
          planCode,
          billingCycle,
        },
        402
      );
    }

    const subId = newId('sub');
    await env.DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active'")
      .bind(auth.seller.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)`
    )
      .bind(subId, auth.seller.id, auth.user.id, plan.id, billingCycle, plan.currency, `SUB-${subId.slice(-6).toUpperCase()}`)
      .run();

    await notifyUserAndTelegramEdge(
      env,
      auth.user.id,
      'subscription',
      `SOFUMER Plan Updated: ${String(plan.name)}`,
      `Your seller account is now on the ${String(plan.name)} plan.`,
      url.origin
    );

    return json({ subscriptionId: subId, planCode, billingCycle, amountRecorded: 0 }, 201);
  }

  if (sub === '/subscriptions/invoice') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const planCode = String(body.data.planCode || '').toUpperCase();
    const billingCycle = body.data.billingCycle === 'annual' ? 'annual' : 'monthly';
    if (!planCode || planCode === 'FREE') {
      return json({ error: 'Select a paid seller plan (PRO or BUSINESS) for Telegram Stars checkout.' }, 400);
    }

    const plan = await env.DB.prepare(
      `SELECT sp.*, sps.stars_monthly, sps.stars_annual
       FROM subscription_plans sp
       LEFT JOIN subscription_plan_stars sps ON sps.plan_id = sp.id
       WHERE sp.code = ? AND sp.is_active = 1`
    )
      .bind(planCode)
      .first<Record<string, unknown>>();
    if (!plan) return json({ error: 'Subscription plan not found.' }, 404);

    const usdPrice = billingCycle === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
    const starsPerUsd = await getStarsPerUsdEdge(env.DB);
    const configuredStars =
      billingCycle === 'annual' ? Number(plan.stars_annual || 0) : Number(plan.stars_monthly || 0);
    const starsAmount = configuredStars > 0 ? configuredStars : computeStarsFromUsd(usdPrice, starsPerUsd);
    if (starsAmount < 1) {
      return json({ error: 'Unable to determine valid Telegram Stars pricing for this plan.' }, 400);
    }

    const subId = newId('sub');
    const paymentId = newId('xtr');
    const payloadToken = `sfm_sub_${paymentId}_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    await env.DB.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending_payment', ?)`
    )
      .bind(subId, auth.seller.id, auth.user.id, plan.id, billingCycle, usdPrice, payloadToken)
      .run();

    const invoiceTitle = `SOFUMER ${String(plan.name)} (${billingCycle})`;
    const invoiceDescription = `Activate ${String(plan.name)} seller tier (${billingCycle}) on SOFUMER Marketplace.`;

    await env.DB.prepare(
      `INSERT INTO telegram_stars_payments (
         id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle,
         title, description, usd_equivalent, stars_amount, currency, payload_token, status, expires_at
       ) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, ?, ?, ?, 'XTR', ?, 'pending', ?)`
    )
      .bind(
        paymentId,
        auth.user.id,
        auth.user.telegram_id,
        subId,
        planCode,
        billingCycle,
        invoiceTitle,
        invoiceDescription,
        usdPrice,
        starsAmount,
        payloadToken,
        expiresAt
      )
      .run();

    const invoiceRes = await createTelegramInvoiceLinkEdge(env, {
      title: `SOFUMER ${String(plan.name)} (${billingCycle})`,
      description: `Activate ${String(plan.name)} seller tier (${billingCycle}) on SOFUMER Marketplace.`,
      payload: payloadToken,
      starsAmount,
    });

    if (invoiceRes.ok === false) {
      await env.DB.batch([
        env.DB.prepare("UPDATE telegram_stars_payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?").bind(paymentId),
        env.DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").bind(subId),
      ]);
      return json({ error: invoiceRes.error, paymentId }, 502);
    }

    await env.DB.prepare("UPDATE telegram_stars_payments SET invoice_url = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(invoiceRes.invoiceUrl, paymentId)
      .run();

    return json(
      {
        paymentId,
        subscriptionId: subId,
        invoiceUrl: invoiceRes.invoiceUrl,
        starsAmount,
        currency: 'XTR',
        planCode,
        billingCycle,
        expiresAt,
      },
      201
    );
  }

  if (sub === '/promotions') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const shop = auth.shop;

    const promoType = String(body.data.promoType || 'featured_product');
    const productId = sanitizeText(body.data.productId || '', 64) || null;
    const durationDays = Math.min(30, Math.max(1, Number(body.data.durationDays || 7)));
    const title = sanitizeText(body.data.title || '', 120);

    if (!['featured_product', 'sponsored_placement', 'banner_ad', 'shop_spotlight'].includes(promoType) || !title) {
      return json({ error: 'Valid promotion type and title are required.' }, 400);
    }

    if (productId) {
      const owned = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
        .bind(productId, auth.user.id)
        .first();
      if (!owned) return json({ error: 'You can only promote your own listings.' }, 403);
    }

    const settingKey =
      promoType === 'sponsored_placement'
        ? 'sponsored_placement_price_7d'
        : promoType === 'banner_ad'
        ? 'banner_ad_price_7d'
        : 'featured_product_price_7d';

    const [basePriceRow, activeSub, starsPerUsd] = await Promise.all([
      env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(settingKey).first<{ value: string }>(),
      getActiveSubscriptionEdge(env.DB, { userId: auth.user.id }),
      getStarsPerUsdEdge(env.DB),
    ]);

    const base7dPrice = Number(basePriceRow?.value || 15);
    const discountPct = activeSub ? Number(activeSub.promotional_discount_pct || 0) : 0;
    const computedPrice = Number(((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2));
    const starsAmount = computeStarsFromUsd(computedPrice, starsPerUsd);
    const promoId = newId('promo');

    await env.DB.prepare(
      `INSERT INTO promotions (id, shop_id, product_id, user_id, promo_type, title, duration_days, price_amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending')`
    )
      .bind(promoId, shop.id, productId, auth.user.id, promoType, title, durationDays, computedPrice)
      .run();

    await env.DB.prepare(
      `INSERT INTO promotion_transactions (id, promotion_id, user_id, amount, currency, status, reference)
       VALUES (?, ?, ?, ?, 'USD', 'pending', ?)`
    )
      .bind(newId('ptx'), promoId, auth.user.id, computedPrice, `PROMO-${promoId.slice(-6).toUpperCase()}`)
      .run();

    return json({ promotionId: promoId, priceAmount: computedPrice, starsAmount, currency: 'XTR', status: 'pending' }, 201);
  }

  if (sub === '/promotions/invoice') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const shop = auth.shop;

    const promoType = String(body.data.promoType || 'featured_product');
    const productId = sanitizeText(body.data.productId || '', 64) || null;
    const durationDays = Math.min(30, Math.max(1, Math.floor(Number(body.data.durationDays || 7))));
    const title = sanitizeText(body.data.title || '', 120);

    if (!['featured_product', 'sponsored_placement', 'banner_ad', 'shop_spotlight'].includes(promoType) || !title) {
      return json({ error: 'Valid promotion type and title are required.' }, 400);
    }

    if (productId) {
      const owned = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND seller_user_id = ?')
        .bind(productId, auth.user.id)
        .first();
      if (!owned) return json({ error: 'You can only promote your own listings.' }, 403);
    }

    const settingKey =
      promoType === 'sponsored_placement'
        ? 'sponsored_placement_price_7d'
        : promoType === 'banner_ad'
        ? 'banner_ad_price_7d'
        : 'featured_product_price_7d';

    const [basePriceRow, activeSub, starsPerUsd] = await Promise.all([
      env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(settingKey).first<{ value: string }>(),
      getActiveSubscriptionEdge(env.DB, { userId: auth.user.id }),
      getStarsPerUsdEdge(env.DB),
    ]);

    const base7dPrice = Number(basePriceRow?.value || 15);
    const discountPct = activeSub ? Number(activeSub.promotional_discount_pct || 0) : 0;
    const computedPrice = Number(((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2));
    const starsAmount = Math.max(1, computeStarsFromUsd(computedPrice, starsPerUsd));

    const promoId = newId('promo');
    const paymentId = newId('xtr');
    const payloadToken = `sfm_prm_${paymentId}_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    const promoInvoiceTitle = `Promote: ${title.slice(0, 22)}`;
    const promoInvoiceDesc = `${durationDays}-day ${promoType.replace('_', ' ')} campaign on SOFUMER Marketplace.`;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO promotions (id, shop_id, product_id, user_id, promo_type, title, duration_days, price_amount, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending')`
      ).bind(promoId, shop.id, productId, auth.user.id, promoType, title, durationDays, computedPrice),
      env.DB.prepare(
        `INSERT INTO promotion_transactions (id, promotion_id, user_id, amount, currency, status, reference)
         VALUES (?, ?, ?, ?, 'USD', 'pending', ?)`
      ).bind(newId('ptx'), promoId, auth.user.id, computedPrice, payloadToken),
      env.DB.prepare(
        `INSERT INTO telegram_stars_payments (
           id, user_id, payer_telegram_id, target_type, target_id, plan_code, billing_cycle,
           title, description, usd_equivalent, stars_amount, currency, payload_token, status, expires_at
         ) VALUES (?, ?, ?, 'promotion', ?, ?, 'one_time', ?, ?, ?, ?, 'XTR', ?, 'pending', ?)`
      ).bind(
        paymentId,
        auth.user.id,
        auth.user.telegram_id,
        promoId,
        promoType,
        promoInvoiceTitle,
        promoInvoiceDesc,
        computedPrice,
        starsAmount,
        payloadToken,
        expiresAt
      ),
    ]);

    const invoiceRes = await createTelegramInvoiceLinkEdge(env, {
      title: `Promote: ${title.slice(0, 22)}`,
      description: `${durationDays}-day ${promoType.replace('_', ' ')} campaign on SOFUMER Marketplace.`,
      payload: payloadToken,
      starsAmount,
    });

    if (invoiceRes.ok === false) {
      await env.DB.batch([
        env.DB.prepare("UPDATE telegram_stars_payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?").bind(paymentId),
        env.DB.prepare("UPDATE promotions SET status = 'rejected' WHERE id = ?").bind(promoId),
      ]);
      return json({ error: invoiceRes.error, paymentId }, 502);
    }

    await env.DB.prepare("UPDATE telegram_stars_payments SET invoice_url = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(invoiceRes.invoiceUrl, paymentId)
      .run();

    return json(
      {
        paymentId,
        promotionId: promoId,
        invoiceUrl: invoiceRes.invoiceUrl,
        starsAmount,
        priceAmount: computedPrice,
        currency: 'XTR',
        expiresAt,
      },
      201
    );
  }

  if (sub.startsWith('/promotions/') && sub !== '/promotions/invoice') {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const promoId = decodeURIComponent(sub.slice('/promotions/'.length));
    const promo = await env.DB.prepare('SELECT * FROM promotions WHERE id = ? AND user_id = ?')
      .bind(promoId, auth.user.id)
      .first<Record<string, unknown>>();
    if (!promo) return json({ error: 'Promotion not found or unauthorized.' }, 404);
    if (promo.status !== 'pending') {
      return json({ error: 'Only pending promotions can be cancelled and removed.' }, 409);
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE target_type = 'promotion' AND target_id = ? AND status = 'pending'"
      ).bind(promoId),
      env.DB.prepare('DELETE FROM promotion_transactions WHERE promotion_id = ?').bind(promoId),
      env.DB.prepare('DELETE FROM promotions WHERE id = ? AND user_id = ?').bind(promoId, auth.user.id),
    ]);
    return json({ deleted: true, promotionId: promoId });
  }

  if (sub === '/payments') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const payments = await env.DB.prepare(
      `SELECT id, target_type, target_id, plan_code, billing_cycle, stars_amount, currency,
              invoice_url, telegram_payment_charge_id, status, paid_at, expires_at, created_at
       FROM telegram_stars_payments
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
    )
      .bind(auth.user.id)
      .all();
    return json({ payments: payments.results });
  }

  if (sub.startsWith('/payments/') && sub.endsWith('/cancel')) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const paymentId = decodeURIComponent(sub.slice('/payments/'.length, -'/cancel'.length));
    const payment = await env.DB.prepare(
      'SELECT * FROM telegram_stars_payments WHERE id = ? AND user_id = ?'
    )
      .bind(paymentId, auth.user.id)
      .first<Record<string, unknown>>();
    if (!payment) return json({ error: 'Payment invoice not found.' }, 404);
    if (payment.status !== 'pending') {
      return json({ cancelled: false, status: payment.status });
    }
    await env.DB.prepare(
      "UPDATE telegram_stars_payments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
      .bind(payment.id)
      .run();
    if (payment.target_type === 'subscription') {
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'"
      )
        .bind(payment.target_id)
        .run();
    } else if (payment.target_type === 'promotion') {
      await env.DB.prepare(
        "UPDATE promotions SET status = 'rejected' WHERE id = ? AND status = 'pending'"
      )
        .bind(payment.target_id)
        .run();
    }
    return json({ cancelled: true, status: 'cancelled' });
  }

  return json({ error: 'Seller API endpoint not found.' }, 404);
}
