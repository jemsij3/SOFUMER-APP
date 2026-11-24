-- SOFUMER Migration 0008: Safe Shop Deletion Metadata, Protected Audit-Log Archive Lifecycle & Conversation Hiding

ALTER TABLE shops ADD COLUMN deleted_at TEXT;
ALTER TABLE shops ADD COLUMN deleted_by TEXT DEFAULT '';
ALTER TABLE shops ADD COLUMN deletion_reason TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_shops_deleted_at ON shops(deleted_at);

ALTER TABLE admin_audit_logs ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_audit_logs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_audit_logs ADD COLUMN archived_at TEXT;
ALTER TABLE admin_audit_logs ADD COLUMN archived_by TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_is_archived ON admin_audit_logs(is_archived);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_is_protected ON admin_audit_logs(is_protected);

-- Audit source rows remain immutable when protected; this table records who archived each entry and why.
CREATE TABLE IF NOT EXISTS admin_audit_log_archives (
  log_id TEXT PRIMARY KEY,
  archived_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_archives_archived_at
  ON admin_audit_log_archives(archived_at);

UPDATE admin_audit_logs
SET is_protected = 1
WHERE action LIKE 'audit.%'
   OR action LIKE 'rbac.%'
   OR action LIKE 'setting%'
   OR action LIKE 'plan.%'
   OR action LIKE 'ai.%'
   OR action LIKE 'shop.deleted%'
   OR action IN (
     'user.status_updated',
     'seller.updated',
     'promotion.updated',
     'notification.broadcast',
     'notification.deleted',
     'order.status_updated'
   );

ALTER TABLE conversation_participants ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_conversation_participants_hidden ON conversation_participants(user_id, is_hidden);

INSERT OR IGNORE INTO platform_settings (key, value, value_type, description)
VALUES (
  'audit_retention_days',
  '90',
  'number',
  'Retention period (days) before non-critical audit logs are eligible for archiving or cleanup'
);
