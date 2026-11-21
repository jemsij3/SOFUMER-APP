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

## 4. Automatic Cloudflare D1 Provisioning, Workers AI & Deployment

`wrangler.jsonc` declares `"database_name": "sofumer-db"` without a hardcoded `database_id` so Cloudflare / Wrangler automatically creates and binds `sofumer-db` on first deploy (and reconnects to `sofumer-db` by name on subsequent deploys). R2 (`MEDIA_BUCKET`) is intentionally excluded for now and can be added later.

1. **Deploy Worker (Auto-Creates `sofumer-db`)**:
   - **Via Cloudflare Workers Builds / Cloudflare AI** (GitHub integration for Worker `sofumer-app`):
     - **Build command**: `npm run build`
     - **Deploy command**: `npx wrangler deploy --x-provision`
     - Cloudflare automatically creates `sofumer-db` and binds it as `env.DB`. On the first `/api/*` request, the Worker's built-in `ensureD1Schema(env.DB)` bootstrapper automatically creates all 40 tables, indexes, and system configuration seeds if the database is empty.
   - **Via CLI**:
     ```bash
     npm run build
     npx wrangler deploy --x-provision
     npx wrangler d1 migrations apply sofumer-db --remote
     ```
2. **Configure Cloudflare Secrets** (Dashboard → Workers & Pages → `sofumer-app` → Settings → Variables and Secrets, or CLI):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put ADMIN_TELEGRAM_IDS
   ```
3. **GitHub Actions CI/CD**:
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub Repository Secrets. Pushing to `main` automatically runs `npm run lint`, `npm run build`, `npm test`, deploys the Worker with `--x-provision` (creating `sofumer-db` if needed), and applies `migrations/`.

