import {
  type Env,
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
  requireEdgeSeller,
  requireEdgeUser,
  sanitizeSafeUrl,
  sanitizeText,
  slugify,
} from './helpers.ts';

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

  if (sub === '/register') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
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
    const existing = await env.DB.prepare('SELECT id FROM seller_profiles WHERE user_id = ?')
      .bind(user.id)
      .first();
    if (existing) {
      return json({ error: 'You already have a registered seller profile.' }, 409);
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

    const sellerId = newId('sel');
    const shopId = newId('shop');
    const baseSlug = slugify(shopName);
    const slugConflict = await env.DB.prepare('SELECT id FROM shops WHERE slug = ?').bind(baseSlug).first();
    const shopSlug = slugConflict ? `${baseSlug}-${shopId.slice(-5)}` : baseSlug;

    await env.DB.prepare(
      `INSERT INTO seller_profiles (id, user_id, seller_type, legal_name, business_registration_no, country_code, contact_email, contact_phone, contact_telegram)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(sellerId, user.id, sellerType, legalName, businessRegistrationNo, countryCode, contactEmail, contactPhone, contactTelegram)
      .run();

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
    const shop = await env.DB.prepare('SELECT * FROM shops WHERE seller_id = ?')
      .bind(sellerProfile.id)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

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
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeSeller(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const shop = await env.DB.prepare('SELECT * FROM shops WHERE user_id = ?')
      .bind(auth.user.id)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

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

    const shop = await env.DB.prepare('SELECT * FROM shops WHERE seller_id = ?')
      .bind(auth.seller.id)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

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
                (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) as primary_image,
                COALESCE(inv.stock_quantity, 1) as stock_quantity,
                COALESCE(inv.availability_status, 'in_stock') as availability_status,
                EXISTS(SELECT 1 FROM product_digital_assets da WHERE da.product_id = p.id) as has_digital_package
         FROM products p JOIN categories c ON c.id = p.category_id
         LEFT JOIN product_inventory inv ON inv.product_id = p.id
         WHERE p.seller_user_id = ? ORDER BY p.updated_at DESC`
      )
        .bind(auth.user.id)
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
      const shop = await env.DB.prepare('SELECT * FROM shops WHERE user_id = ?')
        .bind(userId)
        .first<Record<string, unknown>>();
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
      const rawImages = Array.isArray(body.data.images) ? body.data.images.slice(0, 6) : [];
      for (const u of rawImages) {
        if (!isSafeUrlOrEmpty(u, 300)) {
          return json({ error: 'Product image URLs must use http(s) or a valid relative path.' }, 400);
        }
      }
      const images: string[] = rawImages.map((u: unknown) => sanitizeSafeUrl(u, 300)).filter(Boolean);
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

      for (let idx = 0; idx < images.length; idx++) {
        await env.DB.prepare(
          `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(newId('img'), productId, images[idx], title, idx, idx === 0 ? 1 : 0)
          .run();
      }

      const created = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first();
      return json({ product: created, moderationNotes }, 201);
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

    return methodNotAllowed(['GET', 'POST']);
  }

  if (sub.startsWith('/products/')) {
    const productId = decodeURIComponent(sub.slice('/products/'.length));
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
      const nextStatusInput = body.data.status ? String(body.data.status) : String(existing.status);

      let finalStatus = String(existing.status);
      if (['draft', 'published', 'archived'].includes(nextStatusInput)) {
        finalStatus = nextStatusInput;
        if (finalStatus === 'published') {
          const flagged = await checkProhibitedKeywordsEdge(env, `${title} ${description}`);
          if (flagged.length > 0) finalStatus = 'pending_review';
        }
      }

      await env.DB.prepare(
        `UPDATE products
         SET title = ?, description = ?, price = ?, currency = ?,
             shipping_info = ?, international_shipping = ?, return_policy = ?,
             delivery_timeframe = ?, status = ?, updated_at = datetime('now')
         WHERE id = ? AND seller_user_id = ?`
      )
        .bind(
          title,
          description,
          price,
          currency,
          sanitizeText(body.data.shippingInfo ?? existing.shipping_info, 500),
          body.data.internationalShipping !== undefined
            ? body.data.internationalShipping
              ? 1
              : 0
            : existing.international_shipping,
          sanitizeText(body.data.returnPolicy ?? existing.return_policy, 500),
          sanitizeText(body.data.deliveryTimeframe ?? existing.delivery_timeframe, 120),
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

      if (Array.isArray(body.data.images)) {
        const rawImgs = body.data.images.slice(0, 6);
        for (const u of rawImgs) {
          if (!isSafeUrlOrEmpty(u, 300)) {
            return json({ error: 'Product image URLs must use http(s) or a valid relative path.' }, 400);
          }
        }
        const imgs = rawImgs.map((u: unknown) => sanitizeSafeUrl(u, 300)).filter(Boolean);
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

      const updated = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(existing.id).first();
      return json({ product: updated });
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

      await env.DB.batch([
        env.DB.prepare('UPDATE conversations SET product_id = NULL WHERE product_id = ?').bind(productId),
        env.DB.prepare('UPDATE promotions SET product_id = NULL WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM digital_download_logs WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_digital_assets WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM inquiries WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_favorites WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM recently_viewed WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_variants WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_images WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM product_inventory WHERE product_id = ?').bind(productId),
        env.DB.prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?').bind(productId, auth.user.id),
      ]);

      return json({ deleted: true, archived: false });
    }

    return methodNotAllowed(['PATCH', 'DELETE']);
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

    const shop = await env.DB.prepare('SELECT * FROM shops WHERE user_id = ?')
      .bind(auth.user.id)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

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

    const shop = await env.DB.prepare('SELECT * FROM shops WHERE user_id = ?')
      .bind(auth.user.id)
      .first<Record<string, unknown>>();
    if (!shop) return json({ error: 'Shop not found.' }, 404);

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
