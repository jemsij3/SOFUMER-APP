import {
  type Env,
  json,
  methodNotAllowed,
  newId,
  notifyUserAndTelegramEdge,
  parseJsonBody,
  requireEdgeUser,
  sanitizeText,
} from './helpers.ts';

export async function handleCommerceAndAccountRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;
  const isHandled =
    path === '/api/conversations' ||
    path.startsWith('/api/conversations/') ||
    path === '/api/users/blocks' ||
    path === '/api/users/block' ||
    path.startsWith('/api/users/block/') ||
    path === '/api/orders' ||
    path.startsWith('/api/orders/') ||
    path.startsWith('/api/account/');

  if (!isHandled) return null;
  if (!env.DB) return json({ error: 'Database binding (DB) is not configured.' }, 503);

  // Conversations list / create
  if (path === '/api/conversations') {
    if (request.method === 'GET') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const rows = await env.DB.prepare(
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
        .bind(auth.user.id)
        .all();
      return json({ conversations: rows.results });
    }

    if (request.method === 'POST') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const buyerId = auth.user.id;
      const productId = sanitizeText(body.data.productId || '', 64) || null;
      const shopIdInput = sanitizeText(body.data.shopId || '', 64) || null;
      const initialMessage = sanitizeText(body.data.message || '', 2000);

      let sellerUserId = '';
      let shopId = shopIdInput;
      let subject = sanitizeText(body.data.subject || 'Marketplace Inquiry', 140);

      if (productId) {
        const product = await env.DB.prepare(
          "SELECT id, shop_id, seller_user_id, title FROM products WHERE id = ? AND status = 'published'"
        )
          .bind(productId)
          .first<{ id: string; shop_id: string; seller_user_id: string; title: string }>();
        if (!product) return json({ error: 'Listing not found.' }, 404);
        sellerUserId = product.seller_user_id;
        shopId = product.shop_id;
        subject = product.title;
      } else if (shopId) {
        const shop = await env.DB.prepare("SELECT id, user_id, name FROM shops WHERE id = ? AND status = 'active'")
          .bind(shopId)
          .first<{ id: string; user_id: string; name: string }>();
        if (!shop) return json({ error: 'Shop not found.' }, 404);
        sellerUserId = shop.user_id;
        subject = `Inquiry: ${shop.name}`;
      } else {
        return json({ error: 'Product ID or Shop ID is required.' }, 400);
      }

      if (sellerUserId === buyerId) {
        return json({ error: 'You cannot start a conversation with yourself.' }, 400);
      }

      const blocked = await env.DB.prepare(
        `SELECT 1 FROM user_blocks
         WHERE (blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?)`
      )
        .bind(buyerId, sellerUserId, sellerUserId, buyerId)
        .first();
      if (blocked) return json({ error: 'Messaging is blocked between these accounts.' }, 403);

      const existing = await env.DB.prepare(
        `SELECT c.id FROM conversations c
         JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = ?
         JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = ?
         WHERE (? IS NULL AND c.product_id IS NULL AND c.shop_id = ?) OR c.product_id = ?
         LIMIT 1`
      )
        .bind(buyerId, sellerUserId, productId, shopId, productId)
        .first<{ id: string }>();

      let conversationId = existing?.id;
      if (!conversationId) {
        conversationId = newId('conv');
        await env.DB.prepare(
          `INSERT INTO conversations (id, product_id, shop_id, subject, last_message_at, last_message_preview)
           VALUES (?, ?, ?, ?, datetime('now'), ?)`
        )
          .bind(conversationId, productId, shopId, subject, initialMessage.slice(0, 120))
          .run();

        await env.DB.prepare(
          `INSERT INTO conversation_participants (id, conversation_id, user_id, role, unread_count)
           VALUES (?, ?, ?, 'buyer', 0)`
        )
          .bind(newId('cp'), conversationId, buyerId)
          .run();

        await env.DB.prepare(
          `INSERT INTO conversation_participants (id, conversation_id, user_id, role, unread_count)
           VALUES (?, ?, ?, 'seller', ?)`
        )
          .bind(newId('cp'), conversationId, sellerUserId, initialMessage ? 1 : 0)
          .run();

        if (productId && shopId) {
          await env.DB.prepare(
            `INSERT INTO inquiries (id, product_id, shop_id, buyer_user_id, seller_user_id, conversation_id, initial_message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(newId('inq'), productId, shopId, buyerId, sellerUserId, conversationId, initialMessage || 'Started product inquiry')
            .run();
          await env.DB.prepare('UPDATE products SET inquiry_count = inquiry_count + 1 WHERE id = ?')
            .bind(productId)
            .run();
        }

        if (initialMessage) {
          await env.DB.prepare(
            `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
             VALUES (?, ?, ?, ?, 'text')`
          )
            .bind(newId('msg'), conversationId, buyerId, initialMessage)
            .run();

          await notifyUserAndTelegramEdge(
            env,
            sellerUserId,
            'message',
            `New Inquiry: ${subject}`,
            `${auth.user.display_name}: ${initialMessage.slice(0, 120)}`,
            url.origin
          );
        }
      } else if (initialMessage) {
        await env.DB.prepare(
          `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
           VALUES (?, ?, ?, ?, 'text')`
        )
          .bind(newId('msg'), conversationId, buyerId, initialMessage)
          .run();
        await env.DB.prepare(
          `UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?`
        )
          .bind(initialMessage.slice(0, 120), conversationId)
          .run();
        await env.DB.prepare(
          `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
        )
          .bind(conversationId, sellerUserId)
          .run();

        await notifyUserAndTelegramEdge(
          env,
          sellerUserId,
          'message',
          `New Message: ${subject}`,
          `${auth.user.display_name}: ${initialMessage.slice(0, 120)}`,
          url.origin
        );
      }

      return json({ conversationId }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  // Conversation messages
  if (path.startsWith('/api/conversations/') && path.endsWith('/messages')) {
    const convId = decodeURIComponent(path.slice('/api/conversations/'.length, -'/messages'.length));
    if (request.method === 'GET') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const participant = await env.DB.prepare(
        'SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?'
      )
        .bind(convId, auth.user.id)
        .first();
      if (!participant) return json({ error: 'Not authorized to access this conversation.' }, 403);

      await env.DB.prepare(
        `UPDATE conversation_participants SET unread_count = 0, last_read_at = datetime('now')
         WHERE conversation_id = ? AND user_id = ?`
      )
        .bind(convId, auth.user.id)
        .run();

      const messages = await env.DB.prepare(
        `SELECT m.*, u.display_name as sender_name, u.avatar_url as sender_avatar
         FROM messages m JOIN users u ON u.id = m.sender_user_id
         WHERE m.conversation_id = ? AND m.is_deleted = 0 ORDER BY m.created_at ASC`
      )
        .bind(convId)
        .all();
      return json({ messages: messages.results });
    }

    if (request.method === 'POST') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const myPart = await env.DB.prepare(
        'SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?'
      )
        .bind(convId, auth.user.id)
        .first();
      if (!myPart) return json({ error: 'Not authorized to send messages in this conversation.' }, 403);

      const otherPart = await env.DB.prepare(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ? LIMIT 1'
      )
        .bind(convId, auth.user.id)
        .first<{ user_id: string }>();

      if (otherPart) {
        const blocked = await env.DB.prepare(
          `SELECT 1 FROM user_blocks
           WHERE (blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?)`
        )
          .bind(auth.user.id, otherPart.user_id, otherPart.user_id, auth.user.id)
          .first();
        if (blocked) return json({ error: 'Conversation is blocked.' }, 403);
      }

      const msgBody = sanitizeText(body.data.body || '', 2500);
      const attachmentUrl = sanitizeText(body.data.attachmentUrl || '', 300);
      const attachmentType = sanitizeText(body.data.attachmentType || '', 40);
      if (!msgBody && !attachmentUrl) {
        return json({ error: 'Message text or image attachment is required.' }, 400);
      }

      const msgId = newId('msg');
      const messageType = attachmentUrl ? 'image' : 'text';
      const preview = msgBody || '[Image attachment]';

      await env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_user_id, body, attachment_url, attachment_type, message_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(msgId, convId, auth.user.id, msgBody, attachmentUrl, attachmentType, messageType)
        .run();
      await env.DB.prepare(
        `UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?`
      )
        .bind(preview.slice(0, 120), convId)
        .run();

      if (otherPart) {
        await env.DB.prepare(
          `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
        )
          .bind(convId, otherPart.user_id)
          .run();
        await notifyUserAndTelegramEdge(
          env,
          otherPart.user_id,
          'message',
          'New SOFUMER Message',
          `${auth.user.display_name}: ${preview.slice(0, 120)}`,
          url.origin
        );
      }

      const created = await env.DB.prepare(
        `SELECT m.*, u.display_name as sender_name
         FROM messages m JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`
      )
        .bind(msgId)
        .first();
      return json({ message: created }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  // User blocks
  if (path === '/api/users/blocks') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const blocks = await env.DB.prepare(
      `SELECT ub.*, u.display_name, u.telegram_username
       FROM user_blocks ub JOIN users u ON u.id = ub.blocked_user_id
       WHERE ub.blocker_user_id = ?`
    )
      .bind(auth.user.id)
      .all();
    return json({ blocks: blocks.results });
  }

  if (path === '/api/users/block') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const targetUserId = sanitizeText(body.data.userId || '', 64);
    const reason = sanitizeText(body.data.reason || '', 200);
    if (!targetUserId || targetUserId === auth.user.id) {
      return json({ error: 'Valid target user ID required.' }, 400);
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_blocks (id, blocker_user_id, blocked_user_id, reason) VALUES (?, ?, ?, ?)`
    )
      .bind(newId('blk'), auth.user.id, targetUserId, reason)
      .run();
    return json({ blocked: true });
  }

  if (path.startsWith('/api/users/block/')) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const targetId = decodeURIComponent(path.slice('/api/users/block/'.length));
    await env.DB.prepare('DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?')
      .bind(auth.user.id, targetId)
      .run();
    return json({ unblocked: true });
  }

  // Direct Orders
  if (path === '/api/orders') {
    if (request.method === 'GET') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const role = String(url.searchParams.get('role') || 'all');
      let where = '(o.buyer_user_id = ? OR o.seller_user_id = ?)';
      const params: unknown[] = [auth.user.id, auth.user.id];
      if (role === 'buyer') {
        where = 'o.buyer_user_id = ?';
        params.length = 1;
      } else if (role === 'seller') {
        where = 'o.seller_user_id = ?';
        params.length = 1;
      }
      const orders = await env.DB.prepare(
        `SELECT o.*, s.name as shop_name, s.slug as shop_slug,
                bu.display_name as buyer_name, su.display_name as seller_name,
                (SELECT oi.product_title FROM order_items oi WHERE oi.order_id = o.id LIMIT 1) as primary_item_title,
                (SELECT COUNT(*) FROM reviews r WHERE r.order_id = o.id) as has_review
         FROM orders o JOIN shops s ON s.id = o.shop_id
         JOIN users bu ON bu.id = o.buyer_user_id JOIN users su ON su.id = o.seller_user_id
         WHERE ${where} ORDER BY o.updated_at DESC`
      )
        .bind(...params)
        .all();
      return json({ orders: orders.results });
    }

    if (request.method === 'POST') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;

      const userId = auth.user.id;
      const productId = sanitizeText(body.data.productId || '', 64);
      const buyerUserId = sanitizeText(body.data.buyerUserId || '', 64);
      const conversationId = sanitizeText(body.data.conversationId || '', 64) || null;
      const quantity = Math.max(1, Math.floor(Number(body.data.quantity || 1)));
      const agreedTotal = Number(body.data.agreedTotal ?? 0);
      const currency = sanitizeText(body.data.currency || 'USD', 6).toUpperCase();
      const paymentArrangement = sanitizeText(
        body.data.paymentArrangement || 'Direct payment agreed between buyer and seller',
        240
      );
      const deliveryArrangement = sanitizeText(body.data.deliveryArrangement || '', 300);
      const notes = sanitizeText(body.data.notes || '', 600);

      if (!productId || !buyerUserId || Number.isNaN(agreedTotal) || agreedTotal < 0) {
        return json({ error: 'Product, buyer, and agreed total are required.' }, 400);
      }

      const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?')
        .bind(productId)
        .first<Record<string, unknown>>();
      if (!product) return json({ error: 'Product not found.' }, 404);
      if (product.seller_user_id !== userId) {
        return json({ error: 'Only the seller can record agreed order details after negotiating with the buyer.' }, 403);
      }
      if (buyerUserId === userId) {
        return json({ error: 'Buyer and seller cannot be the same account.' }, 400);
      }

      const orderId = newId('ord');
      const orderNumber = `SFM-${Date.now().toString(36).toUpperCase()}-${orderId.slice(-4).toUpperCase()}`;
      const unitPrice = Number((agreedTotal / quantity).toFixed(2));

      await env.DB.prepare(
        `INSERT INTO orders (
          id, order_number, buyer_user_id, seller_user_id, shop_id, conversation_id,
          status, agreed_total, currency, payment_arrangement, delivery_arrangement, notes
        ) VALUES (?, ?, ?, ?, ?, ?, 'Pending Confirmation', ?, ?, ?, ?, ?)`
      )
        .bind(orderId, orderNumber, buyerUserId, userId, product.shop_id, conversationId, agreedTotal, currency, paymentArrangement, deliveryArrangement, notes)
        .run();

      await env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_title, listing_type, quantity, unit_price, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(newId('oi'), orderId, product.id, product.title, product.listing_type, quantity, unitPrice, currency)
        .run();

      await env.DB.prepare(
        `INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by_user_id, changed_by_role, note)
         VALUES (?, ?, '', 'Pending Confirmation', ?, 'seller', ?)`
      )
        .bind(newId('osh'), orderId, userId, `Seller recorded agreed order (${currency} ${agreedTotal}). Awaiting buyer confirmation.`)
        .run();

      if (conversationId) {
        await env.DB.prepare(
          `INSERT INTO messages (id, conversation_id, sender_user_id, body, message_type)
           VALUES (?, ?, ?, ?, 'order_proposal')`
        )
          .bind(
            newId('msg'),
            conversationId,
            userId,
            `Recorded Order ${orderNumber}: ${String(product.title)} x${quantity} — ${currency} ${agreedTotal}. Delivery: ${deliveryArrangement || 'Direct arrangement'}.`
          )
          .run();
        await env.DB.prepare(
          `UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id = ?`
        )
          .bind(conversationId, buyerUserId)
          .run();
      }

      await notifyUserAndTelegramEdge(
        env,
        buyerUserId,
        'order',
        `Order ${orderNumber} Needs Confirmation`,
        `Seller recorded ${String(product.title)} (${currency} ${agreedTotal}). Review and confirm details in My Orders.`,
        url.origin
      );

      return json({ orderId, orderNumber, status: 'Pending Confirmation' }, 201);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  if (path.startsWith('/api/orders/') && path.endsWith('/status')) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const orderId = decodeURIComponent(path.slice('/api/orders/'.length, -'/status'.length));
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?')
      .bind(orderId)
      .first<Record<string, unknown>>();
    if (!order) return json({ error: 'Order not found.' }, 404);

    const userId = auth.user.id;
    const isBuyer = order.buyer_user_id === userId;
    const isSeller = order.seller_user_id === userId;
    if (!isBuyer && !isSeller) return json({ error: 'Not authorized to update this order.' }, 403);

    const newStatus = String(body.data.status || '');
    const note = sanitizeText(body.data.note || '', 500);
    const sellerMarkedPaid = body.data.sellerMarkedPaid;
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
      return json({ error: `Invalid transition from "${currentStatus}" to "${newStatus}" for ${actorRole}.` }, 400);
    }

    const updates: string[] = ['status = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [newStatus];
    if (isBuyer && newStatus === 'Confirmed') updates.push("buyer_confirmed_at = datetime('now')");
    if (isBuyer && newStatus === 'Completed') updates.push("completed_at = datetime('now')");
    if (isSeller && typeof sellerMarkedPaid === 'boolean') {
      updates.push('seller_marked_paid = ?');
      params.push(sellerMarkedPaid ? 1 : 0);
    }
    params.push(order.id);
    await env.DB.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

    await env.DB.prepare(
      `INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by_user_id, changed_by_role, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('osh'), order.id, currentStatus, newStatus, userId, actorRole, note || `Updated to ${newStatus} by ${actorRole}.`)
      .run();

    const recipientId = isBuyer ? String(order.seller_user_id) : String(order.buyer_user_id);
    await notifyUserAndTelegramEdge(
      env,
      recipientId,
      'order',
      `Order ${String(order.order_number)}: ${newStatus}`,
      note || `Status changed from ${currentStatus} to ${newStatus}.`,
      url.origin
    );

    return json({ orderId: order.id, oldStatus: currentStatus, newStatus });
  }

  if (path.startsWith('/api/orders/') && path.endsWith('/review')) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;

    const orderId = decodeURIComponent(path.slice('/api/orders/'.length, -'/review'.length));
    const rating = Math.round(Number(body.data.rating || 0));
    const comment = sanitizeText(body.data.comment || '', 1200);
    if (rating < 1 || rating > 5) return json({ error: 'Rating must be between 1 and 5.' }, 400);

    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND buyer_user_id = ?')
      .bind(orderId, auth.user.id)
      .first<Record<string, unknown>>();
    if (!order) return json({ error: 'Order not found or unauthorized.' }, 404);
    if (order.status !== 'Completed') {
      return json({ error: 'Reviews can only be submitted for Completed orders.' }, 400);
    }

    const existing = await env.DB.prepare('SELECT id FROM reviews WHERE order_id = ?').bind(order.id).first();
    if (existing) return json({ error: 'You have already reviewed this order.' }, 409);

    const item = await env.DB.prepare('SELECT product_id FROM order_items WHERE order_id = ? LIMIT 1')
      .bind(order.id)
      .first<{ product_id: string }>();
    if (!item) return json({ error: 'Order item missing.' }, 404);

    const reviewId = newId('rev');
    await env.DB.prepare(
      `INSERT INTO reviews (id, order_id, product_id, shop_id, reviewer_user_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(reviewId, order.id, item.product_id, order.shop_id, auth.user.id, rating, comment)
      .run();

    const prodAgg = await env.DB.prepare(
      "SELECT AVG(rating) as avg_r, COUNT(*) as cnt FROM reviews WHERE product_id = ? AND status = 'published'"
    )
      .bind(item.product_id)
      .first<{ avg_r: number; cnt: number }>();
    await env.DB.prepare('UPDATE products SET rating_avg = ?, review_count = ? WHERE id = ?')
      .bind(Number((prodAgg?.avg_r || 0).toFixed(2)), prodAgg?.cnt || 0, item.product_id)
      .run();

    const shopAgg = await env.DB.prepare(
      "SELECT AVG(rating) as avg_r, COUNT(*) as cnt FROM reviews WHERE shop_id = ? AND status = 'published'"
    )
      .bind(order.shop_id)
      .first<{ avg_r: number; cnt: number }>();
    await env.DB.prepare('UPDATE shops SET rating_avg = ?, review_count = ? WHERE id = ?')
      .bind(Number((shopAgg?.avg_r || 0).toFixed(2)), shopAgg?.cnt || 0, order.shop_id)
      .run();

    return json({ reviewId, rating }, 201);
  }

  if (path.startsWith('/api/orders/')) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const orderId = decodeURIComponent(path.slice('/api/orders/'.length));
    const order = await env.DB.prepare(
      `SELECT o.*, s.name as shop_name, s.slug as shop_slug,
              bu.display_name as buyer_name, bu.telegram_username as buyer_handle,
              su.display_name as seller_name, su.telegram_username as seller_handle
       FROM orders o JOIN shops s ON s.id = o.shop_id
       JOIN users bu ON bu.id = o.buyer_user_id JOIN users su ON su.id = o.seller_user_id
       WHERE o.id = ? AND (o.buyer_user_id = ? OR o.seller_user_id = ?)`
    )
      .bind(orderId, auth.user.id, auth.user.id)
      .first<Record<string, unknown>>();
    if (!order) return json({ error: 'Order not found or unauthorized.' }, 404);

    const [items, history, review] = await Promise.all([
      env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(order.id).all(),
      env.DB.prepare(
        `SELECT h.*, u.display_name as actor_name FROM order_status_history h
         JOIN users u ON u.id = h.changed_by_user_id WHERE h.order_id = ? ORDER BY h.created_at ASC`
      )
        .bind(order.id)
        .all(),
      env.DB.prepare('SELECT * FROM reviews WHERE order_id = ?').bind(order.id).first(),
    ]);

    return json({ order, items: items.results, history: history.results, review: review || null });
  }

  // Account routes
  if (path === '/api/account/profile') {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const body = await parseJsonBody(request);
    if (!body.ok) return body.error;
    const u = auth.user;

    await env.DB.prepare(
      `UPDATE users
       SET display_name = ?, bio = ?, phone = ?, country_code = ?, preferred_currency = ?, preferred_language = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(
        sanitizeText(body.data.displayName ?? u.display_name, 80),
        sanitizeText(body.data.bio ?? u.bio, 500),
        sanitizeText(body.data.phone ?? u.phone, 32),
        sanitizeText(body.data.countryCode ?? u.country_code, 4).toUpperCase(),
        sanitizeText(body.data.preferredCurrency ?? u.preferred_currency, 6).toUpperCase(),
        sanitizeText(body.data.preferredLanguage ?? u.preferred_language, 10),
        u.id
      )
      .run();

    return json({ updated: true });
  }

  if (path === '/api/account/notifications') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    const items = await env.DB.prepare(
      `SELECT * FROM notifications WHERE user_id = ? OR scope = 'global' ORDER BY created_at DESC LIMIT 50`
    )
      .bind(auth.user.id)
      .all();
    return json({ notifications: items.results });
  }

  if (path === '/api/account/notifications/read') {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const auth = await requireEdgeUser(request, env);
    if ('error' in auth) return auth.error;
    await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(auth.user.id).run();
    return json({ read: true });
  }

  if (path === '/api/account/support') {
    if (request.method === 'GET') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const tickets = await env.DB.prepare(
        'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC'
      )
        .bind(auth.user.id)
        .all();
      return json({ tickets: tickets.results });
    }
    if (request.method === 'POST') {
      const auth = await requireEdgeUser(request, env);
      if ('error' in auth) return auth.error;
      const body = await parseJsonBody(request);
      if (!body.ok) return body.error;
      const category = sanitizeText(body.data.category || 'general', 40);
      const subject = sanitizeText(body.data.subject || '', 140);
      const message = sanitizeText(body.data.message || '', 2000);
      if (!subject || !message) return json({ error: 'Subject and message are required.' }, 400);
      const ticketId = newId('tkt');
      await env.DB.prepare(
        `INSERT INTO support_tickets (id, user_id, category, subject, message) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(ticketId, auth.user.id, category, subject, message)
        .run();
      return json({ ticketId, status: 'open' }, 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  return json({ error: 'API endpoint not found.' }, 404);
}
