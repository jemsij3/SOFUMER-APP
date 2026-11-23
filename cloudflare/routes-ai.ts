import {
  type Env,
  checkEdgeRateLimit,
  getActiveSubscriptionEdge,
  json,
  methodNotAllowed,
  newId,
  parseJsonBody,
  requireEdgeUser,
  sanitizeText,
} from './helpers.ts';
import {
  coerceAiString,
  coerceAiStringList,
  estimateTokens,
  normalizeAiJsonObject,
  normalizeAiText,
  resolveActiveCfAiModel,
  runWorkersAiWithJsonFallback,
  sanitizeAiErrorForUser,
  type WorkersAiMessage,
} from './ai-normalizer.ts';

async function checkEdgeAiPermission(env: Env, userId: string, featureKey: string) {
  const defaultModel = resolveActiveCfAiModel(env.CLOUDFLARE_AI_MODEL);

  const globalSetting = await env.DB!.prepare(
    "SELECT is_enabled, model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'"
  ).first<{ is_enabled: number; model_name: string }>();

  if (!globalSetting || !globalSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'AI services are currently disabled globally by platform administrators.',
      modelName: resolveActiveCfAiModel(globalSetting?.model_name, defaultModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const featureSetting = await env.DB!.prepare(
    'SELECT is_enabled, model_name, daily_limit_per_user FROM ai_feature_settings WHERE feature_key = ?'
  )
    .bind(featureKey)
    .first<{ is_enabled: number; model_name: string; daily_limit_per_user: number }>();

  if (featureSetting && !featureSetting.is_enabled) {
    return {
      allowed: false,
      reason: `The "${featureKey}" AI feature is currently disabled by administrators.`,
      modelName: resolveActiveCfAiModel(featureSetting.model_name, globalSetting.model_name, defaultModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const userPerm = await env.DB!.prepare(
    'SELECT ai_enabled, custom_daily_limit, reason FROM ai_permissions WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ ai_enabled: number; custom_daily_limit: number | null; reason: string }>();

  if (userPerm && !userPerm.ai_enabled) {
    return {
      allowed: false,
      reason: userPerm.reason || 'Your AI access has been restricted by an administrator.',
      modelName: resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, defaultModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const activeSub = await getActiveSubscriptionEdge(env.DB!, { userId });
  const subDailyLimit = activeSub ? Number(activeSub.ai_daily_limit) : null;

  const dailyLimit =
    userPerm?.custom_daily_limit ??
    subDailyLimit ??
    featureSetting?.daily_limit_per_user ??
    25;

  const usedRow = await env.DB!.prepare(
    `SELECT COUNT(*) as cnt FROM ai_usage
     WHERE user_id = ? AND status = 'success' AND date(created_at) = date('now')`
  )
    .bind(userId)
    .first<{ cnt: number }>();

  const usedToday = usedRow?.cnt || 0;
  if (usedToday >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily AI usage limit reached (${usedToday}/${dailyLimit}).`,
      modelName: resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, defaultModel),
      dailyLimit,
      usedToday,
    };
  }

  const modelName = resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, defaultModel);

  return {
    allowed: true,
    modelName,
    dailyLimit,
    usedToday,
  };
}

async function logEdgeAiUsage(
  env: Env,
  userId: string,
  featureKey: string,
  modelName: string,
  promptSummary: string,
  status: 'success' | 'denied' | 'error',
  latencyMs: number,
  tokensEstimated = 0,
  errorMessage = ''
) {
  await env.DB!.prepare(
    `INSERT INTO ai_usage (id, user_id, feature_key, model_name, prompt_summary, tokens_estimated, status, error_message, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('ai'),
      userId,
      featureKey,
      modelName,
      promptSummary.slice(0, 240),
      tokensEstimated,
      status,
      errorMessage.slice(0, 400),
      latencyMs
    )
    .run();
}

async function runEdgeAiText(
  env: Env,
  modelName: string,
  messages: WorkersAiMessage[],
  maxTokens = 900
): Promise<{ text: string; estimatedTokens: number }> {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding (env.AI) is not configured.');
  }
  const rawOutput = await runWorkersAiWithJsonFallback(env.AI, modelName, messages, false, maxTokens, 0.2);
  const text = await normalizeAiText(rawOutput);
  return {
    text,
    estimatedTokens: estimateTokens(text),
  };
}

async function runEdgeAiJson(
  env: Env,
  modelName: string,
  messages: WorkersAiMessage[],
  maxTokens = 900
): Promise<{ data: Record<string, unknown>; estimatedTokens: number }> {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding (env.AI) is not configured.');
  }
  const rawOutput = await runWorkersAiWithJsonFallback(env.AI, modelName, messages, true, maxTokens, 0.2);
  return await normalizeAiJsonObject(rawOutput);
}

function normalizeFaqs(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  const faqs: Array<{ question: string; answer: string }> = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const question = coerceAiString(rec.question);
      const answer = coerceAiString(rec.answer);
      if (question && answer) {
        faqs.push({ question, answer });
      }
    }
    if (faqs.length >= 8) break;
  }
  return faqs;
}

export async function handleAiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/ai/')) return null;
  const auth = await requireEdgeUser(request, env);
  if ('error' in auth) return auth.error;
  const userId = auth.user.id;

  if (request.method === 'POST') {
    const limited = await checkEdgeRateLimit(request, env, 'ai', 60, 60, userId);
    if (limited) return limited;
  }

  if (url.pathname === '/api/ai/status') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const featuresRes = await env.DB!.prepare(
      'SELECT feature_key, label, is_enabled, daily_limit_per_user, model_name FROM ai_feature_settings'
    ).all();
    const check = await checkEdgeAiPermission(env, userId, 'buyer_search');
    return json({
      allowed: check.allowed,
      reason: check.reason || null,
      dailyLimit: check.dailyLimit,
      usedToday: check.usedToday,
      modelName: check.modelName,
      features: featuresRes.results,
    });
  }

  if (url.pathname === '/api/ai/buyer/discover') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{ query?: string }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const query = sanitizeText(parsedBody.data.query || '', 600);
    if (!query) return json({ error: 'Search prompt is required.' }, 400);

    const perm = await checkEdgeAiPermission(env, userId, 'buyer_search');
    if (!perm.allowed) {
      await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
      return json({ error: perm.reason || 'AI access denied' }, 403);
    }

    const catalogRes = await env.DB!.prepare(
      `SELECT p.id, p.title, p.description, p.price, p.currency, p.listing_type, p.condition,
              p.country_code, p.international_shipping, c.name as category_name, s.name as shop_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN shops s ON s.id = p.shop_id
       WHERE p.status = 'published' AND s.status = 'active'
       ORDER BY p.is_featured DESC, p.created_at DESC LIMIT 120`
    ).all<Record<string, unknown>>();
    const catalog = catalogRes.results;

    const catalogForPrompt = catalog.map((item) => ({
      id: item.id,
      title: item.title,
      description: String(item.description || '').slice(0, 220),
      price: item.price,
      currency: item.currency,
      listing_type: item.listing_type,
      condition: item.condition,
      country_code: item.country_code,
      international_shipping: item.international_shipping,
      category_name: item.category_name,
      shop_name: item.shop_name,
    }));

    try {
      const { data: parsed, estimatedTokens } = await runEdgeAiJson(env, perm.modelName, [
        {
          role: 'system',
          content:
            'You are the SOFUMER Marketplace AI Shopping Assistant. STRICT RULE: Only reference products present in the provided SOFUMER catalog JSON. NEVER invent products, prices, ratings, or sellers. Respond ONLY with valid JSON: {"answer": string, "matchedProductIds": string[], "suggestedFollowUps": string[]}.',
        },
        {
          role: 'user',
          content: `Buyer query: "${query}"\n\nCatalog JSON:\n${JSON.stringify(catalogForPrompt)}`,
        },
      ]);

      const validIds = new Set(catalog.map((c) => String(c.id)));
      const matchedIds = Array.isArray(parsed.matchedProductIds)
        ? parsed.matchedProductIds.filter((id: unknown) => validIds.has(String(id))).map(String)
        : [];
      const matchedSet = new Set(matchedIds);
      const matchedProducts = catalog.filter((c) => matchedSet.has(String(c.id)));

      const answer =
        coerceAiString(parsed.answer) ||
        (matchedProducts.length > 0
          ? `Found ${matchedProducts.length} matching published listing${matchedProducts.length === 1 ? '' : 's'} on SOFUMER.`
          : 'No published listings in the current SOFUMER catalog matched your query.');

      await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'success', Date.now() - start, estimatedTokens);
      return json({
        answer,
        matchedProducts,
        suggestedFollowUps: coerceAiStringList(parsed.suggestedFollowUps, 3),
        catalogCount: catalog.length,
        provider: 'cloudflare-workers-ai',
        model: perm.modelName,
      });
    } catch (err) {
      const { internalMessage, userMessage } = sanitizeAiErrorForUser(err);
      await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, internalMessage);
      return json({ error: userMessage }, 502);
    }
  }

  if (url.pathname === '/api/ai/buyer/compare') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{ productIds?: string[]; focusQuestion?: string }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const productIds = Array.isArray(parsedBody.data.productIds)
      ? parsedBody.data.productIds.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, 4)
      : [];
    if (!productIds.length) return json({ error: 'Select 1 to 4 listings to compare.' }, 400);

    const perm = await checkEdgeAiPermission(env, userId, 'buyer_compare');
    if (!perm.allowed) {
      await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, 'compare', 'denied', Date.now() - start, 0, perm.reason || 'Denied');
      return json({ error: perm.reason || 'AI access denied' }, 403);
    }

    const placeholders = productIds.map(() => '?').join(',');
    const productsRes = await env.DB!.prepare(
      `SELECT p.*, c.name as category_name, s.name as shop_name FROM products p
       JOIN categories c ON c.id = p.category_id JOIN shops s ON s.id = p.shop_id
       WHERE p.id IN (${placeholders}) AND p.status = 'published' AND s.status = 'active'`
    )
      .bind(...productIds)
      .all<Record<string, unknown>>();
    if (!productsRes.results.length) return json({ error: 'No published listings found.' }, 404);

    const focusQuestion = sanitizeText(parsedBody.data.focusQuestion || '', 400);

    try {
      const { text: comparison, estimatedTokens } = await runEdgeAiText(env, perm.modelName, [
        {
          role: 'system',
          content: 'Compare real SOFUMER listings strictly using the provided JSON fields without inventing specs.',
        },
        {
          role: 'user',
          content: `Compare these listings.${focusQuestion ? ` Focus: ${focusQuestion}` : ''}\n${JSON.stringify(productsRes.results)}`,
        },
      ]);
      await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'success', Date.now() - start, estimatedTokens);
      return json({ comparison, products: productsRes.results, provider: 'cloudflare-workers-ai', model: perm.modelName });
    } catch (err) {
      const { internalMessage, userMessage } = sanitizeAiErrorForUser(err);
      await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, internalMessage);
      return json({ error: userMessage }, 502);
    }
  }

  if (url.pathname === '/api/ai/seller/assist') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{
      action?: 'generate_listing' | 'translate' | 'analytics';
      title?: string;
      notes?: string;
      listingType?: string;
      targetLanguage?: string;
    }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const body = parsedBody.data;
    if (!body.action || !['generate_listing', 'translate', 'analytics'].includes(body.action)) {
      return json({ error: 'Invalid seller AI action.' }, 400);
    }

    const title = sanitizeText(body.title || '', 140);
    const notes = sanitizeText(body.notes || '', 2500);
    const listingType = sanitizeText(body.listingType || 'physical', 24) || 'physical';
    const targetLanguage = sanitizeText(body.targetLanguage || 'French', 40) || 'French';

    const featureKey =
      body.action === 'translate'
        ? 'seller_translate'
        : body.action === 'analytics'
        ? 'seller_analytics'
        : 'seller_listing';

    const perm = await checkEdgeAiPermission(env, userId, featureKey);
    if (!perm.allowed) {
      await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.action, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
      return json({ error: perm.reason || 'AI access denied' }, 403);
    }

    try {
      if (body.action === 'translate') {
        if (!title && !notes) {
          return json({ error: 'Enter a listing title or description to translate.' }, 400);
        }
        const { data: parsed, estimatedTokens } = await runEdgeAiJson(env, perm.modelName, [
          {
            role: 'system',
            content: 'Translate listing accurately. Respond ONLY with JSON: {"translatedTitle": string, "translatedDescription": string}.',
          },
          {
            role: 'user',
            content: `Target: ${targetLanguage}\nTitle: ${title}\nDescription: ${notes}`,
          },
        ]);
        const translatedTitle = coerceAiString(parsed.translatedTitle, title);
        const translatedDescription = coerceAiString(parsed.translatedDescription, notes);
        await logEdgeAiUsage(env, userId, featureKey, perm.modelName, `translate:${targetLanguage}`, 'success', Date.now() - start, estimatedTokens);
        return json({
          translatedTitle,
          translatedDescription,
          targetLanguage,
          provider: 'cloudflare-workers-ai',
          model: perm.modelName,
        });
      }

      if (body.action === 'analytics') {
        const activeShop = await env.DB!.prepare(
          "SELECT id FROM shops WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1"
        )
          .bind(userId)
          .first<{ id: string }>();
        if (!activeShop) {
          return json({ error: 'Active shop required to view AI shop analytics.' }, 403);
        }
        const stats = await env.DB!.prepare(
          `SELECT s.name,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as published_products,
                  (SELECT COALESCE(SUM(view_count), 0) FROM products p WHERE p.shop_id = s.id) as total_views,
                  (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) as total_orders
           FROM shops s WHERE s.id = ? LIMIT 1`
        )
          .bind(activeShop.id)
          .first();
        const { text: insights, estimatedTokens } = await runEdgeAiText(env, perm.modelName, [
          { role: 'system', content: 'Interpret real SOFUMER shop metrics without inventing numbers.' },
          { role: 'user', content: JSON.stringify(stats || {}) },
        ]);
        await logEdgeAiUsage(env, userId, featureKey, perm.modelName, 'shop_analytics', 'success', Date.now() - start, estimatedTokens);
        return json({ insights, stats, provider: 'cloudflare-workers-ai', model: perm.modelName });
      }

      if (!title && !notes) {
        return json({ error: 'Enter a product title or notes so AI can draft a listing.' }, 400);
      }
      const cats = await env.DB!.prepare('SELECT id, name FROM categories WHERE is_active = 1').all<{ id: string; name: string }>();
      const validCatIds = new Set(cats.results.map((c) => String(c.id)));
      const { data: parsed, estimatedTokens } = await runEdgeAiJson(env, perm.modelName, [
        {
          role: 'system',
          content:
            'Generate a seller listing draft for review. Respond ONLY with valid JSON: {"suggestedTitle": string, "improvedDescription": string, "suggestedCategoryId": string, "keywords": string[], "faqs": [{"question": string, "answer": string}]}.',
        },
        {
          role: 'user',
          content: `Type: ${listingType}\nTitle: ${title}\nNotes: ${notes}\nCategories: ${JSON.stringify(cats.results)}`,
        },
      ]);
      const rawCatId = coerceAiString(parsed.suggestedCategoryId);
      const suggestedCategoryId = validCatIds.has(rawCatId) ? rawCatId : '';

      await logEdgeAiUsage(env, userId, featureKey, perm.modelName, title || 'listing_draft', 'success', Date.now() - start, estimatedTokens);
      return json({
        suggestedTitle: coerceAiString(parsed.suggestedTitle, title),
        improvedDescription: coerceAiString(parsed.improvedDescription, notes),
        suggestedCategoryId,
        keywords: coerceAiStringList(parsed.keywords, 12),
        faqs: normalizeFaqs(parsed.faqs),
        provider: 'cloudflare-workers-ai',
        model: perm.modelName,
      });
    } catch (err) {
      const { internalMessage, userMessage } = sanitizeAiErrorForUser(err);
      await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.action, 'error', Date.now() - start, 0, internalMessage);
      return json({ error: userMessage }, 502);
    }
  }

  if (url.pathname === '/api/ai/platform/support') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{ question?: string }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const question = sanitizeText(parsedBody.data.question || '', 800);
    if (!question) return json({ error: 'Question is required.' }, 400);

    const perm = await checkEdgeAiPermission(env, userId, 'platform_support');
    if (!perm.allowed) {
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
      return json({ error: perm.reason || 'AI access denied' }, 403);
    }

    try {
      const { text: reply, estimatedTokens } = await runEdgeAiText(env, perm.modelName, [
        {
          role: 'system',
          content:
            'You are SOFUMER Platform Support AI. Explain SOFUMER marketplace features accurately: direct buyer-to-seller transactions (no escrow), physical/digital/service listings, Free/Pro/Business plans, and listing moderation reporting.',
        },
        { role: 'user', content: question },
      ]);
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'success', Date.now() - start, estimatedTokens);
      return json({ reply, provider: 'cloudflare-workers-ai', model: perm.modelName });
    } catch (err) {
      const { internalMessage, userMessage } = sanitizeAiErrorForUser(err);
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, internalMessage);
      return json({ error: userMessage }, 502);
    }
  }

  return json({ error: 'AI API endpoint not found.' }, 404);
}

