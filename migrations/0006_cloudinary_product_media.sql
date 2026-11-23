-- SOFUMER Migration 0006: Cloudinary Product Photos & Short Videos Media Table & Configurable Limits

CREATE TABLE IF NOT EXISTS product_media (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL DEFAULT 'cloudinary' CHECK (storage_provider IN ('cloudinary', 'legacy_url')),
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('image', 'video')),
  public_id TEXT NOT NULL DEFAULT '',
  secure_url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  duration REAL DEFAULT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_media_product_id ON product_media(product_id);
CREATE INDEX IF NOT EXISTS idx_product_media_product_type_order ON product_media(product_id, media_type, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_media_seller_user_id ON product_media(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_product_media_public_id ON product_media(public_id) WHERE public_id != '';

INSERT OR IGNORE INTO platform_settings (key, value, value_type, description) VALUES
  ('max_product_videos', '2', 'number', 'Maximum number of short videos allowed per product (independent of the 6-photo limit)'),
  ('max_product_image_mb', '10', 'number', 'Maximum file size in MB per product photo (JPG, JPEG, PNG, WebP)'),
  ('max_product_video_mb', '30', 'number', 'Maximum file size in MB per product short video (MP4, MOV, max 10 seconds)');
