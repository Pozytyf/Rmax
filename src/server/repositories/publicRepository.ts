import { getDb, generateId } from '../db.ts';
import { BaseRepository } from './BaseRepository.ts';

export class PublicRepository extends BaseRepository {
  constructor() {
    super({ tableName: 'qr_codes', tenantColumn: 'restaurant_id' });
  }

  findActivePlans() {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, code, name, tagline, price_monthly_xof, price_yearly_xof,
                trial_days, max_tables, max_staff, max_menu_items,
                is_demo_pricing, is_featured, features_json, active
         FROM plans WHERE active = 1 ORDER BY price_monthly_xof ASC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  findAllPlatformSettings() {
    const db = getDb();
    return db
      .prepare('SELECT key, value FROM platform_settings')
      .all() as Array<{ key: string; value: string }>;
  }

  createLead(params: {
    leadType: 'CONTACT' | 'DEMO_REQUEST';
    fullName: string;
    email: string;
    phone: string;
    restaurantName: string;
    city: string;
    message: string;
  }): string {
    const db = getDb();
    const id = generateId(params.leadType === 'CONTACT' ? 'lead' : 'demo');
    db.prepare(
      `INSERT INTO contact_leads (id, lead_type, full_name, email, phone, restaurant_name, city, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.leadType,
      params.fullName,
      params.email,
      params.phone,
      params.restaurantName,
      params.city,
      params.message,
      new Date().toISOString(),
    );
    return id;
  }

  findQrContextByToken(token: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT q.id as qr_id, q.token, q.version, q.status as qr_status,
                t.id as table_id, t.label as table_label, t.zone as table_zone,
                r.id as restaurant_id, r.name as restaurant_name, r.slug as restaurant_slug,
                r.city, r.currency, r.tax_rate_percent, r.opening_hours,
                r.loyalty_enabled, r.loyalty_points_per_1000_xof, r.loyalty_xof_per_point,
                r.status as restaurant_status, r.deleted_at
         FROM qr_codes q
         JOIN dining_tables t ON t.id = q.table_id
         JOIN restaurants r ON r.id = q.restaurant_id
         WHERE q.token = ?`,
      )
      .get(token) as Record<string, unknown> | undefined;
  }

  findStorefrontBySlug(slug: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, name, slug, city, address, phone, currency, tax_rate_percent,
                opening_hours, paydunya_mode, storefront_enabled, delivery_enabled,
                delivery_zones_json, pickup_slots_json,
                loyalty_enabled, loyalty_points_per_1000_xof, loyalty_xof_per_point,
                status, deleted_at
         FROM restaurants
         WHERE slug = ?`,
      )
      .get(slug) as Record<string, unknown> | undefined;
  }

  createQrTableSession(params: {
    restaurantId: string;
    tableId: string;
    qrToken: string;
    expiresAt: string;
  }): string {
    const db = getDb();
    const sessionId = generateId('qrs');
    db.prepare(
      `INSERT INTO qr_table_sessions (id, restaurant_id, table_id, qr_token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      params.restaurantId,
      params.tableId,
      params.qrToken,
      params.expiresAt,
      new Date().toISOString(),
    );
    return sessionId;
  }

  findQrTableSession(sessionId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, restaurant_id, table_id, expires_at
         FROM qr_table_sessions WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
  }

  findActiveCategories(restaurantId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, name, station, sort_order
         FROM menu_categories
         WHERE restaurant_id = ? AND active = 1
         ORDER BY sort_order ASC`,
      )
      .all(restaurantId) as Array<Record<string, unknown>>;
  }

  findAvailableMenuItems(restaurantId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT m.id, m.category_id, m.name, m.description, m.price_xof, m.image_url,
                m.options_json, m.option_groups_json, c.station
         FROM menu_items m
         JOIN menu_categories c ON c.id = m.category_id
         WHERE m.restaurant_id = ? AND m.available = 1 AND c.active = 1
         ORDER BY c.sort_order ASC, m.sort_order ASC, m.name ASC`,
      )
      .all(restaurantId) as Array<Record<string, unknown>>;
  }

  findOrderByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    const db = getDb();
    return db
      .prepare(
        'SELECT id, order_number, total_xof, status, order_type FROM orders WHERE restaurant_id = ? AND idempotency_key = ?',
      )
      .get(restaurantId, idempotencyKey) as Record<string, unknown> | undefined;
  }

  countOrdersForRestaurant(restaurantId: string): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) as c FROM orders WHERE restaurant_id = ?')
      .get(restaurantId) as { c: number };
    return row.c;
  }

  findMenuItemWithStation(menuItemId: string, restaurantId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT m.id, m.category_id, m.name, m.price_xof, m.available,
                m.options_json, m.option_groups_json, c.station, c.active as category_active
         FROM menu_items m
         JOIN menu_categories c ON c.id = m.category_id
         WHERE m.id = ? AND m.restaurant_id = ?`,
      )
      .get(menuItemId, restaurantId) as Record<string, unknown> | undefined;
  }

  insertPublicOrderTransaction(params: {
    orderId: string;
    restaurantId: string;
    orderNumber: string;
    orderType: 'QR_TABLE' | 'CLICK_COLLECT' | 'DELIVERY';
    tableId: string | null;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    deliveryZone: string;
    deliveryFeeXof: number;
    scheduledSlot: string;
    promoCode: string;
    loyaltyPointsUsed: number;
    subtotalHtXof: number;
    discountXof: number;
    taxXof: number;
    totalXof: number;
    notes: string;
    idempotencyKey: string | null;
    now: string;
    lines: Array<{
      id: string;
      menuItemId: string;
      name: string;
      station: string;
      unitPriceXof: number;
      optionsSummary: string;
      optionsDeltaXof: number;
      quantity: number;
      lineTotalXof: number;
      notes: string;
    }>;
  }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO orders (
        id, restaurant_id, order_number, order_type, table_id, customer_name, customer_phone,
        delivery_address, delivery_zone, delivery_fee_xof, scheduled_slot,
        promo_code, loyalty_points_used,
        status, subtotal_xof, discount_xof, tax_xof, total_xof, paid_xof,
        notes, idempotency_key, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
    ).run(
      params.orderId,
      params.restaurantId,
      params.orderNumber,
      params.orderType,
      params.tableId,
      params.customerName,
      params.customerPhone,
      params.deliveryAddress,
      params.deliveryZone,
      params.deliveryFeeXof,
      params.scheduledSlot,
      params.promoCode,
      params.loyaltyPointsUsed,
      params.subtotalHtXof,
      params.discountXof,
      params.taxXof,
      params.totalXof,
      params.notes,
      params.idempotencyKey,
      params.now,
      params.now,
    );

    const insertLine = db.prepare(
      `INSERT INTO order_items (
        id, order_id, menu_item_id, name, station, unit_price_xof,
        options_summary, options_delta_xof, quantity, line_total_xof, notes, prep_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    );
    for (const pl of params.lines) {
      insertLine.run(
        pl.id,
        params.orderId,
        pl.menuItemId,
        pl.name,
        pl.station,
        pl.unitPriceXof,
        pl.optionsSummary,
        pl.optionsDeltaXof,
        pl.quantity,
        pl.lineTotalXof,
        pl.notes,
      );
    }

    if (params.tableId) {
      db.prepare(
        `UPDATE dining_tables SET status = 'OCCUPIED' WHERE id = ? AND restaurant_id = ?`,
      ).run(params.tableId, params.restaurantId);
    }
  }

  findTrackedQrOrder(token: string, orderId: string) {
    const db = getDb();
    const order = db
      .prepare(
        `SELECT o.id, o.restaurant_id, o.order_number, o.order_type, o.status, o.discount_xof,
                o.total_xof, o.paid_xof, o.notes, o.customer_name, o.customer_phone,
                o.promo_code, o.loyalty_points_used, o.loyalty_points_earned,
                o.created_at, o.updated_at, t.label as table_label,
                r.name as restaurant_name, r.loyalty_enabled
         FROM orders o
         JOIN qr_codes q ON q.table_id = o.table_id AND q.restaurant_id = o.restaurant_id
         JOIN dining_tables t ON t.id = o.table_id
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE q.token = ? AND o.id = ?`,
      )
      .get(token, orderId) as Record<string, unknown> | undefined;

    if (!order) return null;

    const items = db
      .prepare(
        `SELECT id, name, station, quantity, options_summary, line_total_xof, notes, prep_status
         FROM order_items WHERE order_id = ?`,
      )
      .all(orderId);

    const review = this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  findTrackedStorefrontOrder(slug: string, orderId: string) {
    const db = getDb();
    const order = db
      .prepare(
        `SELECT o.id, o.order_number, o.order_type, o.status, o.discount_xof,
                o.total_xof, o.paid_xof, o.notes, o.customer_name, o.customer_phone,
                o.delivery_address, o.delivery_zone, o.delivery_fee_xof, o.scheduled_slot,
                o.promo_code, o.loyalty_points_used, o.loyalty_points_earned,
                o.created_at, o.updated_at, r.name as restaurant_name,
                r.slug as restaurant_slug, r.phone as restaurant_phone,
                r.address as restaurant_address, r.city as restaurant_city,
                r.loyalty_enabled
         FROM orders o
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE r.slug = ? AND o.id = ? AND o.order_type IN ('CLICK_COLLECT', 'DELIVERY')`,
      )
      .get(slug, orderId) as Record<string, unknown> | undefined;

    if (!order) return null;

    const items = db
      .prepare(
        `SELECT id, name, station, quantity, options_summary, line_total_xof, notes, prep_status
         FROM order_items WHERE order_id = ?`,
      )
      .all(orderId);

    const review = this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  findOrderForQrPayment(token: string, orderId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT o.id, o.restaurant_id, o.table_id, o.order_number, o.status,
                o.total_xof, o.paid_xof, o.customer_phone,
                r.paydunya_mode, r.status as restaurant_status, r.deleted_at, q.status as qr_status
         FROM orders o
         JOIN qr_codes q ON q.table_id = o.table_id AND q.restaurant_id = o.restaurant_id
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE q.token = ? AND o.id = ?`,
      )
      .get(token, orderId) as
      | {
          id: string;
          restaurant_id: string;
          table_id: string;
          order_number: string;
          status: string;
          total_xof: number;
          paid_xof: number;
          customer_phone: string;
          paydunya_mode: string;
          restaurant_status: string;
          deleted_at: string | null;
          qr_status: string;
        }
      | undefined;
  }

  findOrderForStorefrontPayment(slug: string, orderId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT o.id, o.restaurant_id, o.order_number, o.status, o.order_type,
                o.total_xof, o.paid_xof, o.customer_phone,
                r.paydunya_mode, r.status as restaurant_status, r.deleted_at
         FROM orders o
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE r.slug = ? AND o.id = ? AND o.order_type IN ('CLICK_COLLECT', 'DELIVERY')`,
      )
      .get(slug, orderId) as
      | {
          id: string;
          restaurant_id: string;
          order_number: string;
          status: string;
          order_type: string;
          total_xof: number;
          paid_xof: number;
          customer_phone: string;
          paydunya_mode: string;
          restaurant_status: string;
          deleted_at: string | null;
        }
      | undefined;
  }

  updateOrderCustomerPhone(orderId: string, restaurantId: string, phone: string) {
    const db = getDb();
    db.prepare(
      'UPDATE orders SET customer_phone = ? WHERE id = ? AND restaurant_id = ?',
    ).run(phone, orderId, restaurantId);
  }

  findQrPaymentByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    const db = getDb();
    return db
      .prepare(
        'SELECT id, order_id as orderId, amount_xof as amountXof, method, mode, reference, status, created_at as createdAt FROM payments WHERE restaurant_id = ? AND idempotency_key = ?',
      )
      .get(restaurantId, idempotencyKey) as Record<string, unknown> | undefined;
  }

  insertPublicOrderPayment(params: {
    paymentId: string;
    restaurantId: string;
    orderId: string;
    amountXof: number;
    method: string;
    mode: string;
    reference: string;
    idempotencyKey: string | null;
    newPaidXof: number;
    fullyPaid: boolean;
    now: string;
  }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO payments (
        id, restaurant_id, order_id, amount_xof, method, status, mode, reference, idempotency_key, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'PAID', ?, ?, ?, NULL, ?)`,
    ).run(
      params.paymentId,
      params.restaurantId,
      params.orderId,
      params.amountXof,
      params.method,
      params.mode,
      params.reference,
      params.idempotencyKey,
      params.now,
    );

    if (params.fullyPaid) {
      db.prepare(
        `UPDATE orders SET paid_xof = ?, status = 'PAID', updated_at = ? WHERE id = ? AND restaurant_id = ?`,
      ).run(params.newPaidXof, params.now, params.orderId, params.restaurantId);
    } else {
      db.prepare(
        `UPDATE orders SET paid_xof = ?, updated_at = ? WHERE id = ? AND restaurant_id = ?`,
      ).run(params.newPaidXof, params.now, params.orderId, params.restaurantId);
    }
  }

  createTableCall(params: {
    restaurantId: string;
    tableId: string;
    tableLabel: string;
    callType: 'WAITER' | 'BILL';
    note: string;
  }) {
    const db = getDb();
    const id = generateId('call');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO table_calls (
        id, restaurant_id, table_id, table_label, call_type, note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    ).run(
      id,
      params.restaurantId,
      params.tableId,
      params.tableLabel,
      params.callType,
      params.note,
      now,
    );

    db.prepare(
      `INSERT INTO notifications (
        id, restaurant_id, type, title, message, stock_id, email_dispatched, email_recipients, email_status, is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, '', 'SKIPPED', 0, ?)`,
    ).run(
      generateId('ntf'),
      params.restaurantId,
      params.callType === 'BILL' ? 'TABLE_BILL_REQUEST' : 'TABLE_WAITER_CALL',
      params.callType === 'BILL'
        ? `Demande d’addition · ${params.tableLabel}`
        : `Appel serveur · ${params.tableLabel}`,
      params.note || `La table ${params.tableLabel} demande votre présence.`,
      now,
    );

    return {
      id,
      restaurantId: params.restaurantId,
      tableId: params.tableId,
      tableLabel: params.tableLabel,
      callType: params.callType,
      note: params.note,
      status: 'PENDING' as const,
      createdAt: now,
    };
  }

  findReviewByOrderId(orderId: string) {
    const db = getDb();
    const r = db
      .prepare(
        `SELECT id, restaurant_id as restaurantId, order_id as orderId, order_number as orderNumber,
                table_label as tableLabel, customer_name as customerName, rating,
                COALESCE(service_rating, rating) as serviceRating,
                COALESCE(food_rating, rating) as foodRating,
                COALESCE(speed_rating, rating) as speedRating,
                COALESCE(waiter_name, '') as waiterName,
                COALESCE(channel, 'QR_ORDER') as channel,
                comment, reply, created_at as createdAt
         FROM customer_reviews WHERE order_id = ?`,
      )
      .get(orderId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const rating = Number(r.rating);
    return {
      id: String(r.id),
      restaurantId: String(r.restaurantId),
      orderId: r.orderId ? String(r.orderId) : null,
      orderNumber: String(r.orderNumber || ''),
      tableLabel: String(r.tableLabel || ''),
      customerName: String(r.customerName || 'Client'),
      rating,
      serviceRating: Number(r.serviceRating || rating),
      foodRating: Number(r.foodRating || rating),
      speedRating: Number(r.speedRating || rating),
      waiterName: String(r.waiterName || ''),
      channel: String(r.channel || 'QR_ORDER'),
      comment: String(r.comment || ''),
      reply: String(r.reply || ''),
      createdAt: String(r.createdAt),
    };
  }

  findPublicRatingStats(restaurantId: string) {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) as total,
                ROUND(AVG(rating), 1) as avgRating,
                ROUND(AVG(COALESCE(service_rating, rating)), 1) as avgServiceRating
         FROM customer_reviews
         WHERE restaurant_id = ?`,
      )
      .get(restaurantId) as {
      total: number;
      avgRating: number | null;
      avgServiceRating: number | null;
    };
    return {
      total: Number(row?.total || 0),
      avgRating: Number(row?.avgRating || 0),
      avgServiceRating: Number(row?.avgServiceRating || 0),
    };
  }

  findServiceWaiterNames(restaurantId: string): string[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT u.full_name
         FROM restaurant_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.restaurant_id = ?
           AND rm.status = 'ACTIVE'
           AND u.status = 'ACTIVE'
           AND rm.role IN ('WAITER', 'CASHIER', 'MANAGER')
         ORDER BY u.full_name ASC LIMIT 20`,
      )
      .all(restaurantId) as Array<{ full_name: string }>;
    return rows.map((r) => String(r.full_name || '').trim()).filter(Boolean);
  }

  insertCustomerReview(params: {
    restaurantId: string;
    orderId: string | null;
    orderNumber: string;
    tableLabel: string;
    customerName: string;
    rating: number;
    serviceRating: number;
    foodRating: number;
    speedRating: number;
    waiterName: string;
    channel: string;
    comment: string;
  }) {
    const db = getDb();
    const id = generateId('rev');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO customer_reviews (
        id, restaurant_id, order_id, order_number, table_label, customer_name,
        rating, service_rating, food_rating, speed_rating, waiter_name, channel,
        comment, reply, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    ).run(
      id,
      params.restaurantId,
      params.orderId,
      params.orderNumber,
      params.tableLabel,
      params.customerName,
      params.rating,
      params.serviceRating,
      params.foodRating,
      params.speedRating,
      params.waiterName,
      params.channel,
      params.comment,
      now,
    );
    return {
      id,
      restaurantId: params.restaurantId,
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      tableLabel: params.tableLabel,
      customerName: params.customerName,
      rating: params.rating,
      serviceRating: params.serviceRating,
      foodRating: params.foodRating,
      speedRating: params.speedRating,
      waiterName: params.waiterName,
      channel: params.channel,
      comment: params.comment,
      reply: '',
      createdAt: now,
    };
  }
}

export const publicRepository = new PublicRepository();
