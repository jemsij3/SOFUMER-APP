import { db, newId } from './db.ts';
import { getActiveSubscriptionLocal } from './security.ts';
import {
  type WorkersAiBinding,
  type WorkersAiMessage,
  type WorkersAiRawOutput,
  coerceAiString,
  coerceAiStringList,
  estimateTokens,
  normalizeAiJsonObject,
  normalizeAiText,
  resolveActiveCfAiModel,
  runWorkersAiWithJsonFallback,
  sanitizeAiErrorForUser,
} from '../cloudflare/ai-normalizer.ts';

export type { WorkersAiBinding };
export const DEFAULT_CLOUDFLARE_AI_MODEL = resolveActiveCfAiModel(process.env.CLOUDFLARE_AI_MODEL);

let registeredAiBinding: WorkersAiBinding | null = null;

export function setWorkersAiBinding(binding: WorkersAiBinding | null) {
  registeredAiBinding = binding;
}

async function runCloudflareWorkersAiRest(
  accountId: string,
  apiToken: string,
  modelName: string,
  messages: WorkersAiMessage[],
  expectJson: boolean,
  maxTokens: number,
  temperature: number
): Promise<WorkersAiRawOutput> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelName}`;

  const postRun = async (withResponseFormat: boolean) => {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(withResponseFormat ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    const contentType = resp.headers.get('content-type') || '';
    if (resp.ok && (contentType.includes('text/event-stream') || contentType.includes('text/plain'))) {
      return resp.body as ReadableStream<Uint8Array>;
    }

    const payload = (await resp.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: Array<{ message?: string; code?: number }>;
      [key: string]: unknown;
    };

    if (!resp.ok || payload.success === false) {
      const errMsg =
        payload.errors?.[0]?.message || `Cloudflare Workers AI request failed (${resp.status})`;
      throw Object.assign(new Error(errMsg), { status: resp.status });
    }
    return payload as WorkersAiRawOutput;
  };

  if (!expectJson) {
    return await postRun(false);
  }

  try {
    return await postRun(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    const isSchemaFlagRejected =
      msg.includes('response_format') ||
      msg.includes('json_object') ||
      msg.includes('schema') ||
      msg.includes('unsupported property');
    if (isSchemaFlagRejected) {
      return await postRun(false);
    }
    throw err;
  }
}

async function invokeWorkersAiRaw(
  modelName: string,
  messages: WorkersAiMessage[],
  expectJson = false,
  maxTokens = 900,
  temperature = 0.2
): Promise<WorkersAiRawOutput> {
  if (registeredAiBinding) {
    return await runWorkersAiWithJsonFallback(
      registeredAiBinding,
      modelName,
      messages,
      expectJson,
      maxTokens,
      temperature
    );
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare Workers AI is not bound in this local Node.js process. Run via Cloudflare Workers (`env.AI` binding) or configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN for local Workers AI REST execution.'
    );
  }

  return await runCloudflareWorkersAiRest(
    accountId,
    apiToken,
    modelName,
    messages,
    expectJson,
    maxTokens,
    temperature
  );
}

export async function invokeCloudflareWorkersAi(
  modelName: string,
  messages: WorkersAiMessage[],
  expectJson = false,
  maxTokens = 900,
  temperature = 0.2
): Promise<string> {
  const raw = await invokeWorkersAiRaw(modelName, messages, expectJson, maxTokens, temperature);
  return await normalizeAiText(raw);
}

export async function invokeCloudflareWorkersAiJson(
  modelName: string,
  messages: WorkersAiMessage[],
  maxTokens = 900,
  temperature = 0.2
): Promise<{ data: Record<string, unknown>; estimatedTokens: number }> {
  const raw = await invokeWorkersAiRaw(modelName, messages, true, maxTokens, temperature);
  return await normalizeAiJsonObject(raw);
}

export interface AiAccessCheck {
  allowed: boolean;
  reason?: string;
  modelName: string;
  dailyLimit: number;
  usedToday: number;
}

export function checkAiPermission(userId: string, featureKey: string): AiAccessCheck {
  const fallbackModel = resolveActiveCfAiModel(process.env.CLOUDFLARE_AI_MODEL);

  const globalSetting = db
    .prepare("SELECT is_enabled, model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'")
    .get() as { is_enabled: number; model_name: string } | undefined;

  if (!globalSetting || !globalSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'AI services are currently disabled globally by platform administrators.',
      modelName: resolveActiveCfAiModel(globalSetting?.model_name, fallbackModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const featureSetting = db
    .prepare('SELECT is_enabled, model_name, daily_limit_per_user FROM ai_feature_settings WHERE feature_key = ?')
    .get(featureKey) as { is_enabled: number; model_name: string; daily_limit_per_user: number } | undefined;

  if (featureSetting && !featureSetting.is_enabled) {
    return {
      allowed: false,
      reason: `The "${featureKey}" AI feature is currently disabled by administrators.`,
      modelName: resolveActiveCfAiModel(featureSetting.model_name, globalSetting.model_name, fallbackModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const userPerm = db
    .prepare('SELECT ai_enabled, custom_daily_limit, reason FROM ai_permissions WHERE user_id = ?')
    .get(userId) as { ai_enabled: number; custom_daily_limit: number | null; reason: string } | undefined;

  if (userPerm && !userPerm.ai_enabled) {
    return {
      allowed: false,
      reason: userPerm.reason || 'Your AI access has been restricted by an administrator.',
      modelName: resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, fallbackModel),
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  const activeSub = getActiveSubscriptionLocal({ userId });
  const subDailyLimit = activeSub ? Number(activeSub.ai_daily_limit) : null;

  const dailyLimit =
    userPerm?.custom_daily_limit ??
    subDailyLimit ??
    featureSetting?.daily_limit_per_user ??
    25;

  const usedRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM ai_usage
       WHERE user_id = ? AND status = 'success' AND date(created_at) = date('now')`
    )
    .get(userId) as { cnt: number };

  if (usedRow.cnt >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily AI usage limit reached (${usedRow.cnt}/${dailyLimit}). Upgrade your seller plan or wait until tomorrow.`,
      modelName: resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, fallbackModel),
      dailyLimit,
      usedToday: usedRow.cnt,
    };
  }

  const modelName = resolveActiveCfAiModel(featureSetting?.model_name, globalSetting.model_name, fallbackModel);

  return {
    allowed: true,
    modelName,
    dailyLimit,
    usedToday: usedRow.cnt,
  };
}

export function logAiUsage(
  userId: string | null,
  featureKey: string,
  modelName: string,
  promptSummary: string,
  status: 'success' | 'denied' | 'error',
  latencyMs: number,
  tokensEstimated = 0,
  errorMessage = ''
) {
  db.prepare(
    `INSERT INTO ai_usage (id, user_id, feature_key, model_name, prompt_summary, tokens_estimated, status, error_message, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('ai'),
    userId,
    featureKey,
    modelName,
    promptSummary.slice(0, 240),
    tokensEstimated,
    status,
    errorMessage.slice(0, 400),
    latencyMs
  );
}

function normalizeFaqs(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  const faqs: Array<{ question: string; answer: string }> = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const question = coerceAiString(rec.question);
      const answer = coerceAiString(rec.answer);
      if (question && answer) faqs.push({ question, answer });
    }
    if (faqs.length >= 8) break;
  }
  return faqs;
}

export async function runBuyerDiscoveryAi(userId: string, query: string) {
  const start = Date.now();
  const perm = checkAiPermission(userId, 'buyer_search');
  if (!perm.allowed) {
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  const catalog = db
    .prepare(
      `SELECT p.id, p.title, p.description, p.price, p.currency, p.listing_type, p.condition,
              p.country_code, p.international_shipping, p.shipping_info, p.file_format,
              p.service_mode, p.delivery_timeframe, p.return_policy, p.rating_avg,
              c.name as category_name, s.name as shop_name, s.slug as shop_slug, s.verification_status
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN shops s ON s.id = p.shop_id
       WHERE p.status = 'published' AND s.status = 'active'
       ORDER BY p.is_featured DESC, p.created_at DESC
       LIMIT 120`
    )
    .all() as Record<string, unknown>[];

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
    const { data: parsed, estimatedTokens } = await invokeCloudflareWorkersAiJson(perm.modelName, [
      {
        role: 'system',
        content:
          'You are the SOFUMER Marketplace AI Shopping Assistant. STRICT RULE: Only reference products present in the provided SOFUMER catalog JSON. NEVER invent products, prices, ratings, sellers, or availability. If the catalog is empty or no items match, say so honestly. Respond ONLY with a valid JSON object matching: {"answer": string, "matchedProductIds": string[], "suggestedFollowUps": string[]}.',
      },
      {
        role: 'user',
        content: `Buyer query: "${query}"\n\nPublished SOFUMER catalog JSON:\n${JSON.stringify(catalogForPrompt)}`,
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

    const latency = Date.now() - start;
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'success', latency, estimatedTokens);

    return {
      answer,
      matchedProducts,
      suggestedFollowUps: coerceAiStringList(parsed.suggestedFollowUps, 3),
      catalogCount: catalog.length,
      provider: 'cloudflare-workers-ai',
      model: perm.modelName,
    };
  } catch (error) {
    const { internalMessage, userMessage } = sanitizeAiErrorForUser(error);
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, internalMessage);
    throw Object.assign(new Error(userMessage), { statusCode: 503 });
  }
}

export async function runBuyerCompareAi(userId: string, productIds: string[], focusQuestion = '') {
  const start = Date.now();
  const perm = checkAiPermission(userId, 'buyer_compare');
  if (!perm.allowed) {
    logAiUsage(userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  if (!productIds.length || productIds.length > 4) {
    throw Object.assign(new Error('Select between 1 and 4 published listings to compare.'), { statusCode: 400 });
  }

  const placeholders = productIds.map(() => '?').join(',');
  const products = db
    .prepare(
      `SELECT p.*, c.name as category_name, s.name as shop_name, s.country_code as shop_country, s.verification_status
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id IN (${placeholders}) AND p.status = 'published'`
    )
    .all(...productIds) as Record<string, unknown>[];

  if (!products.length) {
    throw Object.assign(new Error('No published listings found for comparison.'), { statusCode: 404 });
  }

  try {
    const comparison = await invokeCloudflareWorkersAi(perm.modelName, [
      {
        role: 'system',
        content:
          'You compare real SOFUMER marketplace listings strictly using the provided JSON fields. Highlight price, currency, delivery/shipping, return policy, and seller country without inventing unstated specs.',
      },
      {
        role: 'user',
        content: `Compare these SOFUMER listings objectively.${focusQuestion ? ` Focus: ${focusQuestion}` : ''}\n\nListings JSON:\n${JSON.stringify(products)}`,
      },
    ]);

    logAiUsage(userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'success', Date.now() - start, estimateTokens(comparison));
    return { comparison, products, provider: 'cloudflare-workers-ai', model: perm.modelName };
  } catch (error) {
    const { internalMessage, userMessage } = sanitizeAiErrorForUser(error);
    logAiUsage(userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, internalMessage);
    throw Object.assign(new Error(userMessage), { statusCode: 503 });
  }
}

export async function runSellerListingAi(
  userId: string,
  payload: {
    action: 'generate_listing' | 'translate' | 'analytics';
    title?: string;
    notes?: string;
    listingType?: string;
    targetLanguage?: string;
    shopId?: string;
  }
) {
  const start = Date.now();
  const featureKey =
    payload.action === 'translate'
      ? 'seller_translate'
      : payload.action === 'analytics'
      ? 'seller_analytics'
      : 'seller_listing';

  const perm = checkAiPermission(userId, featureKey);
  if (!perm.allowed) {
    logAiUsage(userId, featureKey, perm.modelName, payload.action, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  const title = (payload.title || '').trim();
  const notes = (payload.notes || '').trim();

  try {
    if (payload.action === 'translate') {
      if (!title && !notes) {
        throw Object.assign(new Error('Enter a listing title or description to translate.'), { statusCode: 400 });
      }
      const { data: parsed, estimatedTokens } = await invokeCloudflareWorkersAiJson(perm.modelName, [
        {
          role: 'system',
          content:
            'Translate marketplace listings accurately into the requested target language. Respond ONLY with JSON: {"translatedTitle": string, "translatedDescription": string}.',
        },
        {
          role: 'user',
          content: `Target Language: ${payload.targetLanguage || 'French'}\nTitle: ${title}\nDescription: ${notes}`,
        },
      ]);
      logAiUsage(userId, featureKey, perm.modelName, `translate:${payload.targetLanguage}`, 'success', Date.now() - start, estimatedTokens);
      return {
        translatedTitle: coerceAiString(parsed.translatedTitle, title),
        translatedDescription: coerceAiString(parsed.translatedDescription, notes),
        targetLanguage: payload.targetLanguage || 'French',
        provider: 'cloudflare-workers-ai',
        model: perm.modelName,
      };
    }

    if (payload.action === 'analytics') {
      const shopStats = db
        .prepare(
          `SELECT s.name,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') as published_products,
                  (SELECT COALESCE(SUM(view_count), 0) FROM products p WHERE p.shop_id = s.id) as total_views,
                  (SELECT COALESCE(SUM(favorite_count), 0) FROM products p WHERE p.shop_id = s.id) as total_favorites,
                  (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) as total_orders,
                  (SELECT COUNT(*) FROM inquiries i WHERE i.shop_id = s.id) as total_inquiries
           FROM shops s WHERE s.user_id = ? LIMIT 1`
        )
        .get(userId);

      const insights = await invokeCloudflareWorkersAi(perm.modelName, [
        {
          role: 'system',
          content:
            'Provide clear, actionable analytics interpretation based ONLY on the provided real SOFUMER shop metrics. Never invent metrics.',
        },
        {
          role: 'user',
          content: `Explain these real SOFUMER shop metrics and suggest concrete improvements:\n${JSON.stringify(shopStats || {})}`,
        },
      ]);

      logAiUsage(userId, featureKey, perm.modelName, 'shop_analytics', 'success', Date.now() - start, estimateTokens(insights));
      return { insights, stats: shopStats, provider: 'cloudflare-workers-ai', model: perm.modelName };
    }

    if (!title && !notes) {
      throw Object.assign(new Error('Enter a product title or notes so AI can draft a listing.'), { statusCode: 400 });
    }
    const categories = db.prepare('SELECT id, name FROM categories WHERE is_active = 1').all() as Array<{ id: string; name: string }>;
    const validCatIds = new Set(categories.map((c) => String(c.id)));
    const { data: parsed, estimatedTokens } = await invokeCloudflareWorkersAiJson(perm.modelName, [
      {
        role: 'system',
        content:
          'You assist SOFUMER sellers in drafting accurate, clear, trustworthy listings for seller review before publication. Never invent fake certifications. Respond ONLY with valid JSON: {"suggestedTitle": string, "improvedDescription": string, "suggestedCategoryId": string, "keywords": string[], "faqs": [{"question": string, "answer": string}]}.',
      },
      {
        role: 'user',
        content: `Listing Type: ${payload.listingType || 'physical'}\nDraft Title: ${title}\nSeller Notes: ${notes}\nAvailable Categories: ${JSON.stringify(categories)}`,
      },
    ]);
    const rawCatId = coerceAiString(parsed.suggestedCategoryId);
    const suggestedCategoryId = validCatIds.has(rawCatId) ? rawCatId : '';

    logAiUsage(userId, featureKey, perm.modelName, title || 'listing_draft', 'success', Date.now() - start, estimatedTokens);
    return {
      suggestedTitle: coerceAiString(parsed.suggestedTitle, title),
      improvedDescription: coerceAiString(parsed.improvedDescription, notes),
      suggestedCategoryId,
      keywords: coerceAiStringList(parsed.keywords, 12),
      faqs: normalizeFaqs(parsed.faqs),
      provider: 'cloudflare-workers-ai',
      model: perm.modelName,
    };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 400) {
      throw error;
    }
    const { internalMessage, userMessage } = sanitizeAiErrorForUser(error);
    logAiUsage(userId, featureKey, perm.modelName, payload.action, 'error', Date.now() - start, 0, internalMessage);
    throw Object.assign(new Error(userMessage), { statusCode: 503 });
  }
}

export async function runPlatformSupportAi(userId: string, question: string) {
  const start = Date.now();
  const perm = checkAiPermission(userId, 'platform_support');
  if (!perm.allowed) {
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  try {
    const reply = await invokeCloudflareWorkersAi(perm.modelName, [
      {
        role: 'system',
        content:
          'You are SOFUMER Platform Support AI. Explain SOFUMER marketplace features accurately: SOFUMER connects buyers and sellers globally via Telegram Mini App; transactions are direct buyer-to-seller arrangements (SOFUMER does not hold escrow or process mandatory platform payments); sellers can list Physical products, Digital products, and Professional Services under Free, Pro, or Business plans; users can report suspicious listings for human review.',
      },
      {
        role: 'user',
        content: question,
      },
    ]);

    logAiUsage(userId, 'platform_support', perm.modelName, question, 'success', Date.now() - start, estimateTokens(reply));
    return { reply, provider: 'cloudflare-workers-ai', model: perm.modelName };
  } catch (error) {
    const { internalMessage, userMessage } = sanitizeAiErrorForUser(error);
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, internalMessage);
    throw Object.assign(new Error(userMessage), { statusCode: 503 });
  }
}

