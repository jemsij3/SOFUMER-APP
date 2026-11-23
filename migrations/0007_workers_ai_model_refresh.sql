-- SOFUMER Migration 0007: Refresh Cloudflare Workers AI Model Catalog (retire Qwen3-30B-A3B-FP8 deprecated Nov 20, 2026)

UPDATE ai_feature_settings
SET model_name = '@cf/meta/llama-3.1-8b-instruct-fast',
    updated_by = 'migration_0007',
    updated_at = datetime('now')
WHERE model_name IN (
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/infire-llama-3.1-8b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.1',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen2.5-7b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8'
)
OR model_name NOT LIKE '@cf/%';
