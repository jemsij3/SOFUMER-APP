/**
 * Idempotent Cloudflare D1 Schema Bootstrapper
 * Ensures a brand-new empty D1 database is automatically initialized with all
 * SOFUMER tables, indexes, and required system lookup rows even if deployed
 * before running `wrangler d1 migrations apply`.
 */
import type { D1Database } from './helpers.ts';

const SCHEMA_STATEMENTS: string[] = [
  // 1. Global Reference: Currencies & Countries
  `CREATE TABLE IF NOT EXISTS currencies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    usd_rate REAL NOT NULL DEFAULT 1.0,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_currencies_is_active ON currencies(is_active)`,

  `CREATE TABLE IF NOT EXISTS countries (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dial_code TEXT NOT NULL,
    default_currency TEXT NOT NULL REFERENCES currencies(code),
    region TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    shipping_notes TEXT DEFAULT '',
    verification_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_countries_default_currency ON countries(default_currency)`,
  `CREATE INDEX IF NOT EXISTS idx_countries_is_enabled ON countries(is_enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_countries_name ON countries(name)`,

  // 2. Identity, Roles & Sessions
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    telegram_username TEXT DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT DEFAULT '',
    display_name TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    country_code TEXT DEFAULT 'US' REFERENCES countries(code),
    preferred_currency TEXT DEFAULT 'USD' REFERENCES currencies(code),
    preferred_language TEXT DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'suspended')),
    restriction_reason TEXT DEFAULT '',
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`,
  `CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)`,

  `CREATE TABLE IF NOT EXISTS user_roles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'moderator', 'admin', 'super_admin')),
    granted_by TEXT DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT UNIQUE NOT NULL,
    session_type TEXT NOT NULL DEFAULT 'telegram' CHECK (session_type IN ('telegram', 'admin', 'sandbox')),
    ip_address TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_session_type ON sessions(session_type)`,

  // 3. Sellers, Shops & Verification
  `CREATE TABLE IF NOT EXISTS seller_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
    seller_type TEXT NOT NULL CHECK (seller_type IN ('individual', 'business')),
    legal_name TEXT NOT NULL,
    business_registration_no TEXT DEFAULT '',
    country_code TEXT NOT NULL REFERENCES countries(code),
    contact_email TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    contact_telegram TEXT DEFAULT '',
    verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    suspension_reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seller_profiles_user_id ON seller_profiles(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_seller_profiles_country_code ON seller_profiles(country_code)`,
  `CREATE INDEX IF NOT EXISTS idx_seller_profiles_created_at ON seller_profiles(created_at)`,

  `CREATE TABLE IF NOT EXISTS shops (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES seller_profiles(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    country_code TEXT NOT NULL REFERENCES countries(code),
    logo_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    return_policy TEXT NOT NULL DEFAULT 'Direct buyer-seller agreement required before dispatch.',
    shipping_policy TEXT NOT NULL DEFAULT 'Shipping terms arranged directly between buyer and seller.',
    default_currency TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
    verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
    is_featured INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
    rating_avg REAL NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shops_seller_id ON shops(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_user_id ON shops(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_slug ON shops(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_country_code ON shops(country_code)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_status ON shops(status)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_is_featured ON shops(is_featured)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_created_at ON shops(created_at)`,

  `CREATE TABLE IF NOT EXISTS shop_verifications (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    seller_id TEXT NOT NULL REFERENCES seller_profiles(id),
    document_type TEXT NOT NULL,
    document_reference TEXT NOT NULL DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT DEFAULT '',
    review_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shop_verifications_shop_id ON shop_verifications(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shop_verifications_seller_id ON shop_verifications(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shop_verifications_created_at ON shop_verifications(created_at)`,

  // 4. Catalog
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon_name TEXT DEFAULT 'Package',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_categories_is_active ON categories(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_categories_sort_order ON categories(sort_order)`,

  `CREATE TABLE IF NOT EXISTS subcategories (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES categories(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subcategories_category_id ON subcategories(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subcategories_is_active ON subcategories(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_subcategories_sort_order ON subcategories(sort_order)`,

  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    seller_user_id TEXT NOT NULL REFERENCES users(id),
    category_id TEXT NOT NULL REFERENCES categories(id),
    subcategory_id TEXT REFERENCES subcategories(id),
    listing_type TEXT NOT NULL CHECK (listing_type IN ('physical', 'digital', 'service')),
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT NOT NULL,
    price REAL NOT NULL CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
    condition TEXT DEFAULT 'new' CHECK (condition IN ('new', 'like_new', 'used', 'refurbished', 'not_applicable')),
    country_code TEXT NOT NULL REFERENCES countries(code),
    location_text TEXT DEFAULT '',
    shipping_info TEXT DEFAULT '',
    international_shipping INTEGER NOT NULL DEFAULT 0,
    file_format TEXT DEFAULT '',
    digital_delivery_method TEXT DEFAULT '',
    license_info TEXT DEFAULT '',
    pricing_model TEXT DEFAULT 'fixed',
    service_mode TEXT DEFAULT 'remote' CHECK (service_mode IN ('remote', 'onsite', 'hybrid', 'not_applicable')),
    delivery_timeframe TEXT DEFAULT '',
    return_policy TEXT DEFAULT '',
    keywords TEXT DEFAULT '',
    faqs_json TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'archived')),
    moderation_notes TEXT DEFAULT '',
    is_featured INTEGER NOT NULL DEFAULT 0,
    is_sponsored INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    favorite_count INTEGER NOT NULL DEFAULT 0,
    inquiry_count INTEGER NOT NULL DEFAULT 0,
    rating_avg REAL NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_seller_user_id ON products(seller_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_country_code ON products(country_code)`,
  `CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)`,
  `CREATE INDEX IF NOT EXISTS idx_products_listing_type ON products(listing_type)`,
  `CREATE INDEX IF NOT EXISTS idx_products_price ON products(price)`,
  `CREATE INDEX IF NOT EXISTS idx_products_is_featured ON products(is_featured)`,
  `CREATE INDEX IF NOT EXISTS idx_products_is_sponsored ON products(is_sponsored)`,
  `CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at)`,

  `CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    url TEXT NOT NULL,
    alt_text TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_product_images_sort_order ON product_images(sort_order)`,

  `CREATE TABLE IF NOT EXISTS product_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    sku TEXT DEFAULT '',
    price_delta REAL NOT NULL DEFAULT 0,
    attributes_json TEXT DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_product_variants_is_active ON product_variants(is_active)`,

  `CREATE TABLE IF NOT EXISTS product_inventory (
    id TEXT PRIMARY KEY,
    product_id TEXT UNIQUE NOT NULL REFERENCES products(id),
    stock_quantity INTEGER NOT NULL DEFAULT 1,
    unlimited_digital INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 3,
    availability_status TEXT NOT NULL DEFAULT 'in_stock' CHECK (availability_status IN ('in_stock', 'low_stock', 'out_of_stock', 'available_on_request')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_inventory_product_id ON product_inventory(product_id)`,

  // 5. Discovery
  `CREATE TABLE IF NOT EXISTS product_favorites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_favorites_user_id ON product_favorites(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_product_favorites_product_id ON product_favorites(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_product_favorites_created_at ON product_favorites(created_at)`,

  `CREATE TABLE IF NOT EXISTS recently_viewed (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recently_viewed_user_id ON recently_viewed(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recently_viewed_product_id ON recently_viewed(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recently_viewed_viewed_at ON recently_viewed(viewed_at)`,

  // 6. Communication
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    product_id TEXT REFERENCES products(id),
    shop_id TEXT REFERENCES shops(id),
    subject TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'flagged', 'closed')),
    last_message_at TEXT,
    last_message_preview TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_product_id ON conversations(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_shop_id ON conversations(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at)`,

  `CREATE TABLE IF NOT EXISTS conversation_participants (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller')),
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_read_at TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(conversation_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation_id ON conversation_participants(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_participants_user_id ON conversation_participants(user_id)`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    sender_user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL DEFAULT '',
    attachment_url TEXT DEFAULT '',
    attachment_type TEXT DEFAULT '',
    message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'order_proposal', 'system')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_user_id ON messages(sender_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(is_deleted)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,

  `CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    shop_id TEXT NOT NULL REFERENCES shops(id),
    buyer_user_id TEXT NOT NULL REFERENCES users(id),
    seller_user_id TEXT NOT NULL REFERENCES users(id),
    conversation_id TEXT REFERENCES conversations(id),
    initial_message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted_to_order', 'closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_product_id ON inquiries(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_shop_id ON inquiries(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_buyer_user_id ON inquiries(buyer_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries(created_at)`,

  `CREATE TABLE IF NOT EXISTS user_blocks (
    id TEXT PRIMARY KEY,
    blocker_user_id TEXT NOT NULL REFERENCES users(id),
    blocked_user_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(blocker_user_id, blocked_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker_user_id ON user_blocks(blocker_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_user_id ON user_blocks(blocked_user_id)`,

  // 7. Direct Transactions
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    buyer_user_id TEXT NOT NULL REFERENCES users(id),
    seller_user_id TEXT NOT NULL REFERENCES users(id),
    shop_id TEXT NOT NULL REFERENCES shops(id),
    conversation_id TEXT REFERENCES conversations(id),
    status TEXT NOT NULL DEFAULT 'Inquiry' CHECK (
      status IN ('Inquiry', 'Pending Confirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Completed', 'Cancelled', 'Disputed')
    ),
    agreed_total REAL NOT NULL CHECK (agreed_total >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
    payment_arrangement TEXT NOT NULL DEFAULT 'Direct buyer-seller arrangement',
    delivery_arrangement TEXT NOT NULL DEFAULT '',
    shipping_address_notes TEXT DEFAULT '',
    buyer_confirmed_at TEXT,
    seller_marked_paid INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_buyer_user_id ON orders(buyer_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_seller_user_id ON orders(seller_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_conversation_id ON orders(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders(updated_at)`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    product_title TEXT NOT NULL,
    listing_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    unit_price REAL NOT NULL CHECK (unit_price >= 0),
    currency TEXT NOT NULL DEFAULT 'USD'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id)`,

  `CREATE TABLE IF NOT EXISTS order_status_history (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    old_status TEXT DEFAULT '',
    new_status TEXT NOT NULL,
    changed_by_user_id TEXT NOT NULL REFERENCES users(id),
    changed_by_role TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_status_history_changed_by_user_id ON order_status_history(changed_by_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_order_status_history_created_at ON order_status_history(created_at)`,

  // 8. Trust: Reviews & Reports
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    order_id TEXT UNIQUE NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    shop_id TEXT NOT NULL REFERENCES shops(id),
    reviewer_user_id TEXT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL DEFAULT '',
    is_verified_transaction INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'removed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_shop_id ON reviews(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_user_id ON reviews(reviewer_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at)`,

  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_user_id TEXT NOT NULL REFERENCES users(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('product', 'shop', 'user', 'message', 'review')),
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
    resolved_by TEXT DEFAULT '',
    reviewed_by TEXT DEFAULT '',
    resolution_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_reporter_user_id ON reports(reporter_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at)`,

  // 9. Monetization
  `CREATE TABLE IF NOT EXISTS subscription_plans (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL CHECK (code IN ('FREE', 'PRO', 'BUSINESS')),
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    monthly_price REAL NOT NULL DEFAULT 0,
    annual_price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
    max_products INTEGER NOT NULL DEFAULT 10,
    ai_daily_limit INTEGER NOT NULL DEFAULT 15,
    featured_slots INTEGER NOT NULL DEFAULT 0,
    promotional_discount_pct REAL NOT NULL DEFAULT 0,
    analytics_level TEXT NOT NULL DEFAULT 'basic',
    custom_branding INTEGER NOT NULL DEFAULT 0,
    priority_support INTEGER NOT NULL DEFAULT 0,
    features_json TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_plans_code ON subscription_plans(code)`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_plans_is_active ON subscription_plans(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_plans_monthly_price ON subscription_plans(monthly_price)`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES seller_profiles(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
    billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
    amount_recorded REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_payment', 'cancelled', 'expired')),
    payment_reference TEXT DEFAULT '',
    starts_at TEXT NOT NULL DEFAULT (datetime('now')),
    ends_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_seller_id ON subscriptions(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_id ON subscriptions(plan_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_created_at ON subscriptions(created_at)`,

  `CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    product_id TEXT REFERENCES products(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    promo_type TEXT NOT NULL CHECK (promo_type IN ('featured_product', 'sponsored_placement', 'banner_ad', 'shop_spotlight')),
    title TEXT NOT NULL,
    duration_days INTEGER NOT NULL DEFAULT 7,
    price_amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'completed', 'rejected')),
    starts_at TEXT,
    ends_at TEXT,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_shop_id ON promotions(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_product_id ON promotions(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_user_id ON promotions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_created_at ON promotions(created_at)`,

  `CREATE TABLE IF NOT EXISTS promotion_transactions (
    id TEXT PRIMARY KEY,
    promotion_id TEXT NOT NULL REFERENCES promotions(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('pending', 'recorded', 'refunded')),
    reference TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_transactions_promotion_id ON promotion_transactions(promotion_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_transactions_user_id ON promotion_transactions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_transactions_created_at ON promotion_transactions(created_at)`,

  // 10. AI Governance
  `CREATE TABLE IF NOT EXISTS ai_feature_settings (
    id TEXT PRIMARY KEY,
    feature_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_enabled INTEGER NOT NULL DEFAULT 1,
    model_name TEXT NOT NULL DEFAULT '@cf/meta/llama-3.1-8b-instruct',
    daily_limit_per_user INTEGER NOT NULL DEFAULT 30,
    updated_by TEXT DEFAULT 'system',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_feature_settings_feature_key ON ai_feature_settings(feature_key)`,

  `CREATE TABLE IF NOT EXISTS ai_permissions (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    ai_enabled INTEGER NOT NULL DEFAULT 1,
    custom_daily_limit INTEGER,
    reason TEXT DEFAULT '',
    updated_by TEXT DEFAULT 'system',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    feature_key TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_summary TEXT DEFAULT '',
    tokens_estimated INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('success', 'denied', 'error')),
    error_message TEXT DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_user_id ON ai_usage(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_status ON ai_usage(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at)`,

  // 11. Administration
  `CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'string',
    description TEXT DEFAULT '',
    updated_by TEXT DEFAULT 'system',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS admin_roles (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_roles_code ON admin_roles(code)`,

  `CREATE TABLE IF NOT EXISTS admin_permissions (
    id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES admin_roles(id),
    permission_key TEXT NOT NULL,
    UNIQUE(role_id, permission_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_permissions_role_id ON admin_permissions(role_id)`,

  `CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_identifier TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT DEFAULT '',
    target_id TEXT DEFAULT '',
    details_json TEXT DEFAULT '{}',
    ip_address TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at)`,

  // 12. Support, Notifications & Telegram Bot Idempotency
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global')),
    type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link_url TEXT DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    telegram_delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_scope ON notifications(scope)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)`,

  `CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    category TEXT NOT NULL DEFAULT 'general',
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    admin_response TEXT DEFAULT '',
    responded_by TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at)`,

  `CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    chat_id TEXT DEFAULT '',
    command TEXT DEFAULT '',
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // 13. Required System Lookup & Configuration Seeds
  `INSERT OR IGNORE INTO currencies (code, name, symbol, usd_rate, decimal_places) VALUES
    ('USD', 'US Dollar', '$', 1.0, 2),
    ('EUR', 'Euro', '€', 0.92, 2),
    ('GBP', 'British Pound', '£', 0.79, 2),
    ('CAD', 'Canadian Dollar', 'CA$', 1.39, 2),
    ('AUD', 'Australian Dollar', 'A$', 1.54, 2),
    ('JPY', 'Japanese Yen', '¥', 154.0, 0),
    ('AED', 'UAE Dirham', 'AED ', 3.67, 2),
    ('NGN', 'Nigerian Naira', '₦', 1620.0, 0),
    ('KES', 'Kenyan Shilling', 'KSh ', 129.0, 0),
    ('ZAR', 'South African Rand', 'R', 18.1, 2),
    ('ETB', 'Ethiopian Birr', 'ETB ', 124.0, 2),
    ('INR', 'Indian Rupee', '₹', 84.4, 2),
    ('SGD', 'Singapore Dollar', 'S$', 1.34, 2),
    ('BRL', 'Brazilian Real', 'R$', 5.8, 2)`,

  `INSERT OR IGNORE INTO countries (code, name, dial_code, default_currency, region, is_enabled, shipping_notes, verification_notes) VALUES
    ('US', 'United States', '+1', 'USD', 'North America', 1, 'Domestic & international courier support arranged by seller.', 'Standard business or individual verification.'),
    ('GB', 'United Kingdom', '+44', 'GBP', 'Europe', 1, 'UK & EU cross-border shipping defined per listing.', 'Standard verification supported.'),
    ('DE', 'Germany', '+49', 'EUR', 'Europe', 1, 'EU single-market & international shipping.', 'Business VAT ID optional for pro verification.'),
    ('FR', 'France', '+33', 'EUR', 'Europe', 1, 'EU & international courier options.', 'Standard verification supported.'),
    ('CA', 'Canada', '+1', 'CAD', 'North America', 1, 'North American & worldwide dispatch.', 'Standard verification supported.'),
    ('AE', 'United Arab Emirates', '+971', 'AED', 'Middle East', 1, 'GCC & global air courier support.', 'Trade license supported for business shops.'),
    ('NG', 'Nigeria', '+234', 'NGN', 'Africa', 1, 'Regional logistics & international export by seller.', 'National ID or CAC registration supported.'),
    ('KE', 'Kenya', '+254', 'KES', 'Africa', 1, 'East African & international shipping.', 'Standard verification supported.'),
    ('ET', 'Ethiopia', '+251', 'ETB', 'Africa', 1, 'Local pickup & international air freight by agreement.', 'Business license or ID supported.'),
    ('ZA', 'South Africa', '+27', 'ZAR', 'Africa', 1, 'Domestic & global courier options.', 'Standard verification supported.'),
    ('SG', 'Singapore', '+65', 'SGD', 'Asia Pacific', 1, 'APAC & worldwide express shipping.', 'ACRA UEN supported for business accounts.'),
    ('JP', 'Japan', '+81', 'JPY', 'Asia Pacific', 1, 'International EMS & DHL/FedEx shipping.', 'Standard verification supported.'),
    ('IN', 'India', '+91', 'INR', 'Asia Pacific', 1, 'Domestic & export courier services.', 'GST/business verification optional.'),
    ('AU', 'Australia', '+61', 'AUD', 'Oceania', 1, 'Domestic & global air dispatch.', 'ABN optional for business sellers.'),
    ('BR', 'Brazil', '+55', 'BRL', 'South America', 1, 'Mercosur & international delivery terms per seller.', 'CPF/CNPJ verification optional.')`,

  `INSERT OR IGNORE INTO categories (id, slug, name, description, icon_name, sort_order) VALUES
    ('cat_electronics', 'electronics', 'Electronics', 'Computers, phones, audio gear, components, and hardware.', 'Cpu', 1),
    ('cat_fashion', 'fashion', 'Fashion', 'Apparel, footwear, accessories, watches, and tailoring.', 'Shirt', 2),
    ('cat_home', 'home-and-living', 'Home and Living', 'Furniture, lighting, decor, kitchenware, and home essentials.', 'Home', 3),
    ('cat_beauty', 'beauty-and-personal-care', 'Beauty and Personal Care', 'Skincare, grooming, cosmetics, and wellness products.', 'Sparkles', 4),
    ('cat_sports', 'sports-and-fitness', 'Sports and Fitness', 'Equipment, athletic apparel, outdoor gear, and recovery.', 'Dumbbell', 5),
    ('cat_vehicles', 'vehicles-and-accessories', 'Vehicles and Accessories', 'Auto parts, EV accessories, motorcycles, and mobility gear.', 'Car', 6),
    ('cat_digital', 'digital-products', 'Digital Products', 'Templates, e-books, design assets, datasets, and media packs.', 'FileCode', 7),
    ('cat_software', 'software', 'Software', 'SaaS licenses, developer tools, plugins, scripts, and apps.', 'Terminal', 8),
    ('cat_services', 'professional-services', 'Professional Services', 'Engineering, design, consulting, legal, and business services.', 'Briefcase', 9),
    ('cat_other', 'other-products-and-services', 'Other Products and Services', 'Specialized goods, industrial supplies, and custom offerings.', 'Layers', 10)`,

  `INSERT OR IGNORE INTO subcategories (id, category_id, slug, name, sort_order) VALUES
    ('sub_laptops', 'cat_electronics', 'laptops-workstations', 'Laptops & Workstations', 1),
    ('sub_phones', 'cat_electronics', 'smartphones-tablets', 'Smartphones & Tablets', 2),
    ('sub_audio', 'cat_electronics', 'audio-studio', 'Audio & Studio Gear', 3),
    ('sub_menswear', 'cat_fashion', 'menswear', 'Menswear', 1),
    ('sub_womenswear', 'cat_fashion', 'womenswear', 'Womenswear', 2),
    ('sub_footwear', 'cat_fashion', 'footwear-bags', 'Footwear & Bags', 3),
    ('sub_furniture', 'cat_home', 'furniture', 'Furniture & Lighting', 1),
    ('sub_kitchen', 'cat_home', 'kitchen-dining', 'Kitchen & Dining', 2),
    ('sub_skincare', 'cat_beauty', 'skincare', 'Skincare & Serums', 1),
    ('sub_fitness_eq', 'cat_sports', 'training-equipment', 'Training Equipment', 1),
    ('sub_auto_parts', 'cat_vehicles', 'parts-diagnostics', 'Parts & Diagnostics', 1),
    ('sub_ui_kits', 'cat_digital', 'design-templates', 'Design Kits & Templates', 1),
    ('sub_ebooks', 'cat_digital', 'guides-ebooks', 'Guides & E-Books', 2),
    ('sub_saas', 'cat_software', 'saas-licenses', 'SaaS & Tool Licenses', 1),
    ('sub_plugins', 'cat_software', 'scripts-plugins', 'Scripts & Plugins', 2),
    ('sub_dev', 'cat_services', 'software-engineering', 'Software Engineering', 1),
    ('sub_design', 'cat_services', 'brand-product-design', 'Brand & Product Design', 2),
    ('sub_consulting', 'cat_services', 'business-consulting', 'Business Consulting', 3),
    ('sub_custom', 'cat_other', 'custom-industrial', 'Custom & Industrial', 1)`,

  `INSERT OR IGNORE INTO subscription_plans (
    id, code, name, tagline, monthly_price, annual_price, currency,
    max_products, ai_daily_limit, featured_slots, promotional_discount_pct,
    analytics_level, custom_branding, priority_support, features_json
  ) VALUES
    (
      'plan_free', 'FREE', 'Free Starter', 'For new individual sellers launching on SOFUMER',
      0, 0, 'USD', 10, 15, 0, 0, 'basic', 0, 0,
      '["Basic public storefront","Up to 10 active listings","Basic shop analytics","15 AI assistant actions per day","Direct buyer-seller messaging"]'
    ),
    (
      'plan_pro', 'PRO', 'Pro Seller', 'For active merchants scaling globally',
      29, 290, 'USD', 100, 100, 3, 15, 'advanced', 1, 0,
      '["Enhanced custom shop banner & branding","Up to 100 active listings","Advanced product & conversion analytics","100 AI assistant actions per day","3 featured slots & 15% promo discount"]'
    ),
    (
      'plan_business', 'BUSINESS', 'Business Enterprise', 'For multi-line brands and B2B exporters',
      89, 890, 'USD', 1000, 500, 12, 30, 'enterprise', 1, 1,
      '["Full storefront customization & priority badge review","Up to 1,000 active listings","Enterprise analytics & AI shop insights","500 AI assistant actions per day","12 featured slots & 30% promo discount"]'
    )`,

  `INSERT OR IGNORE INTO ai_feature_settings (id, feature_key, label, description, is_enabled, model_name, daily_limit_per_user) VALUES
    ('ai_global', 'global_ai', 'Global AI Engine', 'Master switch controlling all SOFUMER AI endpoints.', 1, '@cf/meta/llama-3.1-8b-instruct', 100),
    ('ai_buyer_search', 'buyer_search', 'AI Product & Shop Discovery', 'Natural-language search grounded strictly in published SOFUMER catalog records.', 1, '@cf/meta/llama-3.1-8b-instruct', 40),
    ('ai_buyer_compare', 'buyer_compare', 'AI Product Comparison', 'Side-by-side comparison of real SOFUMER listings.', 1, '@cf/meta/llama-3.1-8b-instruct', 25),
    ('ai_seller_listing', 'seller_listing', 'AI Seller Listing Writer', 'Generates title suggestions, descriptions, category picks, keywords, and FAQs for seller review.', 1, '@cf/meta/llama-3.1-8b-instruct', 40),
    ('ai_seller_translate', 'seller_translate', 'AI Listing Translation', 'Translates listing titles and descriptions for global buyers.', 1, '@cf/meta/llama-3.1-8b-instruct', 30),
    ('ai_seller_analytics', 'seller_analytics', 'AI Shop Analytics Insights', 'Explains real shop metrics and listing engagement.', 1, '@cf/meta/llama-3.1-8b-instruct', 20),
    ('ai_platform_support', 'platform_support', 'AI Platform Support & Trust', 'Explains SOFUMER rules, direct transactions, and assists flagging suspicious listings.', 1, '@cf/meta/llama-3.1-8b-instruct', 40)`,

  `INSERT OR IGNORE INTO platform_settings (key, value, value_type, description) VALUES
    ('seller_registration_enabled', 'true', 'boolean', 'Allow Telegram users to register seller profiles and shops'),
    ('product_submissions_enabled', 'true', 'boolean', 'Allow sellers to publish new product and service listings'),
    ('auto_approve_products', 'true', 'boolean', 'Publish compliant listings immediately or queue for manual moderation'),
    ('featured_product_price_7d', '15', 'number', 'Base price in USD for 7-day featured listing placement'),
    ('sponsored_placement_price_7d', '35', 'number', 'Base price in USD for 7-day sponsored top search placement'),
    ('banner_ad_price_7d', '75', 'number', 'Base price in USD for 7-day homepage promotional banner'),
    ('prohibited_keywords', 'counterfeit,stolen,illegal weapon,narcotic,scam', 'string', 'Comma-separated moderation keywords flagged on submission'),
    ('marketplace_announcement', '', 'string', 'Optional global announcement displayed to users')`,

  `INSERT OR IGNORE INTO admin_roles (id, code, name, description) VALUES
    ('role_owner', 'OWNER', 'Platform Owner', 'Full system, security, AI, monetization, and role governance'),
    ('role_mod', 'MODERATOR', 'Trust & Safety Moderator', 'Product moderation, abuse reports, messages investigation, and seller reviews'),
    ('role_ops', 'OPERATIONS', 'Marketplace Operations', 'Categories, countries, subscriptions, promotions, and support tickets')`,

  `INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES
    ('perm_1', 'role_owner', '*'),
    ('perm_2', 'role_mod', 'moderation.manage'),
    ('perm_3', 'role_mod', 'reports.manage'),
    ('perm_4', 'role_mod', 'sellers.suspend'),
    ('perm_5', 'role_ops', 'catalog.manage'),
    ('perm_6', 'role_ops', 'monetization.manage'),
    ('perm_7', 'role_ops', 'support.manage')`,
];

let schemaVerified = false;
let inFlightBootstrap: Promise<boolean> | null = null;

export async function isD1Initialized(db?: D1Database): Promise<boolean> {
  if (!db) return false;
  try {
    const tablesRow = await db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'categories', 'platform_settings', 'ai_feature_settings')"
      )
      .first<{ cnt: number }>();
    if ((tablesRow?.cnt ?? 0) < 4) return false;
    const catRow = await db.prepare('SELECT COUNT(*) as cnt FROM categories').first<{ cnt: number }>();
    return (catRow?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function ensureD1Schema(db?: D1Database): Promise<boolean> {
  if (!db) return false;
  if (schemaVerified) return true;
  if (inFlightBootstrap) return inFlightBootstrap;

  inFlightBootstrap = (async () => {
    try {
      const alreadyReady = await isD1Initialized(db);
      if (alreadyReady) {
        schemaVerified = true;
        return true;
      }

      const CHUNK_SIZE = 25;
      for (let i = 0; i < SCHEMA_STATEMENTS.length; i += CHUNK_SIZE) {
        const chunk = SCHEMA_STATEMENTS.slice(i, i + CHUNK_SIZE);
        await db.batch(chunk.map((sql) => db.prepare(sql)));
      }

      schemaVerified = true;
      return true;
    } catch (err) {
      console.error(
        'D1 schema auto-bootstrap error:',
        err instanceof Error ? err.message : 'unknown'
      );
      return false;
    } finally {
      inFlightBootstrap = null;
    }
  })();

  return inFlightBootstrap;
}

export function resetD1BootstrapCacheForTests() {
  schemaVerified = false;
  inFlightBootstrap = null;
}
