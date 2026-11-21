# SOFUMER — Deployment & Configuration Guide

**SOFUMER — AI-Powered Global Marketplace**  
*Buy Smarter. Sell Faster.*

---

## 1. Architecture Overview

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Telegram Mini Apps SDK (`https://telegram.org/js/telegram-web-app.js`).
- **Development / Node.js Runtime**: `server.ts` (Express + Vite + SQLite `better-sqlite3` running the exact D1 SQL migrations + local R2 mirror `storage/r2/` + Cloudflare Workers AI REST adapter).
- **Production Edge Target**: Cloudflare Workers (`cloudflare/worker.ts`) + Cloudflare D1 (`DB` / `sofumer-db`) + **Cloudflare Workers AI (`env.AI` binding)** + GitHub Actions CI/CD (`.github/workflows/deploy.yml`). (R2 media bucket omitted for now; can be enabled later.)

---

## 2. Independent SOFUMER Telegram Bot Setup

SOFUMER requires its own dedicated Telegram Bot (never reuse credentials from another project).

1. Open `@BotFather` on Telegram and run `/newbot`.
2. Choose your bot display name and handle (public bot info is automatically retrieved via Telegram `getMe` from `TELEGRAM_BOT_TOKEN`).
3. Copy the Bot Token (`TELEGRAM_BOT_TOKEN`).
4. Configure the Mini App button in `@BotFather` (`/newapp` or `/setmenubutton`) pointing to your production HTTPS URL (`https://sofumer-app.derartuaman8.workers.dev`).
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
| `TELEGRAM_BOT_TOKEN` | Cloudflare Secret | Yes | Verifies Telegram `initData` HMAC-SHA256, resolves bot info via `getMe`, and sends bot messages |
| `TELEGRAM_WEBHOOK_SECRET` | Cloudflare Secret | Yes | Validates `X-Telegram-Bot-Api-Secret-Token` header on webhook |
| `JWT_SECRET` | Cloudflare Secret | Yes | Signs & verifies HS256 JWT authentication tokens for Telegram users |
| `ADMIN_TELEGRAM_IDS` | Cloudflare Secret | Yes | Comma-separated numeric Telegram user IDs authorized for the Admin Governance Console |
| `MINI_APP_URL` | Env Var (Optional) | No | Optional override for Mini App URL used in Telegram bot buttons |
| `CLOUDFLARE_AI_MODEL` | `wrangler.jsonc` Var | Yes | Cloudflare Workers AI model (default: `@cf/meta/llama-3.1-8b-instruct`) |
| `CLOUDFLARE_ACCOUNT_ID` | Local Dev Only | Optional | Used only when running Node.js `server.ts` outside Cloudflare Workers |
| `CLOUDFLARE_AI_API_TOKEN` | Local Dev Only | Optional | Workers AI REST token when testing AI from Node.js outside Wrangler |

> **Note:** SOFUMER enforces strict Telegram Mini App-only authentication. Standard public browser access without valid Telegram `initData` is rejected on both the UI and all marketplace/commerce/AI/admin API endpoints.

---

## 4. Cloudflare D1, Workers AI & Deployment

1. **D1 Database (`sofumer-db`)**:
   - Configured in `wrangler.jsonc` with `database_id: "37387526-bf6a-4a2d-bf61-70dece9eb2f5"` (`WEUR`).
   - R2 bucket (`MEDIA_BUCKET`) is intentionally excluded for now and can be added later.
2. **Apply version-controlled D1 migrations**:
   ```bash
   npx wrangler d1 migrations apply sofumer-db --remote
   ```
3. **Configure Cloudflare Secrets**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put ADMIN_TELEGRAM_IDS
   ```
6. **Build and Deploy**:
   ```bash
   npm run build
   npx wrangler deploy
   ```
   If using **Cloudflare Workers Builds** (GitHub auto-deploy for Worker `sofumer-app`):
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
7. **GitHub Actions CI/CD**:
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub Repository Secrets. Pushing to `main` automatically runs `npm run lint`, `npm run build`, applies D1 migrations, and deploys to Cloudflare.
