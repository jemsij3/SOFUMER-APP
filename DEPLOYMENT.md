# SOFUMER — Deployment & Configuration Guide

**SOFUMER — AI-Powered Global Marketplace**  
*Buy Smarter. Sell Faster.*

---

## 1. Architecture Overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Telegram Mini Apps SDK (`https://telegram.org/js/telegram-web-app.js`).
- **Development / Node.js Runtime**: `server.ts` (Express + Vite + SQLite `better-sqlite3` running the exact D1 SQL migrations + local R2 mirror `storage/r2/` + Cloudflare Workers AI REST adapter).
- **Production Edge Target**: Cloudflare Workers (`cloudflare/worker.ts`) + Cloudflare D1 (`DB`) + Cloudflare R2 (`MEDIA_BUCKET`, Free Tier 10 GB/mo) + **Cloudflare Workers AI (`env.AI` binding)** + GitHub Actions CI/CD (`.github/workflows/deploy.yml`).

---

## 2. Independent SOFUMER Telegram Bot Setup

SOFUMER requires its own dedicated Telegram Bot (never reuse credentials from another project).

1. Open `@BotFather` on Telegram and run `/newbot`.
2. Name: `SOFUMER`, Username: e.g. `SofumerBot`.
3. Copy the Bot Token (`TELEGRAM_BOT_TOKEN`).
4. Configure the Mini App button in `@BotFather` (`/newapp` or `/setmenubutton`) pointing to your production HTTPS URL (`MINI_APP_URL`).
5. Generate a random 32+ character webhook secret (`TELEGRAM_WEBHOOK_SECRET`).
6. Register the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://<YOUR_DOMAIN>/api/telegram/webhook",
       "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
     }'
   ```

---

## 3. Required Environment Variables & Secrets Checklist

| Variable / Secret | Scope | Required | Purpose |
| :--- | :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Server Secret | Yes (Prod) | Verifies Telegram `initData` HMAC-SHA256 & sends bot messages |
| `TELEGRAM_WEBHOOK_SECRET` | Server Secret | Yes (Prod) | Validates `X-Telegram-Bot-Api-Secret-Token` header on webhook |
| `TELEGRAM_BOT_NAME` | Env Var | Yes | Bot display name (`SOFUMER`) |
| `TELEGRAM_BOT_USERNAME` | Env Var | Yes | Bot handle without `@` (e.g. `SofumerBot`) |
| `MINI_APP_URL` | Env Var | Yes | Public HTTPS URL of the SOFUMER Mini App |
| `SESSION_SECRET` | Server Secret | Yes (Prod) | Signs user and admin session token hashes |
| `ADMIN_BOOTSTRAP_SECRET` | Server Secret | Yes | Server-side passcode to authenticate the initial Owner Admin |
| `CLOUDFLARE_AI_MODEL` | `wrangler.toml` Var | Yes | Cloudflare Workers AI model (default: `@cf/meta/llama-3.1-8b-instruct`) |
| `CLOUDFLARE_ACCOUNT_ID` | Local Dev Only | Optional | Used only when running Node.js `server.ts` outside Cloudflare Workers |
| `CLOUDFLARE_AI_API_TOKEN` | Local Dev Only | Optional | Workers AI REST token when testing AI from Node.js outside Wrangler |
| `ALLOW_DEV_SANDBOX` | Env Var | Prod: `false` | Enables cryptographic preview sandbox outside Telegram in dev only |

> **Note:** In Cloudflare Workers production, AI runs natively via the `[ai]` binding (`env.AI`) declared in `wrangler.toml`. No external AI API key is needed in production.

---

## 4. Cloudflare D1, R2, Workers AI & Deployment

1. **Create Cloudflare resources (Free Tier compatible, no Paid Queues plan required)**:
   ```bash
   npx wrangler d1 create sofumer-db
   npx wrangler r2 bucket create sofumer-media
   ```
2. Update `database_id` in `wrangler.toml` with the output ID from `d1 create`.
3. Verify the Workers AI binding in `wrangler.toml`:
   ```toml
   [ai]
   binding = "AI"
   ```
4. **Apply version-controlled D1 migrations**:
   ```bash
   npx wrangler d1 migrations apply sofumer-db --remote
   ```
5. **Configure Cloudflare Secrets**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
   ```
6. **Build and Deploy**:
   ```bash
   npm run build
   npx wrangler deploy
   ```
7. **GitHub Actions CI/CD**:
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub Repository Secrets. Pushing to `main` automatically runs `npm run lint`, `npm run build`, applies D1 migrations, and deploys to Cloudflare.
