# SOFUMER — AI-Powered Global Marketplace

**Buy Smarter. Sell Faster.**

SOFUMER is an independent global multi-vendor Telegram Mini App marketplace connecting buyers, sellers, individuals, and businesses across physical products, digital downloads, software licenses, and professional services.

- **Production Worker**: `sofumer-app`
- **Cloudflare Runtime**: Cloudflare Workers (`src/index.js` → `cloudflare/worker.ts`) + Cloudflare D1 (`DB`) + Cloudflare R2 (`MEDIA_BUCKET`) + Cloudflare Workers AI (`env.AI`) + Static Assets (`./dist`)
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Telegram Mini Apps SDK

---

## Project Structure

```text
sofumer-app/
├── src/
│   ├── index.js                # Wrangler Worker entrypoint (exports SOFUMER Edge Worker)
│   ├── main.tsx                # React SPA entrypoint
│   ├── App.tsx                 # Marketplace UI shell
│   ├── pages/                  # Buyer, Seller, AI Assistant, Messaging, Orders, Admin pages
│   └── ...
├── cloudflare/
│   ├── worker.ts               # Edge router, Telegram auth & webhook, R2 media, SPA assets
│   ├── helpers.ts              # Web Crypto Telegram HMAC-SHA256 & D1 auth helpers
│   ├── routes-marketplace.ts   # Catalog, explore, product detail, shops, favorites, reports
│   ├── routes-seller.ts        # Seller onboarding, shop management, listings, plans, promos
│   ├── routes-commerce.ts      # Conversations, direct orders, reviews, account & support
│   ├── routes-ai.ts            # Cloudflare Workers AI (`env.AI`) endpoints & quota enforcement
│   └── routes-admin.ts         # Isolated admin governance console API
├── migrations/                 # Version-controlled D1 SQL migrations (0001–0003)
├── test/
│   └── worker.test.js          # Vitest + @cloudflare/vitest-pool-workers Worker test suite
├── tests/
│   └── integration.ts          # Full end-to-end API & D1 SQLite adapter test suite
├── wrangler.toml               # Worker config (`name = "sofumer-app"`, `main = "src/index.js"`)
├── vitest.config.ts            # Cloudflare Workers pool test configuration
├── eslint.config.mjs           # ESLint configuration
├── .dev.vars.example           # Local Wrangler secret template (never commit `.dev.vars`)
└── .github/workflows/deploy.yml
```

---

## 1. Install Dependencies

```bash
npm install
```

## 2. Local Development

### Option A — Full-Stack Preview (Express + Vite + SQLite D1 mirror)

```bash
cp .env.example .env
npm run dev
```

### Option B — Cloudflare Workers Local Runtime (`wrangler dev`)

```bash
cp .dev.vars.example .dev.vars
# Fill in your TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SESSION_SECRET, ADMIN_BOOTSTRAP_SECRET in .dev.vars
npm run build
npx wrangler d1 migrations apply sofumer-db --local
npx wrangler dev
```

## 3. Linting & Automated Tests

```bash
# TypeScript + ESLint checks
npm run lint

# Build frontend static bundle (./dist)
npm run build

# Run Cloudflare Worker Vitest suite (@cloudflare/vitest-pool-workers)
npm test
```

## 4. Cloudflare Resource & Secret Setup

Create the Cloudflare D1 database and R2 bucket (Free Tier compatible, no Paid Queues plan required):

```bash
npx wrangler d1 create sofumer-db
npx wrangler r2 bucket create sofumer-media
```

Update `database_id` in `wrangler.toml` with the UUID printed by `wrangler d1 create`, then apply remote migrations:

```bash
npx wrangler d1 migrations apply sofumer-db --remote
```

Configure production secrets (never stored in `wrangler.toml` or Git):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
```

## 5. Deploy to Existing `sofumer-app` Worker

```bash
npm run build
npx wrangler deploy
```

## 6. Secure Telegram Webhook Registration

After deploying `sofumer-app`, register your Telegram bot webhook **once** using the `TELEGRAM_BOT_TOKEN` and the same `TELEGRAM_WEBHOOK_SECRET` stored via `wrangler secret put`:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://sofumer-app.derartuaman8.workers.dev/api/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Verify the webhook status:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```
