import {
  type Env,
  checkProhibitedKeywordsEdge,
  json,
  methodNotAllowed,
  newId,
  notifyUserAndTelegramEdge,
  parseJsonBody,
  requireEdgeSeller,
  requireEdgeUser,
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
    const logoUrl = sanitizeText(body.data.logoUrl || '', 300);
    const bannerUrl = sanitizeText(body.data.bannerUrl || '', 300);
    const defaultCurrency = sanitizeText(body.data.defaultCurrency || 'USD', 6).toUpperCase();

    if (!legalName || !shopName) {
      return json({ error: 'Seller name and shop name are required.' }, 400);
    }

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
      .bind(shopId, sellerId, user.id, shopSlug, shopName, description, countryCode, logoUrl, bannerUrl, defaultCurrency)
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

    const [subscription, stats, promotions, verifications] = await Promise.all([
      env.DB.prepare(
        `SELECT s.*, sp.code as plan_code, sp.name as plan_name, sp.max_products, sp.ai_daily_limit,
                sp.featured_slots, sp.promotional_discount_pct, sp.analytics_level
         FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.seller_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`
      )
        .bind(sellerProfile.id)
        .first(),
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
    ]);

    return json({
      sellerProfile,
      shop,
      subscription,
      stats,
      promotions: promotions.results,
      verifications: verifications.results,
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

    const name = sanitizeText(body.data.name ?? shop.name, 80);
    const description = sanitizeText(body.data.description ?? shop.description, 1200);
    const logoUrl = sanitizeText(body.data.logoUrl ?? shop.logo_url, 300);
    const bannerUrl = sanitizeText(body.data.bannerUrl ?? shop.banner_url, 300);
    const returnPolicy = sanitizeText(body.data.returnPolicy ?? shop.return_policy, 600);
    const shippingPolicy = sanitizeText(body.data.shippingPolicy ?? shop.shipping_policy, 600);
    const defaultCurrency = sanitizeText(body.data.defaultCurrency ?? shop.default_currency, 6).toUpperCase();
    const countryCode = sanitizeText(body.data.countryCode ?? shop.country_code, 4).toUpperCase();

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
                COALESCE(inv.availability_status, 'in_stock') as availability_status
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

      const subRow = await env.DB.prepare(
        `SELECT sp.max_products FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.user_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`
      )
        .bind(userId)
        .first<{ max_products: number }>();
      const maxProducts = subRow?.max_products ?? 10;
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

      if (!title || !description || !categoryId || Number.isNaN(price) || price < 0) {
        return json({ error: 'Title, description, category, and valid price are required.' }, 400);
      }

      const catExists = await env.DB.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1')
        .bind(categoryId)
        .first();
      if (!catExists) return json({ error: 'Selected category does not exist.' }, 400);

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
      const images: string[] = Array.isArray(body.data.images)
        ? body.data.images.map((u: unknown) => sanitizeText(u, 300)).filter(Boolean).slice(0, 6)
        : [];
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
          sanitizeText(body.data.countryCode || String(shop.country_code), 4).toUpperCase(),
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
      const currency = sanitizeText(body.data.currency ?? existing.currency, 6).toUpperCase();
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
          `UPDATE product_inventory SET stock_quantity = ?, availability_status = ?, updated_at = datetime('now') WHERE product_id = ?`
        )
          .bind(qty, avail, existing.id)
          .run();
      }

      if (Array.isArray(body.data.images)) {
        const imgs = body.data.images.map((u: unknown) => sanitizeText(u, 300)).filter(Boolean).slice(0, 6);
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
      const res = await env.DB.prepare('DELETE FROM products WHERE id = ? AND seller_user_id = ?')
        .bind(productId, auth.user.id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        return json({ error: 'Listing not found or unauthorized.' }, 404);
      }
      return json({ deleted: true });
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

    const price = billingCycle === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
    const subId = newId('sub');
    const endsAt =
      billingCycle === 'annual'
        ? new Date(Date.now() + 365 * 86400_000).toISOString()
        : new Date(Date.now() + 30 * 86400_000).toISOString();

    await env.DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE seller_id = ? AND status = 'active'")
      .bind(auth.seller.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, seller_id, user_id, plan_id, billing_cycle, amount_recorded, currency, status, payment_reference, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
      .bind(subId, auth.seller.id, auth.user.id, plan.id, billingCycle, price, plan.currency, `SUB-${subId.slice(-6).toUpperCase()}`, endsAt)
      .run();

    await notifyUserAndTelegramEdge(
      env,
      auth.user.id,
      'subscription',
      `SOFUMER Plan Updated: ${String(plan.name)}`,
      `Your seller account is now on the ${String(plan.name)} plan (${billingCycle}).`,
      url.origin
    );

    return json({ subscriptionId: subId, planCode, billingCycle, amountRecorded: price }, 201);
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

    const [basePriceRow, planDiscountRow] = await Promise.all([
      env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(settingKey).first<{ value: string }>(),
      env.DB.prepare(
        `SELECT sp.promotional_discount_pct FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.user_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`
      )
        .bind(auth.user.id)
        .first<{ promotional_discount_pct: number }>(),
    ]);

    const base7dPrice = Number(basePriceRow?.value || 15);
    const discountPct = planDiscountRow?.promotional_discount_pct || 0;
    const computedPrice = Number(((base7dPrice * (durationDays / 7)) * (1 - discountPct / 100)).toFixed(2));
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

    return json({ promotionId: promoId, priceAmount: computedPrice, status: 'pending' }, 201);
  }

  return json({ error: 'Seller API endpoint not found.' }, 404);
}
