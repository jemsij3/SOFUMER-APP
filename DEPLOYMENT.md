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
4. Configure the Mini App button in `@BotFather` (`/newapp` or `/setmenubutton`) pointing to your production HTTPS URL (`<YOUR_WORKER_URL>`).
5. Generate a random 32+ character webhook secret (`TELEGRAM_WEBHOOK_SECRET`).
6. Register the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "<YOUR_WORKER_URL>/api/telegram/webhook",
       "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
     }'
   ```

---

## 3. Required Environment Variables & Secrets Checklist

| Variable / Secret | Scope | Required | Purpose |
| :--- | :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Cloudflare Secret | Yes | Verifies Telegram `initData` HMAC-SHA256, resolves bot info via `getMe`, sends bot messages, and creates Telegram Stars (`XTR`) invoice links |
| `TELEGRAM_WEBHOOK_SECRET` | Cloudflare Secret | Yes | Validates `X-Telegram-Bot-Api-Secret-Token` header on webhook (`pre_checkout_query` & `successful_payment`) |
| `JWT_SECRET` | Cloudflare Secret | Yes | Signs & verifies HS256 JWT authentication tokens for Telegram users |
| `ADMIN_TELEGRAM_IDS` (or `ADMIN_TELEGRAM_ID`) | Cloudflare Secret / Var | Yes | Comma-separated numeric Telegram user IDs authorized for the Admin Governance Console |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudflare Secret / Var | Optional | Preserved automatically across deploys via `keep_vars: true` and `--keep-vars` |
| `MINI_APP_URL` | Env Var (Optional) | No | Optional override for Mini App URL used in Telegram bot buttons |
| `CLOUDFLARE_AI_MODEL` | `wrangler.jsonc` Var | Yes | Cloudflare Workers AI model (default: `@cf/meta/llama-3.1-8b-instruct-fast`) |
| `CLOUDFLARE_ACCOUNT_ID` | Local Dev Only | Optional | Used only when running Node.js `server.ts` outside Cloudflare Workers |
| `CLOUDFLARE_AI_API_TOKEN` | Local Dev Only | Optional | Workers AI REST token when testing AI from Node.js outside Wrangler |

> **Note:** SOFUMER enforces strict Telegram Mini App-only authentication. Standard public browser access without valid Telegram `initData` is rejected on both the UI and all marketplace/commerce/AI/admin API endpoints.

---

## 4. Telegram Stars (`XTR`) Billing & Protected Digital Delivery

- **Telegram Stars (`XTR`) Payments**: Paid seller plans (`PRO`, `BUSINESS`) and promotional placements require real Telegram Stars invoices created via Bot API `createInvoiceLink` (`POST /api/seller/subscriptions/invoice`, `POST /api/seller/promotions/invoice`), opened natively via `Telegram.WebApp.openInvoice(...)`, verified synchronously on `pre_checkout_query`, and fulfilled idempotently on `message.successful_payment`. Ensure your webhook is registered so Telegram delivers payment updates.
- **Protected Digital Product Delivery**: Digital product packages (`product_digital_assets`) are blocked from public `/r2/digital/*` access and unlock only for confirmed/completed orders (`GET /api/orders/:id/digital` and `/api/orders/:id/digital/:productId/download`).
- **Optional Future R2 Storage**: `MEDIA_BUCKET` is intentionally omitted from `wrangler.jsonc` for now and can be bound later when binary asset hosting in R2 is enabled.

---

## 5. Automatic Cloudflare D1 Provisioning, Workers AI & Deployment

`wrangler.jsonc` targets production Worker `sofumer-app`, sets `"keep_vars": true` to protect dashboard-managed Environment Variables, and binds `sofumer-db` (`DB`), Workers AI (`AI`), and static assets (`ASSETS`). Migrations `0001`–`0008` define all tables, indexes, and system seeds.

1. **Deploy Worker**:
   - **Via Cloudflare Workers Builds** (Dashboard Git integration for Worker `sofumer-app`):
     - **Build command**: `npm run build`
     - **Deploy command**: `npx wrangler deploy --x-provision --keep-vars` (IMPORTANT: omitting `--keep-vars` causes Cloudflare Workers Builds to wipe dashboard Secrets/Vars such as `TELEGRAM_BOT_TOKEN` and `JWT_SECRET` on deploy)
     - On the first `/api/*` request, the Worker's built-in `ensureD1Schema(env.DB)` bootstrapper automatically creates any missing tables, columns, indexes, and system configuration seeds.
   - **Via CLI**:
     ```bash
     npm run build
     npx wrangler deploy --name sofumer-app --keep-vars --x-provision
     npx wrangler d1 migrations apply sofumer-db --remote -y
     ```
2. **Configure Cloudflare Secrets** (Dashboard → Workers & Pages → `sofumer-app` → Settings → Variables and Secrets, or CLI):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put ADMIN_TELEGRAM_IDS
   ```
3. **GitHub Actions CI/CD**:
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub Repository Secrets. Pushing to `main` runs `npm run lint`, `npm run build`, `npm test`, deploys `sofumer-app` with `--keep-vars --x-provision` (preserving all dashboard Environment Variables and Secrets), and applies `migrations/` with `-y`.


