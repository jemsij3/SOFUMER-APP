import fs from 'fs';
import { Router } from 'express';
import { db, newId, resolveConfinedDigitalPath } from '../db.ts';
import {
  PAID_ORDER_STATUSES,
  isSafeUrlOrEmpty,
  rateLimit,
  requireAuth,
  sanitizeSafeUrl,
  sanitizeText,
} from '../security.ts';
import { notifyUserAndTelegram } from '../telegram.ts';

export const messagingOrdersRouter = Router();

// ============================================================================
// MESSAGING & INQUIRIES
// ============================================================================

messagingOrdersRouter.get('/conversations', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const rows = db
    .prepare(
      `SELECT c.*, cp.unread_count, cp.role as my_role,
              p.title as product_title, p.price as product_price, p.currency as product_currency,
              (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) as product_image,
              s.name as shop_name, s.slug as shop_slug,
              other_u.id as other_user_id, other_u.display_name as other_user_name,
              other_u.telegram_username as other_telegram_username, other_u.avatar_url as other_avatar_url
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id
       JOIN conversation_participants other_cp ON other_cp.conversation_id = c.id AND other_cp.user_id != cp.user_id
       JOIN users other_u ON other_u.id = other_cp.user_id
       LEFT JOIN products p ON p.id = c.product_id
       LEFT JOIN shops s ON s.id = c.shop_id
       WHERE cp.user_id = ?
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`
    )
    .all(userId);
  res.json({ conversations: rows });
});

messagingOrdersRouter.post('/conversations', requireAuth, rateLimit(20, 60_000, 'msg'), async (req, res) => {
  const buyerId = req.authUser!.id;
  const productId = sanitizeText(req.body?.productId || '', 64) || null;
  const shopIdInput = sanitizeText(req.body?.shopId || '', 64) || null;
  const initialMessage = sanitizeText(req.body?.message || '', 2000);

  let sellerUserId = '';
  let shopId = shopIdInput;
  let subject = sanitizeText(req.body?.subject || 'Marketplace Inquiry', 140);

  if (productId) {
    const product = db
      .prepare(
        `SELECT p.id, p.shop_id, p.seller_user_id, p.title
         FROM products p JOIN shops s ON s.id = p.shop_id
         WHERE p.id = ? AND p.status = 'published' AND s.status = 'active'`
      )
      .get(productId) as { id: string; shop_id: string; seller_user_id: string; title: string } | undefined;
    if (!product) {
      return res.status(404).json({ error: 'Listing not found.' });
    }
    sellerUserId = product.seller_user_id;
    shopId = product.shop_id;
    subject = product.title;
  } else if (shopId) {
    const shop = db
      .prepare("SELECT id, user_id, name FROM shops WHERE id = ? AND status = 'active'")
      .get(shopId) as { id: string; user_id: string; name: string } | undefined;
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found.' });
    }
    sellerUserId = shop.user_id;
    subject = `Inquiry: ${shop.name}`;
  } else {
    return res.status(400).json({ error: 'Product ID or Shop ID is required.' });
  }

  if (sellerUserId === buyerId) {
    return res.status(400).json({ error: 'You cannot start a conversation with yourself.' });
  }

  const blocked = db
    .prepare(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?)`
    )
    .get(buyerId, sellerUserId, sellerUserId, buyerId);
  if (blocked) {
    return res.status(403).json({ error: 'Messaging is blocked between these accounts.' });
  }

  // Reuse existing conversation for same buyer + seller + product
  const existing = db
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = ?
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = ?
       WHERE (? IS NULL AND c.product_id IS NULL AND c.shop_id = ?) OR c.product_id = ?
       LIMIT 1`
    )
    .get(buyerId, sellerUserId, productId, shopId, productId) as { id: string } | undefined;

  let conversationId = existing?.id;

  if (!conversationId) {
    conversationId = newId('conv');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations (id, product_id, shop_id, subject, last_message_at, last_message_preview)
         VALUES (?, ?, ?, ?, datetime('now'), ?)`
      ).run(conversationId, productId, shopId, subject, initialMessage.slice(0, 120));

      db.prepare(
        `INSERT INTO conversation_participants (id, conversation_id, user_id, role, unread_count)
         VALUES (?, ?, ?, 'buyer', 0)`
      ).run(newId('cp'), conversationId, buyerId);

      db.prepare(
        `INSERT INTO conversation_participants (id, conversation_id, user_id, role, unread_count)
         VALUES (?, ?, ?, 'seller', ?)`
      ).run(newId('cp'), conversationId, sellerUserId, initialMessage ? 1 : 0);

      if (productId && shopId) {
        db.prepare(
          `INSERT INTO inquiries (id, product_id, shop_id, buyer_user_id, seller_user_id, conversation_id, initial_message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId('inq'),
          productId,
          shopId,
          buyerId,
          sellerUserId,
          conversationId,
          initialMessage || 'Started product inquiry'
        );
        db.prepare('UPDATE products SET inquiry_count = inquiry_count + 1 WHERE id = ?').run(productId);
      }

      if (initialMessage) {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
           VALUES (?, ?, ?, ?, 'text')`
        ).run(newId('msg'), conversationId, buyerId, initialMessage);
      }
    })();

    if (initialMessage) {
      await notifyUserAndTelegram(
        sellerUserId,
        'message',
        `New Inquiry: ${subject}`,
        `${req.authUser!.display_name}: ${initialMessage.slice(0, 120)}`
      );
    }
  } else if (initialMessage) {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
         VALUES (?, ?, ?, ?, 'text')`
      ).run(newId('msg'), conversationId, buyerId, initialMessage);

      db.prepare(
        `UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?`
      ).run(initialMessage.slice(0, 120), conversationId);

      db.prepare(
        `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
      ).run(conversationId, sellerUserId);
    })();

    await notifyUserAndTelegram(
      sellerUserId,
      'message',
      `New Message: ${subject}`,
      `${req.authUser!.display_name}: ${initialMessage.slice(0, 120)}`
    );
  }

  res.status(201).json({ conversationId });
});

messagingOrdersRouter.get('/conversations/:id/messages', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const convId = req.params.id;

  const participant = db
    .prepare('SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?')
    .get(convId, userId);
  if (!participant) {
    return res.status(403).json({ error: 'Not authorized to access this conversation.' });
  }

  db.prepare(
    `UPDATE conversation_participants
     SET unread_count = 0, last_read_at = datetime('now')
     WHERE conversation_id = ? AND user_id = ?`
  ).run(convId, userId);

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name as sender_name, u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON u.id = m.sender_user_id
       WHERE m.conversation_id = ? AND m.is_deleted = 0
       ORDER BY m.created_at ASC`
    )
    .all(convId);

  res.json({ messages });
});

messagingOrdersRouter.post('/conversations/:id/messages', requireAuth, rateLimit(40, 60_000, 'msg'), async (req, res) => {
  const userId = req.authUser!.id;
  const convId = req.params.id;

  const myPart = db
    .prepare('SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?')
    .get(convId, userId);
  if (!myPart) {
    return res.status(403).json({ error: 'Not authorized to send messages in this conversation.' });
  }

  const otherPart = db
    .prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ? LIMIT 1')
    .get(convId, userId) as { user_id: string } | undefined;

  if (otherPart) {
    const blocked = db
      .prepare(
        `SELECT 1 FROM user_blocks
         WHERE (blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?)`
      )
      .get(userId, otherPart.user_id, otherPart.user_id, userId);
    if (blocked) {
      return res.status(403).json({ error: 'Conversation is blocked.' });
    }
  }

  const body = sanitizeText(req.body?.body || '', 2500);
  if (!isSafeUrlOrEmpty(req.body?.attachmentUrl, 300)) {
    return res.status(400).json({ error: 'Attachment URL must use http(s) or a valid relative path.' });
  }
  const attachmentUrl = sanitizeSafeUrl(req.body?.attachmentUrl || '', 300);
  const attachmentType = sanitizeText(req.body?.attachmentType || '', 40);

  if (!body && !attachmentUrl) {
    return res.status(400).json({ error: 'Message text or image attachment is required.' });
  }

  const msgId = newId('msg');
  const messageType = attachmentUrl ? 'image' : 'text';
  const preview = body || '[Image attachment]';

  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_user_id, body, attachment_url, attachment_type, message_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(msgId, convId, userId, body, attachmentUrl, attachmentType, messageType);

    db.prepare(
      `UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?`
    ).run(preview.slice(0, 120), convId);

    if (otherPart) {
      db.prepare(
        `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
      ).run(convId, otherPart.user_id);
    }
  })();

  if (otherPart) {
    await notifyUserAndTelegram(
      otherPart.user_id,
      'message',
      'New SOFUMER Message',
      `${req.authUser!.display_name}: ${preview.slice(0, 120)}`
    );
  }

  const created = db
    .prepare(
      `SELECT m.*, u.display_name as sender_name
       FROM messages m JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`
    )
    .get(msgId);

  res.status(201).json({ message: created });
});

messagingOrdersRouter.get('/users/blocks', requireAuth, (req, res) => {
  const blocks = db
    .prepare(
      `SELECT ub.*, u.display_name, u.telegram_username
       FROM user_blocks ub
       JOIN users u ON u.id = ub.blocked_user_id
       WHERE ub.blocker_user_id = ?`
    )
    .all(req.authUser!.id);
  res.json({ blocks });
});

messagingOrdersRouter.post('/users/block', requireAuth, (req, res) => {
  const targetUserId = sanitizeText(req.body?.userId || '', 64);
  const reason = sanitizeText(req.body?.reason || '', 200);
  if (!targetUserId || targetUserId === req.authUser!.id) {
    return res.status(400).json({ error: 'Valid target user ID required.' });
  }
  db.prepare(
    `INSERT OR IGNORE INTO user_blocks (id, blocker_user_id, blocked_user_id, reason)
     VALUES (?, ?, ?, ?)`
  ).run(newId('blk'), req.authUser!.id, targetUserId, reason);
  res.json({ blocked: true });
});

messagingOrdersRouter.delete('/users/block/:userId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?').run(
    req.authUser!.id,
    req.params.userId
  );
  res.json({ unblocked: true });
});

// ============================================================================
// DIRECT TRANSACTION ORDERS & STATUS HISTORY
// ============================================================================

messagingOrdersRouter.get('/orders', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const role = String(req.query.role || 'all');

  let where = '(o.buyer_user_id = ? OR o.seller_user_id = ?)';
  const params: unknown[] = [userId, userId];

  if (role === 'buyer') {
    where = 'o.buyer_user_id = ?';
    params.length = 0;
    params.push(userId);
  } else if (role === 'seller') {
    where = 'o.seller_user_id = ?';
    params.length = 0;
    params.push(userId);
  }

  const orders = db
    .prepare(
      `SELECT o.*, s.name as shop_name, s.slug as shop_slug,
              bu.display_name as buyer_name, su.display_name as seller_name,
              (SELECT oi.product_title FROM order_items oi WHERE oi.order_id = o.id LIMIT 1) as primary_item_title,
              (SELECT COUNT(*) FROM reviews r WHERE r.order_id = o.id) as has_review
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id
       JOIN users su ON su.id = o.seller_user_id
       WHERE ${where}
       ORDER BY o.updated_at DESC`
    )
    .all(...params);

  res.json({ orders });
});

messagingOrdersRouter.get('/orders/:id', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const order = db
    .prepare(
      `SELECT o.*, s.name as shop_name, s.slug as shop_slug,
              bu.display_name as buyer_name, bu.telegram_username as buyer_handle,
              su.display_name as seller_name, su.telegram_username as seller_handle
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id
       JOIN users su ON su.id = o.seller_user_id
       WHERE o.id = ? AND (o.buyer_user_id = ? OR o.seller_user_id = ?)`
    )
    .get(req.params.id, userId, userId) as Record<string, unknown> | undefined;

  if (!order) {
    return res.status(404).json({ error: 'Order not found or unauthorized.' });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const history = db
    .prepare(
      `SELECT h.*, u.display_name as actor_name
       FROM order_status_history h
       JOIN users u ON u.id = h.changed_by_user_id
       WHERE h.order_id = ?
       ORDER BY h.created_at ASC`
    )
    .all(order.id);

  const review = db.prepare('SELECT * FROM reviews WHERE order_id = ?').get(order.id) || null;

  res.json({ order, items, history, review });
});

// Seller records the agreed direct transaction order (Step 5)
messagingOrdersRouter.post('/orders', requireAuth, async (req, res) => {
  const userId = req.authUser!.id;
  const productId = sanitizeText(req.body?.productId || '', 64);
  const buyerUserId = sanitizeText(req.body?.buyerUserId || '', 64);
  const conversationId = sanitizeText(req.body?.conversationId || '', 64) || null;
  const quantity = Math.max(1, Math.floor(Number(req.body?.quantity || 1)));
  const agreedTotal = Number(req.body?.agreedTotal ?? 0);
  const currency = sanitizeText(req.body?.currency || 'USD', 6).toUpperCase();
  const paymentArrangement = sanitizeText(
    req.body?.paymentArrangement || 'Direct payment agreed between buyer and seller',
    240
  );
  const deliveryArrangement = sanitizeText(req.body?.deliveryArrangement || '', 300);
  const notes = sanitizeText(req.body?.notes || '', 600);

  if (!productId || !buyerUserId || !Number.isFinite(agreedTotal) || agreedTotal < 0) {
    return res.status(400).json({ error: 'Product, buyer, and agreed total are required.' });
  }

  const product = db
    .prepare('SELECT * FROM products WHERE id = ?')
    .get(productId) as Record<string, unknown> | undefined;
  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  // Only the seller of the listing can record the agreed order details for buyer confirmation
  if (product.seller_user_id !== userId) {
    return res.status(403).json({
      error: 'Only the seller can record agreed order details after negotiating with the buyer.',
    });
  }
  if (buyerUserId === userId) {
    return res.status(400).json({ error: 'Buyer and seller cannot be the same account.' });
  }

  const orderId = newId('ord');
  const orderNumber = `SFM-${Date.now().toString(36).toUpperCase()}-${orderId.slice(-4).toUpperCase()}`;
  const unitPrice = Number((agreedTotal / quantity).toFixed(2));

  db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (
        id, order_number, buyer_user_id, seller_user_id, shop_id, conversation_id,
        status, agreed_total, currency, payment_arrangement, delivery_arrangement, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 'Pending Confirmation', ?, ?, ?, ?, ?)`
    ).run(
      orderId,
      orderNumber,
      buyerUserId,
      userId,
      product.shop_id,
      conversationId,
      agreedTotal,
      currency,
      paymentArrangement,
      deliveryArrangement,
      notes
    );

    db.prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_title, listing_type, quantity, unit_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId('oi'), orderId, product.id, product.title, product.listing_type, quantity, unitPrice, currency);

    db.prepare(
      `INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by_user_id, changed_by_role, note)
       VALUES (?, ?, '', 'Pending Confirmation', ?, 'seller', ?)`
    ).run(newId('osh'), orderId, userId, `Seller recorded agreed order (${currency} ${agreedTotal}). Awaiting buyer confirmation.`);

    if (conversationId) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
         VALUES (?, ?, ?, ?, 'order_proposal')`
      ).run(
        newId('msg'),
        conversationId,
        userId,
        `Recorded Order ${orderNumber}: ${product.title} x${quantity} — ${currency} ${agreedTotal}. Delivery: ${deliveryArrangement || 'Direct arrangement'}.`
      );
      db.prepare(
        `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
      ).run(conversationId, buyerUserId);
    }
  })();

  await notifyUserAndTelegram(
    buyerUserId,
    'order',
    `Order ${orderNumber} Needs Confirmation`,
    `Seller recorded ${String(product.title)} (${currency} ${agreedTotal}). Review and confirm details in My Orders.`
  );

  res.status(201).json({ orderId, orderNumber, status: 'Pending Confirmation' });
});

messagingOrdersRouter.patch('/orders/:id/status', requireAuth, async (req, res) => {
  const userId = req.authUser!.id;
  const newStatus = String(req.body?.status || '');
  const note = sanitizeText(req.body?.note || '', 500);
  const sellerMarkedPaid = req.body?.sellerMarkedPaid;

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const isBuyer = order.buyer_user_id === userId;
  const isSeller = order.seller_user_id === userId;
  if (!isBuyer && !isSeller) {
    return res.status(403).json({ error: 'Not authorized to update this order.' });
  }

  const currentStatus = String(order.status);
  const actorRole = isSeller ? 'seller' : 'buyer';

  const buyerAllowed: Record<string, string[]> = {
    'Pending Confirmation': ['Confirmed', 'Cancelled'],
    Confirmed: ['Cancelled', 'Disputed'],
    Processing: ['Disputed'],
    Shipped: ['Delivered', 'Completed', 'Disputed'],
    Delivered: ['Completed', 'Disputed'],
  };

  const sellerAllowed: Record<string, string[]> = {
    Inquiry: ['Pending Confirmation', 'Cancelled'],
    'Pending Confirmation': ['Cancelled'],
    Confirmed: ['Processing', 'Shipped', 'Delivered', 'Cancelled'],
    Processing: ['Shipped', 'Delivered', 'Cancelled'],
    Shipped: ['Delivered'],
  };

  const allowedTargets = isBuyer ? buyerAllowed[currentStatus] || [] : sellerAllowed[currentStatus] || [];
  if (!allowedTargets.includes(newStatus)) {
    return res.status(400).json({
      error: `Invalid transition from "${currentStatus}" to "${newStatus}" for ${actorRole}.`,
    });
  }

  db.transaction(() => {
    const updates: string[] = ['status = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [newStatus];

    if (isBuyer && newStatus === 'Confirmed') {
      updates.push("buyer_confirmed_at = datetime('now')");
    }
    if (isBuyer && newStatus === 'Completed') {
      updates.push("completed_at = datetime('now')");
    }
    if (isSeller && typeof sellerMarkedPaid === 'boolean') {
      updates.push('seller_marked_paid = ?');
      params.push(sellerMarkedPaid ? 1 : 0);
    }

    params.push(order.id);
    db.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    db.prepare(
      `INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by_user_id, changed_by_role, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('osh'),
      order.id,
      currentStatus,
      newStatus,
      userId,
      actorRole,
      note || `Updated to ${newStatus} by ${actorRole}.`
    );
  })();

  const recipientId = isBuyer ? String(order.seller_user_id) : String(order.buyer_user_id);
  await notifyUserAndTelegram(
    recipientId,
    'order',
    `Order ${String(order.order_number)}: ${newStatus}`,
    note || `Status changed from ${currentStatus} to ${newStatus}.`
  );

  res.json({ orderId: order.id, oldStatus: currentStatus, newStatus });
});

messagingOrdersRouter.post('/orders/:id/review', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const rating = Math.round(Number(req.body?.rating || 0));
  const comment = sanitizeText(req.body?.comment || '', 1200);

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND buyer_user_id = ?')
    .get(req.params.id, userId) as Record<string, unknown> | undefined;
  if (!order) {
    return res.status(404).json({ error: 'Order not found or unauthorized.' });
  }
  if (order.status !== 'Completed') {
    return res.status(400).json({ error: 'Reviews can only be submitted for Completed orders.' });
  }

  const existing = db.prepare('SELECT id FROM reviews WHERE order_id = ?').get(order.id);
  if (existing) {
    return res.status(409).json({ error: 'You have already reviewed this order.' });
  }

  const item = db
    .prepare('SELECT product_id FROM order_items WHERE order_id = ? LIMIT 1')
    .get(order.id) as { product_id: string };

  const reviewId = newId('rev');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO reviews (id, order_id, product_id, shop_id, reviewer_user_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(reviewId, order.id, item.product_id, order.shop_id, userId, rating, comment);

    // Recalculate product and shop ratings
    const prodAgg = db
      .prepare("SELECT AVG(rating) as avg_r, COUNT(*) as cnt FROM reviews WHERE product_id = ? AND status = 'published'")
      .get(item.product_id) as { avg_r: number; cnt: number };
    db.prepare('UPDATE products SET rating_avg = ?, review_count = ? WHERE id = ?').run(
      Number((prodAgg.avg_r || 0).toFixed(2)),
      prodAgg.cnt,
      item.product_id
    );

    const shopAgg = db
      .prepare("SELECT AVG(rating) as avg_r, COUNT(*) as cnt FROM reviews WHERE shop_id = ? AND status = 'published'")
      .get(order.shop_id) as { avg_r: number; cnt: number };
    db.prepare('UPDATE shops SET rating_avg = ?, review_count = ? WHERE id = ?').run(
      Number((shopAgg.avg_r || 0).toFixed(2)),
      shopAgg.cnt,
      order.shop_id
    );
  })();

  res.status(201).json({ reviewId, rating });
});

function resolveLicenseKeyLocal(template: string, orderNumber: string): string {
  const clean = template.trim();
  if (!clean) return '';
  if (/\{\{ORDER_NUMBER\}\}|\{ORDER\}/i.test(clean)) {
    return clean.replace(/\{\{ORDER_NUMBER\}\}|\{ORDER\}/gi, orderNumber);
  }
  return `${clean}-${orderNumber}`;
}

messagingOrdersRouter.get('/orders/:id/digital', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND (buyer_user_id = ? OR seller_user_id = ?)')
    .get(req.params.id, userId, userId) as Record<string, unknown> | undefined;
  if (!order) {
    return res.status(404).json({ error: 'Order not found or unauthorized.' });
  }

  const isSeller = order.seller_user_id === userId;
  const unlocked = isSeller || (PAID_ORDER_STATUSES as readonly string[]).includes(String(order.status));
  if (!unlocked) {
    return res.status(403).json({
      error: 'Digital delivery unlocks once the order is confirmed.',
      status: order.status,
      unlocked: false,
    });
  }

  const rows = db
    .prepare(
      `SELECT oi.product_id, oi.product_title, oi.listing_type,
              da.id as asset_id, da.file_name, da.content_type, da.file_size,
              da.storage_provider, da.delivery_instructions, da.license_key_template, da.download_limit,
              (SELECT COUNT(*) FROM digital_download_logs l WHERE l.order_id = oi.order_id AND l.product_id = oi.product_id) as downloads_used
       FROM order_items oi
       LEFT JOIN product_digital_assets da ON da.product_id = oi.product_id
       WHERE oi.order_id = ?`
    )
    .all(order.id) as Array<Record<string, unknown>>;

  const assets = rows
    .filter((row) => row.asset_id || row.listing_type === 'digital')
    .map((row) => ({
      productId: String(row.product_id),
      productTitle: String(row.product_title),
      hasAsset: Boolean(row.asset_id),
      fileName: row.file_name ? String(row.file_name) : null,
      contentType: row.content_type ? String(row.content_type) : null,
      fileSize: Number(row.file_size || 0),
      hasFile: row.storage_provider === 'r2' || row.storage_provider === 'local',
      deliveryInstructions: String(row.delivery_instructions || ''),
      licenseKey: resolveLicenseKeyLocal(String(row.license_key_template || ''), String(order.order_number)),
      downloadLimit: Number(row.download_limit || 5),
      downloadsUsed: Number(row.downloads_used || 0),
    }));

  res.json({
    orderId: order.id,
    orderNumber: order.order_number,
    status: order.status,
    unlocked: true,
    assets,
  });
});

messagingOrdersRouter.get('/orders/:id/digital/:productId/download', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND (buyer_user_id = ? OR seller_user_id = ?)')
    .get(req.params.id, userId, userId) as Record<string, unknown> | undefined;
  if (!order) {
    return res.status(404).json({ error: 'Order not found or unauthorized.' });
  }

  const isSeller = order.seller_user_id === userId;
  const unlocked = isSeller || (PAID_ORDER_STATUSES as readonly string[]).includes(String(order.status));
  if (!unlocked) {
    return res.status(403).json({ error: 'Digital downloads unlock once the order is confirmed.' });
  }

  const item = db
    .prepare('SELECT id, product_title FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1')
    .get(order.id, req.params.productId) as { id: string; product_title: string } | undefined;
  if (!item) {
    return res.status(404).json({ error: 'Digital product is not part of this order.' });
  }

  const asset = db
    .prepare('SELECT * FROM product_digital_assets WHERE product_id = ?')
    .get(req.params.productId) as Record<string, unknown> | undefined;
  if (!asset) {
    return res.status(404).json({ error: 'Digital delivery package has not been uploaded by the seller yet.' });
  }

  const usedRow = db
    .prepare('SELECT COUNT(*) as cnt FROM digital_download_logs WHERE order_id = ? AND product_id = ?')
    .get(order.id, req.params.productId) as { cnt: number };
  const limit = Math.max(1, Number(asset.download_limit || 5));
  if (!isSeller && usedRow.cnt >= limit) {
    return res.status(403).json({ error: `Download quota exceeded (${usedRow.cnt}/${limit}). Contact the seller.` });
  }

  const safeFilename = String(asset.file_name || `${item.product_title}.txt`).replace(/[\r\n"\\/]/g, '_');

  if (asset.storage_provider === 'r2' || asset.storage_provider === 'local') {
    const filePath = resolveConfinedDigitalPath(String(asset.storage_key || ''));
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Stored digital file is unavailable on disk.' });
    }
    db.prepare(
      `INSERT INTO digital_download_logs (id, order_id, product_id, user_id)
       VALUES (?, ?, ?, ?)`
    ).run(newId('ddl'), order.id, req.params.productId, userId);
    db.prepare("UPDATE product_digital_assets SET download_count = download_count + 1, updated_at = datetime('now') WHERE id = ?").run(
      asset.id
    );

    res.setHeader('Content-Type', String(asset.content_type || 'application/octet-stream'));
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(filePath);
  }

  db.prepare(
    `INSERT INTO digital_download_logs (id, order_id, product_id, user_id)
     VALUES (?, ?, ?, ?)`
  ).run(newId('ddl'), order.id, req.params.productId, userId);
  db.prepare("UPDATE product_digital_assets SET download_count = download_count + 1, updated_at = datetime('now') WHERE id = ?").run(
    asset.id
  );

  const licenseKey = resolveLicenseKeyLocal(String(asset.license_key_template || ''), String(order.order_number));
  const receipt = [
    `SOFUMER Digital Delivery Receipt`,
    `Order: ${String(order.order_number)}`,
    `Product: ${item.product_title}`,
    licenseKey ? `License Key: ${licenseKey}` : null,
    asset.delivery_instructions ? `\nDelivery Instructions:\n${String(asset.delivery_instructions)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename.replace(/\.txt$/i, '')}-delivery.txt"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(receipt);
});
