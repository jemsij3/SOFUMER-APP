-- SOFUMER Migration 0004: Telegram Stars (XTR) Payments, Protected Digital Delivery & Edge Rate Limits
-- Idempotent D1 / SQLite compatible DDL and seeds

CREATE TABLE IF NOT EXISTS subscription_plan_stars (
  plan_id TEXT PRIMARY KEY REFERENCES subscription_plans(id),
  stars_monthly INTEGER NOT NULL DEFAULT 0,
  stars_annual INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO subscription_plan_stars (plan_id, stars_monthly, stars_annual) VALUES
  ('plan_free', 0, 0),
  ('plan_pro', 1450, 14500),
  ('plan_business', 4450, 44500);

INSERT OR IGNORE INTO platform_settings (key, value, value_type, description) VALUES
  ('stars_per_usd', '50', 'number', 'Conversion rate of USD to Telegram Stars (XTR) for platform services and promotions');

CREATE TABLE IF NOT EXISTS telegram_stars_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payer_telegram_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('subscription', 'promotion')),
  target_id TEXT NOT NULL,
  plan_code TEXT DEFAULT '',
  billing_cycle TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  payload_token TEXT UNIQUE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XTR',
  stars_amount INTEGER NOT NULL CHECK (stars_amount > 0),
  usd_equivalent REAL NOT NULL DEFAULT 0,
  invoice_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'expired', 'failed', 'refunded')),
  telegram_payment_charge_id TEXT DEFAULT '',
  provider_payment_charge_id TEXT DEFAULT '',
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stars_payments_user_id ON telegram_stars_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_stars_payments_target ON telegram_stars_payments(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_stars_payments_status ON telegram_stars_payments(status);
CREATE INDEX IF NOT EXISTS idx_stars_payments_created_at ON telegram_stars_payments(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stars_payments_charge_id
  ON telegram_stars_payments(telegram_payment_charge_id)
  WHERE telegram_payment_charge_id != '';

CREATE TABLE IF NOT EXISTS product_digital_assets (
  id TEXT PRIMARY KEY,
  product_id TEXT UNIQUE NOT NULL REFERENCES products(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL DEFAULT 'inline_note' CHECK (storage_provider IN ('r2', 'local', 'inline_note')),
  storage_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  delivery_instructions TEXT NOT NULL DEFAULT '',
  license_key_template TEXT NOT NULL DEFAULT '',
  download_limit INTEGER NOT NULL DEFAULT 10,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_digital_assets_product_id ON product_digital_assets(product_id);
CREATE INDEX IF NOT EXISTS idx_product_digital_assets_seller_user_id ON product_digital_assets(seller_user_id);

CREATE TABLE IF NOT EXISTS digital_download_logs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digital_download_logs_order_product ON digital_download_logs(order_id, product_id, user_id);

CREATE TABLE IF NOT EXISTS edge_rate_limits (
  rate_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edge_rate_limits_reset_at ON edge_rate_limits(reset_at);
