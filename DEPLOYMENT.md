# SOFUMER — Deployment & Configuration Guide

**SOFUMER — AI-Powered Global Marketplace**  
*Buy Smarter. Sell Faster.*

---

## 1. Architecture Overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Telegram Mini Apps SDK (`https://telegram.org/js/telegram-web-app.js`).
- **Development / Node.js Runtime**: `server.ts` (Express + Vite + SQLite `better-sqlite3` running the exact D1 SQL migrations + local R2 mirror `storage/r2/` + `@google/genai`).
- **Production Edge Target**: Cloudflare Workers (`cloudflare/worker.ts`) + Cloudflare D1 (`DB`) + Cloudflare R2 (`MEDIA_BUCKET`) + Cloudflare Workers AI (`AI`) + Cloudflare Queues (`SOFUMER_QUEUE`) + GitHub Actions CI/CD (`.github/workflows/deploy.yml`).

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
| `GEMINI_API_KEY` | Server Secret | Yes | Enables server-side Gemini AI shopping, listing & support endpoints |
| `ALLOW_DEV_SANDBOX` | Env Var | Prod: `false` | Enables cryptographic preview sandbox outside Telegram in dev only |

---

## 4. Cloudflare D1, R2, Queues & Workers Deployment

1. **Create Cloudflare resources**:
   ```bash
   npx wrangler d1 create sofumer-db
   npx wrangler r2 bucket create sofumer-media
   npx wrangler queues create sofumer-notifications
   ```
2. Update `database_id` in `wrangler.toml` with the output ID from `d1 create`.
3. **Apply version-controlled D1 migrations**:
   ```bash
   npx wrangler d1 migrations apply sofumer-db --remote
   ```
4. **Configure Cloudflare Secrets**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
   npx wrangler secret put GEMINI_API_KEY
   ```
5. **Build and Deploy**:
   ```bash
   npm run build
   npx wrangler deploy
   ```
6. **GitHub Actions CI/CD**:
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub Repository Secrets. Pushing to `main` automatically runs `npm run lint`, `npm run build`, applies D1 migrations, and deploys to Cloudflare.
