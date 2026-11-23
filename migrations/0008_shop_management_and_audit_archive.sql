-- SOFUMER Migration 0008: Protected audit-log archive markers.
-- Audit source rows remain immutable; this table records who archived each entry and why.
CREATE TABLE IF NOT EXISTS admin_audit_log_archives (
  log_id TEXT PRIMARY KEY,
  archived_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_archives_archived_at
  ON admin_audit_log_archives(archived_at);
