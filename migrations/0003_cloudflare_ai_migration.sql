-- SOFUMER Migration 0003: Migrate any existing AI feature model configurations to Cloudflare Workers AI

UPDATE ai_feature_settings
SET model_name = '@cf/meta/llama-3.1-8b-instruct-fast',
    updated_by = 'migration_0003',
    updated_at = datetime('now')
WHERE model_name NOT LIKE '@cf/%';
