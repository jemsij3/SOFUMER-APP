import {
  type Env,
  json,
  methodNotAllowed,
  newId,
  parseJsonBody,
  requireEdgeUser,
} from './helpers.ts';

async function checkEdgeAiPermission(env: Env, userId: string, featureKey: string) {
  const defaultModel = env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';

  const globalSetting = await env.DB!.prepare(
    "SELECT is_enabled, model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'"
  ).first<{ is_enabled: number; model_name: string }>();

  if (!globalSetting || !globalSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'AI services are currently disabled globally by platform administrators.',
      modelName: globalSetting?.model_name || defaultModel,
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
      modelName: featureSetting.model_name || defaultModel,
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
      modelName: featureSetting?.model_name || defaultModel,
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const subRow = await env.DB!.prepare(
    `SELECT sp.ai_daily_limit FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ ai_daily_limit: number }>();

  const dailyLimit =
    userPerm?.custom_daily_limit ??
    subRow?.ai_daily_limit ??
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
      modelName: featureSetting?.model_name || defaultModel,
      dailyLimit,
      usedToday,
    };
  }

  return {
    allowed: true,
    modelName: env.CLOUDFLARE_AI_MODEL || featureSetting?.model_name || globalSetting.model_name || defaultModel,
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

function parseJsonFromAi(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(candidate) as Record<string, unknown>;
}

async function runEdgeAi(
  env: Env,
  modelName: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  expectJson = false
): Promise<string> {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding (env.AI) is not configured.');
  }
  const out = await env.AI.run(modelName, {
    messages,
    max_tokens: 900,
    temperature: 0.2,
    ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
  });
  return out?.response ?? out?.result?.response ?? '';
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
    const query = String(parsedBody.data.query || '').trim().slice(0, 600);
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

    try {
      const raw = await runEdgeAi(
        env,
        perm.modelName,
        [
          {
            role: 'system',
            content:
              'You are the SOFUMER Marketplace AI Shopping Assistant. STRICT RULE: Only reference products present in the provided SOFUMER catalog JSON. NEVER invent products, prices, ratings, or sellers. Respond ONLY with valid JSON: {"answer": string, "matchedProductIds": string[], "suggestedFollowUps": string[]}.',
          },
          {
            role: 'user',
            content: `Buyer query: "${query}"\n\nCatalog JSON:\n${JSON.stringify(catalog)}`,
          },
        ],
        true
      );
      const parsed = parseJsonFromAi(raw);
      const validIds = new Set(catalog.map((c) => String(c.id)));
      const matchedIds = Array.isArray(parsed.matchedProductIds)
        ? parsed.matchedProductIds.filter((id: unknown) => validIds.has(String(id)))
        : [];
      const matchedProducts = catalog.filter((c) => matchedIds.includes(String(c.id)));

      await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'success', Date.now() - start, Math.ceil(raw.length / 4));
      return json({
        answer: String(parsed.answer || ''),
        matchedProducts,
        suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) ? parsed.suggestedFollowUps.slice(0, 3) : [],
        catalogCount: catalog.length,
        provider: 'cloudflare-workers-ai',
        model: perm.modelName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Workers AI error';
      await logEdgeAiUsage(env, userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, msg);
      return json({ error: msg }, 502);
    }
  }

  if (url.pathname === '/api/ai/buyer/compare') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{ productIds?: string[]; focusQuestion?: string }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const productIds = Array.isArray(parsedBody.data.productIds) ? parsedBody.data.productIds.slice(0, 4) : [];
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
       WHERE p.id IN (${placeholders}) AND p.status = 'published'`
    )
      .bind(...productIds)
      .all<Record<string, unknown>>();
    if (!productsRes.results.length) return json({ error: 'No published listings found.' }, 404);

    try {
      const comparison = await runEdgeAi(env, perm.modelName, [
        {
          role: 'system',
          content: 'Compare real SOFUMER listings strictly using the provided JSON fields without inventing specs.',
        },
        {
          role: 'user',
          content: `Compare these listings.${parsedBody.data.focusQuestion ? ` Focus: ${parsedBody.data.focusQuestion}` : ''}\n${JSON.stringify(productsRes.results)}`,
        },
      ]);
      await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'success', Date.now() - start, Math.ceil(comparison.length / 4));
      return json({ comparison, products: productsRes.results, provider: 'cloudflare-workers-ai', model: perm.modelName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Workers AI comparison error';
      await logEdgeAiUsage(env, userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, msg);
      return json({ error: msg }, 502);
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
        const raw = await runEdgeAi(
          env,
          perm.modelName,
          [
            {
              role: 'system',
              content: 'Translate listing accurately. Respond ONLY with JSON: {"translatedTitle": string, "translatedDescription": string}.',
            },
            {
              role: 'user',
              content: `Target: ${body.targetLanguage || 'French'}\nTitle: ${body.title || ''}\nDescription: ${body.notes || ''}`,
            },
          ],
          true
        );
        await logEdgeAiUsage(env, userId, featureKey, perm.modelName, `translate:${body.targetLanguage}`, 'success', Date.now() - start, Math.ceil(raw.length / 4));
        return json(parseJsonFromAi(raw));
      }

      if (body.action === 'analytics') {
        const stats = await env.DB!.prepare(
          `SELECT s.name,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as published_products,
                  (SELECT COALESCE(SUM(view_count), 0) FROM products p WHERE p.shop_id = s.id) as total_views,
                  (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) as total_orders
           FROM shops s WHERE s.user_id = ? LIMIT 1`
        )
          .bind(userId)
          .first();
        const insights = await runEdgeAi(env, perm.modelName, [
          { role: 'system', content: 'Interpret real SOFUMER shop metrics without inventing numbers.' },
          { role: 'user', content: JSON.stringify(stats || {}) },
        ]);
        await logEdgeAiUsage(env, userId, featureKey, perm.modelName, 'shop_analytics', 'success', Date.now() - start, Math.ceil(insights.length / 4));
        return json({ insights, stats, provider: 'cloudflare-workers-ai', model: perm.modelName });
      }

      const cats = await env.DB!.prepare('SELECT id, name FROM categories WHERE is_active = 1').all();
      const raw = await runEdgeAi(
        env,
        perm.modelName,
        [
          {
            role: 'system',
            content:
              'Generate a seller listing draft for review. Respond ONLY with valid JSON: {"suggestedTitle": string, "improvedDescription": string, "suggestedCategoryId": string, "keywords": string[], "faqs": [{"question": string, "answer": string}]}.',
          },
          {
            role: 'user',
            content: `Type: ${body.listingType || 'physical'}\nTitle: ${body.title || ''}\nNotes: ${body.notes || ''}\nCategories: ${JSON.stringify(cats.results)}`,
          },
        ],
        true
      );
      await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.title || 'listing_draft', 'success', Date.now() - start, Math.ceil(raw.length / 4));
      return json(parseJsonFromAi(raw));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Workers AI seller assist failed';
      await logEdgeAiUsage(env, userId, featureKey, perm.modelName, body.action, 'error', Date.now() - start, 0, msg);
      return json({ error: msg }, 502);
    }
  }

  if (url.pathname === '/api/ai/platform/support') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const start = Date.now();
    const parsedBody = await parseJsonBody<{ question?: string }>(request);
    if (!parsedBody.ok) return parsedBody.error;
    const question = String(parsedBody.data.question || '').trim().slice(0, 800);
    if (!question) return json({ error: 'Question is required.' }, 400);

    const perm = await checkEdgeAiPermission(env, userId, 'platform_support');
    if (!perm.allowed) {
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
      return json({ error: perm.reason || 'AI access denied' }, 403);
    }

    try {
      const reply = await runEdgeAi(env, perm.modelName, [
        {
          role: 'system',
          content:
            'You are SOFUMER Platform Support AI. Explain SOFUMER marketplace features accurately: direct buyer-to-seller transactions (no escrow), physical/digital/service listings, Free/Pro/Business plans, and listing moderation reporting.',
        },
        { role: 'user', content: question },
      ]);
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'success', Date.now() - start, Math.ceil(reply.length / 4));
      return json({ reply, provider: 'cloudflare-workers-ai', model: perm.modelName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Workers AI support failed';
      await logEdgeAiUsage(env, userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, msg);
      return json({ error: msg }, 502);
    }
  }

  return json({ error: 'AI API endpoint not found.' }, 404);
}
