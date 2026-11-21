import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityDate: '2026-08-15',
          bindings: {
            TELEGRAM_BOT_NAME: 'SOFUMER',
            TELEGRAM_BOT_USERNAME: 'SofumerBot',
            CLOUDFLARE_AI_MODEL: '@cf/meta/llama-3.1-8b-instruct',
            ALLOW_DEV_SANDBOX: 'false',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.js'],
    },
  };
});
