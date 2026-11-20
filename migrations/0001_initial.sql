-- SOFUMER Database Schema (Cloudflare D1 / SQLite Compatible)
-- Migration 0001: Initial Core Marketplace, Seller, AI, Messaging, Orders, & Admin Schema

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. GLOBAL REFERENCE: COUNTRIES & CURRENCIES
-- ============================================================================
CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  usd_rate REAL NOT NULL DEFAULT 1.0,
  decimal_places INTEGER NOT NULL DEFAULT 2,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dial_code TEXT NOT NULL,
  default_currency TEXT NOT NULL REFERENCES currencies(code),
  region TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  shipping_notes TEXT DEFAULT '',
  verification_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 2. IDENTITY, ROLES & SESSIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
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
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'moderator', 'admin', 'super_admin')),
  granted_by TEXT DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'telegram' CHECK (session_type IN ('telegram', 'admin', 'sandbox')),
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- ============================================================================
-- 3. SELLERS, SHOPS & VERIFICATION
-- ============================================================================
CREATE TABLE IF NOT EXISTS seller_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
);

CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
);

CREATE INDEX IF NOT EXISTS idx_shops_user_id ON shops(user_id);
CREATE INDEX IF NOT EXISTS idx_shops_slug ON shops(slug);
CREATE INDEX IF NOT EXISTS idx_shops_country ON shops(country_code);

CREATE TABLE IF NOT EXISTS shop_verifications (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_reference TEXT NOT NULL DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT DEFAULT '',
  review_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

-- ============================================================================
-- 4. CATALOG: CATEGORIES, SUBCATEGORIES, PRODUCTS, MEDIA, VARIANTS, INVENTORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon_name TEXT DEFAULT 'Package',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subcategories (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(category_id, slug)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  -- Physical specific
  shipping_info TEXT DEFAULT '',
  international_shipping INTEGER NOT NULL DEFAULT 0,
  -- Digital specific
  file_format TEXT DEFAULT '',
  digital_delivery_method TEXT DEFAULT '',
  license_info TEXT DEFAULT '',
  -- Service specific
  pricing_model TEXT DEFAULT 'fixed',
  service_mode TEXT DEFAULT 'remote' CHECK (service_mode IN ('remote', 'onsite', 'hybrid', 'not_applicable')),
  delivery_timeframe TEXT DEFAULT '',
  -- Policies & Metadata
  return_policy TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  faqs_json TEXT DEFAULT '[]',
  -- Status & Moderation
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
);

CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_listing_type ON products(listing_type);
CREATE INDEX IF NOT EXISTS idx_products_country ON products(country_code);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  alt_text TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  price_delta REAL NOT NULL DEFAULT 0,
  attributes_json TEXT DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_inventory (
  id TEXT PRIMARY KEY,
  product_id TEXT UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stock_quantity INTEGER NOT NULL DEFAULT 1,
  unlimited_digital INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  availability_status TEXT NOT NULL DEFAULT 'in_stock' CHECK (availability_status IN ('in_stock', 'low_stock', 'out_of_stock', 'available_on_request')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 5. DISCOVERY: FAVORITES & RECENTLY VIEWED
-- ============================================================================
CREATE TABLE IF NOT EXISTS product_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON product_favorites(user_id);

CREATE TABLE IF NOT EXISTS recently_viewed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_recently_viewed_user ON recently_viewed(user_id, viewed_at DESC);

-- ============================================================================
-- 6. COMMUNICATION: CONVERSATIONS, PARTICIPANTS, MESSAGES, INQUIRIES, BLOCKS
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  subject TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'flagged', 'closed')),
  last_message_at TEXT,
  last_message_preview TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conversation_participants(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  attachment_url TEXT DEFAULT '',
  attachment_type TEXT DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'order_proposal', 'system')),
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  initial_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted_to_order', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blocker_user_id, blocked_user_id)
);

-- ============================================================================
-- 7. DIRECT TRANSACTIONS: ORDERS, ITEMS, STATUS HISTORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  buyer_user_id TEXT NOT NULL REFERENCES users(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  shop_id TEXT NOT NULL REFERENCES shops(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Inquiry' CHECK (
    status IN (
      'Inquiry',
      'Pending Confirmation',
      'Confirmed',
      'Processing',
      'Shipped',
      'Delivered',
      'Completed',
      'Cancelled',
      'Disputed'
    )
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
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_title TEXT NOT NULL,
  listing_type TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  currency TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status TEXT DEFAULT '',
  new_status TEXT NOT NULL,
  changed_by_user_id TEXT NOT NULL REFERENCES users(id),
  changed_by_role TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history(order_id, created_at ASC);

-- ============================================================================
-- 8. TRUST: REVIEWS, REPORTS, MODERATION
-- ============================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT NOT NULL DEFAULT '',
  is_verified_transaction INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('product', 'shop', 'user', 'message', 'review')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolved_by TEXT DEFAULT '',
  resolution_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT DEFAULT '',
  performed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 9. MONETIZATION: SUBSCRIPTIONS & PROMOTIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
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
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  amount_recorded REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_payment', 'cancelled', 'expired')),
  payment_reference TEXT DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
);

CREATE TABLE IF NOT EXISTS promotion_transactions (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('pending', 'recorded', 'refunded')),
  reference TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 10. AI GOVERNANCE, USAGE & PERMISSIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_feature_settings (
  id TEXT PRIMARY KEY,
  feature_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  model_name TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
  daily_limit_per_user INTEGER NOT NULL DEFAULT 30,
  updated_by TEXT DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_permissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  custom_daily_limit INTEGER,
  reason TEXT DEFAULT '',
  updated_by TEXT DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  feature_key TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_summary TEXT DEFAULT '',
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('success', 'denied', 'error')),
  error_message TEXT DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_status ON ai_usage(status);

-- ============================================================================
-- 11. ADMINISTRATION, RBAC, SETTINGS & AUDIT LOGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  description TEXT DEFAULT '',
  updated_by TEXT DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_roles (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  UNIQUE(role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_identifier TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT DEFAULT '',
  target_id TEXT DEFAULT '',
  details_json TEXT DEFAULT '{}',
  ip_address TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON admin_audit_logs(created_at DESC);

-- ============================================================================
-- 12. SUPPORT, NOTIFICATIONS & TELEGRAM BOT IDEMPOTENCY
-- ============================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global')),
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link_url TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  telegram_delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_response TEXT DEFAULT '',
  responded_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  chat_id TEXT DEFAULT '',
  command TEXT DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
