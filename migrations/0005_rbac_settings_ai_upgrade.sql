-- SOFUMER Migration 0005: Database-Backed RBAC Assignments, Expanded Permissions, and Active Cloudflare Workers AI Model Upgrade

-- 1. Database-backed Admin Role Assignments
CREATE TABLE IF NOT EXISTS admin_role_assignments (
  id TEXT PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  role_id TEXT NOT NULL REFERENCES admin_roles(id),
  display_label TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  assigned_by TEXT DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_telegram_id ON admin_role_assignments(telegram_id);
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_role_id ON admin_role_assignments(role_id);

-- 2. Expanded Canonical Permissions for Built-In Roles (idempotent)
INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES
  ('perm_1', 'role_owner', '*'),
  ('perm_mod_overview', 'role_mod', 'overview.view'),
  ('perm_mod_analytics', 'role_mod', 'analytics.view'),
  ('perm_mod_sellers', 'role_mod', 'sellers.manage'),
  ('perm_mod_shops', 'role_mod', 'shops.manage'),
  ('perm_mod_orders', 'role_mod', 'orders.manage'),
  ('perm_mod_reviews', 'role_mod', 'reviews.manage'),
  ('perm_mod_messages', 'role_mod', 'messages.moderate'),
  ('perm_mod_support', 'role_mod', 'support.manage'),
  ('perm_mod_audit', 'role_mod', 'audit.view'),
  ('perm_ops_overview', 'role_ops', 'overview.view'),
  ('perm_ops_analytics', 'role_ops', 'analytics.view'),
  ('perm_ops_countries', 'role_ops', 'countries.manage'),
  ('perm_ops_notifications', 'role_ops', 'notifications.manage'),
  ('perm_ops_orders', 'role_ops', 'orders.manage');

-- 3. Upgrade Deprecated Cloudflare Workers AI Models to Active Fast Default
UPDATE ai_feature_settings
SET model_name = '@cf/meta/llama-3.1-8b-instruct-fast',
    updated_by = 'migration_0005',
    updated_at = datetime('now')
WHERE model_name IN (
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/infire-llama-3.1-8b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.1',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen2.5-7b-instruct'
)
OR model_name NOT LIKE '@cf/%';
