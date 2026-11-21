/**
 * SOFUMER — Cloudflare Workers Primary Entry Point (`main = "src/index.js"`)
 * Connects the existing Cloudflare Worker `sofumer-app` to the full SOFUMER
 * marketplace backend, Telegram Bot integration, D1/R2/Workers AI, and React SPA.
 */
import worker from '../cloudflare/worker.ts';

export default worker;
