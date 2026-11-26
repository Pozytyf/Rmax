import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';

export class KnexPublicRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

  async findActivePlans() {
    return this.db('plans')
      .select('id', 'code', 'name', 'tagline', 'price_monthly_xof', 'price_yearly_xof',
        'trial_days', 'max_tables', 'max_staff', 'max_menu_items',
        'is_demo_pricing', 'is_featured', 'features_json', 'active')
      .where('active', 1)
      .orderBy('price_monthly_xof', 'asc');
  }

  async findAllPlatformSettings() {
    return this.db('platform_settings').select('key', 'value');
  }

  async createLead(params: {
    leadType: 'CONTACT' | 'DEMO_REQUEST';
    fullName: string;
    email: string;
    phone: string;
    restaurantName: string;
    city: string;
    message: string;
  }): Promise<string> {
    const id = this.id(params.leadType === 'CONTACT' ? 'lead' : 'demo');
    await this.db('contact_leads').insert({
      id, lead_type: params.leadType, full_name: params.fullName,
      email: params.email, phone: params.phone, restaurant_name: params.restaurantName,
      city: params.city, message: params.message, created_at: new Date().toISOString(),
    });
    return id;
  }

  async findQrContextByToken(token: string) {
    return this.db('qr_codes as q')
      .join('dining_tables as t', 't.id', 'q.table_id')
      .join('restaurants as r', 'r.id', 'q.restaurant_id')
      .select({
        qr_id: 'q.id', token: 'q.token', version: 'q.version', qr_status: 'q.status',
        table_id: 't.id', table_label: 't.label', table_zone: 't.zone',
        restaurant_id: 'r.id', restaurant_name: 'r.name', restaurant_slug: 'r.slug',
        city: 'r.city', currency: 'r.currency', tax_rate_percent: 'r.tax_rate_percent',
        opening_hours: 'r.opening_hours', loyalty_enabled: 'r.loyalty_enabled',
        loyalty_points_per_1000_xof: 'r.loyalty_points_per_1000_xof',
        loyalty_xof_per_point: 'r.loyalty_xof_per_point',
        restaurant_status: 'r.status', deleted_at: 'r.deleted_at',
      })
      .where('q.token', token)
      .first();
  }

  async findStorefrontBySlug(slug: string) {
    return this.db('restaurants')
      .select('id', 'name', 'slug', 'city', 'address', 'phone', 'currency', 'tax_rate_percent',
        'opening_hours', 'paydunya_mode', 'storefront_enabled', 'delivery_enabled',
        'delivery_zones_json', 'pickup_slots_json', 'loyalty_enabled',
        'loyalty_points_per_1000_xof', 'loyalty_xof_per_point', 'status', 'deleted_at')
      .where({ slug })
      .first();
  }

  async createQrTableSession(params: {
    restaurantId: string; tableId: string; qrToken: string; expiresAt: string;
  }): Promise<string> {
    const id = this.id('qrs');
    await this.db('qr_table_sessions').insert({
      id, restaurant_id: params.restaurantId, table_id: params.tableId,
      qr_token: params.qrToken, expires_at: params.expiresAt,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async findQrTableSession(sessionId: string) {
    return this.db('qr_table_sessions')
      .select('id', 'restaurant_id', 'table_id', 'expires_at')
      .where({ id: sessionId })
      .first();
  }

  async findActiveCategories(restaurantId: string) {
    return this.db('menu_categories')
      .select('id', 'name', 'station', 'sort_order')
      .where({ restaurant_id: restaurantId, active: 1 })
      .orderBy('sort_order', 'asc');
  }

  async findAvailableMenuItems(restaurantId: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', 'c.id', 'm.category_id')
      .select('m.id', 'm.category_id', 'm.name', 'm.description', 'm.price_xof',
        'm.image_url', 'm.options_json', 'm.option_groups_json', 'c.station')
      .where('m.restaurant_id', restaurantId)
      .where('m.available', 1)
      .where('c.active', 1)
      .orderBy('c.sort_order', 'asc')
      .orderBy('m.sort_order', 'asc')
      .orderBy('m.name', 'asc');
  }

  async findOrderByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    return this.db('orders')
      .select('id', 'order_number', 'total_xof', 'status', 'order_type')
      .where({ restaurant_id: restaurantId, idempotency_key: idempotencyKey })
      .first();
  }

  async nextOrderNumber(trx: Knex.Transaction, restaurantId: string): Promise<string> {
    const maxResult = await trx.raw(
      `SELECT COALESCE(
         MAX(CASE
           WHEN order_number ~ '^CMD-[0-9]+
    const row = await this.db('orders').where({ restaurant_id: restaurantId }).count({ c: '*' }).first();
    return Number(row?.c || 0);
  }

  async findMenuItemWithStation(menuItemId: string, restaurantId: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', 'c.id', 'm.category_id')
      .select('m.id', 'm.category_id', 'm.name', 'm.price_xof', 'm.available',
        'm.options_json', 'm.option_groups_json', { station: 'c.station' },
        { category_active: 'c.active' })
      .where('m.id', menuItemId)
      .where('m.restaurant_id', restaurantId)
      .first();
  }

  async findOrderForQrPayment(token: string, orderId: string) {
    return this.db('orders as o')
      .join('qr_codes as q', function () {
        this.on('q.table_id', '=', 'o.table_id').andOn('q.restaurant_id', '=', 'o.restaurant_id');
      })
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id', table_id: 'o.table_id',
        order_number: 'o.order_number', status: 'o.status',
        total_xof: 'o.total_xof', paid_xof: 'o.paid_xof',
        customer_phone: 'o.customer_phone', paydunya_mode: 'r.paydunya_mode',
        restaurant_name: 'r.name', restaurant_status: 'r.status',
        deleted_at: 'r.deleted_at', qr_status: 'q.status',
      })
      .where('q.token', token)
      .where('o.id', orderId)
      .first();
  }

  async findOrderForStorefrontPayment(slug: string, orderId: string) {
    return this.db('orders as o')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id',
        order_number: 'o.order_number', status: 'o.status',
        order_type: 'o.order_type', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', customer_phone: 'o.customer_phone',
        paydunya_mode: 'r.paydunya_mode', restaurant_name: 'r.name',
        restaurant_status: 'r.status', deleted_at: 'r.deleted_at',
      })
      .where('r.slug', slug)
      .where('o.id', orderId)
      .whereIn('o.order_type', ['CLICK_COLLECT', 'DELIVERY'])
      .first();
  }

  async updateOrderCustomerPhone(orderId: string, restaurantId: string, phone: string) {
    return this.db('orders')
      .where({ id: orderId, restaurant_id: restaurantId })
      .update({ customer_phone: phone, updated_at: new Date().toISOString() });
  }

  async findQrPaymentByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    return this.db('payments')
      .select({
        id: 'id', orderId: 'order_id', amountXof: 'amount_xof',
        method: 'method', mode: 'mode', reference: 'reference',
        status: 'status', createdAt: 'created_at',
        provider: 'provider', providerReference: 'provider_reference',
        checkoutUrl: 'checkout_url',
      })
      .where({ restaurant_id: restaurantId, idempotency_key: idempotencyKey })
      .first();
  }

  async insertPendingPublicOrderPayment(params: {
    paymentId: string; restaurantId: string; orderId: string;
    amountXof: number; method: string; mode: string; reference: string;
    idempotencyKey: string | null; now: string;
  }) {
    await this.db('payments').insert({
      id: params.paymentId, restaurant_id: params.restaurantId,
      order_id: params.orderId, amount_xof: params.amountXof,
      method: params.method, status: 'PENDING', mode: params.mode,
      reference: params.reference, idempotency_key: params.idempotencyKey,
      provider: 'PAYDUNYA', provider_status: 'INITIALIZING',
      created_by_user_id: null, created_at: params.now, updated_at: params.now,
    });
  }

  async updatePaymentProviderDetails(params: {
    paymentId: string; restaurantId: string; providerReference: string;
    checkoutUrl: string | null; providerStatus: string; payloadJson: string; mode: string; now: string;
  }) {
    const updated = await this.db('payments')
      .where({
        id: params.paymentId, restaurant_id: params.restaurantId,
        provider: 'PAYDUNYA', status: 'PENDING',
      })
      .update({
        provider_reference: params.providerReference,
        checkout_url: params.checkoutUrl,
        provider_status: params.providerStatus,
        provider_payload_json: params.payloadJson,
        mode: params.mode,
        updated_at: params.now,
      });
    if (updated !== 1) throw new Error('Le paiement en attente est introuvable pour enregistrer la référence PayDunya.');
  }

  async markPendingPaymentFailed(params: {
    paymentId: string; restaurantId: string; reason: string; now: string;
  }) {
    await this.db('payments')
      .where({
        id: params.paymentId, restaurant_id: params.restaurantId,
        status: 'PENDING',
      })
      .update({
        status: 'FAILED', provider_status: 'FAILED',
        provider_payload_json: params.reason, updated_at: params.now,
      });
  }

  async findPaymentByProviderReference(providerReference: string) {
    return this.db('payments')
      .select('id', 'restaurant_id', 'order_id', 'amount_xof', 'method',
        'status', 'provider', 'provider_reference', 'idempotency_key')
      .where({ provider: 'PAYDUNYA', provider_reference: providerReference })
      .first();
  }

  async completePaydunyaOrderPayment(
    trx: Knex.Transaction,
    params: {
      paymentId: string; restaurantId: string; orderId: string;
      providerReference: string; amountXof: number; payloadJson: string; now: string;
    },
  ) {
    const payment = await trx('payments')
      .where({
        id: params.paymentId, restaurant_id: params.restaurantId,
        order_id: params.orderId, provider: 'PAYDUNYA',
      })
      .forUpdate()
      .first();
    if (!payment) throw new Error('Paiement PayDunya introuvable.');
    if (payment.status === 'PAID') return { alreadyPaid: true, fullyPaid: false, order: null };
    if (payment.status !== 'PENDING') throw new Error('Ce paiement n’est plus en attente.');
    if (String(payment.provider_reference) !== params.providerReference) {
      throw new Error('La référence PayDunya ne correspond pas au paiement enregistré.');
    }
    if (Number(payment.amount_xof) !== params.amountXof) {
      throw new Error('Le montant confirmé par PayDunya ne correspond pas au paiement.');
    }

    const order = await trx('orders')
      .where({ id: params.orderId, restaurant_id: params.restaurantId })
      .forUpdate()
      .first();
    if (!order) throw new Error('Commande associée au paiement introuvable.');
    const remaining = Number(order.total_xof) - Number(order.paid_xof);
    if (params.amountXof <= 0 || params.amountXof > remaining) {
      throw new Error('Le montant du paiement dépasse le solde de la commande.');
    }
    const newPaid = Number(order.paid_xof) + params.amountXof;
    const fullyPaid = newPaid >= Number(order.total_xof);
    await trx('payments')
      .where({ id: params.paymentId, restaurant_id: params.restaurantId })
      .update({
        status: 'PAID', provider_status: 'COMPLETED',
        provider_payload_json: params.payloadJson, updated_at: params.now,
      });
    await trx('orders')
      .where({ id: params.orderId, restaurant_id: params.restaurantId })
      .update({
        paid_xof: newPaid,
        status: fullyPaid ? 'PAID' : order.status,
        updated_at: params.now,
      });
    return { alreadyPaid: false, fullyPaid, order: { ...order, paid_xof: newPaid } };
  }

  async insertPublicOrderTransaction(
    trx: Knex.Transaction,
    params: {
      orderId: string; restaurantId: string; orderNumber: string;
      orderType: 'QR_TABLE' | 'CLICK_COLLECT' | 'DELIVERY'; tableId: string | null;
      customerName: string; customerPhone: string; deliveryAddress: string;
      deliveryZone: string; deliveryFeeXof: number; scheduledSlot: string;
      promoCode: string; loyaltyPointsUsed: number; subtotalHtXof: number;
      discountXof: number; taxXof: number; totalXof: number; notes: string;
      idempotencyKey: string | null; now: string;
      lines: Array<{
        id: string; menuItemId: string; name: string; station: string;
        unitPriceXof: number; optionsSummary: string; optionsDeltaXof: number;
        quantity: number; lineTotalXof: number; notes: string;
      }>;
    },
  ): Promise<void> {
    await trx('orders').insert({
      id: params.orderId, restaurant_id: params.restaurantId,
      order_number: params.orderNumber, order_type: params.orderType,
      table_id: params.tableId, customer_name: params.customerName,
      customer_phone: params.customerPhone, delivery_address: params.deliveryAddress,
      delivery_zone: params.deliveryZone, delivery_fee_xof: params.deliveryFeeXof,
      scheduled_slot: params.scheduledSlot, promo_code: params.promoCode,
      loyalty_points_used: params.loyaltyPointsUsed, loyalty_points_earned: 0,
      status: 'PENDING', subtotal_xof: params.subtotalHtXof,
      discount_xof: params.discountXof, tax_xof: params.taxXof,
      total_xof: params.totalXof, paid_xof: 0, notes: params.notes,
      idempotency_key: params.idempotencyKey, created_by_user_id: null,
      created_at: params.now, updated_at: params.now,
    });
    await trx('order_items').insert(params.lines.map((line) => ({
      id: line.id, order_id: params.orderId, menu_item_id: line.menuItemId,
      name: line.name, station: line.station, unit_price_xof: line.unitPriceXof,
      options_summary: line.optionsSummary, options_delta_xof: line.optionsDeltaXof,
      quantity: line.quantity, line_total_xof: line.lineTotalXof,
      notes: line.notes, prep_status: 'PENDING',
    })));
    if (params.tableId) {
      await trx('dining_tables')
        .where({ id: params.tableId, restaurant_id: params.restaurantId })
        .update({ status: 'OCCUPIED' });
    }
  }

  async findTrackedQrOrder(token: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('qr_codes as q', function () {
        this.on('q.table_id', '=', 'o.table_id').andOn('q.restaurant_id', '=', 'o.restaurant_id');
      })
      .join('dining_tables as t', 't.id', 'o.table_id')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', table_label: 't.label',
        restaurant_name: 'r.name', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('q.token', token)
      .where('o.id', orderId)
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findTrackedStorefrontOrder(slug: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', delivery_address: 'o.delivery_address',
        delivery_zone: 'o.delivery_zone', delivery_fee_xof: 'o.delivery_fee_xof',
        scheduled_slot: 'o.scheduled_slot', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', restaurant_name: 'r.name',
        restaurant_slug: 'r.slug', restaurant_phone: 'r.phone', restaurant_address: 'r.address',
        restaurant_city: 'r.city', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('r.slug', slug)
      .where('o.id', orderId)
      .whereIn('o.order_type', ['CLICK_COLLECT', 'DELIVERY'])
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findReviewByOrderId(orderId: string) {
    const r = await this.db('customer_reviews')
      .select({
        id: 'id', restaurantId: 'restaurant_id', orderId: 'order_id',
        orderNumber: 'order_number', tableLabel: 'table_label',
        customerName: 'customer_name', rating: 'rating',
        serviceRating: this.db.raw('COALESCE(service_rating, rating)'),
        foodRating: this.db.raw('COALESCE(food_rating, rating)'),
        speedRating: this.db.raw('COALESCE(speed_rating, rating)'),
        waiterName: this.db.raw("COALESCE(waiter_name, '')"),
        channel: this.db.raw("COALESCE(channel, 'QR_ORDER')"),
        comment: 'comment', reply: 'reply', createdAt: 'created_at',
      })
      .where({ order_id: orderId })
      .first();
    if (!r) return null;
    const rating = Number(r.rating);
    return {
      id: String(r.id), restaurantId: String(r.restaurantId),
      orderId: r.orderId ? String(r.orderId) : null,
      orderNumber: String(r.orderNumber || ''), tableLabel: String(r.tableLabel || ''),
      customerName: String(r.customerName || 'Client'), rating,
      serviceRating: Number(r.serviceRating || rating),
      foodRating: Number(r.foodRating || rating),
      speedRating: Number(r.speedRating || rating),
      waiterName: String(r.waiterName || ''), channel: String(r.channel || 'QR_ORDER'),
      comment: String(r.comment || ''), reply: String(r.reply || ''),
      createdAt: String(r.createdAt),
    };
  }

  async findPublicRatingStats(restaurantId: string) {
    const row = await this.db('customer_reviews')
      .where({ restaurant_id: restaurantId })
      .select(
        this.db.raw('COUNT(*)::int as total'),
        this.db.raw('ROUND(AVG(rating)::numeric, 1) as "avgRating"'),
        this.db.raw('ROUND(AVG(COALESCE(service_rating, rating))::numeric, 1) as "avgServiceRating"'),
      )
      .first();
    return {
      total: Number(row?.total || 0),
      avgRating: Number(row?.avgRating || 0),
      avgServiceRating: Number(row?.avgServiceRating || 0),
    };
  }

  async resolveLoyaltyForPhone(
    restaurantId: string,
    cleanPhone: string,
    executor: Knex | Knex.Transaction = this.db,
  ) {
    if (cleanPhone.length < 6) return null;
    const digitsTail = cleanPhone.replace(/\\D/g, '').slice(-8);
    const resto = await executor('restaurants')
      .select('loyalty_enabled', 'loyalty_points_per_1000_xof', 'loyalty_xof_per_point')
      .where({ id: restaurantId })
      .first();
    const customer = await executor('customers')
      .select('id', 'full_name', 'phone', 'loyalty_points', 'total_spent_xof', 'visits_count')
      .where('restaurant_id', restaurantId)
      .andWhere(function () {
        this.where('phone', cleanPhone)
          .orWhereRaw("REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE ?", [`%${digitsTail}`]);
      })
      .first();
    return {
      loyaltyEnabled: Boolean(resto?.loyalty_enabled ?? 1),
      pointsPer1000Xof: Number(resto?.loyalty_points_per_1000_xof || 10),
      xofPerPoint: Number(resto?.loyalty_xof_per_point || 25),
      customer: customer ? {
        id: customer.id,
        fullName: customer.full_name,
        phone: customer.phone,
        loyaltyPoints: Number(customer.loyalty_points || 0),
        totalSpentXof: Number(customer.total_spent_xof || 0),
        visitsCount: Number(customer.visits_count || 0),
      } : null,
    };
  }

  async createTableCall(params: {
    restaurantId: string;
    tableId: string;
    tableLabel: string;
    callType: 'WAITER' | 'BILL';
    note: string;
  }) {
    const id = this.id('call');
    const notificationId = this.id('ntf');
    const now = new Date().toISOString();
    await this.db.transaction(async (trx) => {
      await trx('table_calls').insert({
        id, restaurant_id: params.restaurantId, table_id: params.tableId,
        table_label: params.tableLabel, call_type: params.callType,
        note: params.note, status: 'PENDING', created_at: now,
      });
      await trx('notifications').insert({
        id: notificationId, restaurant_id: params.restaurantId,
        type: params.callType === 'BILL' ? 'TABLE_BILL_REQUEST' : 'TABLE_WAITER_CALL',
        title: params.callType === 'BILL'
          ? `Demande d’addition · ${params.tableLabel}`
          : `Appel serveur · ${params.tableLabel}`,
        message: params.note || `La table ${params.tableLabel} demande votre présence.`,
        stock_id: null, email_dispatched: 0, email_recipients: '',
        email_status: 'SKIPPED', is_read: 0, created_at: now,
      });
    });
    return {
      id, restaurantId: params.restaurantId, tableId: params.tableId,
      tableLabel: params.tableLabel, callType: params.callType,
      note: params.note, status: 'PENDING' as const, createdAt: now,
    };
  }

  async insertCustomerReview(params: {
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
    const id = this.id('rev');
    const now = new Date().toISOString();
    await this.db('customer_reviews').insert({
      id, restaurant_id: params.restaurantId, order_id: params.orderId,
      order_number: params.orderNumber, table_label: params.tableLabel,
      customer_name: params.customerName, rating: params.rating,
      service_rating: params.serviceRating, food_rating: params.foodRating,
      speed_rating: params.speedRating, waiter_name: params.waiterName,
      channel: params.channel, comment: params.comment, reply: '',
      created_at: now,
    });
    return {
      id, restaurantId: params.restaurantId, orderId: params.orderId,
      orderNumber: params.orderNumber, tableLabel: params.tableLabel,
      customerName: params.customerName, rating: params.rating,
      serviceRating: params.serviceRating, foodRating: params.foodRating,
      speedRating: params.speedRating, waiterName: params.waiterName,
      channel: params.channel, comment: params.comment, reply: '',
      createdAt: now,
    };
  }

  async findServiceWaiterNames(restaurantId: string): Promise<string[]> {
    const rows = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select('u.full_name')
      .where('rm.restaurant_id', restaurantId)
      .where('rm.status', 'ACTIVE')
      .where('u.status', 'ACTIVE')
      .whereIn('rm.role', ['WAITER', 'CASHIER', 'MANAGER'])
      .orderBy('u.full_name', 'asc')
      .limit(20);
    return rows.map((r) => String(r.full_name || '').trim()).filter(Boolean);
  }
}

export const knexPublicRepository = new KnexPublicRepository();
 THEN substring(order_number from 5)::integer
           ELSE 1000
         END),
         1000
       ) AS max_number
       FROM orders
       WHERE restaurant_id = ?`,
      [restaurantId],
    );
    const initial = Math.max(1000, Number(maxResult.rows?.[0]?.max_number || 1000));
    const now = new Date().toISOString();
    const inserted = await trx('restaurant_order_counters')
      .insert({ restaurant_id: restaurantId, last_number: initial + 1, updated_at: now })
      .onConflict('restaurant_id')
      .merge({
        last_number: trx.raw('GREATEST(restaurant_order_counters.last_number, ?) + 1', [initial]),
        updated_at: now,
      })
      .returning('last_number');
    const next = Number(inserted[0]?.last_number);
    if (!Number.isSafeInteger(next) || next <= 1000) {
      throw new Error('Impossible de réserver un numéro de commande unique.');
    }
    return `CMD-${next}`;
  }

  async countOrdersForRestaurant(restaurantId: string): Promise<number> {
    const row = await this.db('orders').where({ restaurant_id: restaurantId }).count({ c: '*' }).first();
    return Number(row?.c || 0);
  }

  async findMenuItemWithStation(menuItemId: string, restaurantId: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', 'c.id', 'm.category_id')
      .select('m.id', 'm.category_id', 'm.name', 'm.price_xof', 'm.available',
        'm.options_json', 'm.option_groups_json', { station: 'c.station' },
        { category_active: 'c.active' })
      .where('m.id', menuItemId)
      .where('m.restaurant_id', restaurantId)
      .first();
  }

  async insertPublicOrderTransaction(
    trx: Knex.Transaction,
    params: {
      orderId: string; restaurantId: string; orderNumber: string;
      orderType: 'QR_TABLE' | 'CLICK_COLLECT' | 'DELIVERY'; tableId: string | null;
      customerName: string; customerPhone: string; deliveryAddress: string;
      deliveryZone: string; deliveryFeeXof: number; scheduledSlot: string;
      promoCode: string; loyaltyPointsUsed: number; subtotalHtXof: number;
      discountXof: number; taxXof: number; totalXof: number; notes: string;
      idempotencyKey: string | null; now: string;
      lines: Array<{
        id: string; menuItemId: string; name: string; station: string;
        unitPriceXof: number; optionsSummary: string; optionsDeltaXof: number;
        quantity: number; lineTotalXof: number; notes: string;
      }>;
    },
  ): Promise<void> {
    await trx('orders').insert({
      id: params.orderId, restaurant_id: params.restaurantId,
      order_number: params.orderNumber, order_type: params.orderType,
      table_id: params.tableId, customer_name: params.customerName,
      customer_phone: params.customerPhone, delivery_address: params.deliveryAddress,
      delivery_zone: params.deliveryZone, delivery_fee_xof: params.deliveryFeeXof,
      scheduled_slot: params.scheduledSlot, promo_code: params.promoCode,
      loyalty_points_used: params.loyaltyPointsUsed, loyalty_points_earned: 0,
      status: 'PENDING', subtotal_xof: params.subtotalHtXof,
      discount_xof: params.discountXof, tax_xof: params.taxXof,
      total_xof: params.totalXof, paid_xof: 0, notes: params.notes,
      idempotency_key: params.idempotencyKey, created_by_user_id: null,
      created_at: params.now, updated_at: params.now,
    });
    await trx('order_items').insert(params.lines.map((line) => ({
      id: line.id, order_id: params.orderId, menu_item_id: line.menuItemId,
      name: line.name, station: line.station, unit_price_xof: line.unitPriceXof,
      options_summary: line.optionsSummary, options_delta_xof: line.optionsDeltaXof,
      quantity: line.quantity, line_total_xof: line.lineTotalXof,
      notes: line.notes, prep_status: 'PENDING',
    })));
    if (params.tableId) {
      await trx('dining_tables')
        .where({ id: params.tableId, restaurant_id: params.restaurantId })
        .update({ status: 'OCCUPIED' });
    }
  }

  async findTrackedQrOrder(token: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('qr_codes as q', function () {
        this.on('q.table_id', '=', 'o.table_id').andOn('q.restaurant_id', '=', 'o.restaurant_id');
      })
      .join('dining_tables as t', 't.id', 'o.table_id')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', table_label: 't.label',
        restaurant_name: 'r.name', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('q.token', token)
      .where('o.id', orderId)
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findTrackedStorefrontOrder(slug: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', restaurant_id: 'o.restaurant_id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', delivery_address: 'o.delivery_address',
        delivery_zone: 'o.delivery_zone', delivery_fee_xof: 'o.delivery_fee_xof',
        scheduled_slot: 'o.scheduled_slot', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', restaurant_name: 'r.name',
        restaurant_slug: 'r.slug', restaurant_phone: 'r.phone', restaurant_address: 'r.address',
        restaurant_city: 'r.city', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('r.slug', slug)
      .where('o.id', orderId)
      .whereIn('o.order_type', ['CLICK_COLLECT', 'DELIVERY'])
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findReviewByOrderId(orderId: string) {
    const r = await this.db('customer_reviews')
      .select({
        id: 'id', restaurantId: 'restaurant_id', orderId: 'order_id',
        orderNumber: 'order_number', tableLabel: 'table_label',
        customerName: 'customer_name', rating: 'rating',
        serviceRating: this.db.raw('COALESCE(service_rating, rating)'),
        foodRating: this.db.raw('COALESCE(food_rating, rating)'),
        speedRating: this.db.raw('COALESCE(speed_rating, rating)'),
        waiterName: this.db.raw("COALESCE(waiter_name, '')"),
        channel: this.db.raw("COALESCE(channel, 'QR_ORDER')"),
        comment: 'comment', reply: 'reply', createdAt: 'created_at',
      })
      .where({ order_id: orderId })
      .first();
    if (!r) return null;
    const rating = Number(r.rating);
    return {
      id: String(r.id), restaurantId: String(r.restaurantId),
      orderId: r.orderId ? String(r.orderId) : null,
      orderNumber: String(r.orderNumber || ''), tableLabel: String(r.tableLabel || ''),
      customerName: String(r.customerName || 'Client'), rating,
      serviceRating: Number(r.serviceRating || rating),
      foodRating: Number(r.foodRating || rating),
      speedRating: Number(r.speedRating || rating),
      waiterName: String(r.waiterName || ''), channel: String(r.channel || 'QR_ORDER'),
      comment: String(r.comment || ''), reply: String(r.reply || ''),
      createdAt: String(r.createdAt),
    };
  }

  async findPublicRatingStats(restaurantId: string) {
    const row = await this.db('customer_reviews')
      .where({ restaurant_id: restaurantId })
      .select(
        this.db.raw('COUNT(*)::int as total'),
        this.db.raw('ROUND(AVG(rating)::numeric, 1) as "avgRating"'),
        this.db.raw('ROUND(AVG(COALESCE(service_rating, rating))::numeric, 1) as "avgServiceRating"'),
      )
      .first();
    return {
      total: Number(row?.total || 0),
      avgRating: Number(row?.avgRating || 0),
      avgServiceRating: Number(row?.avgServiceRating || 0),
    };
  }

  async resolveLoyaltyForPhone(
    restaurantId: string,
    cleanPhone: string,
    executor: Knex | Knex.Transaction = this.db,
  ) {
    if (cleanPhone.length < 6) return null;
    const digitsTail = cleanPhone.replace(/\\D/g, '').slice(-8);
    const resto = await executor('restaurants')
      .select('loyalty_enabled', 'loyalty_points_per_1000_xof', 'loyalty_xof_per_point')
      .where({ id: restaurantId })
      .first();
    const customer = await executor('customers')
      .select('id', 'full_name', 'phone', 'loyalty_points', 'total_spent_xof', 'visits_count')
      .where('restaurant_id', restaurantId)
      .andWhere(function () {
        this.where('phone', cleanPhone)
          .orWhereRaw("REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE ?", [`%${digitsTail}`]);
      })
      .first();
    return {
      loyaltyEnabled: Boolean(resto?.loyalty_enabled ?? 1),
      pointsPer1000Xof: Number(resto?.loyalty_points_per_1000_xof || 10),
      xofPerPoint: Number(resto?.loyalty_xof_per_point || 25),
      customer: customer ? {
        id: customer.id,
        fullName: customer.full_name,
        phone: customer.phone,
        loyaltyPoints: Number(customer.loyalty_points || 0),
        totalSpentXof: Number(customer.total_spent_xof || 0),
        visitsCount: Number(customer.visits_count || 0),
      } : null,
    };
  }

  async createTableCall(params: {
    restaurantId: string;
    tableId: string;
    tableLabel: string;
    callType: 'WAITER' | 'BILL';
    note: string;
  }) {
    const id = this.id('call');
    const notificationId = this.id('ntf');
    const now = new Date().toISOString();
    await this.db.transaction(async (trx) => {
      await trx('table_calls').insert({
        id, restaurant_id: params.restaurantId, table_id: params.tableId,
        table_label: params.tableLabel, call_type: params.callType,
        note: params.note, status: 'PENDING', created_at: now,
      });
      await trx('notifications').insert({
        id: notificationId, restaurant_id: params.restaurantId,
        type: params.callType === 'BILL' ? 'TABLE_BILL_REQUEST' : 'TABLE_WAITER_CALL',
        title: params.callType === 'BILL'
          ? `Demande d’addition · ${params.tableLabel}`
          : `Appel serveur · ${params.tableLabel}`,
        message: params.note || `La table ${params.tableLabel} demande votre présence.`,
        stock_id: null, email_dispatched: 0, email_recipients: '',
        email_status: 'SKIPPED', is_read: 0, created_at: now,
      });
    });
    return {
      id, restaurantId: params.restaurantId, tableId: params.tableId,
      tableLabel: params.tableLabel, callType: params.callType,
      note: params.note, status: 'PENDING' as const, createdAt: now,
    };
  }

  async insertCustomerReview(params: {
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
    const id = this.id('rev');
    const now = new Date().toISOString();
    await this.db('customer_reviews').insert({
      id, restaurant_id: params.restaurantId, order_id: params.orderId,
      order_number: params.orderNumber, table_label: params.tableLabel,
      customer_name: params.customerName, rating: params.rating,
      service_rating: params.serviceRating, food_rating: params.foodRating,
      speed_rating: params.speedRating, waiter_name: params.waiterName,
      channel: params.channel, comment: params.comment, reply: '',
      created_at: now,
    });
    return {
      id, restaurantId: params.restaurantId, orderId: params.orderId,
      orderNumber: params.orderNumber, tableLabel: params.tableLabel,
      customerName: params.customerName, rating: params.rating,
      serviceRating: params.serviceRating, foodRating: params.foodRating,
      speedRating: params.speedRating, waiterName: params.waiterName,
      channel: params.channel, comment: params.comment, reply: '',
      createdAt: now,
    };
  }

  async findServiceWaiterNames(restaurantId: string): Promise<string[]> {
    const rows = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select('u.full_name')
      .where('rm.restaurant_id', restaurantId)
      .where('rm.status', 'ACTIVE')
      .where('u.status', 'ACTIVE')
      .whereIn('rm.role', ['WAITER', 'CASHIER', 'MANAGER'])
      .orderBy('u.full_name', 'asc')
      .limit(20);
    return rows.map((r) => String(r.full_name || '').trim()).filter(Boolean);
  }
}

export const knexPublicRepository = new KnexPublicRepository();
