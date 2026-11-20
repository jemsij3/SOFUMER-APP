import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { db, getUploadDir, newId } from '../db.ts';
import { rateLimit, requireAuth, sanitizeText } from '../security.ts';
import {
  checkAiPermission,
  runBuyerCompareAi,
  runBuyerDiscoveryAi,
  runPlatformSupportAi,
  runSellerListingAi,
} from '../ai.ts';

export const accountAiRouter = Router();

// ============================================================================
// R2-COMPATIBLE VALIDATED FILE UPLOAD ENDPOINT
// ============================================================================
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, getUploadDir()),
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype] || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      return cb(new Error('Unsupported file type. Allowed: JPEG, PNG, WebP, GIF (max 5MB).'));
    }
    cb(null, true);
  },
});

accountAiRouter.post('/uploads', requireAuth, rateLimit(20, 60_000, 'upload'), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }
    const url = `/r2/${path.basename(req.file.filename)}`;
    res.status(201).json({ url, size: req.file.size, mimeType: req.file.mimetype });
  });
});

// ============================================================================
// USER ACCOUNT, PREFERENCES, NOTIFICATIONS, SUPPORT
// ============================================================================

accountAiRouter.patch('/account/profile', requireAuth, (req, res) => {
  const user = req.authUser!;
  const displayName = sanitizeText(req.body?.displayName ?? user.display_name, 80);
  const bio = sanitizeText(req.body?.bio ?? user.bio, 500);
  const phone = sanitizeText(req.body?.phone ?? user.phone, 32);
  const countryCode = sanitizeText(req.body?.countryCode ?? user.country_code, 4).toUpperCase();
  const preferredCurrency = sanitizeText(req.body?.preferredCurrency ?? user.preferred_currency, 6).toUpperCase();
  const preferredLanguage = sanitizeText(req.body?.preferredLanguage ?? user.preferred_language, 10);

  db.prepare(
    `UPDATE users
     SET display_name = ?, bio = ?, phone = ?, country_code = ?, preferred_currency = ?, preferred_language = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(displayName, bio, phone, countryCode, preferredCurrency, preferredLanguage, user.id);

  res.json({ updated: true });
});

accountAiRouter.get('/account/notifications', requireAuth, (req, res) => {
  const items = db
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ? OR scope = 'global'
       ORDER BY created_at DESC LIMIT 50`
    )
    .all(req.authUser!.id);
  res.json({ notifications: items });
});

accountAiRouter.patch('/account/notifications/read', requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").run(req.authUser!.id);
  res.json({ read: true });
});

accountAiRouter.get('/account/support', requireAuth, (req, res) => {
  const tickets = db
    .prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.authUser!.id);
  res.json({ tickets });
});

accountAiRouter.post('/account/support', requireAuth, (req, res) => {
  const category = sanitizeText(req.body?.category || 'general', 40);
  const subject = sanitizeText(req.body?.subject || '', 140);
  const message = sanitizeText(req.body?.message || '', 2000);
  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }
  const ticketId = newId('tkt');
  db.prepare(
    `INSERT INTO support_tickets (id, user_id, category, subject, message) VALUES (?, ?, ?, ?, ?)`
  ).run(ticketId, req.authUser!.id, category, subject, message);
  res.status(201).json({ ticketId, status: 'open' });
});

// ============================================================================
// SERVER-SIDE AI ENDPOINTS (PROTECTED BY BACKEND GOVERNANCE)
// ============================================================================

accountAiRouter.get('/ai/status', requireAuth, (req, res) => {
  const features = db.prepare('SELECT feature_key, label, is_enabled, daily_limit_per_user FROM ai_feature_settings').all();
  const check = checkAiPermission(req.authUser!.id, 'buyer_search');
  res.json({
    allowed: check.allowed,
    reason: check.reason || null,
    dailyLimit: check.dailyLimit,
    usedToday: check.usedToday,
    features,
  });
});

accountAiRouter.post('/ai/buyer/discover', requireAuth, rateLimit(20, 60_000, 'ai'), async (req, res) => {
  const query = sanitizeText(req.body?.query || '', 600);
  if (!query) {
    return res.status(400).json({ error: 'Search prompt is required.' });
  }
  try {
    const result = await runBuyerDiscoveryAi(req.authUser!.id, query);
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'AI request failed' });
  }
});

accountAiRouter.post('/ai/buyer/compare', requireAuth, rateLimit(15, 60_000, 'ai'), async (req, res) => {
  const productIds = Array.isArray(req.body?.productIds)
    ? req.body.productIds.map((id: unknown) => sanitizeText(id, 64)).filter(Boolean)
    : [];
  const focusQuestion = sanitizeText(req.body?.focusQuestion || '', 400);
  try {
    const result = await runBuyerCompareAi(req.authUser!.id, productIds, focusQuestion);
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'AI comparison failed' });
  }
});

accountAiRouter.post('/ai/seller/assist', requireAuth, rateLimit(20, 60_000, 'ai'), async (req, res) => {
  const action = req.body?.action;
  if (!['generate_listing', 'translate', 'analytics'].includes(action)) {
    return res.status(400).json({ error: 'Invalid seller AI action.' });
  }
  try {
    const result = await runSellerListingAi(req.authUser!.id, {
      action,
      title: sanitizeText(req.body?.title || '', 140),
      notes: sanitizeText(req.body?.notes || '', 2500),
      listingType: sanitizeText(req.body?.listingType || 'physical', 24),
      targetLanguage: sanitizeText(req.body?.targetLanguage || 'French', 40),
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Seller AI failed' });
  }
});

accountAiRouter.post('/ai/platform/support', requireAuth, rateLimit(20, 60_000, 'ai'), async (req, res) => {
  const question = sanitizeText(req.body?.question || '', 800);
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }
  try {
    const result = await runPlatformSupportAi(req.authUser!.id, question);
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Support AI failed' });
  }
});
