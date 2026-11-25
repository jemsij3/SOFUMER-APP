# SOFUMER — GitHub Push & Deployment Guide

This guide details how to push your fully restored **SOFUMER** marketplace application and Governance Console repository to GitHub.

---

## Prerequisites

1. **Git Installed** on your local machine.
2. A **GitHub Repository** created under your GitHub account (e.g., `sofumer-marketplace`).
3. Your Cloudflare credentials ready (if setting up automated GitHub Actions deployment):
   - `CLOUDFLARE_API_TOKEN` (with Workers and D1 permissions)
   - `CLOUDFLARE_ACCOUNT_ID`

---

## Step 1: Initialize Git and Commit Files

Run the following commands in your project root directory:

```bash
# 1. Initialize git repository if not already initialized
git init

# 2. Add all files in the project workspace
git add .

# 3. Create initial commit with the restored marketplace and Governance Console
git commit -m "feat: restore complete SOFUMER marketplace frontend and retain Governance Console"
```

---

## Step 2: Connect to Your GitHub Repository

Link your local repository to your remote GitHub repository URL:

```bash
# Replace with your actual GitHub repository URL
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPOSITORY_NAME.git

# Set branch name to main
git branch -M main
```

---

## Step 3: Push to GitHub

```bash
git push -u origin main
```

---

## Step 4: Configure GitHub Actions Secrets (Optional - for Automated Deployment)

If you want GitHub Actions (`.github/workflows/deploy.yml`) to automatically deploy your Worker and apply Cloudflare D1 migrations on every push to `main`:

1. Go to your GitHub repository -> **Settings** -> **Secrets and variables** -> **Actions**.
2. Add the following **Repository Secrets**:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token.
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID.
   - `TELEGRAM_BOT_TOKEN`: Your official Telegram Bot Token (e.g. `@sofumer_bot`).
   - `TELEGRAM_WEBHOOK_SECRET`: 32-character secret string.
   - `JWT_SECRET`: 32-character secret string for secure session signing.
   - `ADMIN_TELEGRAM_IDS`: Comma-separated administrator Telegram IDs (e.g. `999001`).
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (optional Cloudinary media storage credentials).

---

## Local Development & Testing

- Run development server: `npm run dev`
- Run worker development: `npm run dev:worker`
- Run typecheck & linter: `npm run lint`
- Run full unit & worker tests: `npm test`
- Run integration tests: `npm run test:integration`
