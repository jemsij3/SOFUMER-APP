import { GoogleGenAI, Type } from '@google/genai';
import { db, newId } from './db.ts';

const VALID_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-argon',
]);

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface AiAccessCheck {
  allowed: boolean;
  reason?: string;
  modelName: string;
  dailyLimit: number;
  usedToday: number;
}

export function checkAiPermission(userId: string, featureKey: string): AiAccessCheck {
  const globalSetting = db
    .prepare("SELECT is_enabled, model_name FROM ai_feature_settings WHERE feature_key = 'global_ai'")
    .get() as { is_enabled: number; model_name: string } | undefined;

  if (!globalSetting || !globalSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'AI services are currently disabled globally by platform administrators.',
      modelName: globalSetting?.model_name || 'gemini-4-hydrogen',
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
      modelName: featureSetting.model_name,
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
      modelName: featureSetting?.model_name || globalSetting.model_name,
      dailyLimit: 0,
      usedToday: 0,
    };
  }

  // Determine daily limit from subscription plan or feature default
  const subRow = db
    .prepare(
      `SELECT sp.ai_daily_limit
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(userId) as { ai_daily_limit: number } | undefined;

  const dailyLimit =
    userPerm?.custom_daily_limit ??
    subRow?.ai_daily_limit ??
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
      modelName: featureSetting?.model_name || globalSetting.model_name,
      dailyLimit,
      usedToday: usedRow.cnt,
    };
  }

  const rawModel = featureSetting?.model_name || globalSetting.model_name || 'gemini-4-hydrogen';
  const modelName = VALID_MODELS.has(rawModel) ? rawModel : 'gemini-4-hydrogen';

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

export async function runBuyerDiscoveryAi(userId: string, query: string) {
  const start = Date.now();
  const perm = checkAiPermission(userId, 'buyer_search');
  if (!perm.allowed) {
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  // Fetch all published real marketplace products + shops
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

  const ai = getAiClient();
  if (!ai) {
    const err = 'GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in Settings > Secrets.';
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, err);
    throw Object.assign(new Error(err), { statusCode: 503 });
  }

  try {
    const response = await ai.models.generateContent({
      model: perm.modelName,
      contents: `User query: "${query}"\n\nReal SOFUMER published catalog records (JSON):\n${JSON.stringify(catalog)}`,
      config: {
        systemInstruction:
          'You are the SOFUMER Marketplace AI Shopping Assistant. STRICT RULE: Only reference products present in the provided SOFUMER catalog JSON. NEVER invent products, prices, ratings, sellers, or availability. If the catalog is empty or no items match, say so honestly and clearly explain what is missing.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: {
              type: Type.STRING,
              description: 'Helpful, concise marketplace answer grounded strictly in the catalog JSON.',
            },
            matchedProductIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Exact product id strings from the catalog JSON that match the buyer request.',
            },
            suggestedFollowUps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2-3 helpful follow-up questions the buyer can ask.',
            },
          },
          required: ['answer', 'matchedProductIds', 'suggestedFollowUps'],
        },
      },
    });

    const parsed = JSON.parse((response.text || '{}').trim());
    const validIds = new Set(catalog.map((c) => String(c.id)));
    const matchedIds = Array.isArray(parsed.matchedProductIds)
      ? parsed.matchedProductIds.filter((id: unknown) => validIds.has(String(id)))
      : [];
    const matchedProducts = catalog.filter((c) => matchedIds.includes(String(c.id)));

    const latency = Date.now() - start;
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'success', latency, Math.ceil((response.text?.length || 100) / 4));

    return {
      answer: String(parsed.answer || ''),
      matchedProducts,
      suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) ? parsed.suggestedFollowUps.slice(0, 3) : [],
      catalogCount: catalog.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'AI generation failed';
    logAiUsage(userId, 'buyer_search', perm.modelName, query, 'error', Date.now() - start, 0, msg);
    throw Object.assign(new Error(msg), { statusCode: 502 });
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

  const ai = getAiClient();
  if (!ai) {
    const err = 'GEMINI_API_KEY is not configured on the server.';
    logAiUsage(userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, err);
    throw Object.assign(new Error(err), { statusCode: 503 });
  }

  try {
    const response = await ai.models.generateContent({
      model: perm.modelName,
      contents: `Compare these SOFUMER listings objectively.${focusQuestion ? ` Focus: ${focusQuestion}` : ''}\n\nListings JSON:\n${JSON.stringify(products)}`,
      config: {
        systemInstruction:
          'You compare real SOFUMER marketplace listings strictly using the provided JSON fields. Highlight price, currency, delivery/shipping, return policy, and seller country without inventing unstated specs.',
      },
    });
    logAiUsage(userId, 'buyer_compare', perm.modelName, `compare:${productIds.join(',')}`, 'success', Date.now() - start, 250);
    return { comparison: response.text || '', products };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'AI comparison failed';
    logAiUsage(userId, 'buyer_compare', perm.modelName, 'compare', 'error', Date.now() - start, 0, msg);
    throw Object.assign(new Error(msg), { statusCode: 502 });
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

  const ai = getAiClient();
  if (!ai) {
    const err = 'GEMINI_API_KEY is not configured on the server.';
    logAiUsage(userId, featureKey, perm.modelName, payload.action, 'error', Date.now() - start, 0, err);
    throw Object.assign(new Error(err), { statusCode: 503 });
  }

  try {
    if (payload.action === 'translate') {
      const response = await ai.models.generateContent({
        model: perm.modelName,
        contents: `Translate this marketplace listing into ${payload.targetLanguage || 'French'} while keeping commercial clarity.\nTitle: ${payload.title || ''}\nDescription: ${payload.notes || ''}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              translatedTitle: { type: Type.STRING },
              translatedDescription: { type: Type.STRING },
            },
            required: ['translatedTitle', 'translatedDescription'],
          },
        },
      });
      logAiUsage(userId, featureKey, perm.modelName, `translate:${payload.targetLanguage}`, 'success', Date.now() - start, 180);
      return JSON.parse((response.text || '{}').trim());
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
      const response = await ai.models.generateContent({
        model: perm.modelName,
        contents: `Explain these real SOFUMER shop metrics and suggest concrete improvements for the seller:\n${JSON.stringify(shopStats || {})}`,
        config: {
          systemInstruction: 'Provide clear, actionable analytics interpretation based ONLY on the provided real shop numbers. Never invent metrics.',
        },
      });
      logAiUsage(userId, featureKey, perm.modelName, 'shop_analytics', 'success', Date.now() - start, 200);
      return { insights: response.text || '', stats: shopStats };
    }

    // generate_listing
    const categories = db.prepare('SELECT id, name FROM categories WHERE is_active = 1').all();
    const response = await ai.models.generateContent({
      model: perm.modelName,
      contents: `Generate a structured marketplace listing draft for review by the seller.\nListing Type: ${payload.listingType || 'physical'}\nDraft Title: ${payload.title || ''}\nSeller Notes: ${payload.notes || ''}\nAvailable Categories: ${JSON.stringify(categories)}`,
      config: {
        systemInstruction:
          'You assist SOFUMER sellers in drafting accurate, clear, trustworthy listings. All output is a draft for seller review before publishing. Never invent fake certifications or deceptive claims.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedTitle: { type: Type.STRING },
            improvedDescription: { type: Type.STRING },
            suggestedCategoryId: { type: Type.STRING },
            keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            faqs: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  answer: { type: Type.STRING },
                },
                required: ['question', 'answer'],
              },
            },
          },
          required: ['suggestedTitle', 'improvedDescription', 'suggestedCategoryId', 'keywords', 'faqs'],
        },
      },
    });
    logAiUsage(userId, featureKey, perm.modelName, payload.title || 'listing_draft', 'success', Date.now() - start, 300);
    return JSON.parse((response.text || '{}').trim());
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Seller AI failed';
    logAiUsage(userId, featureKey, perm.modelName, payload.action, 'error', Date.now() - start, 0, msg);
    throw Object.assign(new Error(msg), { statusCode: 502 });
  }
}

export async function runPlatformSupportAi(userId: string, question: string) {
  const start = Date.now();
  const perm = checkAiPermission(userId, 'platform_support');
  if (!perm.allowed) {
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'denied', Date.now() - start, 0, perm.reason || 'Denied');
    throw Object.assign(new Error(perm.reason || 'AI access denied'), { statusCode: 403 });
  }

  const ai = getAiClient();
  if (!ai) {
    const err = 'GEMINI_API_KEY is not configured on the server.';
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, err);
    throw Object.assign(new Error(err), { statusCode: 503 });
  }

  try {
    const response = await ai.models.generateContent({
      model: perm.modelName,
      contents: question,
      config: {
        systemInstruction:
          'You are SOFUMER Platform Support AI. Explain SOFUMER marketplace features accurately: SOFUMER connects buyers and sellers globally via Telegram Mini App; transactions are direct buyer-to-seller arrangements (SOFUMER does not hold escrow or process mandatory platform payments); sellers can list Physical products, Digital products, and Professional Services under Free, Pro, or Business plans; users can report suspicious listings for human review.',
      },
    });
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'success', Date.now() - start, 180);
    return { reply: response.text || '' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Platform support AI failed';
    logAiUsage(userId, 'platform_support', perm.modelName, question, 'error', Date.now() - start, 0, msg);
    throw Object.assign(new Error(msg), { statusCode: 502 });
  }
}
