import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { getUploadDir, runMigrations } from './server/db.ts';
import { authRouter } from './server/routes/auth.ts';
import { marketplaceRouter } from './server/routes/marketplace.ts';
import { sellerRouter } from './server/routes/seller.ts';
import { messagingOrdersRouter } from './server/routes/messaging_orders.ts';
import { accountAiRouter } from './server/routes/account_ai.ts';
import { adminRouter } from './server/routes/admin.ts';
import { processTelegramWebhookUpdate, verifyWebhookSecret } from './server/telegram.ts';
import { verifyCookieCsrf } from './server/security.ts';

async function startServer() {
  runMigrations();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  // Basic security headers (compatible with Telegram Mini App & iframe embedding)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(verifyCookieCsrf);

  // Never serve private digital product files publicly under /r2
  app.use('/r2/digital', (_req, res) => {
    res.status(403).json({ error: 'Protected digital assets require authenticated order delivery.' });
  });

  // Serve R2-compatible uploaded media with safe headers
  app.use(
    '/r2',
    express.static(getUploadDir(), {
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    })
  );

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      service: 'SOFUMER',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // Independent SOFUMER Telegram Bot Webhook
  app.post('/api/telegram/webhook', async (req, res) => {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    const headerStr = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    if (!verifyWebhookSecret(headerStr)) {
      return res.status(401).json({ error: 'Invalid Telegram webhook secret.' });
    }
    try {
      const result = await processTelegramWebhookUpdate(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Webhook processing error' });
    }
  });

  // Modular API routes
  app.use('/api/auth', authRouter);
  app.use('/api/marketplace', marketplaceRouter);
  app.use('/api/seller', sellerRouter);
  app.use('/api', messagingOrdersRouter);
  app.use('/api', accountAiRouter);
  app.use('/api/admin', adminRouter);

  // Return JSON 404 for unknown /api routes
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(500).send('Production build missing. Run npm run build.');
      }
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SOFUMER server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start SOFUMER server:', err);
  process.exit(1);
});
